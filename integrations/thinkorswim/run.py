import asyncio
import os
import signal
import sys
import threading
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from settings import settings, api_key
from state import State
from collector import Collector
from http_api import create_server


async def main():
    os.umask(0o077)
    config = settings()
    state = State(config["directory"])
    state.save()
    collector = Collector(config, state)
    loop = asyncio.get_running_loop()
    def history_request(symbol):
        return asyncio.run_coroutine_threadsafe(collector.fetch_history(symbol), loop).result(timeout=10)
    def quote_request(symbol):
        pending = asyncio.run_coroutine_threadsafe(collector.fetch_quote(symbol), loop)
        try:
            return pending.result(timeout=10)
        finally:
            if not pending.done():
                pending.cancel()
    server = create_server(config["port"], api_key(config["directory"]), state, history_request, quote_request)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(sig, collector.stopped.set)
    print("Thinkorswim read-only market service started on loopback.", flush=True)
    try:
        await collector.run()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        print("Thinkorswim startup failed: " + type(error).__name__, file=sys.stderr)
        raise SystemExit(1)
