"""Version-pinned adapters; never edits installed TradingAgents files."""
from concurrent.futures import Future, ThreadPoolExecutor
from contextvars import copy_context
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import RLock
from zoneinfo import ZoneInfo
import json
import os
import re
import sys

from financials import load_book
from market_data import fetch_frame, snapshot_text, indicator_text, safe_indicators
from data_notices import SOURCES, missing_details, missing_notice
from price_context import PriceContext
from evidence import SourceResult, instant, record
from public_data import PublicClient, SourceUnavailable
from sec_sources import SecSources, UnsupportedIssuer
from news_sources import NewsSources
from valuation import valuation_result

NY = ZoneInfo("America/New_York")


def parallel(tasks):
    with ThreadPoolExecutor(max_workers=len(tasks)) as pool:
        pending = [(name, pool.submit(copy_context().run, function)) for name, function in tasks]
        return {name: future.result() for name, future in pending}


def current_date():
    return datetime.now(NY).date().isoformat()


def news_window(pub, start, end):
    # Dates are New York calendar dates; publication timestamps retain their TZ.
    low = datetime.combine(start.date(), datetime.min.time(), NY)
    high = datetime.combine(end.date() + timedelta(days=1), datetime.min.time(), NY)
    now = datetime.now(timezone.utc)
    if pub is None:
        return False  # unknown publication time cannot establish window membership
    instant = pub.replace(tzinfo=timezone.utc) if pub.tzinfo is None else pub
    return low <= instant < high and instant <= now


def coverage_gap(dates, start, end, source, subject):
    now = datetime.now(NY)
    observed = [(d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d).astimezone(NY) for d in dates if d is not None]
    oldest = min(observed, default=now)
    if end > now.date().isoformat() or oldest.date().isoformat() > start:
        return f"<{source} unavailable for {start}..{end}: incomplete observed coverage of {subject}>"
    return None


def data_present(value):
    text = str(value).strip()
    return bool(text) and not (
        text.startswith(("DATA_UNAVAILABLE", "NO_DATA_AVAILABLE", "Error",
                         "Polymarket data is currently unavailable", "Prediction-market odds are withheld for"))
        or re.search(r"^<.*(?:unavailable|no .* (?:messages|posts)|none of)", text, re.I)
        or "withheld for this date" in text
        or text.lower().startswith(("no news found", "no global news found"))
    )


class DataRuntime:
    def __init__(self, ticker, as_of, directory, market_context=None):
        self.ticker, self.as_of, self.directory = ticker, as_of, Path(directory)
        self.lock, self.cache, self.coverage, self.patches = RLock(), {}, {}, []
        self.coverage = {name: {"status": "not_requested", "reason": "本次未查询"}
                         for name in SOURCES if name not in ("financial_validation", "price_validation")}
        self.prices = PriceContext(ticker, market_context)
        self.price_guards = {}
        end = datetime.fromisoformat(as_of + "T23:59:59").replace(tzinfo=NY)
        received = ((market_context or {}).get("quote") or {}).get("reference", {}).get("receivedAt")
        self.cutoff = (instant(received) or min(end, datetime.now(timezone.utc))).astimezone(timezone.utc)
        self.client = PublicClient(os.environ.get("TRADINGAGENTS_PUBLIC_CACHE_DIR") or self.directory / "public-cache")
        self.sec = SecSources(ticker, self.cutoff, self.client)
        self.news = NewsSources(ticker, self.cutoff, self.client, self.sec)
        self.source_records = {}
        self.coverage_requests = {}
        self.book, self.optional = None, {}
        self.secrets = [v for k, v in os.environ.items() if v and (k.endswith("_API_KEY") or "proxy" in k.lower())]

    def redact(self, value):
        text = str(value)
        for secret in self.secrets:
            text = text.replace(secret, "[redacted]")
        return re.sub(r"(https?://)[^/\s:@]+:[^/\s@]+@", r"\1[redacted]@", text)

    def invoke(self, name, arguments, function, category=None):
        key = (name, json.dumps(arguments, sort_keys=True, default=str))
        with self.lock:
            owner = key not in self.cache
            future = self.cache.setdefault(key, Future())
        if not owner:
            return future.result()
        try:
            try:
                value = function()
                source_result = value if isinstance(value, SourceResult) else None
                result = self.redact(source_result.text if source_result else value)
            except Exception as error:
                source_result = None
                result = "DATA_UNAVAILABLE: " + self.redact(f"{type(error).__name__}: {error}")[:500]
            quality = source_result.quality if source_result else ("verified" if data_present(result) else "unavailable")
            entry = {"tool": name, "arguments": arguments, "fetchedAt": datetime.now(timezone.utc).isoformat(),
                     "status": "available" if quality == "verified" else "unavailable", "result": result,
                     "verificationStatus": quality, "reason": source_result.reason if source_result else "",
                     "retrievalStatus": "retrieved" if data_present(result) or source_result and source_result.records else "failed"}
            with self.lock:
                if source_result:
                    for row in source_result.records:
                        self.source_records[row["id"]] = row
                    entry["sourceIds"] = [r["id"] for r in source_result.records]
                    payload = {"cutoff": self.cutoff.isoformat(), "records": list(self.source_records.values())}
                    (self.directory / "source-evidence.json").write_text(self.redact(json.dumps(payload, ensure_ascii=False)), encoding="utf-8")
                if category:
                    requests = self.coverage_requests.setdefault(category, {})
                    requests[key] = entry
                    failures = [(item.get("reason") or item["result"])[:200] for item in requests.values() if item["status"] != "available"]
                    grades = {item["verificationStatus"] for item in requests.values()}
                    self.coverage[category] = {"status": "unavailable" if failures else "available",
                        "fetchedAt": entry["fetchedAt"],
                        "reason": "; ".join(sorted(set(failures or [item.get("reason", "") for item in requests.values()])))[:600],
                        "verificationStatus": "unavailable" if "unavailable" in grades else "partial" if "partial" in grades else "verified",
                        "retrievalStatus": "retrieved" if any(item["retrievalStatus"] == "retrieved" for item in requests.values()) else "failed",
                        "sourceIds": sorted({i for item in requests.values() for i in item.get("sourceIds", [])})}
                with (self.directory / "data-audit.jsonl").open("a", encoding="utf-8") as output:
                    output.write(self.redact(json.dumps(entry, ensure_ascii=False, default=str)) + "\n")
            future.set_result(result)
            return result
        except BaseException as error:
            future.set_exception(error)
            raise

    def frame(self):
        with self.lock:
            if not hasattr(self, "_frame"):
                expected = self.prices.context.get("expectedSettledDate")
                self._frame = fetch_frame(self.ticker, min(self.as_of, expected) if expected else self.as_of, expected)
            return self._frame.copy()

    def financial_report(self):
        with self.lock:
            if self.book is None:
                self._financial_base = self.sec.financials()
                self.book = self.sec.book
                self.book.save(self.directory)
            base = getattr(self, "_financial_base", SourceResult(self.book.report()))
            extra = "\n\n".join(f"## {name}\n{text}" for name, text in self.optional.items())
            return SourceResult(base.text + ("\n\n" + extra if extra else ""), base.records, base.quality, base.reason)

    def financial_brief(self):
        """Verified metrics and sources without the raw statements or release body."""
        if self.book is None:
            return None
        extra = "\n\n".join(f"## {name}\n{text}" for name, text in self.optional.items())
        return (self.sec.provenance() + "\n\n" + self.sec.gap_note() + self.book.report(statements=False)
                + ("\n\n" + extra if extra else ""))

    def preflight(self):
        from tradingagents.dataflows.router import route_to_vendor
        try:
            self.sec.check_issuer()
        except UnsupportedIssuer:
            raise
        except SourceUnavailable:
            pass  # the disclosure task below records the specific failure
        start = (datetime.fromisoformat(self.as_of) - timedelta(days=7)).date().isoformat()
        tasks = [
            ("quote", lambda: self.invoke("latest_quote", [self.ticker], self.prices.validate, "quote")),
            ("disclosures", lambda: self.invoke("latest_disclosures", [self.ticker, self.cutoff.isoformat()],
                                               self.sec.disclosures, "disclosures")),
            ("market", lambda: self.invoke("market_snapshot", [self.ticker, self.as_of],
                lambda: snapshot_text(self.ticker, self.as_of, self.frame()), "market")),
            ("financials", lambda: self.invoke("filed_financials", [self.ticker, self.as_of], self.financial_report, "financials")),
            ("news", lambda: self.invoke("company_news", [self.ticker, start, self.as_of],
                lambda: route_to_vendor("get_news", self.ticker, start, self.as_of), "news")),
        ]
        self.prefetched = parallel(tasks)
        self.core_ready = all(self.coverage[name]["status"] == "available" for name in ("quote", "market", "financials", "disclosures"))
        if self.coverage["market"]["status"] == "available":
            import pandas as pd
            missing = [name for name, series in safe_indicators(self.frame()) if pd.isna(series.iloc[-1])]
            self.coverage["technical_indicators"] = {
                "status": "unavailable" if missing else "available",
                "reason": "样本不足或 OHLCV 缺失：" + ", ".join(missing) if missing else "",
            }
            self.invoke("price_alignment", [self.ticker, self.as_of],
                lambda: (self.prices.history(self.frame(), safe_indicators(self.frame())), "价格时间与口径已核对")[1],
                "price_validation")
            if self.coverage["price_validation"]["status"] != "available":
                self.core_ready = False
        (self.directory / "price-facts.json").write_text(json.dumps(self.prices.facts, ensure_ascii=False), encoding="utf-8")
        if self.core_ready:
            optional = [
                ("当前估值",
                 lambda: route_to_vendor("get_fundamentals", self.ticker, self.as_of)),
                ("内部人交易", lambda: route_to_vendor("get_insider_transactions", self.ticker, self.as_of)),
            ]
            self.optional = parallel(optional)
            self.prefetched["financials"] = self.financial_report().text
        if not os.environ.get("FRED_API_KEY"):
            self.coverage["macro"] = {"status": "unavailable", "reason": "未配置 FRED_API_KEY"}
        if not self.core_ready:
            for name in ("valuation", "insiders"):
                self.coverage[name] = {"status": "not_requested", "reason": "关键数据不足，未继续查询"}
        return self.core_ready

    def quality(self):
        missing = [name for name, row in self.coverage.items() if row["status"] != "available"]
        return {"status": "partial" if missing else "complete", "missing": missing,
                "details": missing_details(self.coverage)}

    def missing_notice(self):
        return missing_notice(self.coverage)

    def coverage_report(self):
        lines = ["## 数据覆盖", "| 数据 | 取数 | 核验 | 数据期间 | 说明 |", "|---|---|---|---|---|"]
        for name, row in self.coverage.items():
            note = row.get("reason", "").replace("|", "/").replace("\n", " ")
            periods = sorted({str(self.source_records[i].get("period")) for i in row.get("sourceIds", [])
                              if i in self.source_records and self.source_records[i].get("period")})
            label = SOURCES.get(name, (name, ""))[0]
            labels = {"retrieved": "已取得", "failed": "失败", "verified": "通过", "partial": "部分核验",
                      "available": "可用", "unavailable": "未通过", "not_requested": "未查询"}
            retrieval = row.get("retrievalStatus", row["status"])
            quality = row.get("verificationStatus", row["status"])
            lines.append(f"| {label} | {labels.get(retrieval, retrieval)} | "
                         f"{labels.get(quality, quality)} | {', '.join(periods[-3:]) or '见章节'} | {note} |")
        return "\n".join(lines)

    def freshness_report(self):
        latest = self.sec.latest_period or "未核验"
        formal = self.book.latest_period if self.book else "未核验"
        return (f"资料截止时间：{self.cutoff.isoformat()}。\n\n"
                f"最新披露期间：{latest}；正式结构化财报期间：{formal}。"
                "来源、单位及公告/定期报告的区别见基本面章节。\n\n")

    def patch(self, module, name, value):
        self.patches.append((module, name, getattr(module, name)))
        setattr(module, name, value)

    def replace_aliases(self, old, new):
        for name, module in list(sys.modules.items()):
            if name.startswith("tradingagents.") and module:
                for attribute, value in list(vars(module).items()):
                    if value is old:
                        self.patch(module, attribute, new)

    def close(self):
        for module, name, value in reversed(self.patches):
            setattr(module, name, value)
        self.patches.clear()

    def install(self):
        # Import consumers first so existing "from ... import ..." aliases are
        # replaced too. Everything is scoped to this one-job worker process.
        import tradingagents.graph.setup as setup
        from tradingagents.dataflows import date_window, router
        from tradingagents.dataflows.vendors.yahoo import snapshot, common
        from tradingagents.dataflows.vendors import sec_edgar
        from tradingagents.dataflows.vendors import fred
        self.macro_records, self.macro_units = {}, {}
        def fred_request(endpoint, params):
            if endpoint not in ("series", "series/observations"):
                raise SourceUnavailable("未支持的 FRED 读取接口")
            key = os.environ.get("FRED_API_KEY")
            if not key:
                raise SourceUnavailable("未配置 FRED_API_KEY")
            body, fetched = self.client.json("https://api.stlouisfed.org/fred/" + endpoint,
                params={**params, "api_key": key, "file_type": "json"}, ttl=0)
            if body.get("error_code"):
                raise SourceUnavailable("FRED 返回数据或参数错误")
            series = params.get("series_id", "")
            if endpoint == "series":
                self.macro_units[series] = (body.get("seriess") or [{}])[0].get("units")
            else:
                dates = [r["date"] for r in body.get("observations", []) if r.get("value") != "."]
                self.macro_records[series] = record("FRED", "https://fred.stlouisfed.org/series/" + series,
                    fetched["fetchedAt"], period=max(dates, default=None), unit=self.macro_units.get(series),
                    revision=params.get("realtime_start"), locator=series,
                    publicationPrecision="版本日期；不等同于观察日期", observationCount=len(dates))
            return body
        self.patch(fred, "_request", fred_request)
        from tradingagents.agents import context
        original_context = context.get_instrument_context_from_state
        self.replace_aliases(original_context, lambda state: original_context(state) + self.prices.prompt()
                            + "\n" + self.sec.context() + "\n新闻情绪与社交情绪分别讨论，缺失社交样本不补分。")
        self.replace_aliases(date_window.get_current_date, current_date)
        self.replace_aliases(date_window.in_window, news_window)
        self.replace_aliases(date_window.coverage_gap, coverage_gap)
        retry = common.yf_retry
        self.replace_aliases(retry, lambda function, **_: retry(function, max_retries=1))
        from news_data import get_company_news
        self.patch(router, "VENDOR_METHODS", {
            **router.VENDOR_METHODS,
            "get_news": {**router.VENDOR_METHODS["get_news"], "yfinance": get_company_news},
        })
        original_route = router.route_to_vendor

        def route(method, *args, **kwargs):
            category = {"get_news": "news", "get_global_news": "global_news",
                        "get_macro_indicators": "macro", "get_prediction_markets": "prediction_markets",
                        "get_fundamentals": "valuation", "get_insider_transactions": "insiders"}.get(method)
            def fetch():
                if method == "get_stock_data":
                    symbol, start, end = args
                    if symbol != self.ticker:
                        raise ValueError("行情请求证券与研究标的不匹配")
                    frame = self.frame()
                    return frame[(frame["Date"] >= start) & (frame["Date"] <= end)].to_csv(index=False)
                if method == "get_indicators":
                    symbol, indicator, as_of, lookback = args
                    if symbol != self.ticker:
                        raise ValueError("指标请求证券与研究标的不匹配")
                    frame = self.frame()
                    frame = frame[frame["Date"] <= as_of].reset_index(drop=True)
                    return indicator_text(symbol, indicator, as_of, lookback, frame)
                if method in ("get_news", "get_fundamentals", "get_insider_transactions"):
                    if not args or args[0] != self.ticker:
                        raise ValueError("数据请求证券与研究标的不匹配")
                    if method == "get_news":
                        return self.news.company(args[1])
                    if method == "get_insider_transactions":
                        return self.sec.insiders()
                    self.financial_report()
                    return valuation_result(self.book, self.sec.latest_period, self.prices.quote, self.sec.records)
                if method == "get_global_news":
                    return self.news.global_news(args[1] if len(args) > 1 else 7, args[2] if len(args) > 2 else 12)
                if method == "get_macro_indicators":
                    if not os.environ.get("FRED_API_KEY"):
                        return SourceResult("DATA_UNAVAILABLE: 未配置 FRED_API_KEY，宏观数值未知。",
                                            quality="unavailable", reason="未配置 FRED_API_KEY")
                    value = original_route(method, *args, **kwargs)
                    series = fred._resolve_series_id(args[0])
                    rows = [self.macro_records[series]] if series in self.macro_records else []
                    ok = data_present(value) and bool(rows) and rows[0]["observationCount"] > 0
                    return SourceResult(value, rows, "verified" if ok else "unavailable",
                                        "" if ok else "未取得有观察日期、单位和版本的宏观数值")
                if method == "get_prediction_markets":
                    value = original_route(method, *args, **kwargs)
                    value = value.replace("higher traded volume = deeper, more reliable",
                                          "traded volume alone does not establish current liquidity or reliability")
                    return SourceResult(value + "\n预测市场概率不是宏观事实；盘口和逐笔报价时点未核验。",
                        quality="partial" if data_present(value) else "unavailable",
                        reason="预测市场盘口及报价源时间未核验")
                return original_route(method, *args, **kwargs)
            return self.invoke(method, [args, kwargs], fetch, category)
        self.replace_aliases(original_route, route)

        def verified(symbol, as_of, look_back_days=30, indicators=None):
            def fetch():
                if symbol != self.ticker:
                    raise ValueError("快照请求证券与研究标的不匹配")
                frame = self.frame()
                frame = frame[frame["Date"] <= as_of].reset_index(drop=True)
                return snapshot_text(symbol, as_of, frame, look_back_days) + "\n\n" + self.prices.prompt()
            return self.invoke("verified_snapshot", [symbol, as_of, look_back_days], fetch, "market")
        self.replace_aliases(snapshot.build_verified_market_snapshot, verified)

        def statement(kind, ticker, freq, as_of, title):
            if ticker != self.ticker:
                raise ValueError("财报请求证券与研究标的不匹配")
            cutoff = min(as_of or self.as_of, self.as_of)
            book = self.book if self.book and cutoff == self.as_of else load_book(ticker, cutoff)
            return book.statement(kind, freq)
        self.patch(sec_edgar, "_statement", statement)
        self.install_analysts(setup)

    def guard_report(self, name, text, llm=None):
        from langchain_core.messages import HumanMessage
        from price_validation import guard_section
        def rewrite(blocks, issues):
            prompt = (self.prices.prompt() + "\n只修正以下段落的价格事实。用给定的价格引用和比较引用替换数值及价位关系；"
                      "保留非价格信息，不新增评级或目标价。不确定的比较删去。"
                      "只输出 JSON 数组，每项为 {index: 原段落编号, text: 修正后段落}，不要 Markdown 代码围栏。\n"
                      + json.dumps(blocks, ensure_ascii=False) + "\n问题："
                      + json.dumps([{k: v for k, v in i.items() if k != "snippet"} for i in issues], ensure_ascii=False))
            return llm.invoke([HumanMessage(content=prompt)]).content
        result, trace = guard_section(self.prices, text, rewrite if llm else None, name == "market_report")
        with self.lock:
            self.price_guards[name] = trace
            (self.directory / "price-stage-validation.json").write_text(
                self.redact(json.dumps(self.price_guards, ensure_ascii=False)), encoding="utf-8")
        return result

    def install_analysts(self, setup):
        from langchain_core.messages import AIMessage, HumanMessage
        for factory_name, source in [("create_market_analyst", "market"), ("create_news_analyst", "news")]:
            factory = getattr(setup, factory_name)
            def grounded_factory(llm, _factory=factory, _source=source):
                normal = _factory(llm)
                def node(state):
                    evidence = self.prefetched.get(_source, "DATA_UNAVAILABLE")
                    if _source == "news" and not data_present(evidence):
                        return {"messages": [AIMessage(content=evidence)], "news_report": evidence}
                    result = normal({**state, "messages": [HumanMessage(content="本次已核验来源数据：\n" + evidence), *state["messages"]]})
                    report_key = _source + "_report"
                    if result.get(report_key):
                        result[report_key] = self.guard_report(report_key, result[report_key], llm)
                        result["messages"] = [AIMessage(content=result[report_key])]
                    return result
                return node
            self.replace_aliases(factory, grounded_factory)

        def fundamentals_factory(llm):
            def node(state):
                report = self.financial_report().text
                return {"messages": [AIMessage(content=report)], "fundamentals_report": report}
            return node
        self.replace_aliases(setup.create_fundamentals_analyst, fundamentals_factory)

        # Upstream gives the Trader only the technical report plus the research
        # plan's digest. It then treats the plan's fundamental claims as
        # unverified and lets price structure override them (AMZN 2026-10-30:
        # plan hold -> Trader sell "financials not provided"). Give it the same
        # verified fundamentals the risk analysts already receive.
        original_trader = setup.create_trader
        def trader_factory(llm):
            normal = original_trader(llm)
            def node(state):
                fundamentals = (state.get("fundamentals_report") or "").strip()
                if not fundamentals:
                    return normal(state)
                market = state.get("market_report") or ""
                return normal({**state, "market_report": market
                               + "\n\n## 已核验基本面资料（与上方技术面同为已核验证据）\n\n" + fundamentals})
            return node
        self.replace_aliases(original_trader, trader_factory)

        # StockTwits and Reddit are unreachable from this host and were dropped
        # by the owner; the section says so instead of fetching or scoring.
        def sentiment_factory(llm):
            def node(state):
                value = {"overall_band": "Unknown", "overall_score": None, "confidence": "low",
                         "reason": "本系统未接入社交媒体数据，社交情绪未知；新闻情绪仅在新闻章节讨论，不能补成市场共识"}
                (self.directory / "sentiment.json").write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
                report = "**Overall Sentiment:** Unknown\n**Score:** N/A\n**Confidence:** Low\n\n" + value["reason"]
                return {"messages": [AIMessage(content=report)], "sentiment_report": report}
            return node
        self.replace_aliases(setup.create_sentiment_analyst, sentiment_factory)
