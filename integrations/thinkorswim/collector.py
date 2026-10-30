import asyncio
from holding_greeks import contract, subscribe_holding, stamp_fields, DeltaVerifier
from datetime import datetime
from market import QUOTE_FIELDS, OPTION_FIELDS, NY, timestamp, quotes, history, settled_history, choose_series, chain_details
from settings import read_private, WS_URL
from wire import Wire, AuthRequired, ProtocolError
from universe import read_universe, valid_symbol
from price_basis import validate_basis


class Collector:
    def __init__(self, config, state):
        self.config, self.state = config, state
        self.session_path = config["directory"] / "session.json"
        self.stopped = asyncio.Event()
        self.wire = None
        self.delta_verifier = DeltaVerifier()
        self.history_tasks = {}
        self.history_limit = asyncio.Semaphore(2)
        self.requested_history = set()
        self.quote_tasks = {}
        self.quote_limit = asyncio.Semaphore(2)

    async def run(self):
        failures, rejected = 0, None
        while not self.stopped.is_set():
            wire = None
            try:
                session = read_private(self.session_path)
                if session.get("wsUrl") != WS_URL or not isinstance(session.get("token"), str):
                    raise AuthRequired()
                signature = self.session_path.stat().st_mtime_ns
                if signature == rejected:
                    raise AuthRequired()
                self.state.status(state="connecting", connected=False)
                wire = Wire(self.config["proxy"], lambda: self.state.status(lastFrameAt=timestamp()))
                info = await wire.open(session["token"])
                self.delta_verifier = DeltaVerifier()
                self.state.clear_risk_fields()
                self.wire = wire
                self.state.status(state="connected", connected=True, error=None, **info)
                failures = 0
                await self.collect(wire, signature)
            except (FileNotFoundError, AuthRequired):
                rejected = self.session_path.stat().st_mtime_ns if self.session_path.exists() else None
                self.state.status(state="login_required", connected=False, error=None)
            except Exception as error:
                failures += 1
                reason = str(error) if isinstance(error, ProtocolError) else type(error).__name__
                self.state.status(state="reconnecting", connected=False, error=reason)
            finally:
                self.wire = None
                if wire:
                    await wire.close()
                self.state.save()
            delay = min(60, 2 ** min(failures, 6)) if failures else 3
            try:
                await asyncio.wait_for(self.stopped.wait(), delay)
            except TimeoutError:
                pass

    async def collect(self, wire, signature):
        day = datetime.now(NY).date()
        tasks = [asyncio.create_task(f(wire)) for f in (self.quote_streams, self.histories, self.holding_greeks, self.options)]
        try:
            while not self.stopped.is_set():
                if wire.reader.done():
                    await wire.reader
                for task in tasks[:3]:
                    if task.done():
                        await task
                        raise ProtocolError("market_task_stopped")
                if self.session_path.stat().st_mtime_ns != signature:
                    return
                if datetime.now(NY).date() != day:
                    return  # Refresh the single option expiry after the New York date changes.
                self.state.status(frames=dict(wire.counts))
                self.state.save()
                await asyncio.sleep(5)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def quote_streams(self, wire):
        subscriptions = {}
        def update(symbol, body):
            try:
                fresh = quotes(body, {symbol}, timestamp())
                saved = self.state.view(["quotes"]) ["quotes"]
                stamp_fields(fresh, saved, body, wire.current_kind, getattr(wire, "current_patch", None))
                for key, row in fresh.items():
                    row["confirmedAt"] = row["receivedAt"]
                    old = saved.get(key)
                    if wire.current_kind == "patch" and old and row["values"] == old["values"]:
                        row["receivedAt"] = old["receivedAt"]
                    saved[key] = row
                self.state.update("quotes", saved)
            except (ValueError, KeyError, TypeError):
                pass
        while not self.stopped.is_set():
            symbols, _ = read_universe(self.config["directory"])
            for symbol in set(subscriptions) - set(symbols):
                request_id = subscriptions.pop(symbol)
                await wire.send("unsubscribe", {"targetService": "quotes", "targetRequestId": request_id})
                wire.handlers.pop(("quotes", request_id), None)
                wire.bases.pop(("quotes", request_id), None)
            for symbol in symbols:
                if ("quotes", subscriptions.get(symbol)) in wire.subscription_errors:
                    wire.subscription_errors.pop(("quotes", subscriptions[symbol]), None)
                    subscriptions.pop(symbol, None)
                if symbol not in subscriptions:
                    subscriptions[symbol] = await wire.subscribe("quotes", {"symbols": [symbol],
                        "fields": list(QUOTE_FIELDS), "refreshRate": 1000}, lambda body, s=symbol: update(s, body))
                    await asyncio.sleep(0.05)
            await self.quote_snapshots(wire, symbols)
            await asyncio.sleep(45)

    async def quote_snapshots(self, wire, symbols):
        for symbol in symbols:
            try:
                body = await wire.request("quotes/get", {"symbols": [symbol],
                    "fields": ["BID", "ASK", "LAST", "LAST_RTH", "VOLUME"]}, timeout=5)
                rows = quotes(body, {symbol}, timestamp(), snapshot=True)
                saved = self.state.view(["snapshotQuotes"]) ["snapshotQuotes"]
                stamp_fields(rows, saved, body, "snapshot", None)
                saved.update(rows)
                self.state.update("snapshotQuotes", saved)
            except Exception:
                pass

    async def fetch_quote(self, symbol):
        """One bounded read, including symbols outside portfolio subscriptions."""
        if not valid_symbol(symbol) or not self.wire:
            raise ValueError("quote_unavailable")
        if symbol in self.quote_tasks:
            return await asyncio.shield(self.quote_tasks[symbol])
        if len(self.quote_tasks) >= 8:
            raise ValueError("quote_queue_full")
        async def fetch():
            async with asyncio.timeout(8), self.quote_limit:
                wire = self.wire
                if not wire:
                    raise ValueError("disconnected")
                body = await wire.request("quotes/get", {"symbols": [symbol],
                    "fields": ["BID", "ASK", "LAST", "LAST_RTH", "VOLUME"]}, timeout=5)
                rows = quotes(body, {symbol}, timestamp(), snapshot=True)
                stamp_fields(rows, {}, body, "snapshot", None)
                return rows[symbol]
        task = asyncio.create_task(fetch())
        self.quote_tasks[symbol] = task
        try:
            return await asyncio.shield(task)
        finally:
            if task.done():
                self.quote_tasks.pop(symbol, None)
            else:
                task.add_done_callback(lambda _: self.quote_tasks.pop(symbol, None))

    async def fetch_history(self, symbol):
        if not valid_symbol(symbol) or not self.wire:
            raise ValueError("history_unavailable")
        if len(self.history_tasks) >= 32 and symbol not in self.history_tasks:
            raise ValueError("history_queue_full")
        if len(self.requested_history) < 100:
            self.requested_history.add(symbol)
        cached = self.state.view(["history"])["history"].get(symbol)
        reusable = cached and (cached.get("adjustment") == "unknown" or cached.get("basisVerification", {}).get("ruleVersion") == 2 or self.config["adjustment"] != "unknown")
        cache_seconds = 900 if cached and cached.get("adjustment") != "unknown" else 60
        if reusable and cached.get("basisCheckedAt") and (datetime.now(NY) - datetime.fromisoformat(cached["receivedAt"])).total_seconds() < cache_seconds:
            self.state.status(**{symbol + "History": "available", symbol + "HistoryError": None})
            return cached
        async def fetch():
            async with self.history_limit:
                wire = self.wire
                if not wire:
                    raise ValueError("disconnected")
                body = await wire.request("chart", {"symbol": symbol, "timeAggregation": "DAY",
                    "range": self.config["history_range"], "extendedHours": False, "studies": []}, version=1)
                value = history(body, symbol, timestamp(), self.config["history_range"], self.config["adjustment"])
                value = settled_history(value, datetime.now(NY).date().isoformat())
                value = await asyncio.to_thread(validate_basis, value, cached, self.config["proxy"])
                value["basisCheckedAt"] = timestamp()
                saved = self.state.view(["history"]) ["history"]
                saved[symbol] = value
                self.state.update("history", saved)
                self.state.status(**{symbol + "History": "available", symbol + "HistoryError": None})
                return value
        if symbol not in self.history_tasks:
            task = asyncio.create_task(fetch())
            self.history_tasks[symbol] = task
            task.add_done_callback(lambda done: (self.history_tasks.pop(symbol, None), None if done.cancelled() else done.exception()))
        return await asyncio.shield(self.history_tasks[symbol])

    async def histories(self, wire):
        while not self.stopped.is_set():
            _, symbols = read_universe(self.config["directory"])
            for symbol in sorted(set(symbols) | self.requested_history):
                try:
                    await self.fetch_history(symbol)
                except Exception as error:
                    self.state.status(**{symbol + "History": "unavailable", symbol + "HistoryError": type(error).__name__})
            await asyncio.sleep(900)

    async def options(self, wire):
        try:
            for _ in range(20):
                if self.state.view(["quotes"])["quotes"].get("SPY"):
                    break
                await asyncio.sleep(0.5)
            series_body = await wire.request("optionSeries", {"underlying": "SPY"})
            series = choose_series(series_body, self.config["expiry"])
            body = await wire.request("option_chain/get", {"underlyingSymbol": "SPY",
                "filter": {"seriesNames": [series["name"]], "strikeQuantity": self.config["strikes"]}})
            spy = self.state.view(["quotes"]) ["quotes"].get("SPY", {}).get("values", {})
            center = spy.get("MARK") or spy.get("LAST") or spy.get("BID")
            if not center:
                raise ValueError("underlying_price_missing")
            chain = chain_details(body, series, self.config["strikes"], center)
            allowed = {r[k] for r in chain["pairs"] for k in ("callSymbol", "putSymbol")}
            def update_options(response):
                value = {**chain, "quotes": quotes(response, allowed, timestamp(), option=True),
                         "receivedAt": timestamp(), "greeksUnits": "unverified"}
                for pair in chain['pairs']:
                    self.delta_verifier.observe(value['quotes'], pair)
                self.state.update("options", value)
                self.state.status(options="available", optionsError=None)
            await wire.subscribe("quotes/options", {"underlyingSymbol": "SPY", "exchange": "BEST",
                "fields": list(OPTION_FIELDS), "filter": {"seriesNames": [series["name"]],
                    "minStrike": chain["minStrike"], "maxStrike": chain["maxStrike"]}}, update_options)
        except Exception as error:
            self.state.status(options="unavailable", optionsError=type(error).__name__)

    async def holding_greeks(self, wire):
        subscriptions = {}
        while not self.stopped.is_set():
            started = asyncio.get_running_loop().time()
            symbols, _ = read_universe(self.config['directory'])
            wanted = {s: contract(s) for s in symbols if contract(s)}
            for symbol in list(subscriptions):
                subscription = subscriptions[symbol]
                failed = ('quotes/options', subscription.request_id) in wire.subscription_errors
                if symbol not in wanted or failed:
                    await subscription.close()
                    subscriptions.pop(symbol)
            saved = self.state.view(['holdingGreeks'])['holdingGreeks']
            self.state.update('holdingGreeks', {s: r for s, r in saved.items() if s in wanted})
            series_cache = {}
            for symbol, held in wanted.items():
                try:
                    if symbol in subscriptions:
                        await subscriptions[symbol].refresh()
                    else:
                        underlying = held['underlying']
                        if underlying not in series_cache:
                            series_cache[underlying] = await wire.request('optionSeries', {'underlying': underlying})
                        subscriptions[symbol] = await subscribe_holding(wire, held, self.state, series_cache[underlying], self.delta_verifier)
                except Exception:
                    pass  # Keep the last observation with its ORIGINAL time; failure never confirms freshness.
                await asyncio.sleep(0.05)
            elapsed = asyncio.get_running_loop().time() - started
            await asyncio.sleep(max(1, 60 - elapsed))
