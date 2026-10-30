"""Only market fields enter cache; timestamps distinguish receipt from source time."""
from datetime import datetime, timezone, time
from zoneinfo import ZoneInfo
import math
import re
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from us_sessions import latest_settled

NY = ZoneInfo("America/New_York")
QUOTE_FIELDS = ("MARK", "MARK_CHANGE", "MARK_PERCENT_CHANGE", "NET_CHANGE", "NET_CHANGE_PERCENT",
                "BID", "ASK", "BID_SIZE", "ASK_SIZE", "VOLUME", "OPEN", "HIGH", "LOW", "LAST", "LAST_SIZE", "CLOSE")
OPTION_FIELDS = ("BID", "ASK", "DELTA", "OPEN_INT", "VOLUME", "IMPLIED_VOLATILITY")
SNAPSHOT_FIELDS = ("MARK", "BID", "ASK", "LAST", "LAST_RTH", "VOLUME")


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def number(value):
    return value if not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) else None


def quotes(body, allowed, received_at, option=False, snapshot=False):
    if not isinstance(body, dict) or not isinstance(body.get("items"), list):
        raise ValueError("invalid_quote_shape")
    output = {}
    fields = OPTION_FIELDS if option else SNAPSHOT_FIELDS if snapshot else QUOTE_FIELDS
    for row in body["items"]:
        symbol = row.get("symbol")
        if symbol not in allowed or not isinstance(row.get("values"), dict):
            continue
        values = {name: number(row["values"].get(name)) for name in fields}
        output[symbol] = {
            "symbol": symbol, "provider": "thinkorswim", "receivedAt": received_at,
            "sourceTime": None,
            "isDelayed": row.get("isDelayed") if isinstance(row.get("isDelayed"), bool) else None,
            "values": values,
            "returnedFields": [name for name in fields if name in row["values"]],
        }
    if not output:
        raise ValueError("no_requested_quotes")
    return output


def history(body, symbol, received_at, requested_range, adjustment="unknown"):
    if not isinstance(body, dict) or body.get("symbol") != symbol:
        raise ValueError("history_symbol_mismatch")
    candles = body.get("candles", {})
    keys = ("timestamps", "opens", "highs", "lows", "closes", "volumes")
    if any(not isinstance(candles.get(k), list) for k in keys):
        raise ValueError("invalid_candles")
    count = len(candles["timestamps"])
    if not 1 <= count <= 20000 or any(len(candles[k]) != count for k in keys):
        raise ValueError("unequal_candle_arrays")
    bars, dates = [], set()
    for values in zip(*(candles[k] for k in keys)):
        ts, opening, high, low, close, volume = (number(v) for v in values)
        if ts is None or not 631152000000 <= ts <= 4102444800000:
            raise ValueError("invalid_millisecond_timestamp")
        date = datetime.fromtimestamp(ts / 1000, NY).date().isoformat()
        if date in dates:
            raise ValueError("duplicate_daily_bar")
        dates.add(date)
        if any(v is None or v <= 0 for v in (opening, high, low, close)):
            raise ValueError("invalid_ohlc")
        if not low <= min(opening, close) <= max(opening, close) <= high:
            raise ValueError("inconsistent_ohlc")
        if volume is not None and volume < 0:
            raise ValueError("invalid_volume")
        bars.append({"date": date, "timestamp": ts, "open": opening, "high": high,
                     "low": low, "close": close, "volume": volume})
    bars.sort(key=lambda row: row["date"])
    return {"provider": "thinkorswim", "symbol": symbol, "receivedAt": received_at,
            "interval": "1d", "session": "regular", "timezone": "America/New_York",
            "adjustment": adjustment, "requestedRange": requested_range,
            "returnedFields": list(keys), "bars": bars, "count": len(bars)}


def settled_history(value, as_of, now=None):
    now = now or datetime.now(NY)
    cutoff = latest_settled(as_of, now)
    bars = [r for r in value["bars"] if r["date"] <= cutoff]
    return {**value, "bars": bars, "count": len(bars), "asOf": as_of,
            "settledOnly": True, "latestDate": bars[-1]["date"] if bars else None}


def choose_series(body, requested=None, today=None):
    today = today or datetime.now(NY).date().isoformat()
    candidates = [r for r in body.get("series", []) if r.get("underlying") == "SPY" and
                  r.get("spc") == 100 and r.get("multiplier") == 100 and
                  isinstance(r.get("name"), str) and
                  str(r.get("lastTradeDate") or r.get("expiration") or "")[:10] > today]
    if requested:
        candidates = [r for r in candidates if str(r.get("lastTradeDate") or r.get("expiration"))[:10] == requested]
    if not candidates:
        raise ValueError("no_matching_standard_spy_expiry")
    row = min(candidates, key=lambda r: r.get("lastTradeDate") or r["expiration"])
    return {k: row.get(k) for k in ("name", "underlying", "spc", "multiplier",
                                  "expiration", "lastTradeDate", "settlementType", "isEuropean")}


def chain_details(body, series, limit, center):
    rows = [r for r in body.get("optionSeries", []) if r.get("name") == series["name"]]
    if len(rows) != 1:
        raise ValueError("chain_expiry_mismatch")
    pairs = rows[0].get("optionPairs", [])
    pairs = [r for r in pairs if number(r.get("strike")) is not None and r["strike"] > 0
             and all(isinstance(r.get(k), str) and re.fullmatch(r"\.SPY\d{6}[CP]\d+(?:\.\d+)?", r[k])
                     for k in ("callSymbol", "putSymbol"))]
    if not pairs:
        raise ValueError("empty_option_chain")
    pairs = sorted(sorted(pairs, key=lambda r: abs(r["strike"] - center))[:limit], key=lambda r: r["strike"])
    return {"provider": "thinkorswim", "underlying": "SPY", "series": series,
            "minStrike": pairs[0]["strike"], "maxStrike": pairs[-1]["strike"],
            "pairs": [{k: r[k] for k in ("strike", "callSymbol", "putSymbol")} for r in pairs]}
