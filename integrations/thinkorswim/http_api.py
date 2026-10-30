"""Loopback-only authenticated GET API; no generic RPC or broker credentials."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from datetime import datetime
import hmac
import json
import threading
from market import settled_history, NY
from universe import valid_symbol


def create_server(port, key, state, history_request=None, quote_request=None):
    streams = threading.BoundedSemaphore(8)
    quote_reads = threading.BoundedSemaphore(8)
    def disconnected(data):
        try:
            age = (datetime.now(NY) - datetime.fromisoformat(data["status"]["lastFrameAt"])).total_seconds()
            return not data["status"].get("connected") or not -5 <= age <= 20
        except (ValueError, TypeError, KeyError):
            return True

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, code, value):
            data = json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            actual_port = self.server.server_port
            if self.headers.get("Host") not in {f"127.0.0.1:{actual_port}", f"localhost:{actual_port}"} or self.headers.get("Origin"):
                return self.reply(403, {"error": "local_api_only"})
            path = urlparse(self.path)
            if path.path == "/health":
                return self.reply(200, {"ok": True, "readOnly": True})
            supplied = self.headers.get("Authorization", "")
            if not hmac.compare_digest(supplied, "Bearer " + key):
                return self.reply(401, {"error": "unauthorized"})
            try:
                self.dispatch(path)
            except (ValueError, KeyError):
                self.reply(400, {"error": "invalid_request"})
            except (BrokenPipeError, ConnectionError, TimeoutError):
                pass

        def do_POST(self):
            self.reply(405, {"error": "read_only"})

        do_PUT = do_DELETE = do_PATCH = do_POST

        def dispatch(self, path):
            data = state.view()
            query = parse_qs(path.query)
            stale = disconnected(data)
            if path.path == "/v1/status":
                return self.reply(200, data["status"])
            if path.path == "/v1/quotes":
                rows = data["snapshotQuotes" if query.get("snapshot") == ["1"] else "quotes"]
                return self.reply(200 if rows else 503, {"quotes": rows, "disconnected": stale})
            if path.path == "/v1/quote":
                symbol = query.get("symbol", [""])[0]
                if not valid_symbol(symbol):
                    return self.reply(400, {"error": "invalid_symbol"})
                if stale or not quote_request:
                    return self.reply(503, {"error": "quote_unavailable"})
                if not quote_reads.acquire(blocking=False):
                    return self.reply(429, {"error": "quote_read_limit"})
                try:
                    row = quote_request(symbol)
                    return self.reply(200, {"quote": row, "disconnected": disconnected(state.view())})
                except Exception as error:
                    print("quote_read_failed: " + type(error).__name__, flush=True)
                    return self.reply(503, {"error": "quote_unavailable", "reason": type(error).__name__})
                finally:
                    quote_reads.release()
            if path.path == "/v1/options":
                return self.reply(200 if data["options"] else 503, {"chain": data["options"], "disconnected": stale})
            if path.path == "/v1/history":
                symbol = query.get("symbol", [""])[0]
                as_of = query.get("asOf", [datetime.now(NY).date().isoformat()])[0]
                datetime.strptime(as_of, "%Y-%m-%d")
                if not valid_symbol(symbol):
                    return self.reply(400, {"error": "symbol_not_enabled"})
                if history_request and not stale:
                    try:
                        history_request(symbol)
                        data = state.view()
                    except Exception:
                        pass
                if symbol not in data["history"]:
                    return self.reply(503, {"error": "history_unavailable"})
                result = settled_history(data["history"][symbol], as_of)
                return self.reply(200, {**result, "disconnected": disconnected(data),
                    "status": data["status"].get(symbol + "History", "unknown")})
            if path.path == "/v1/events":
                return self.events()
            self.reply(404, {"error": "not_found"})

        def events(self):
            if not streams.acquire(blocking=False):
                return self.reply(429, {"error": "stream_limit"})
            try:
                self.connection.settimeout(15)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                version = -1
                while True:
                    with state.condition:
                        if version == state.version:
                            state.condition.wait(timeout=10)
                        version = state.version
                    payload = json.dumps(state.event(), allow_nan=False)
                    self.wfile.write(("event: market\ndata: " + payload + "\n\n").encode())
                    self.wfile.flush()
            finally:
                streams.release()

    class Server(ThreadingHTTPServer):
        daemon_threads = True
        def handle_error(self, *_):
            pass

    return Server(("127.0.0.1", port), Handler)
