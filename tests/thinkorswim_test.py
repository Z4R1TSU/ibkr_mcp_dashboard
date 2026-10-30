import asyncio
import copy
import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from datetime import datetime
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "integrations/thinkorswim"))
from wire import Wire, validate_request, ProtocolError
from market import quotes, history, settled_history, choose_series, chain_details, NY
from settings import private_json, read_private
from state import State
from http_api import create_server
from price_basis import verify


class MarketTests(unittest.TestCase):
    def test_startup_does_not_claim_login_expiry_or_restore_a_stale_auth_status(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            state = State(directory)
            self.assertEqual(state.view()["status"]["state"], "starting")
            state.status(state="login_required", connected=False)
            state.save()
            restored = State(directory)
            restored.save()
            self.assertEqual(read_private(directory / "market-cache.json")["status"]["state"], "starting")
            self.assertFalse(restored.view()["status"]["connected"])

    def test_basis_rejects_split_discontinuity_and_missing_volume(self):
        bars = [{"date": str(i), "open": 100., "high": 102., "low": 99., "close": 101., "volume": 1000.} for i in range(210)]
        rows = {r["date"]: {**r, "adjusted_close": 90.} for r in bars}
        value = {"bars": bars, "adjustment": "unknown"}
        self.assertEqual(verify(value, rows, [])["adjustment"], "split")
        broken = copy.deepcopy(value)
        broken["bars"][0]["close"] *= 2
        self.assertEqual(verify(broken, rows, [])["adjustment"], "unknown")
        broken = copy.deepcopy(value)
        for r in broken["bars"][10:]:
            r["volume"] = None
        self.assertEqual(verify(broken, rows, [])["adjustment"], "unknown")

    def test_write_and_unbounded_requests_cannot_be_sent(self):
        for service in ("place_order", "cancel_order", "watchlist/create", "user_properties/set", "accounts"):
            with self.assertRaises(ProtocolError):
                validate_request(service, {})
        for f in ({}, {"strikeQuantity": 2147483647}, {"seriesNames": ["a", "b"], "strikeQuantity": 10}):
            with self.assertRaises(ProtocolError):
                validate_request("quotes/options", {"underlyingSymbol": "SPY", "filter": f})
        validate_request("quotes/options", {"underlyingSymbol": "SPY",
            "filter": {"seriesNames": ["one"], "minStrike": 500, "maxStrike": 510}})
        validate_request("quotes", {"symbols": ["AMZN", ".APP261218P250"]})
        for symbol in ["../token", "https://evil.test", "", "AAPL;DROP"]:
            with self.assertRaises(ProtocolError):
                validate_request("chart", {"symbol": symbol})

    def test_quote_unknowns_are_not_zero_or_realtime(self):
        result = quotes({"items": [{"symbol": "SPY", "values": {"BID": 2, "ASK": None}}]}, {"SPY"}, "receipt")
        self.assertIsNone(result["SPY"]["isDelayed"])
        self.assertIsNone(result["SPY"]["sourceTime"])
        self.assertIsNone(result["SPY"]["values"]["ASK"])
        self.assertNotIn("DELTA", result["SPY"]["values"])

    def test_history_validation_and_unsettled_bar_filter(self):
        body = {"symbol": "AAPL", "candles": {
            "timestamps": [1791982800000, 1792069200000],
            "opens": [10, 11], "highs": [12, 13], "lows": [9, 10],
            "closes": [11, 12], "volumes": [None, 100]}}
        value = history(body, "AAPL", "receipt", "YEAR5")
        self.assertEqual(value["adjustment"], "unknown")
        self.assertIsNone(value["bars"][0]["volume"])
        today = value["bars"][-1]["date"]
        now = datetime.fromisoformat(today + "T12:00:00").replace(tzinfo=NY)
        settled = settled_history(value, today, now)
        self.assertEqual(settled["count"], 1)
        malformed = copy.deepcopy(body)
        malformed["candles"]["closes"].pop()
        with self.assertRaises(ValueError):
            history(malformed, "AAPL", "receipt", "YEAR5")

    def test_private_storage_rejects_world_readable_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "value.json"
            private_json(file, {"value": 1})
            self.assertEqual(read_private(file), {"value": 1})
            file.chmod(0o644)
            with self.assertRaises(ValueError):
                read_private(file)

    def test_snapshot_preserves_regular_session_last_and_option_chain_is_bounded(self):
        result = quotes({"items": [{"symbol": "SPY", "values": {"LAST_RTH": 500}}]},
            {"SPY"}, "receipt", snapshot=True)
        self.assertEqual(result["SPY"]["values"]["LAST_RTH"], 500)
        series = {"name": "fixture"}
        pairs = [{"strike": n, "callSymbol": f".SPY261023C{n}", "putSymbol": f".SPY261023P{n}"} for n in range(490, 520)]
        pairs.append({"strike": 505, "callSymbol": ".SPY1261023C505", "putSymbol": ".SPY1261023P505"})
        chain = chain_details({"optionSeries": [{"name": "fixture", "optionPairs": pairs}]}, series, 10, 505)
        self.assertEqual(len(chain["pairs"]), 10)
        self.assertTrue(all(".SPY1" not in r["callSymbol"] for r in chain["pairs"]))


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_on_demand_quote_reads_unheld_symbol_without_reusing_old_fields(self):
        from collector import Collector
        from types import SimpleNamespace
        calls = []
        class FakeWire:
            async def request(self, service, params, **kwargs):
                calls.append((service, params))
                if "MARK" in params["fields"]:
                    raise ProtocolError("unsupported_snapshot_field")
                await asyncio.sleep(0.01)
                return {"items": [{"symbol": "GOOG", "isDelayed": False,
                    "values": {"LAST": 291.54, "LAST_RTH": 321.89}}]}
        with tempfile.TemporaryDirectory() as tmp:
            collector = Collector({"directory": Path(tmp)}, State(Path(tmp)))
            collector.wire = FakeWire()
            first, second = await asyncio.gather(collector.fetch_quote("GOOG"), collector.fetch_quote("GOOG"))
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][0], "quotes/get")
            self.assertEqual(first["values"]["LAST"], 291.54)
            self.assertEqual(first["values"]["LAST_RTH"], 321.89)
            self.assertEqual(first["fieldTimes"]["LAST"], first["receivedAt"])
            self.assertIsNone(first["sourceTime"])
            self.assertEqual(first, second)
            self.assertEqual(collector.quote_tasks, {})
            self.assertEqual(collector.state.view()["quotes"], {})

    async def test_failed_symbol_does_not_stop_other_subscriptions(self):
        frames = [{"payload": [{"header": {"service": "quotes", "id": "bad", "type": "error"}, "body": {}}]},
                  {"payload": [{"header": {"service": "quotes", "id": "good", "type": "snapshot"}, "body": {"value": 2}}]}]
        class Socket:
            async def recv(self):
                if not frames:
                    raise ConnectionError()
                return json.dumps(frames.pop(0))
        wire = Wire(None, lambda: None)
        wire.socket = Socket()
        received = []
        wire.handlers[("quotes", "bad")] = lambda _: self.fail("invalid quote delivered")
        wire.handlers[("quotes", "good")] = lambda body: received.append(body["value"])
        with self.assertRaises(ConnectionError):
            await wire.receive()
        self.assertEqual(received, [2])
        self.assertIn(("quotes", "bad"), wire.subscription_errors)

    async def test_snapshot_and_patch_merge_by_service_and_id(self):
        frames = [{"payload": [{"header": {"service": "quotes", "id": "q", "type": "snapshot"}, "body": {"value": 1}}]},
                  {"payload": [{"header": {"service": "quotes", "id": "q", "type": "patch"}, "body": {"patches": [
                      {"op": "replace", "path": "/value", "value": 2}]}}]}]
        class Socket:
            async def recv(self):
                if not frames:
                    raise ConnectionError()
                return json.dumps(frames.pop(0))
        received = []
        wire = Wire(None, lambda: None)
        wire.socket = Socket()
        wire.handlers[("quotes", "q")] = lambda body: received.append(body["value"])
        with self.assertRaises(ConnectionError):
            await wire.receive()
        self.assertEqual(received, [1, 2])


class HttpTests(unittest.TestCase):
    def test_on_demand_quote_endpoint_is_authenticated_and_checks_symbols_and_connection(self):
        from market import timestamp
        with tempfile.TemporaryDirectory() as tmp:
            state = State(Path(tmp))
            state.status(connected=True, lastFrameAt=timestamp())
            calls = []
            def read(symbol):
                calls.append(symbol)
                return {"symbol": symbol, "values": {"MARK": 291.6}}
            server = create_server(0, "test-key", state, quote_request=read)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            def request(path, authorized=True):
                conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
                conn.request("GET", path, headers={"Authorization": "Bearer test-key"} if authorized else {})
                response = conn.getresponse()
                result = response.status, json.loads(response.read())
                conn.close()
                return result
            try:
                self.assertEqual(request("/v1/quote?symbol=GOOG", False)[0], 401)
                self.assertEqual(request("/v1/quote?symbol=../GOOG")[0], 400)
                status, result = request("/v1/quote?symbol=GOOG")
                self.assertEqual(status, 200)
                self.assertEqual(result["quote"]["values"]["MARK"], 291.6)
                state.status(connected=False)
                self.assertEqual(request("/v1/quote?symbol=GOOG")[0], 503)
                self.assertEqual(calls, ["GOOG"])
            finally:
                server.shutdown()
                server.server_close()

    def test_local_api_auth_and_write_rejection(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = State(Path(tmp))
            server = create_server(0, "test-key", state)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            def request(method, path, headers=None):
                conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
                conn.request(method, path, headers=headers or {})
                response = conn.getresponse()
                result = response.status, response.read()
                conn.close()
                return result
            try:
                self.assertEqual(request("GET", "/health")[0], 200)
                self.assertEqual(request("GET", "/v1/quotes")[0], 401)
                auth = {"Authorization": "Bearer test-key"}
                self.assertEqual(request("POST", "/orders", auth)[0], 405)
                self.assertEqual(request("GET", "/v1/status", auth)[0], 200)
                self.assertEqual(request("GET", "/v1/status", {**auth, "Origin": "https://evil.test"})[0], 403)
                self.assertEqual(request("GET", "/v1/status", {**auth, "Host": "evil.test"})[0], 403)
            finally:
                server.shutdown()
                server.server_close()


class HoldingGreeksTests(unittest.TestCase):
    def test_restart_and_reconnect_invalidate_old_risk_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = State(Path(tmp))
            state.update('holdingGreeks', {'test': {'deltaBasis': 'per-share-feed-v1'}})
            state.update('quotes', {'SPY': {'values': {'LAST': 200}, 'fieldTimes': {'LAST': 'old'}}})
            state.save()
            restored = State(Path(tmp))
            self.assertEqual(restored.view()['holdingGreeks'], {})
            self.assertNotIn('fieldTimes', restored.view()['quotes']['SPY'])
            state.clear_risk_fields()
            self.assertEqual(state.view()['holdingGreeks'], {})

    def test_exact_contract_series_and_pair(self):
        from holding_greeks import contract, match_series, match_pair
        held = contract('.APP261218P250')
        series = dict(name='fixture', underlying='APP', spc=100, multiplier=100, lastTradeDate='2026-12-18T21:00:00Z')
        self.assertEqual(match_series({'series': [series]}, held), series)
        with self.assertRaises(ValueError):
            match_series({'series': [{**series, 'spc': 150}]}, held)
        pair = dict(strike=250, callSymbol='.APP261218C250', putSymbol='.APP261218P250')
        body = {'optionSeries': [{'name': 'fixture', 'optionPairs': [pair]}]}
        self.assertEqual(match_pair(body, series, held), pair)
        pair['putSymbol'] = '.APP1261218P250'
        with self.assertRaises(ValueError):
            match_pair(body, series, held)

    def test_delta_units_sign_and_field_freshness(self):
        from holding_greeks import verified_rows
        pair = dict(callSymbol='.APP261218C250', putSymbol='.APP261218P250')
        series = dict(multiplier=100, spc=100)
        body = {'items': [{'symbol': pair['callSymbol'], 'values': {'DELTA': .3, 'BID': 2}},
                          {'symbol': pair['putSymbol'], 'values': {'DELTA': -.7}}]}
        rows = verified_rows(body, pair, series, {})
        self.assertEqual(rows[pair['callSymbol']]['deltaBasis'], 'per-share-feed-v1')
        old_time = rows[pair['callSymbol']]['fieldTimes']['DELTA']
        body['items'][0]['values']['BID'] = 3
        patch = {'patches': [{'op': 'replace', 'path': '/items/0/values/BID', 'value': 3}]}
        next_rows = verified_rows(body, pair, series, rows, 'patch', patch)
        self.assertEqual(next_rows[pair['callSymbol']]['fieldTimes']['DELTA'], old_time)
        body['items'][0]['values']['DELTA'] = 30
        self.assertEqual(verified_rows(body, pair, series, {})[pair['callSymbol']]['deltaBasis'], 'unverified')
    def test_feed_scale_is_shared_but_each_delta_stays_validated(self):
        from holding_greeks import DeltaVerifier, verified_rows
        pair = dict(callSymbol='.APP261218C250', putSymbol='.APP261218P250')
        series = dict(multiplier=100, spc=100)
        body = {'items': [{'symbol': pair['callSymbol'], 'values': {'DELTA': .3}},
                          {'symbol': pair['putSymbol'], 'values': {'DELTA': -.7}}]}
        verifier = DeltaVerifier()
        verified_rows(body, pair, series, {}, verifier=verifier)
        body['items'][0]['values']['DELTA'] = .1847
        body['items'][1]['values']['DELTA'] = -.999
        self.assertEqual(verified_rows(body, pair, series, {}, verifier=verifier)[pair['callSymbol']]['deltaBasis'], 'per-share-feed-v1')
        self.assertEqual(verified_rows(body, pair, series, {}, verifier=DeltaVerifier())[pair['callSymbol']]['deltaBasis'], 'unverified')
        body['items'][1]['values']['DELTA'] = None
        self.assertEqual(verified_rows(body, pair, series, {}, verifier=verifier)[pair['putSymbol']]['deltaBasis'], 'unverified')

    def test_bounded_non_spy_requests_and_snapshot_times(self):
        from holding_greeks import stamp_fields
        validate_request('optionSeries', {'underlying': 'APP'})
        validate_request('quotes/options', {'underlyingSymbol': 'APP', 'filter': {'seriesNames': ['one'], 'minStrike': 250, 'maxStrike': 250}})
        for underlying in ['../token', 'AAPL;DROP', '.APP261218P250']:
            with self.assertRaises(ProtocolError):
                validate_request('optionSeries', {'underlying': underlying})
        body = {'items': [{'symbol': 'APP', 'values': {'LAST': 200}}]}
        rows = quotes(body, {'APP'}, 'received', snapshot=True)
        stamp_fields(rows, {}, body, 'snapshot', None)
        self.assertEqual(rows['APP']['fieldTimes']['LAST'], 'received')
        stamp_fields(rows, rows, body, 'patch', {'patches': []})
        self.assertNotIn('MARK', rows['APP']['fieldTimes'])

class QuietDeltaTests(unittest.IsolatedAsyncioTestCase):
    async def test_replacement_waits_for_delta_and_timeout_keeps_old_subscription(self):
        from holding_greeks import HoldingSubscription
        class FakeWire:
            def __init__(self):
                self.handlers = {('quotes/options', 'old'): lambda body: None}
                self.bases, self.subscription_errors = {}, {}
                self.count = 0
            async def subscribe(self, service, params, callback):
                self.count += 1
                key = str(self.count)
                self.handlers[(service, key)] = callback
                callback({'delta': None})
                return key
            async def send(self, service, params):
                pass
        wire = FakeWire()
        values = [.3]
        sub = HoldingSubscription(wire, {}, lambda body: values.append(body['delta']), ready=lambda body: body['delta'] is not None)
        sub.request_id = 'old'
        pending = asyncio.create_task(sub.refresh(timeout=1))
        await asyncio.sleep(0)
        self.assertEqual(values, [.3])
        self.assertIn(('quotes/options', 'old'), wire.handlers)
        wire.handlers[('quotes/options', '1')]({'delta': .31})
        await pending
        self.assertEqual(values, [.3, .31])
        self.assertNotIn(('quotes/options', 'old'), wire.handlers)
        with self.assertRaises(TimeoutError):
            await sub.refresh(timeout=.01)
        self.assertEqual(sub.request_id, '1')
        self.assertEqual(values, [.3, .31])
        self.assertNotIn(('quotes/options', '2'), wire.handlers)


    async def test_unchanged_delta_is_confirmed_and_old_handlers_are_removed(self):
        from unittest.mock import patch
        from holding_greeks import HoldingSubscription, verified_rows, DeltaVerifier
        pair = dict(callSymbol='.CRCL261030C100', putSymbol='.CRCL261030P100')
        series = dict(multiplier=100, spc=100)
        body = {'items': [{'symbol': pair['callSymbol'], 'values': {'DELTA': .1398}},
                          {'symbol': pair['putSymbol'], 'values': {'DELTA': -.8016}}]}
        saved, verifier = {}, DeltaVerifier()
        class FakeWire:
            def __init__(self):
                self.handlers, self.bases, self.subscription_errors = {}, {}, {}
                self.requests, self.removed = [], []
                self.fail = False
            async def subscribe(self, service, params, callback):
                if self.fail:
                    raise ConnectionError('fixture')
                self.requests.append(params)
                request_id = str(len(self.requests))
                self.handlers[(service, request_id)] = callback
                self.bases[(service, request_id)] = body
                callback(body)
                return request_id
            async def send(self, service, params):
                self.removed.append(params['targetRequestId'])
        wire = FakeWire()
        def update(response):
            saved.update(verified_rows(response, pair, series, saved, verifier=verifier))
        params = {'underlyingSymbol': 'CRCL', 'filter': {'seriesNames': ['fixture'], 'minStrike': 100, 'maxStrike': 100}, 'fields': ['DELTA']}
        subscription = HoldingSubscription(wire, params, update)
        times = ['2026-10-23T14:00:00Z', '2026-10-23T14:01:00Z', '2026-10-23T14:02:00Z']
        with patch('holding_greeks.timestamp', side_effect=times):
            for expected in times:
                await subscription.refresh()
                self.assertEqual(saved[pair['callSymbol']]['fieldTimes']['DELTA'], expected)
                self.assertEqual(saved[pair['callSymbol']]['values']['DELTA'], .1398)
                self.assertEqual(len(wire.handlers), 1)
        self.assertEqual(wire.removed, ['1', '2'])
        self.assertEqual(wire.requests, [params, params, params])
        wire.fail = True
        with self.assertRaises(ConnectionError):
            await subscription.refresh()
        self.assertEqual(saved[pair['callSymbol']]['fieldTimes']['DELTA'], times[-1])
        self.assertEqual(subscription.request_id, '3')
        await subscription.close()
        self.assertEqual(wire.handlers, {})
        self.assertEqual(wire.bases, {})

    async def test_collector_renews_quiet_contracts_each_cycle_and_removes_closed_positions(self):
        from unittest.mock import patch, AsyncMock
        from collector import Collector
        with tempfile.TemporaryDirectory() as tmp:
            state = State(Path(tmp))
            collector = Collector({'directory': Path(tmp)}, state)
            subscription = type('Subscription', (), {'request_id': 'one', 'refresh': AsyncMock(), 'close': AsyncMock()})()
            wire = type('FakeWire', (), {'subscription_errors': {}, 'request': AsyncMock(return_value={'series': []})})()
            cycles = 0
            async def sleep(seconds):
                nonlocal cycles
                if seconds >= 1:
                    cycles += 1
                    if cycles == 4:
                        collector.stopped.set()
            universe = [(['.CRCL261030C100'], [])] * 3 + [([], [])]
            with patch('collector.read_universe', side_effect=universe), patch('collector.asyncio.sleep', side_effect=sleep), patch('collector.subscribe_holding', new=AsyncMock(return_value=subscription)) as subscribe:
                await collector.holding_greeks(wire)
            self.assertEqual(subscribe.await_count, 1)
            self.assertEqual(subscription.refresh.await_count, 2)
            subscription.close.assert_awaited_once()

if __name__ == "__main__":
    unittest.main()
