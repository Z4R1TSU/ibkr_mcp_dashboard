"""Public endpoint diagnostics. No model, broker, or messaging calls."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
import requests

TARGETS = {
    "yahoo": "https://query2.finance.yahoo.com/v8/finance/chart/AAPL?range=5d&interval=1d",
    "polymarket": "https://gamma-api.polymarket.com/markets?limit=1&active=true&closed=false",
    "sec": "https://www.sec.gov/files/company_tickers.json",
}


def failure_reason(status, body):
    lower = body.lower()
    if "no longer be accessible from mainland china" in lower:
        return "Yahoo 地区限制：当前出口被识别为中国大陆；重试不会解决"
    if "cloudflare" in lower and ("blocked" in lower or "challenge" in lower):
        return "Cloudflare 风控拦截；不能把 HTTP 403 当作没有数据"
    if status == 429:
        return "供应商限流（HTTP 429）"
    if status == 403:
        return "供应商拒绝访问（HTTP 403）"
    return "" if 200 <= status < 300 else f"HTTP {status}"


def probe(item):
    source, url = item
    try:
        with requests.get(url, timeout=(8, 8), stream=True,
                          headers={"User-Agent": os.getenv("SEC_EDGAR_USER_AGENT") or "TradingAgents/0.5.2 (contact@example.com)"}) as response:
            body = next(response.iter_content(16000), b"").decode("utf-8", errors="replace")
            reason = failure_reason(response.status_code, body)
            return {"source": source, "status": response.status_code, "available": response.ok and not reason, "reason": reason}
    except requests.RequestException as error:
        return {"source": source, "available": False, "reason": type(error).__name__}


if __name__ == "__main__":
    print(json.dumps({"proxyConfigured": bool(os.getenv("HTTPS_PROXY")),
                      "fredConfigured": bool(os.getenv("FRED_API_KEY")),
                      "alphaVantageConfigured": bool(os.getenv("ALPHA_VANTAGE_API_KEY"))}), flush=True)
    with ThreadPoolExecutor(max_workers=5) as pool:
        results = list(pool.map(probe, TARGETS.items()))
    for result in results:
        print(json.dumps(result, ensure_ascii=False), flush=True)
    raise SystemExit(0 if all(row["available"] for row in results) else 1)
