"""SEC issuer filings, earnings exhibits, and ownership XML with provenance."""
from datetime import datetime, timedelta, timezone
from pathlib import PurePosixPath
import re
import threading
from urllib.parse import urlparse
from zoneinfo import ZoneInfo
from bs4 import BeautifulSoup
from evidence import SourceResult, record, citation, instant
from public_data import SourceUnavailable
from financials import FinancialBook

NY = ZoneInfo("America/New_York")
PERIODIC = ("10-Q", "10-K", "10-Q/A", "10-K/A")
FOREIGN = ("20-F", "20-F/A", "40-F", "40-F/A", "6-K", "6-K/A")


class UnsupportedIssuer(SourceUnavailable):
    pass


def filings_at(body, cutoff):
    recent = body.get("filings", {}).get("recent", {})
    rows = []
    for i, form in enumerate(recent.get("form", [])):
        row = {k: values[i] for k, values in recent.items() if isinstance(values, list) and i < len(values)}
        accepted = instant(row.get("acceptanceDateTime"))
        if not accepted:
            filed = str(row.get("filingDate", ""))
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", filed) or filed >= cutoff.astimezone(NY).date().isoformat():
                continue
            accepted = datetime.fromisoformat(filed + "T23:59:59").replace(tzinfo=NY)
        if accepted <= cutoff:
            row["publishedAt"] = accepted.astimezone(timezone.utc).isoformat()
            rows.append(row)
    return sorted(rows, key=lambda r: r["publishedAt"], reverse=True)


def filing_url(cik, filing, document=None):
    accession = str(filing["accessionNumber"]).replace("-", "")
    name = document or filing["primaryDocument"]
    if not accession.isdigit() or not str(cik).isdigit() or not isinstance(name, str):
        raise SourceUnavailable("SEC 申报标识无效")
    if name.startswith("xslF") and "/" in name:
        name = name.split("/")[-1]
    if urlparse(name).scheme or name.startswith("/") or ".." in PurePosixPath(name).parts:
        raise SourceUnavailable("SEC 附件路径无效")
    return f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession}/{name}"


def document_text(body):
    soup = BeautifulSoup(body, "html.parser")
    for node in soup.find_all(["script", "style", "ix:header"]):
        node.decompose()
    return soup, soup.get_text(" ", strip=True)


def parse_release(body, primary_body="", filed=None):
    soup, text = document_text(body)
    paragraphs = []
    for node in soup.find_all(["p", "div"]):
        if node.find(["p", "div", "table"]):
            continue
        value = node.get_text(" ", strip=True)
        if len(value) > 40 and not re.search(r"forward-looking|safe harbor", value, re.I):
            if value not in paragraphs:
                paragraphs.append(value)
    tables = []
    for index, table in enumerate(soup.find_all("table")):
        if table.find("table"):
            continue
        rows = [[cell.get_text(" ", strip=True) for cell in tr.find_all(["th", "td"], recursive=False)]
                for tr in table.find_all("tr")]
        if any(re.search(r"revenues?|net income|earnings per|cash flows|balance sheets", " ".join(row), re.I) for row in rows):
            previous = [str(s).strip() for s in table.find_all_previous(string=True, limit=120) if str(s).strip()]
            context = " ".join(reversed(previous[:30]))[-2400:]
            header = context + " " + " | ".join(" ".join(row) for row in rows[:4])
            units = list(re.finditer(r"(?:in|USD)\s+(?:millions|billions|thousands)(?:[^)]{0,80})?", header, re.I))
            tables.append({"locator": "table:" + str(index), "rows": rows,
                           "contextBefore": context, "unitContext": units[-1].group().strip() if units else None})
    # Preserve original columns/units; do not guess which repeated year is Q/YTD.
    blocks = ["\n".join(paragraphs)[:10000] or text[:10000]]
    for table in tables[:5]:
        rows = ["行" + str(i + 1) + " | " + " | ".join(row) for i, row in enumerate(table["rows"]) if any(row)]
        blocks.append("原文表格 " + table["locator"] + "（列序保留，空白不补零）\n"
                      + "表前原文：" + table["contextBefore"] + "\n单位上下文："
                      + (table["unitContext"] or "未确定，不进行单位换算") + "\n" + "\n".join(rows)[:6000])
    from reporting_period import resolve_period
    _, primary_text = document_text(primary_body)
    period, evidence = resolve_period(soup, text, primary_text, filed)
    return {"text": "\n\n".join(blocks), "period": period, "tables": tables[:5], "periodEvidence": evidence}


class SecSources:
    def __init__(self, ticker, cutoff, client):
        self.ticker, self.cutoff, self.client = ticker, cutoff, client
        self.lock = threading.RLock()
        self.rows, self.release, self.latest_period = None, None, None
        self.records, self.book = [], None

    def index(self):
        with self.lock:
            if self.rows is not None:
                return self.rows
            tickers, _ = self.client.json("https://www.sec.gov/files/company_tickers.json", ttl=86400)
            matches = {int(row["cik_str"]) for row in tickers.values() if row.get("ticker") == self.ticker}
            if len(matches) != 1:
                raise SourceUnavailable("SEC 发行人未匹配或不唯一")
            self.cik = matches.pop()
            url = f"https://data.sec.gov/submissions/CIK{self.cik:010d}.json"
            body, receipt = self.client.json(url, ttl=0)
            if int(body.get("cik", 0)) != self.cik:
                raise SourceUnavailable("SEC 申报索引发行人不匹配")
            self.rows = filings_at(body, self.cutoff)
            if not self.rows:
                raise SourceUnavailable("SEC 未返回研究截止前的申报")
            self.records.append(record("SEC submissions", url, receipt["fetchedAt"],
                                       revision=self.rows[0]["accessionNumber"]))
            return self.rows

    def check_issuer(self):
        # Foreign private issuers report quarters in 6-K exhibits and only file
        # annual XBRL; the 10-Q/10-K pipeline cannot verify a current period.
        forms = {r["form"] for r in self.index()}
        if not forms & set(PERIODIC) and forms & set(FOREIGN):
            raise UnsupportedIssuer("外国私人发行人（向 SEC 提交 20-F/6-K，而非 10-K/10-Q），"
                                    "本系统暂不支持核验其财报；未启动研究，未调用模型。")

    def disclosures(self):
        with self.lock:
            rows = self.index()
            candidates = [r for r in rows if r["form"] in PERIODIC
                          and re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(r.get("reportDate", "")))]
            periodic = max(candidates, key=lambda r: (r["reportDate"], r["publishedAt"]), default=None)
            if not periodic:
                raise SourceUnavailable("未找到 SEC 正式定期报告")
            if getattr(self, "_disclosures", None):
                return self._disclosures
            self.periodic = periodic
            self.latest_period = periodic.get("reportDate")
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", self.latest_period or ""):
                raise SourceUnavailable("正式财报期间未知")
            release = next((r for r in rows if r["form"] in ("8-K", "8-K/A") and "2.02" in str(r.get("items", ""))
                            and instant(r["publishedAt"]) >= self.cutoff - timedelta(days=120)), None)
            lines = [f"## 最新披露检查：{self.ticker}",
                     f"正式定期报告：{periodic['form']}，期间截至 {self.latest_period}，披露 {periodic['publishedAt']}。"]
            if release:
                row = self.earnings(release)
                self.records.append(row)
                if row["period"] >= self.latest_period:
                    self.release = row
                    self.latest_period = row["period"]
                    lines += [f"最新业绩公告期间：{self.latest_period}。公告与正式定期报告分别列示。",
                              citation(row), row["text"]]
            else:
                lines.append("研究截止前未发现晚于该定期报告的 Item 2.02 业绩申报。")
            if (self.cutoff.date() - datetime.fromisoformat(self.latest_period).date()).days > 200:
                raise SourceUnavailable("最新财务披露期间过旧，不能用于当前评级")
            self._disclosures = SourceResult("\n\n".join(lines), list(self.records))
            return self._disclosures

    def provenance(self):
        """The disclosure check without the release body (for message delivery)."""
        self.disclosures()
        lines = [f"## 最新披露检查：{self.ticker}",
                 f"正式定期报告：{self.periodic['form']}，期间截至 {self.periodic['reportDate']}，"
                 f"披露 {self.periodic['publishedAt']}。"]
        if self.release:
            lines += [f"最新业绩公告期间：{self.release['period']}。公告原文摘录保存在完整报告中。",
                      citation(self.release)]
        return "\n\n".join(lines)

    def gap_note(self):
        if not self.book or self.book.latest_period >= self.latest_period:
            return ""
        return (f"最新业绩公告截至 {self.latest_period}；以下正式财务表截至 {self.book.latest_period}，"
                "不得称为最新季度数据。公告表格与正式报告分别引用；TTM 口径未衔接时不计算估值。\n\n")

    def earnings(self, filing):
        primary = self.client.get(filing_url(self.cik, filing), ttl=2592000)
        soup, _ = document_text(primary["body"])
        # The exhibit index labels the release by exhibit number; the link text
        # varies by issuer ("Press release", "News release", a bare title).
        links = [a.get("href") for a in soup.find_all("a", href=True)
                 if re.search(r"99[._-]?1|(?:press|news|earnings) release",
                              str(a.get("href")) + " " + a.get_text() + " "
                              + (a.find_parent("tr").get_text(" ") if a.find_parent("tr") else ""), re.I)]
        if not links:
            raise SourceUnavailable("已有新业绩申报，但未能定位业绩公告附件")
        url = filing_url(self.cik, filing, links[0])
        fetched = self.client.get(url, ttl=2592000)
        filed = instant(filing["publishedAt"]).astimezone(NY).date().isoformat()
        parsed = parse_release(fetched["body"], primary["body"], filed)
        excerpt, period, tables = parsed["text"], parsed["period"], parsed["tables"]
        if not period:
            raise SourceUnavailable("已取得业绩公告正文，但未能从 8-K 正文或财务表头确定报告期")
        if period > self.cutoff.astimezone(NY).date().isoformat():
            raise SourceUnavailable("业绩公告报告期晚于研究截止日期")
        if len(excerpt) < 300:
            raise SourceUnavailable("业绩公告正文不完整")
        return record("SEC 业绩公告", url, fetched["fetchedAt"], filing["publishedAt"],
                      period=period, revision=filing["accessionNumber"], content_level="full_text",
                      form=filing["form"], tables=tables, title=f"{self.ticker} 业绩公告",
                      text=excerpt, periodEvidence=parsed["periodEvidence"],
                      accountingBasis="保留原文 GAAP/非 GAAP 标记，不补算")

    def financials(self):
        with self.lock:
            disclosure = self.disclosures()
            if self.book is None:
                url = f"https://data.sec.gov/api/xbrl/companyfacts/CIK{self.cik:010d}.json"
                facts, receipt = self.client.json(url, ttl=900, revision=self.periodic["accessionNumber"])
                if int(facts.get("cik", 0)) != self.cik:
                    raise SourceUnavailable("SEC 财务数据发行人不匹配")
                allowed = {r["accessionNumber"] for r in self.rows}
                self.book = FinancialBook(self.ticker, self.cutoff.astimezone(NY).date().isoformat(), facts,
                                          allowed_filings=allowed)
                if not self.book.available:
                    raise SourceUnavailable("SEC 未返回完整的核心财务报表")
                period = self.book.latest_period
                if period < self.periodic["reportDate"]:
                    raise SourceUnavailable("SEC 结构化财务数据尚未覆盖最新正式报告")
                self.records.append(record("SEC Company Facts", url, receipt["fetchedAt"],
                    self.periodic["publishedAt"], period=period, revision=self.periodic["accessionNumber"],
                    unit="每项保留原始披露单位"))
            return SourceResult(disclosure.text + "\n\n" + self.gap_note() + self.book.report(), list(self.records))

    def context(self):
        if not self.latest_period:
            return "最新财务披露尚未核验，不得用旧财报推定当前经营状况。"
        formal = self.book.latest_period if self.book else "尚未核验"
        return (f"最新披露期间：{self.latest_period}；结构化正式财报期间：{formal}。"
                "新业绩公告与旧财报必须分别引用。原文表格中的季度/累计和GAAP/非GAAP不能混算；"
                "无法确定列标题、单位或证券类别时保留未知。新闻标题不能支持未取得的正文细节。")

    def insiders(self):
        from ownership import parse_form4, ownership_report
        low = self.cutoff - timedelta(days=30)
        filings = [r for r in self.index() if r["form"] in ("4", "4/A") and instant(r["publishedAt"]) >= low]
        records, complete = [], len(filings) <= 10
        for filing in filings[:10]:
            try:
                response = self.client.get(filing_url(self.cik, filing), ttl=2592000)
                records.extend(parse_form4(response["body"], self.cik, filing, response))
            except (SourceUnavailable, ValueError):
                complete = False
        # A truncated submissions index cannot establish absence in this window.
        complete = complete and instant(self.rows[-1]["publishedAt"]) <= low
        return ownership_report(records, complete)
