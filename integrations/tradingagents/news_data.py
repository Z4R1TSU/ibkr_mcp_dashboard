"""Dated company news, with a ticker-matched fallback within Yahoo Finance."""
from datetime import datetime, timezone
import yfinance as yf
from tradingagents.dataflows import date_window
from tradingagents.dataflows.config import get_config
from tradingagents.dataflows.symbols import normalize_symbol
from tradingagents.dataflows.vendors.yahoo import common
from tradingagents.dataflows.vendors.yahoo.news import _extract_article_data


def relevant_articles(items, canonical, start, end, require_match=False):
    accepted, seen = [], set()
    for item in items or []:
        if not isinstance(item, dict):
            continue
        if require_match:
            related = item.get("relatedTickers")
            if not isinstance(related, list) or canonical not in [str(t).upper() for t in related]:
                continue
        try:
            data = _extract_article_data(item)
        except (TypeError, AttributeError, ValueError):
            continue
        if not data["pub_date"] or not date_window.in_window(data["pub_date"], start, end):
            continue
        if data["title"] in ("", "No title"):
            continue
        key = data["link"] or data["title"]
        if key in seen:
            continue
        seen.add(key)
        accepted.append(data)
    return accepted


def company_articles(ticker, start_date, end_date):
    canonical = normalize_symbol(ticker)
    start, end = datetime.fromisoformat(start_date), datetime.fromisoformat(end_date)
    limit = max(1, min(int(get_config().get("news_article_limit", 20)), 50))
    source = "Yahoo Finance ticker feed"
    try:
        items = common.yf_retry(lambda: yf.Ticker(canonical).get_news(count=limit))
        articles = relevant_articles(items, canonical, start, end, require_match=True)
    except Exception:
        articles = []
    if not articles:
        # yfinance treats a 404 JSON from the old ticker feed as an empty list.
        # Search is a separate public Yahoo endpoint, not a new data vendor.
        source = "Yahoo Finance Search (fallback: ticker feed unavailable or no usable articles)"
        items = common.yf_retry(lambda: yf.Search(canonical, news_count=limit,
                                                  enable_fuzzy_query=False, timeout=15).news)
        articles = relevant_articles(items, canonical, start, end, require_match=True)
    if not articles:
        return []
    articles.sort(key=lambda a: a["pub_date"].replace(tzinfo=timezone.utc) if a["pub_date"].tzinfo is None else a["pub_date"], reverse=True)
    return [{**a, "provider_source": source} for a in articles[:limit]]


def get_company_news(ticker, start_date, end_date):
    canonical = normalize_symbol(ticker)
    articles = company_articles(ticker, start_date, end_date)
    if not articles:
        return f"DATA_UNAVAILABLE: Yahoo returned no dated, ticker-matched news for {canonical} within {start_date}..{end_date}; this does not establish an absence of news."
    lines = [f"## {canonical} News, {start_date}..{end_date}", f"Source: {articles[0]['provider_source']}",
             f"Articles retained: {len(articles)}. Recent sample only; not an exhaustive archive.",
             "发布日期经过研究窗口过滤；关联多只股票的文章不代表仅讨论本标的。"]
    for article in articles:
        lines.extend([f"### {article['title']} (source: {article['publisher']})",
                      f"Published: {article['pub_date'].isoformat()}"])
        if article["summary"]:
            lines.append(article["summary"])
        if article["link"]:
            lines.append("Link: " + article["link"])
        lines.append("")
    return "\n".join(lines)
