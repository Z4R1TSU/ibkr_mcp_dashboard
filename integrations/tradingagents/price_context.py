"""Typed price references: calculations and rendered numbers belong to code."""
from datetime import datetime, timezone
import math
import re

TOKEN = re.compile(r"\[\[price:([a-zA-Z0-9_.-]+)\]\]")


class PriceContext:
    def __init__(self, ticker, context=None):
        self.ticker, self.context = ticker, context or {}
        self.refs, self.facts = {}, {}
        self.quote = self.context.get("quote")
        self.valid = False

    @staticmethod
    def positive(value):
        return type(value) in (int, float) and math.isfinite(value) and value > 0

    def add(self, key, value, label, unit=""):
        names = {"mark": "标记价", "last": "最新成交", "bid": "买价", "ask": "卖价",
                 "regularClose": "常规时段收盘", "regularLast": "常规时段最近成交"}
        if key == "latest":
            kind = (self.quote or {}).get("reference", {}).get("kind")
            label = "研究启动参考价（" + {**names, "midpoint": "买卖价中点"}.get(kind, "未知类型") + "）"
        elif key in names:
            label = names[key]
        indicators = {"close_10_ema": "10日EMA", "close_50_sma": "50日SMA", "close_200_sma": "200日SMA",
                      "boll": "布林中轨", "boll_ub": "布林上轨", "boll_lb": "布林下轨", "vwma": "成交量加权均价"}
        if key in indicators:
            label = label[:10] + " " + indicators[key]
        self.facts[key] = {"value": value, "label": label, "unit": unit}
        self.refs[key] = f"{label} {value:.2f}{(' ' + unit) if unit else ''}"

    def validate(self, at=None):
        c, q = self.context, self.quote
        if c.get("version") != 1 or c.get("symbol") != self.ticker or not q:
            raise ValueError("最新报价不可用：" + "; ".join(
                str(r.get("source")) + " " + str(r.get("reason")) for r in c.get("failures", [])))
        if q.get("symbol") != self.ticker or q.get("currency") != "USD":
            raise ValueError("报价证券或币种不匹配")
        ref = q.get("reference", {})
        if ref.get("kind") not in ("mark", "last", "midpoint") or not self.positive(ref.get("value")):
            raise ValueError("最新参考价无效")
        received = datetime.fromisoformat(ref["receivedAt"])
        age = ((at or datetime.now(timezone.utc)) - received).total_seconds()
        if not -5 <= age <= 120:
            raise ValueError("研究启动报价已经过期")
        if ref["kind"] == "last" and q.get("lastIsClose"):
            raise ValueError("收盘字段不能作为最新成交价")
        self.add("latest", ref["value"], "研究启动参考价（" + ref["kind"] + "）", "USD")
        for name, row in q.get("fields", {}).items():
            if self.positive(row.get("value")):
                self.add(name, row["value"], "报价字段 " + name, "USD")
        self.valid = True
        return self.header()

    def restore_facts(self, saved):
        """Replay a private recorded snapshot; never label it as a new quote."""
        at = datetime.fromisoformat(self.quote["reference"]["receivedAt"])
        self.validate(at=at)
        if saved.get("latest", {}).get("value") != self.quote["reference"]["value"]:
            raise ValueError("保存的价格事实与原报价不一致")
        for key, row in saved.items():
            if "value" in row:
                if type(row["value"]) not in (int, float) or not math.isfinite(row["value"]):
                    raise ValueError("保存的价格事实无效")
                self.add(key, row["value"], row["label"], row.get("unit", ""))
        for key in saved:
            if key.startswith("relation.") and key[9:] in self.facts:
                self.relation(key[9:], self.facts[key[9:]]["value"])
        for left, right in (("close_50_sma", "close_200_sma"), ("close_10_ema", "close_50_sma"), ("macd", "macds")):
            if left in self.facts and right in self.facts:
                self.comparison(left, right)

    def history(self, frame, indicators):
        latest = frame.iloc[-1]
        self.date = latest["Date"].strftime("%Y-%m-%d")
        self.add("close", float(latest["Close"]), self.date + " 历史日线收盘", "USD")
        regular = (self.quote or {}).get("fields", {}).get("regularClose", {}).get("value")
        if regular is None and self.context.get("session") in ("pre", "overnight", "closed"):
            regular = (self.quote or {}).get("fields", {}).get("regularLast", {}).get("value")
        # LAST_RTH is a trade in the regular session, not an official close
        # while that session is running or still settling.
        if self.valid and self.context.get("session") in ("pre", "overnight", "closed") \
                and self.positive(regular) and frame.attrs.get("price_basis") == "split":
            if abs(regular / float(latest["Close"]) - 1) > 0.005:
                raise ValueError("同口径常规收盘与历史日线收盘不一致，需复核行情")
        for _, row in frame.tail(30).iterrows():
            day = row["Date"].strftime("%Y-%m-%d")
            self.add("close." + day, float(row["Close"]), day + " 历史日线收盘", "USD")
        for field in ("Open", "High", "Low", "Volume"):
            value = float(latest[field])
            if math.isfinite(value):
                self.add(field.lower(), value, self.date + " 日线 " + field)
        price_indicators = {"close_10_ema", "close_50_sma", "close_200_sma", "boll", "boll_ub", "boll_lb", "vwma"}
        for name, series in indicators:
            value = float(series.iloc[-1])
            if math.isfinite(value):
                self.add(name, value, self.date + " 日线指标 " + name)
                if name in price_indicators:
                    self.relation(name, value)
        if self.valid:
            self.relation("close", float(latest["Close"]))
            self.add("change_from_close", (self.quote["reference"]["value"] / float(latest["Close"]) - 1) * 100,
                     "研究启动参考价相对历史日线收盘变动", "%")
        for left, right in (("close_50_sma", "close_200_sma"), ("close_10_ema", "close_50_sma"), ("macd", "macds")):
            if left in self.facts and right in self.facts:
                self.comparison(left, right)

    def comparison(self, left, right):
        from price_validation import comparable
        if not comparable(left, right):
            raise ValueError("不同类型的指标不能直接比较")
        a, b = self.facts[left]["value"], self.facts[right]["value"]
        if not all(type(n) in (float, int) and math.isfinite(n) for n in (a, b)):
            raise ValueError("比较数值不可用")
        side = "低于" if a < b else "高于" if a > b else "等于"
        key = "compare." + left + "__" + right
        self.facts[key] = {"left": left, "right": right, "leftValue": a, "rightValue": b, "relation": side}
        self.refs[key] = self.refs[left] + "，" + side + self.refs[right]
        return key

    def fact_table(self):
        keys = ["latest", "close", "relation.close", "relation.close_10_ema",
                "relation.close_50_sma", "relation.close_200_sma", "relation.boll_lb",
                "relation.vwma", "compare.close_50_sma__close_200_sma", "compare.macd__macds"]
        rows = ["## 程序核验的价格与指标关系", "| 核验事实 |", "|---|"]
        rows += ["| [[price:" + key + "]] |" for key in keys if key in self.refs]
        return "\n".join(rows)

    def relation(self, key, level):
        if not self.valid:
            return
        price = self.quote["reference"]["value"]
        side = "低于" if price < level else "高于" if price > level else "等于"
        gap = (price / level - 1) * 100
        label = f"研究启动参考价{side}{self.refs[key]}，相差 {gap:+.2f}%"
        self.refs["relation." + key] = label
        self.facts["relation." + key] = {"price": price, "level": level, "changePct": gap, "relation": side}

    def header(self):
        if not self.valid:
            return "## 最新报价\n\n未取得有效最新报价；暂不评级。\n"
        q, c = self.quote, self.context
        session = {"regular": "常规时段", "pre": "盘前", "post": "盘后",
                   "overnight": "隔夜时段", "closed": "休市日"}.get(c.get("session"), "未知时段")
        ref = q["reference"]
        source = {"thinkorswim": "嘉信", "ibkr": "IB"}.get(q["source"], q["source"])
        status = {"REALTIME": "实时（供应商标记）", "DELAYED": "延迟", "UNKNOWN": "延迟状态未知"}.get(q["status"], "未知")
        lines = ["## 本次研究价格依据", self.refs.get("latest", "最新报价未核验"),
                 f"来源：{source}｜状态：{status}｜请求时段：{session}",
                 f"字段接收时间：{ref['receivedAt']}｜成交来源时间：{ref.get('sourceTime') or '未知（接收时间不代表成交时间）'}",
                 "价格固定于研究启动时；报告生成期间不代表持续更新的报价。"]
        lines.extend(self.refs[k] for k in ("last", "bid", "ask", "close", "change_from_close") if k in self.refs)
        if "close" in self.refs:
            lines.append("日线指标截至上述历史交易日；价格跨时段变动本身不代表数据错误。")
        lines.extend(r["source"] + "：" + r["reason"] for r in c.get("failures", []))
        return "\n\n".join(lines) + "\n"

    def prompt(self):
        rows = "\n".join("[[price:" + k + "]] = " + v for k, v in list(self.refs.items()))
        return (
            "\n本次唯一价格依据（优先于历史工具、新闻及持仓估值）：\n" + self.header()
            + "\n价格输出协议：凡提到本股票具体股价、OHLCV、技术指标数值、价格变动百分比，"
            "必须原样使用下列 [[price:...]] 引用，禁止直接抄写或自算数字；系统会替换为已核验文字。"
            "引用包含完整名称和单位，直接作为句子使用。价格与指标的上下位置和百分比只使用 relation 引用，"
            "不要自行重述方向；不可生成目录没有的目标价、止损价或新技术价位。"
            "日期、均线周期、财务披露值和账户份额不受此格式限制。"
            "新闻和公司概览中的旧价格、旧估值不能作为当前价格证据。"
            "技术报告和最终结论必须包含 [[price:latest]]；历史收盘只能标为历史收盘。"
            "没有当前价格时不评级。最新价已经跌破的历史支撑不能再视作下方支撑。\n"
            + rows + "\n"
        )

    def inspect(self, text, require_latest=False):
        from price_validation import inspect_report
        return inspect_report(self, text, require_latest)

    def check(self, text, require_latest=False):
        return [issue["message"] for issue in self.inspect(text, require_latest)["issues"]
                if issue["severity"] == "error"]

    def render(self, text):
        # Models often lead into a reference with its own name ("研究启动参考价为
        # [[price:latest]]"); the reference already carries that name.
        lead = re.compile(r"研究启动参考价\s*(?:为|是|：|:)?\s*(?:\*\*)?$")
        def replace(match):
            value = self.refs[match.group(1)]
            if value.startswith("研究启动参考价") and lead.search(text[max(0, match.start() - 16):match.start()]):
                return value[len("研究启动参考价"):]
            return value
        return TOKEN.sub(replace, text)
