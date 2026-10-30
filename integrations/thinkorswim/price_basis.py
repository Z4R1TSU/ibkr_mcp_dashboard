"""Validate a price basis against an independent history; otherwise keep unknown."""
from datetime import datetime
from market import NY, number, timestamp
import requests
import hashlib
import json


def fingerprint(value):
    return hashlib.sha256(json.dumps(value["bars"], sort_keys=True).encode()).hexdigest()


def verify(value, rows, events):
    overlap = [(b, rows[b["date"]]) for b in value["bars"] if b["date"] in rows]
    if len(overlap) < 200 or len(overlap) < len(value["bars"]) * 0.98:
        return {**value, "basisIssue": "reference_coverage_insufficient"}
    dates = {bar["date"] for bar in value["bars"]}
    first, last = min(dates), max(dates)
    if any(first <= date <= last and number(row.get("close")) and date not in dates
           for date, row in rows.items()):
        return {**value, "basisIssue": "trading_dates_incomplete"}
    diagnostics = {}
    for basis in ("split", "split_dividend"):
        errors, volume_errors = [], []
        for bar, ref in overlap:
            factor = 1
            if basis == "split_dividend":
                if not number(ref.get("close")) or not number(ref.get("adjusted_close")):
                    continue
                factor = ref["adjusted_close"] / ref["close"]
            for field in ("open", "high", "low", "close"):
                if number(ref.get(field)) and number(bar.get(field)):
                    errors.append(abs(bar[field] / (ref[field] * factor) - 1))
            if number(ref.get("volume")) and number(bar.get("volume")):
                volume_errors.append(abs(bar["volume"] / ref["volume"] - 1))
        diagnostics[basis] = {"priceFields": len(errors), "expectedPriceFields": len(overlap) * 4,
            "volumeRows": len(volume_errors), "maxPriceDifference": max(errors, default=None),
            "maxVolumeDifference": max(volume_errors, default=None)}
        if len(errors) < len(overlap) * 4 or len(volume_errors) < len(overlap) * 0.98:
            continue
        if max(errors) <= 0.02 and sum(e <= 0.003 for e in errors) >= len(errors) * 0.99 and max(volume_errors) <= 0.1:
            return {**value, "adjustment": basis, "corporateActions": events,
                "basisVerification": {"reference": "Yahoo chart", "checkedAt": timestamp(),
                    "bars": len(overlap), "ruleVersion": 2, "fingerprint": fingerprint(value)}}
    return {**value, "basisIssue": "ohlcv_comparison_failed", "basisDiagnostics": diagnostics}


def validate_basis(value, previous, proxy):
    if value.get("adjustment") != "unknown":
        return value
    evidence = (previous or {}).get("basisVerification", {})
    if evidence.get("ruleVersion") == 2 and evidence.get("fingerprint") == fingerprint(value) and previous.get("adjustment") in ("split", "split_dividend"):
        return {**value, "adjustment": previous["adjustment"], "basisVerification": evidence,
                "corporateActions": previous.get("corporateActions", [])}
    try:
        rows, events = reference(value["symbol"], proxy)
        return verify(value, rows, events)
    except Exception:
        return {**value, "basisIssue": "reference_unavailable"}


def reference(symbol, proxy):
    with requests.Session() as session:
        session.trust_env = False
        response = session.get("https://query2.finance.yahoo.com/v8/finance/chart/" + symbol,
            params={"range": "5y", "interval": "1d", "events": "div,splits", "includeAdjustedClose": "true"},
            headers={"User-Agent": "Mozilla/5.0"}, proxies={"https": proxy} if proxy else {},
            timeout=(8, 20))
        response.raise_for_status()
        raw = response.json()["chart"]["result"][0]
    values = raw["indicators"]["quote"][0]
    adjusted = raw["indicators"].get("adjclose", [{}])[0].get("adjclose", [])
    rows = {}
    for i, ts in enumerate(raw["timestamp"]):
        date = datetime.fromtimestamp(ts, NY).date().isoformat()
        rows[date] = {k: values.get(k, [None] * len(raw["timestamp"]))[i] for k in ("open", "high", "low", "close", "volume")}
        rows[date]["adjusted_close"] = adjusted[i] if i < len(adjusted) else None
    events = []
    for kind, group in raw.get("events", {}).items():
        for event in group.values():
            events.append({"date": datetime.fromtimestamp(event["date"], NY).date().isoformat(), "type": kind})
    return rows, events
