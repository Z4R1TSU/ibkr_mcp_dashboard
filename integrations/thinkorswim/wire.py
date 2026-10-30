"""wsjson transport with mandatory outgoing allowlist; no trading facade."""
import asyncio
import json
import secrets
import math
import jsonpatch
from websockets.asyncio.client import connect
from settings import WS_URL, ORIGIN
from universe import valid_symbol

MARKET_SERVICES = frozenset({"quotes", "quotes/get", "chart", "optionSeries", "option_chain/get", "quotes/options"})
ALLOWED = MARKET_SERVICES | {"login", "unsubscribe"}


class AuthRequired(Exception):
    pass


class ProtocolError(Exception):
    pass


def validate_request(service, params):
    if service not in ALLOWED or not isinstance(params, dict):
        raise ProtocolError("read_only_service_rejected")
    if service == "unsubscribe" and params.get("targetService") not in MARKET_SERVICES:
        raise ProtocolError("unsubscribe_target_rejected")
    if service in {"option_chain/get", "quotes/options"}:
        f = params.get("filter", {})
        names = f.get('seriesNames') if isinstance(f, dict) else None
        if not valid_symbol(params.get("underlyingSymbol")) or not isinstance(names, list) or len(names) != 1 or not isinstance(names[0], str) or not names[0]:
            raise ProtocolError("option_scope_rejected")
        quantity = f.get("strikeQuantity")
        bounded = type(quantity) is int and 1 <= quantity <= 20
        low, high = f.get("minStrike"), f.get("maxStrike")
        if low is not None or high is not None:
            bounded = all(type(v) in (int, float) and math.isfinite(v) for v in (low, high)) and 0 < low <= high and high - low <= 100
        if not bounded:
            raise ProtocolError("option_range_rejected")
    if service in {"quotes", "quotes/get"} and (not params.get("symbols") or
            len(params["symbols"]) > 200 or not all(valid_symbol(s, True) for s in params["symbols"])):
        raise ProtocolError("symbols_rejected")
    if service == "chart" and not valid_symbol(params.get("symbol")):
        raise ProtocolError("chart_symbol_rejected")
    if service == "optionSeries" and not valid_symbol(params.get("underlying")):
        raise ProtocolError("option_underlying_rejected")


class Wire:
    def __init__(self, proxy, on_activity):
        self.proxy, self.on_activity = proxy, on_activity
        self.socket, self.reader = None, None
        self.handlers, self.bases, self.pending = {}, {}, set()
        self.requests = {}
        self.subscription_errors = {}
        self.counts = {"snapshot": 0, "patch": 0}

    async def send(self, service, params, request_id=None, version=0):
        validate_request(service, params)
        request_id = request_id or secrets.token_hex(8)
        frame = {"payload": [{"header": {"service": service, "id": request_id, "ver": version}, "params": params}]}
        await self.socket.send(json.dumps(frame))
        return request_id

    async def open(self, token):
        self.socket = await connect(WS_URL, proxy=self.proxy, origin=ORIGIN,
            additional_headers={"Pragma": "no-cache", "Cache-Control": "no-cache"},
            compression="deflate", open_timeout=20, ping_interval=None, max_size=8 * 1024 * 1024)
        await self.socket.send(json.dumps({"ver": "27.*.*", "fmt": "json-patches-structured", "heartbeat": "2s"}))
        hello = json.loads(await asyncio.wait_for(self.socket.recv(), 15))
        if not hello.get("session"):
            raise ProtocolError("handshake_failed")
        await self.send("login", {"token": token, "domain": "TOS", "platform": "PROD", "tag": "TOSWeb"}, "login")
        async with asyncio.timeout(15):
            while True:
                frame = json.loads(await self.socket.recv())
                for row in frame.get("payload", []):
                    if row.get("header", {}).get("service") == "login":
                        if row.get("body", {}).get("authenticationStatus") != "OK":
                            raise AuthRequired()
                        self.reader = asyncio.create_task(self.receive())
                        return {"build": hello.get("build"), "protocol": hello.get("ver")}

    async def receive(self):
        try:
            while True:
                frame = json.loads(await asyncio.wait_for(self.socket.recv(), 12))
                self.on_activity()
                for row in frame.get("payload", []):
                    header = row.get("header", {})
                    if header.get("service") in ("login", "login/schwab"):
                        body = row.get("body", {})
                        if header.get("type") == "error" or body.get("authenticated") is False:
                            raise AuthRequired()
                    key = (header.get("service"), header.get("id"))
                    if key not in self.handlers:
                        continue
                    kind, body = header.get("type"), row.get("body")
                    if kind == "error":
                        # Never include broker response text; it may contain identifiers.
                        future = self.requests.get(key)
                        if future:
                            if not future.done():
                                future.set_exception(ProtocolError("service_error_" + key[0]))
                            continue
                        self.subscription_errors[key] = "service_error"
                        self.handlers.pop(key, None)
                        self.bases.pop(key, None)
                        continue
                    if kind == "snapshot":
                        self.bases[key] = body
                    elif kind == "patch":
                        if key not in self.bases:
                            raise ProtocolError("patch_without_snapshot")
                        self.bases[key] = jsonpatch.apply_patch(self.bases[key], body["patches"], in_place=False)
                    else:
                        continue
                    self.counts[kind] += 1
                    self.current_kind = kind
                    self.current_patch = body if kind == "patch" else None
                    self.handlers[key](self.bases[key])
        finally:
            for future in self.pending:
                if not future.done():
                    future.set_exception(ProtocolError("connection_lost"))

    async def subscribe(self, service, params, callback, version=0):
        request_id = secrets.token_hex(8)
        self.handlers[(service, request_id)] = callback
        await self.send(service, params, request_id, version)
        return request_id

    async def request(self, service, params, version=0, timeout=25):
        future = asyncio.get_running_loop().create_future()
        self.pending.add(future)
        request_id = secrets.token_hex(8)
        self.handlers[(service, request_id)] = lambda value: None if future.done() else future.set_result(value)
        self.requests[(service, request_id)] = future
        try:
            await self.send(service, params, request_id, version)
            return await asyncio.wait_for(future, timeout)
        finally:
            self.pending.discard(future)
            self.requests.pop((service, request_id), None)
            self.handlers.pop((service, request_id), None)
            self.bases.pop((service, request_id), None)
            if service != "quotes/get" and self.socket:
                try:
                    await self.send("unsubscribe", {"targetService": service, "targetRequestId": request_id})
                except Exception:
                    pass

    async def close(self):
        if self.socket:
            await self.socket.close()
        if self.reader:
            self.reader.cancel()
            await asyncio.gather(self.reader, return_exceptions=True)
        self.handlers.clear()
        self.bases.clear()
