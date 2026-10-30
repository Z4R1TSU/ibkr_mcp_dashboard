"""One price basis for quotes and indicators, with explicit sample requirements."""
from datetime import datetime, time
from zoneinfo import ZoneInfo
from io import StringIO
import os
from pathlib import Path
import sys
import pandas as pd
from stockstats import wrap
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from us_sessions import latest_settled

MIN_BARS = {"close_10_ema": 30, "close_50_sma": 50, "close_200_sma": 200,
            "rsi": 15, "atr": 15, "boll": 20, "boll_ub": 20, "boll_lb": 20,
            "macd": 35, "macds": 35, "macdh": 35, "vwma": 14, "mfi": 15}


def safe_indicators(frame):
    values = wrap(frame.copy())
    for name, minimum in MIN_BARS.items():
        try:
            series = values[name].copy()
            required = ["Close"] if name.startswith("close_") or name in ("rsi", "macd", "macds", "macdh", "boll", "boll_ub", "boll_lb") else ["High", "Low", "Close"]
            if name in ("vwma", "mfi"):
                required.append("Volume")
            valid = frame[required].notna().all(axis=1).rolling(minimum, min_periods=minimum).sum().eq(minimum)
            yield name, series.where(valid.to_numpy())
        except (KeyError, ValueError, IndexError):
            yield name, pd.Series(float("nan"), index=frame.index)


def fetch_frame(symbol, as_of, expected_settled_date=None):
    primary = os.environ.get("TRADINGAGENTS_MARKET_VENDOR", "yfinance")
    fallback = os.environ.get("TRADINGAGENTS_MARKET_FALLBACK", "yfinance")
    if fallback not in ("yfinance", "alpha_vantage"):
        fallback = "yfinance"
    try:
        frame = _fetch_frame(symbol, as_of, primary)
        if expected_settled_date and frame["Date"].iloc[-1].strftime("%Y-%m-%d") != expected_settled_date:
            raise ValueError("日线未覆盖研究启动时最近应完成的交易日")
        if primary == "thinkorswim" and (len(frame) < 200 or frame.tail(200)[["Open", "High", "Low", "Close", "Volume"]].isna().any().any()):
            raise ValueError("嘉信历史样本不足")
        frame.attrs["source"] = primary
    except Exception:
        if primary != "thinkorswim":
            raise
        frame = _fetch_frame(symbol, as_of, fallback)
        if expected_settled_date and frame["Date"].iloc[-1].strftime("%Y-%m-%d") != expected_settled_date:
            raise ValueError("备用日线未覆盖最近应完成的交易日")
        frame.attrs["source"] = fallback
        frame.attrs["fallback_reason"] = "嘉信日线缺失、过期、样本不足或复权口径未核验，已使用原数据源。"
    return frame


def _fetch_frame(symbol, as_of, vendor):
    if vendor == "yfinance":
        from tradingagents.dataflows.vendors.yahoo.ohlcv import load_ohlcv
        frame = load_ohlcv(symbol, as_of, fill_gaps=False)
    elif vendor == "alpha_vantage":
        from tradingagents.dataflows.vendors.alpha_vantage.stock import get_stock
        start = (pd.Timestamp(as_of) - pd.DateOffset(years=5)).strftime("%Y-%m-%d")
        frame = pd.read_csv(StringIO(get_stock(symbol, start, as_of)))
        required = {"timestamp", "open", "high", "low", "close", "adjusted_close", "volume", "split_coefficient"}
        if not required.issubset(frame.columns):
            raise ValueError("Alpha Vantage 未返回完整复权日线；检查 API 权限与配额")
        frame = frame.sort_values("timestamp")
        for column in required - {"timestamp"}:
            frame[column] = pd.to_numeric(frame[column], errors="coerce")
        factor = frame["adjusted_close"] / frame["close"]
        for column in ("open", "high", "low", "close"):
            frame[column] *= factor
        splits = frame["split_coefficient"].iloc[::-1].cumprod().iloc[::-1] / frame["split_coefficient"]
        frame["volume"] *= splits
        frame = frame.rename(columns={"timestamp": "Date", "open": "Open", "high": "High",
                                      "low": "Low", "close": "Close", "volume": "Volume"})
    elif vendor == "thinkorswim":
        from tos_data import fetch_tos_frame
        frame = fetch_tos_frame(symbol, as_of)
    else:
        raise ValueError("TRADINGAGENTS_MARKET_VENDOR 仅支持 yfinance / alpha_vantage / thinkorswim")
    frame = frame.copy()
    frame["Date"] = pd.to_datetime(frame["Date"]).dt.tz_localize(None).dt.normalize()
    frame = frame[frame["Date"] <= pd.Timestamp(as_of)].sort_values("Date").reset_index(drop=True)
    expected = latest_settled(as_of, datetime.now(ZoneInfo("America/New_York")))
    frame = frame[frame["Date"] <= pd.Timestamp(expected)].reset_index(drop=True)
    if frame.empty or frame["Date"].duplicated().any() or not frame["Close"].gt(0).all():
        raise ValueError("日线缺失、重复或收盘价无效")
    if frame["Date"].iloc[-1].strftime("%Y-%m-%d") != expected:
        raise ValueError("最新日线过期；最近应完成的交易日为 " + expected)
    return frame


def snapshot_text(symbol, as_of, frame, lookback=30):
    latest = frame.iloc[-1]
    lines = [f"## Verified market data snapshot: {symbol}",
             f"Requested analysis date: {as_of}; latest settled trading row: {latest['Date']:%Y-%m-%d}",
             f"Source: {frame.attrs.get('source', os.environ.get('TRADINGAGENTS_MARKET_VENDOR', 'yfinance'))}; bars: {len(frame)}",
             ("价格为拆股复权日线（未作分红复权）。" if frame.attrs.get("price_basis") == "split" else "价格为拆股/分红复权日线。")
             + "不是实时成交报价。缺失 OHLCV 不填补，指标样本不足输出 N/A。",
             "| Field | Value |", "|---|---:|"]
    for field in ("Open", "High", "Low", "Close", "Volume"):
        value = latest.get(field)
        lines.append(f"| {field} | {'N/A' if pd.isna(value) else format(value, '.6f')} |")
    if frame.attrs.get("fallback_reason"):
        lines.append(frame.attrs["fallback_reason"])
    lines.extend(["| Indicator | Value |", "|---|---:|"])
    for name, series in safe_indicators(frame):
        value = series.iloc[-1]
        shown = f"N/A (requires {MIN_BARS[name]} valid bars)" if pd.isna(value) else f"{value:.6f}"
        lines.append(f"| {name} | {shown} |")
    lines.append(frame.tail(max(1, min(int(lookback), 30)))[["Date", "Close"]].to_csv(index=False))
    return "\n".join(lines)


def indicator_text(symbol, indicator, as_of, lookback, frame):
    if indicator not in MIN_BARS:
        raise ValueError(f"Unsupported indicator: {indicator}")
    values = dict(safe_indicators(frame))[indicator]
    start = pd.Timestamp(as_of) - pd.Timedelta(days=max(0, min(int(lookback), 365)))
    lines = [f"## {symbol} {indicator}, required valid bars: {MIN_BARS[indicator]}"]
    for i, row in frame.iterrows():
        if row["Date"] >= start:
            value = values.iloc[i]
            lines.append(f"{row['Date']:%Y-%m-%d}: " + ("N/A: insufficient valid history" if pd.isna(value) else f"{value:.6f}"))
    return "\n".join(lines)
