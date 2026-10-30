"""Qualified news evidence; discovery headlines never become article facts."""
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import os
import re
from zoneinfo import ZoneInfo
from bs4 import BeautifulSoup
from evidence import SourceResult, citation, record, instant
from public_data import SourceUnavailable


def deduplicate(rows):
    found, output = set(), []
    for row in rows:
        title = re.sub(r"\W+", "", row.get("title", "").lower())
        url = row.get("url", "").split("?")[0]
        if url in found or title and title in found:
            continue
        found.update([url, title])
        output.append(row)
    return output


def render_news(rows, failures=()):
    rows = deduplicate(rows)
    usable = [r for r in rows if r["contentLevel"] in ("full_text", "summary") and r.get("text")]
    if not usable:
        return SourceResult("DATA_UNAVAILABLE: 未取得有日期且具备正文或摘要的新闻。标题仅为线索，不推定没有新闻。",
                            rows, "unavailable", "；".join(failures) or "只有标题或没有可核验报道")
    lines = ["## 可核验报道与公告", "这是已取得的样本，不代表全部新闻。公告、报道及摘要分别标注；标题线索未作为事实输入。"]
    for row in usable[:20]:
        label = "原文摘录" if row["contentLevel"] == "full_text" else "供应商摘要（非全文）"
        lines += [f"### {row.get('title', '')}", citation(row), label + "\n" + row["text"][:10000]]
    if failures:
        lines.append("补充来源缺口：" + "；".join(failures))
    return SourceResult("\n\n".join(lines), rows, reason="；".join(failures))


class NewsSources:
    def __init__(self, ticker, cutoff, client, sec):
        self.ticker, self.cutoff, self.client, self.sec = ticker, cutoff, client, sec

    def alpha(self, low, *, topic=None):
        key = os.environ.get("ALPHA_VANTAGE_API_KEY")
        if not key:
            raise SourceUnavailable("未配置 ALPHA_VANTAGE_API_KEY")
        params = {"function": "NEWS_SENTIMENT", "apikey": key, "sort": "LATEST", "limit": 50,
                  "time_from": low.strftime("%Y%m%dT%H%M"), "time_to": self.cutoff.strftime("%Y%m%dT%H%M")}
        params["topics" if topic else "tickers"] = topic or self.ticker
        body, receipt = self.client.json("https://www.alphavantage.co/query", params=params, ttl=900, alpha=True)
        rows = []
        for item in body.get("feed", []):
            try:
                published = datetime.strptime(item["time_published"], "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
            except (KeyError, ValueError):
                continue
            if not low <= published <= self.cutoff:
                continue
            if not topic and not any(r.get("ticker") == self.ticker for r in item.get("ticker_sentiment", [])):
                continue
            if topic and not any(r.get("topic") in ("Economy - Macro", "Economy - Monetary Policy")
                                 for r in item.get("topics", [])):
                continue
            summary, url = str(item.get("summary") or "").strip(), str(item.get("url") or "")
            if not url.startswith("https://"):
                continue
            rows.append(record("Alpha Vantage / " + str(item.get("source", "未知媒体")), url,
                receipt["fetchedAt"], published.isoformat(), content_level="summary" if summary else "headline",
                quality="verified" if summary else "partial", title=item.get("title", ""), text=summary,
                scope=topic or self.ticker))
        return rows

    def company(self, start):
        low = datetime.fromisoformat(start).replace(tzinfo=ZoneInfo("America/New_York")).astimezone(timezone.utc)
        rows, failures = [], []
        try:
            self.sec.disclosures()
            if self.sec.release and low <= instant(self.sec.release["publishedAt"]) <= self.cutoff:
                rows.append(self.sec.release)
        except (SourceUnavailable, ValueError) as error:
            failures.append(str(error))
        # Alpha Vantage is optional; without a key it is skipped, not a gap.
        if os.environ.get("ALPHA_VANTAGE_API_KEY"):
            try:
                rows.extend(self.alpha(low))
            except (SourceUnavailable, ValueError) as error:
                failures.append(str(error))
        # Yahoo remains a discovery/summary fallback, never a source of invented body text.
        if not any(r.get("contentLevel") == "summary" for r in rows):
            try:
                from news_data import company_articles
                articles = company_articles(self.ticker, start, self.cutoff.astimezone(ZoneInfo("America/New_York")).date().isoformat())
                for a in articles:
                    published = a["pub_date"]
                    if published.tzinfo is None or not low <= published <= self.cutoff:
                        continue
                    summary = a.get("summary") or ""
                    rows.append(record("Yahoo / " + a["publisher"], a["link"],
                        datetime.now(timezone.utc).isoformat(), published.isoformat(),
                        content_level="summary" if summary else "headline",
                        quality="verified" if summary else "partial", title=a["title"], text=summary))
            except Exception:
                failures.append("Yahoo 补充新闻读取失败")
        return render_news(rows, failures)

    def global_news(self, days=7, limit=12):
        low = self.cutoff - timedelta(days=max(1, min(int(days), 30)))
        rows, failures = [], []
        try:
            url = "https://www.federalreserve.gov/feeds/press_monetary.xml"
            response = self.client.get(url, ttl=300)
            feed = BeautifulSoup(response["body"], "xml")
            for item in feed.find_all("item"):
                try:
                    published = parsedate_to_datetime(item.pubDate.get_text())
                    link = item.link.get_text().strip()
                except (ValueError, AttributeError):
                    continue
                if not low <= published <= self.cutoff or not link.startswith("https://www.federalreserve.gov/newsevents/pressreleases/"):
                    continue
                page = self.client.get(link, ttl=2592000)
                soup = BeautifulSoup(page["body"], "html.parser")
                article = soup.select_one("#article") or soup.find("main")
                if not article:
                    failures.append("美联储公告正文未能识别")
                    continue
                for node in article.find_all(["script", "style"]):
                    node.decompose()
                text = article.get_text(" ", strip=True)
                if len(text) < 100:
                    continue
                rows.append(record("美联储政策公告", link, page["fetchedAt"], published.isoformat(),
                    content_level="full_text", title=item.title.get_text(), text=text[:12000], scope="美国货币政策"))
                if len(rows) >= min(3, max(1, int(limit))):
                    break
        except (SourceUnavailable, ValueError) as error:
            failures.append(str(error))
        if os.environ.get("ALPHA_VANTAGE_API_KEY"):
            try:
                rows.extend(self.alpha(low, topic="economy_macro"))
            except (SourceUnavailable, ValueError) as error:
                failures.append(str(error))
        result = render_news(rows, failures)
        result.text = "覆盖范围：美国政策公告及已配置的宏观新闻来源，不代表全球事件全景。\n\n" + result.text
        return result
