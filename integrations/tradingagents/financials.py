"""Financial calculations from filed facts, preserving units and periods."""
from datetime import date
from decimal import Decimal
import json
import re
from pathlib import Path
from tradingagents.dataflows.vendors import sec_edgar as sec


def display(value):
    return format(Decimal(str(value)).quantize(Decimal("0.000001")), "f").rstrip("0").rstrip(".") or "0"


def duration(row):
    return (date.fromisoformat(row["end"]) - date.fromisoformat(row["start"])).days if row.get("start") else 0


def span(row):
    days = duration(row)
    if not days:
        return "instant"
    for label, low, high in [("quarter", 60, 115), ("6m", 150, 200), ("9m", 240, 290), ("annual", 300, 400)]:
        if low <= days <= high:
            return label
    return "other"


class FinancialBook:
    def __init__(self, ticker, as_of, facts, allowed_filings=None):
        self.ticker, self.as_of = ticker, as_of
        self.allowed_filings = allowed_filings
        self.gaap = facts.get("facts", {}).get("us-gaap", {})
        self.specs = {kind: list(rows) for kind, rows in sec._STATEMENTS.items()}
        self.specs["income_statement"] += [
            ("Consolidated Profit (includes noncontrolling interests)", ("ProfitLoss",)),
            ("Noncontrolling Interests Profit", ("NetIncomeLossAttributableToNoncontrollingInterest",)),
        ]
        self.rows = {kind: {label: self.select(tags) for label, tags in rows} for kind, rows in self.specs.items()}

    def select(self, tags):
        selected = {}
        for tag in tags:
            for unit, values in self.gaap.get(tag, {}).get("units", {}).items():
                latest = {}
                for row in values:
                    if self.allowed_filings is not None and row.get("accn") not in self.allowed_filings:
                        continue
                    if row["filed"] > self.as_of or row["end"] > self.as_of or span(row) == "other":
                        continue
                    value = row.get("val")
                    if not isinstance(value, (int, float)) or not Decimal(str(value)).is_finite():
                        continue
                    key = (row.get("start"), row["end"], unit)
                    if key not in latest or (row["filed"], row.get("accn", "")) >= (latest[key]["filed"], latest[key].get("accn", "")):
                        latest[key] = {**row, "unit": unit, "tag": tag, "span": span(row)}
                for key, row in latest.items():
                    selected.setdefault(key, row)
        return sorted(selected.values(), key=lambda r: (r["end"], duration(r), r["unit"]))

    def statement(self, kind, freq="quarterly"):
        lines = [f"## {kind}: {self.ticker}，披露截止 {self.as_of}",
                 "金额为原币原始单位（不是百万）；每股数据单列单位。空缺为未知。",
                 "EPS 来自各期申报；不同申报的拆股/重述口径可能不同，不得自行相加或跨期比较。",
                 "| 项目 | 起始 | 截止 | 期间 | 原始值 | 单位 | 披露日 | 标签 / 申报 |",
                 "|---|---|---|---|---:|---|---|---|"]
        for label, rows in self.rows[kind].items():
            eligible = [r for r in rows if (r["span"] == "annual" if freq == "annual" else r["span"] != "annual")]
            for row in eligible[-12:]:
                lines.append(f"| {label} | {row.get('start', '—')} | {row['end']} | {row['span']} | {display(row['val'])} | {row['unit']} | {row['filed']} | {row['tag']} / {row.get('accn', 'unknown')} |")
            if not eligible:
                lines.append(f"| {label} | — | — | — | 未知 | — | — | 未找到相应披露 |")
        return "\n".join(lines)

    def metrics(self):
        result = []
        income = self.rows["income_statement"]
        latest_end = max((r["end"] for r in income["Revenue"]), default="")
        for label, rows in income.items():
            for current in [r for r in rows if r["end"] == latest_end]:
                result.append(self.metric(label, current, current["val"], current["unit"], [current]))
                # For EPS, compare values from the SAME filing, not independent
                # "latest" vintages. This retains the issuer's split/share basis.
                candidates = self.gaap.get(current["tag"], {}).get("units", {}).get(current["unit"], [])
                prior = [r for r in candidates if r.get("accn") == current.get("accn")
                         and r["filed"] <= self.as_of and span(r) == current["span"]
                         and 330 <= (date.fromisoformat(current["end"]) - date.fromisoformat(r["end"])).days <= 400]
                if prior:
                    previous = max(prior, key=lambda r: r["end"])
                    if previous["val"] > 0:
                        growth = (Decimal(str(current["val"])) / Decimal(str(previous["val"])) - 1) * 100
                        result.append(self.metric(label + " YoY", current, growth, "%", [current, previous]))
        for numerator, denominator, label in [
            ("Gross Profit", "Revenue", "Gross Margin"), ("Operating Income", "Revenue", "Operating Margin"),
            ("Net Income", "Revenue", "Parent Net Margin"),
        ]:
            for row in income[numerator]:
                if row["end"] != latest_end:
                    continue
                other = self.match(income[denominator], row)
                if other and other["val"] > 0:
                    value = Decimal(str(row["val"])) / Decimal(str(other["val"])) * 100
                    result.append(self.metric(label, row, value, "%", [row, other]))
        cash = self.rows["cashflow"]
        cash_end = max((r["end"] for r in cash["Operating Cash Flow"]), default="")
        for row in cash["Operating Cash Flow"]:
            capex = self.match(cash["Capital Expenditure"], row)
            if row["end"] == cash_end and capex:
                value = Decimal(str(row["val"])) - Decimal(str(capex["val"]))
                result.append(self.metric("Free Cash Flow (OCF - capex)", row, value, row["unit"], [row, capex]))
        return result

    @staticmethod
    def match(rows, reference):
        return next((r for r in rows if (r.get("start"), r["end"], r["unit"]) ==
                     (reference.get("start"), reference["end"], reference["unit"])
                     and r.get("accn") == reference.get("accn")), None)

    @staticmethod
    def metric(label, row, value, unit, inputs):
        return {"name": label, "start": row.get("start"), "end": row["end"], "span": row["span"],
                "value": display(value), "unit": unit, "inputs": inputs}

    @property
    def available(self):
        # Some issuers tag the bottom line only as ProfitLoss. It stays a separate
        # row and is never relabelled as parent net income; it only proves the
        # statement for the period was filed.
        period = self.latest_period
        income = self.rows["income_statement"]
        profit = income["Net Income"] + income["Consolidated Profit (includes noncontrolling interests)"]
        return bool(period) and all(any(r["end"] == period for r in rows) for rows in (
            income["Revenue"], profit, self.rows["cashflow"]["Operating Cash Flow"]))

    @property
    def latest_period(self):
        return max((r["end"] for r in self.rows["income_statement"]["Revenue"]), default="")

    def report(self, statements=True):
        lines = ["## 已核验财务指标",
                 "下表直接读取披露值或由程序计算。EPS 累计值直接取累计披露，不加总季度 EPS；",
                 "同比只使用同一申报中的同单位、同期间比较值。没有可比披露时不计算。",
                 "Net Income 为归母口径，Consolidated Profit 包含非控股权益，不可互相替代。",
                 "| 指标 | 期间 | 截止 | 数值 | 单位 |", "|---|---|---|---:|---|"]
        for item in self.metrics():
            lines.append(f"| {item['name']} | {item['span']} | {item['end']} | {item['value']} | {item['unit']} |")
        if not statements:
            return "\n".join(lines)
        return "\n".join(lines) + "\n\n" + "\n\n".join(self.statement(kind) for kind in self.rows)

    def save(self, directory):
        payload = {"ticker": self.ticker, "asOf": self.as_of, "statements": self.rows, "metrics": self.metrics()}
        Path(directory, "financial-facts.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    def check_report(self, text):
        """Reject unsupported cumulative EPS claims in downstream model prose."""
        rows = self.rows["income_statement"]["Diluted EPS"]
        known = [float(r["val"]) for r in rows if r["span"] in ("6m", "9m", "annual")]
        changes = [float(m["value"]) for m in self.metrics()
                   if m["name"] == "Diluted EPS YoY" and m["span"] in ("6m", "9m", "annual")]
        errors = []
        for line in text.splitlines():
            clean = line.replace("*", "").replace(",", "")
            match = re.search(r"(?:EPS|每股收益).{0,30}?(?:合计|累计|YTD).{0,15}?([-+]?\d+(?:\.\d+)?)\s*(%|美元|USD)?", clean, re.I)
            if match:
                value = float(match[1])
                candidates = changes if match[2] == "%" else known
                tolerance = 0.15 if match[2] == "%" else 0.015
                if not any(abs(value - expected) <= tolerance for expected in candidates):
                    errors.append("累计 EPS 声明与已披露数值不一致")
        return errors


def load_book(ticker, as_of):
    cik = sec.cik_for(ticker)
    if cik is None:
        raise ValueError("SEC EDGAR 未覆盖该标的")
    facts = sec._cached_json(sec._FACTS_URL.format(cik=cik), f"CIK{cik}.json")
    book = FinancialBook(ticker, as_of, facts)
    if not book.available:
        raise ValueError("未找到截止研究日的可用 SEC 财报")
    return book
