"""Bounded market identifiers; accepts no account IDs or arbitrary RPC."""
import json
import re
from pathlib import Path

BASE = {"AAPL", "SPY", "QQQ", "DIA", "IWM"}
STOCK = re.compile(r"^[A-Z]{1,10}$")
OPTION = re.compile(r"^\.[A-Z]{1,10}\d{6}[CP]\d+(?:\.\d{1,3})?$")


def valid_symbol(value, options=False):
    return isinstance(value, str) and bool(STOCK.fullmatch(value) or options and OPTION.fullmatch(value))


def read_universe(directory):
    try:
        value = json.loads(Path(directory, "universe.json").read_text())
    except (OSError, ValueError):
        value = {}
    if not isinstance(value, dict):
        value = {}
    raw_quotes = value.get("quotes", [])
    raw_history = value.get("history", [])
    quotes = {s for s in raw_quotes[:200] if valid_symbol(s, True)} if isinstance(raw_quotes, list) else set()
    history = {s for s in raw_history[:100] if valid_symbol(s)} if isinstance(raw_history, list) else set()
    return sorted(BASE | set(sorted(quotes - BASE)[:195])), sorted(BASE | set(sorted(history - BASE)[:95]))
