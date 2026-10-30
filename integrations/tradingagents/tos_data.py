"""Local market data only; never receives Schwab credentials."""
import os
from urllib.parse import urlparse
import requests
import pandas as pd
from datetime import datetime, timezone


def fetch_tos_frame(symbol, as_of):
    base = os.environ.get("TOS_MARKET_URL", "http://127.0.0.1:8051")
    address = urlparse(base)
    if address.scheme != "http" or address.hostname not in ("127.0.0.1", "localhost") or address.path not in ("", "/"):
        raise ValueError("thinkorswim 行情地址必须为本机 HTTP 接口")
    key = os.environ.get("TOS_API_KEY")
    if not key:
        raise ValueError("本地行情读取密钥未配置")
    with requests.Session() as session:
        session.trust_env = False
        response = session.get(base.rstrip("/") + "/v1/history",
            params={"symbol": symbol, "asOf": as_of}, headers={"Authorization": "Bearer " + key},
            timeout=(3, 15), allow_redirects=False)
    if response.status_code != 200:
        raise ValueError("本地 thinkorswim 历史行情暂不可用")
    body = response.json()
    received = datetime.fromisoformat(body.get("receivedAt", ""))
    age = (datetime.now(timezone.utc) - received).total_seconds()
    if body.get("disconnected") or body.get("status") != "available" or not -5 <= age <= 1800:
        raise ValueError("嘉信历史行情过期或连接不可用")
    if body.get("symbol") != symbol or body.get("interval") != "1d" or not body.get("settledOnly"):
        raise ValueError("thinkorswim 日线口径不匹配")
    if body.get("adjustment") not in ("split", "split_dividend"):
        raise ValueError("thinkorswim 复权口径尚未核验，暂不用于技术研究")
    frame = pd.DataFrame(body["bars"]).rename(columns={"date": "Date", "open": "Open",
        "high": "High", "low": "Low", "close": "Close", "volume": "Volume"})
    frame.attrs["price_basis"] = body["adjustment"]
    return frame
