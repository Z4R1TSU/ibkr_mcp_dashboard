"""Offline regressions for the installed, pinned research engine."""
import contextlib
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor

ROOT = Path(__file__).resolve().parents[1]
WORKER = runpy.run_path(str(ROOT / "integrations/tradingagents/worker.py"))
sys.path.insert(0, str(ROOT / "integrations/tradingagents"))
from financials import FinancialBook
from market_data import safe_indicators, snapshot_text, fetch_frame
from data_runtime import DataRuntime, news_window, current_date, parallel, data_present
import pandas as pd
from rating_scale import RATINGS, rating_scale, final_rating
from price_context import PriceContext
from us_sessions import latest_settled


class ResearchPriceTests(unittest.TestCase):
    def test_regular_close_conflict_is_blocked_but_overnight_gap_is_allowed(self):
        prices = self.prices()
        prices.quote["fields"]["regularClose"] = {"value": 321.89}
        frame = pd.DataFrame({"Date": pd.to_datetime(["2026-10-28"]), "Open": [319.88],
                              "High": [323.13], "Low": [319.68], "Close": [321.89], "Volume": [1000.]})
        frame.attrs["price_basis"] = "split"
        prices.history(frame, [])
        self.assertEqual(prices.facts["latest"]["value"], 291.6)
        prices.quote["fields"]["regularClose"]["value"] = 290
        with self.assertRaisesRegex(ValueError, "不一致"):
            prices.history(frame, [])
        del prices.quote["fields"]["regularClose"]
        prices.quote["fields"]["regularLast"] = {"value": 290}
        prices.context["session"] = "regular"
        prices.history(frame, [])
        prices.context["session"] = "post"
        prices.history(frame, [])
        prices.context["session"] = "pre"
        with self.assertRaisesRegex(ValueError, "不一致"):
            prices.history(frame, [])

    def test_missing_quote_cannot_be_replaced_by_valid_daily_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = DataRuntime("GOOG", "2026-10-28", tmp)
            runtime._frame = TimeAndMarketTests.frame(210)
            with patch.object(runtime, "financial_report", return_value="财报可用"), \
                 patch.object(runtime.sec, "disclosures", return_value="已检查最新披露"), \
                 patch("tradingagents.dataflows.router.route_to_vendor", return_value="新闻可用"):
                self.assertFalse(runtime.preflight())
            self.assertEqual(runtime.coverage["market"]["status"], "available")
            self.assertEqual(runtime.coverage["quote"]["status"], "unavailable")

    def test_all_agent_context_aliases_receive_the_same_live_price(self):
        import tradingagents.graph.setup
        with tempfile.TemporaryDirectory() as tmp:
            runtime = DataRuntime("GOOG", "2026-10-28", tmp, self.context())
            runtime.prices.validate()
            try:
                runtime.install()
                checked = []
                for name, module in list(sys.modules.items()):
                    if name.startswith("tradingagents.agents.") and hasattr(module, "get_instrument_context_from_state"):
                        prompt = module.get_instrument_context_from_state({"company_of_interest": "GOOG"})
                        self.assertIn("[[price:latest]]", prompt, name)
                        self.assertIn("291.60", prompt, name)
                        checked.append(name)
                self.assertGreaterEqual(len(checked), 10)
            finally:
                runtime.close()

    def test_stale_wrong_symbol_and_close_quotes_cannot_start_research(self):
        context = self.context()
        context["quote"]["reference"]["receivedAt"] = "2026-01-01T00:00:00Z"
        with self.assertRaisesRegex(ValueError, "过期"):
            PriceContext("GOOG", context).validate()
        with self.assertRaises(ValueError):
            PriceContext("GOOGL", self.context()).validate()
        context = self.context()
        context["quote"]["lastIsClose"] = True
        context["quote"]["reference"]["kind"] = "last"
        with self.assertRaisesRegex(ValueError, "收盘"):
            PriceContext("GOOG", context).validate()

    def test_holiday_early_close_and_dst(self):
        for instant, expected in [
                ("2026-11-27T18:14:00+00:00", "2026-11-25"),
                ("2026-11-27T18:15:00+00:00", "2026-11-27"),
                ("2026-12-25T22:00:00+00:00", "2026-12-24"),
                ("2026-03-09T20:14:00+00:00", "2026-03-06"),
                ("2026-03-09T20:15:00+00:00", "2026-03-09")]:
            with self.subTest(instant=instant):
                self.assertEqual(latest_settled(instant[:10], datetime.fromisoformat(instant)), expected)

    def test_daily_data_one_trading_day_behind_is_rejected(self):
        csv = "timestamp,open,high,low,close,adjusted_close,volume,split_coefficient\n" \
              "2026-10-27,100,101,99,100,100,1000,1\n"
        with patch.dict(os.environ, {"TRADINGAGENTS_MARKET_VENDOR": "alpha_vantage"}), \
             patch("tradingagents.dataflows.vendors.alpha_vantage.stock.get_stock", return_value=csv):
            with self.assertRaisesRegex(ValueError, "2026-10-28"):
                fetch_frame("GOOG", "2026-10-28")

    def context(self):
        now = datetime.now(timezone.utc).isoformat()
        return {"version": 1, "symbol": "GOOG", "requestedAt": now, "session": "overnight",
                "expectedSettledDate": "2026-10-28", "failures": [], "quote": {
                    "symbol": "GOOG", "currency": "USD", "source": "thinkorswim", "status": "REALTIME",
                    "lastIsClose": None, "fields": {},
                    "reference": {"kind": "mark", "value": 291.6, "receivedAt": now, "sourceTime": None}}}

    def prices(self):
        prices = PriceContext("GOOG", self.context())
        prices.validate()
        frame = pd.DataFrame({"Date": pd.to_datetime(["2026-10-28"]), "Open": [319.88],
                              "High": [323.13], "Low": [319.68], "Close": [321.89], "Volume": [35578018.]})
        prices.history(frame, [("boll_lb", pd.Series([312.6491])), ("close_200_sma", pd.Series([339.26315]))])
        return prices

    def test_goog_quote_and_old_levels_have_deterministic_relationships(self):
        prices = self.prices()
        text = "[[price:latest]]。[[price:close]]。[[price:relation.boll_lb]]。[[price:change_from_close]]"
        self.assertEqual(prices.check(text, True), [])
        report = prices.render(text)
        self.assertIn("291.60 USD", report)
        self.assertIn("2026-10-28 历史日线收盘 321.89", report)
        self.assertIn("参考价低于", report)
        self.assertAlmostEqual(prices.facts["change_from_close"]["value"], -9.410047, places=5)
        self.assertIn("未知（接收时间不代表成交时间）", prices.header())
        self.assertNotIn("[[price:", report)

    def test_reference_name_is_not_repeated_after_a_model_lead_in(self):
        prices = self.prices()
        for lead in ("GOOG 研究启动参考价为", "研究启动参考价：", "**研究启动参考价：**"):
            report = prices.render(lead + "[[price:latest]]。")
            self.assertEqual(report.count("研究启动参考价"), 1, report)
            self.assertIn("291.60 USD", report)
        self.assertIn("研究启动参考价低于", prices.render("技术面偏弱：[[price:relation.boll_lb]]"))

    def test_wrong_price_unknown_reference_and_bypassed_percent_are_rejected(self):
        prices = self.prices()
        for text in ("当前股价321.89美元", "最新价：321.89",
                     "[[price:invented_target]]", "[[price:latest",
                     "现价 [[price:close]]", "当前股价仍位于布林下轨上方", "| 支撑位 | 999.99 |"):
            with self.subTest(text=text):
                self.assertTrue(prices.check(text))
        self.assertTrue(prices.check("仅引用旧收盘 [[price:close]]", True))
        self.assertFalse(prices.check("收入增长23.05%；200日均线的趋势偏弱。"))
        self.assertFalse(prices.check("当前股价低于布林下轨。"))
        self.assertFalse(prices.check("衰退隐含概率6%，广告和云需求或有支撑。"))
        self.assertTrue(prices.check("当前股价高于布林下轨。"))
        self.assertFalse(prices.check("盘前参考价低于历史收盘。"))
        self.assertFalse(prices.check("旧布林下轨已经被参考价跌破，不能继续视为下方支撑。"))
        self.assertFalse(prices.check("MACD低于信号线，对应 [[price:boll_lb]]。"))
        self.assertFalse(prices.check("收入增长25%，有助于支撑股价。"))
        self.assertTrue(prices.check("收入增长25%，当前股价高于布林下轨。"))
        self.assertTrue(prices.check("布林下轨已经被研究启动参考价站上。"))
        uncertain = prices.inspect("股价低于均线 4.8%")
        self.assertEqual(uncertain["status"], "passed")
        self.assertTrue(any(i["severity"] == "unverified" for i in uncertain["issues"]))


class RatingTests(unittest.TestCase):
    def state(self):
        return {
            "company_of_interest": "TEST", "trade_date": "2026-10-02",
            "investment_plan": "fixture", "trader_investment_plan": "fixture",
            "investment_debate_state": {"history": "", "count": 0},
            "risk_debate_state": {"count": 0, **dict.fromkeys(
                ("history", "aggressive_history", "conservative_history", "neutral_history",
                 "current_aggressive_response", "current_conservative_response", "current_neutral_response"), "")},
        }

    def test_structured_managers_use_all_five_ratings(self):
        from types import SimpleNamespace
        import tradingagents.graph.setup as setup
        for rating in RATINGS:
            with self.subTest(rating=rating):
                prompts = []
                class Model:
                    def with_structured_output(self, schema):
                        def invoke(prompt):
                            prompts.append(prompt)
                            return schema.model_validate({
                                "recommendation": rating, "rating": rating,
                                "rationale": "fixture", "strategic_actions": "fixture",
                                "executive_summary": "fixture", "investment_thesis": "fixture",
                            })
                        return SimpleNamespace(invoke=invoke)
                original = setup.create_portfolio_manager
                with rating_scale():
                    plan = setup.create_research_manager(Model())(self.state())
                    result = setup.create_portfolio_manager(Model())(self.state())
                self.assertIs(setup.create_portfolio_manager, original)
                self.assertEqual(result["final_rating"], rating)
                self.assertIn("**Rating**: " + rating, result["final_trade_decision"])
                self.assertIn("**Recommendation**: " + rating, plan["investment_plan"])
                for prompt in prompts:
                    self.assertIn("strong buy / buy / hold / sell / strong sell", prompt)
                    self.assertNotIn("Overweight", prompt)
                    self.assertNotIn("Underweight", prompt)

    def test_freetext_fallback_keeps_strong_ratings_and_does_not_invent_hold(self):
        from types import SimpleNamespace
        import tradingagents.graph.setup as setup
        class Model:
            def with_structured_output(self, schema):
                raise NotImplementedError("offline fallback")
            def invoke(self, prompt):
                return SimpleNamespace(content="**Rating**: " + label + "\n\nfixture")
        for label in [*(rating.upper() for rating in RATINGS), "Overweight", "未知"]:
            with self.subTest(label=label), rating_scale():
                result = setup.create_portfolio_manager(Model())(self.state())
                expected = label.lower() if label.lower() in RATINGS else "REVIEW"
                self.assertEqual(result["final_rating"], expected)
        for text in ["strong buy", "Rating Scale: strong buy / buy / hold / sell / strong sell",
                     "The analyst says buy, but the evidence is unclear.", "**Rating**: strong buy or sell"]:
            self.assertEqual(final_rating({"final_trade_decision": text})["final_rating"], "REVIEW")


def fact(start, end, value, filed="2026-09-10", accn="same-filing"):
    return {"start": start, "end": end, "val": value, "filed": filed, "accn": accn, "form": "10-Q"}


def fixture():
    return {"facts": {"us-gaap": {
        "RevenueFromContractWithCustomerExcludingAssessedTax": {"units": {"USD": [
            fact("2026-05-04", "2026-08-02", 29591000000)]}},
        "EarningsPerShareDiluted": {"units": {"USD/shares": [
            fact("2025-11-03", "2026-02-01", 1.50),
            fact("2026-02-02", "2026-05-03", 1.91),
            fact("2026-05-04", "2026-08-02", 2.68),
            fact("2025-11-03", "2026-08-02", 6.09),
            fact("2024-11-04", "2025-08-03", 3.02),
            fact("2025-11-03", "2026-08-02", 99, "2026-11-01", "future"),
        ]}},
        "ProfitLoss": {"units": {"USD": [fact("2026-05-04", "2026-08-02", 13088000000)]}},
        "NetCashProvidedByUsedInOperatingActivities": {"units": {"USD": [
            fact("2025-11-03", "2026-08-02", 32950000123)]}},
        "PaymentsToAcquirePropertyPlantAndEquipment": {"units": {"USD": [
            fact("2025-11-03", "2026-08-02", 1013000456)]}},
    }}}


class FinancialTests(unittest.TestCase):
    def setUp(self):
        self.book = FinancialBook("AVGO", "2026-10-02", fixture())

    def test_direct_eps_and_same_filing_growth(self):
        metrics = self.book.metrics()
        eps = next(m for m in metrics if m["name"] == "Diluted EPS" and m["span"] == "9m")
        growth = next(m for m in metrics if m["name"] == "Diluted EPS YoY" and m["span"] == "9m")
        self.assertEqual(eps["value"], "6.09")
        self.assertAlmostEqual(float(growth["value"]), 101.655629, places=5)
        self.assertNotIn("99", [m["value"] for m in metrics])

    def test_profit_labels_and_precision(self):
        report = self.book.report()
        self.assertIn("Consolidated Profit (includes noncontrolling interests)", report)
        self.assertIn("13088000000", report)
        self.assertIn("| Net Income | — |", report)
        metric = next(m for m in self.book.metrics() if m["name"].startswith("Free Cash Flow"))
        self.assertEqual(metric["value"], "31936999667")
        self.assertEqual(metric["span"], "9m")

    def test_no_eps_growth_across_filing_vintages(self):
        raw = fixture()
        rows = raw["facts"]["us-gaap"]["EarningsPerShareDiluted"]["units"]["USD/shares"]
        rows[4]["accn"] = "different-share-basis"
        book = FinancialBook("TEST", "2026-10-02", raw)
        self.assertFalse(any(m["name"] == "Diluted EPS YoY" for m in book.metrics()))

    def test_downstream_eps_mistake_is_rejected(self):
        self.assertTrue(self.book.check_report("摊薄每股收益简单合计约 **7.27美元**"))
        self.assertTrue(self.book.check_report("每股收益简单合计：**+140.7%**"))
        self.assertFalse(self.book.check_report("摊薄每股收益累计 **6.09美元**"))
        self.assertFalse(self.book.check_report("每股收益累计同比 **101.66%**"))


class TimeAndMarketTests(unittest.TestCase):
    def test_alpha_vantage_uses_adjusted_prices_and_split_adjusted_volume(self):
        csv = "timestamp,open,high,low,close,adjusted_close,volume,split_coefficient\n" \
              "2026-10-01,50,52,49,50,50,300,2\n2026-09-30,100,104,98,100,50,100,1\n"
        with patch.dict(os.environ, {"TRADINGAGENTS_MARKET_VENDOR": "alpha_vantage"}), \
             patch("tradingagents.dataflows.vendors.alpha_vantage.stock.get_stock", return_value=csv):
            frame = fetch_frame("TEST", "2026-10-01")
        self.assertEqual(frame["Close"].tolist(), [50.0, 50.0])
        self.assertEqual(frame["Volume"].tolist(), [200.0, 300.0])

    def test_diagnostic_distinguishes_region_block_from_rate_limit(self):
        from doctor import failure_reason
        self.assertIn("地区限制", failure_reason(403, "no longer be accessible from mainland China"))
        self.assertIn("Cloudflare", failure_reason(403, "Cloudflare: blocked"))
        self.assertIn("限流", failure_reason(429, "Too many requests"))

    def setUp(self):
        class FutureClock(datetime):
            @classmethod
            def now(cls, tz=None):
                return datetime(2027, 1, 1, tzinfo=timezone.utc).astimezone(tz)
        clock = patch("data_runtime.datetime", FutureClock)
        clock.start()
        self.addCleanup(clock.stop)
    def test_new_york_today_ignores_server_calendar(self):
        class Clock(datetime):
            @classmethod
            def now(cls, tz=None):
                return datetime(2026, 10, 2, 16, 10, tzinfo=timezone.utc).astimezone(tz)
        with patch("data_runtime.datetime", Clock):
            self.assertEqual(current_date(), "2026-10-02")

    def test_news_includes_evening_and_obeys_dst(self):
        self.assertTrue(news_window(datetime.fromisoformat("2026-10-09T01:00:00+00:00"),
                                    datetime(2026, 10, 1), datetime(2026, 10, 8)))
        self.assertFalse(news_window(datetime.fromisoformat("2026-10-09T04:00:00+00:00"),
                                     datetime(2026, 10, 1), datetime(2026, 10, 8)))
        self.assertFalse(news_window(None, datetime(2026, 10, 1), datetime(2026, 10, 8)))
        self.assertTrue(news_window(datetime.fromisoformat("2026-03-09T03:59:00+00:00"),
                                    datetime(2026, 3, 8), datetime(2026, 3, 8)))

    @staticmethod
    def frame(count):
        return pd.DataFrame({"Date": pd.bdate_range(end="2026-10-08", periods=count),
                             "Open": range(100, 100 + count), "High": range(101, 101 + count),
                             "Low": range(99, 99 + count), "Close": range(100, 100 + count),
                             "Volume": [1000] * count})

    def test_short_history_cannot_be_a_200_day_average(self):
        text = snapshot_text("TEST", "2026-10-08", self.frame(10))
        self.assertIn("| close_200_sma | N/A", text)
        self.assertNotIn("| close_200_sma | 104.5", text)
        frame = self.frame(210)
        values = dict(safe_indicators(frame))
        self.assertEqual(values["close_200_sma"].iloc[-1], frame["Close"].tail(200).mean())

    def test_missing_ohlcv_is_not_forward_filled(self):
        frame = self.frame(60).astype({"High": float})
        frame.loc[59, "High"] = float("nan")
        self.assertTrue(pd.isna(dict(safe_indicators(frame))["atr"].iloc[-1]))


class NewsTests(unittest.TestCase):
    def setUp(self):
        TimeAndMarketTests.setUp(self)

    @staticmethod
    def article(title="Apple news", ticker="AAPL", dated=True, link="https://example.test/apple"):
        item = {"title": title, "publisher": "Fixture", "link": link, "relatedTickers": [ticker]}
        if dated:
            item["providerPublishTime"] = int(datetime(2026, 10, 9, 1, tzinfo=timezone.utc).timestamp())
        return item

    def test_empty_ticker_feed_uses_dated_matching_search_results(self):
        from news_data import get_company_news
        from tradingagents.dataflows import date_window
        articles = [self.article(), self.article(), self.article("Unrelated", "MSFT"),
                    self.article("Undated", dated=False)]
        stale = self.article("Stale", link="https://example.test/stale")
        stale["providerPublishTime"] = int(datetime(2026, 9, 1, tzinfo=timezone.utc).timestamp())
        with patch("news_data.yf.Ticker") as ticker, patch("news_data.yf.Search") as search, \
             patch.object(date_window, "in_window", news_window):
            ticker.return_value.get_news.return_value = []
            search.return_value.news = articles + [stale]
            text = get_company_news("AAPL", "2026-10-03", "2026-10-08")
        self.assertIn("Yahoo Finance Search", text)
        self.assertIn("Articles retained: 1.", text)
        self.assertIn("Published:", text)
        for unsupported in ("Unrelated", "Undated", "Stale"):
            self.assertNotIn(unsupported, text)

    def test_usable_ticker_feed_does_not_query_search(self):
        from news_data import get_company_news
        with patch("news_data.yf.Ticker") as ticker, patch("news_data.yf.Search") as search:
            ticker.return_value.get_news.return_value = [self.article()]
            text = get_company_news("AAPL", "2026-10-03", "2026-10-10")
            search.assert_not_called()
        self.assertIn("Yahoo Finance ticker feed", text)

    def test_failed_or_empty_sources_do_not_become_available_news(self):
        from news_data import get_company_news
        with patch("news_data.yf.Ticker") as ticker, patch("news_data.yf.Search") as search:
            ticker.return_value.get_news.side_effect = ValueError("ticker feed returned 404")
            search.return_value.news = []
            text = get_company_news("AAPL", "2026-10-03", "2026-10-10")
        self.assertFalse(data_present(text))


class RuntimeTests(unittest.TestCase):
    def test_prediction_market_error_text_is_not_usable_data(self):
        response = "Polymarket data is currently unavailable (network error: ConnectTimeout). Proceed without prediction-market signal for 'Fed rate'."
        self.runtime.invoke("get_prediction_markets", ["Fed rate"], lambda: response, "prediction_markets")
        self.assertEqual(self.runtime.coverage["prediction_markets"]["status"], "unavailable")
        self.assertEqual(self.runtime.quality()["status"], "partial")
        self.assertFalse(data_present("Prediction-market odds are withheld for 2026-10-09."))
        self.assertTrue(data_present("## Prediction markets\n| Event | Probability |\n| Rate cut | 40% |\nLiquidity detail unavailable."))

    def test_bound_tools_apply_history_guard_on_both_paths(self):
        from tradingagents.agents.tools import get_indicators, get_verified_market_snapshot
        self.runtime._frame = TimeAndMarketTests.frame(10)
        self.runtime.as_of = "2026-10-08"
        self.runtime.install()
        series = get_indicators.func("TEST", "close_200_sma", "2026-10-08", 30, "2026-10-08")
        snapshot = get_verified_market_snapshot.func("TEST", "2026-10-08", 30, "2026-10-08")
        self.assertIn("N/A: insufficient valid history", series)
        self.assertIn("| close_200_sma | N/A", snapshot)

    def test_parallel_fetches_inherit_vendor_config(self):
        from tradingagents.dataflows.config import run_config, get_config
        with run_config({"data_vendors": {"news_data": "alpha_vantage"}}):
            result = parallel([("news", lambda: get_config()["data_vendors"]["news_data"])])
        self.assertEqual(result["news"], "alpha_vantage")

    def test_later_success_does_not_hide_another_failure(self):
        self.runtime.invoke("macro", ["cpi"], lambda: "DATA_UNAVAILABLE: missing CPI", "macro")
        self.runtime.invoke("macro", ["rate"], lambda: "Fed funds rate: 4%", "macro")
        self.assertEqual(self.runtime.coverage["macro"]["status"], "unavailable")
        self.assertIn("CPI", self.runtime.coverage["macro"]["reason"])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runtime = DataRuntime("TEST", "2026-10-02", self.temp.name)
        self.addCleanup(self.runtime.close)

    def test_requests_coalesce_and_secrets_are_redacted(self):
        self.runtime.secrets = ["private-api-value"]
        calls = []
        def fetch():
            calls.append(1)
            return "DATA_UNAVAILABLE: https://example.test/?apikey=private-api-value"
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.runtime.invoke("news", ["TEST"], fetch, "news"), range(8)))
        self.assertEqual(len(calls), 1)
        self.assertNotIn("private-api-value", "".join(results))
        self.assertNotIn("private-api-value", Path(self.temp.name, "data-audit.jsonl").read_text())
        self.assertEqual(self.runtime.quality()["status"], "partial")

    def test_social_sentiment_is_not_fetched_and_stays_unknown(self):
        import tradingagents.graph.setup as setup
        from tradingagents.agents.analysts import sentiment_analyst as sentiment
        with patch.object(sentiment, "fetch_stocktwits_messages", side_effect=AssertionError("fetched")), \
             patch.object(sentiment, "fetch_reddit_posts", side_effect=AssertionError("fetched")):
            self.runtime.install_analysts(setup)
            result = setup.create_sentiment_analyst(None)({"company_of_interest": "TEST", "trade_date": "2026-10-02"})
            self.assertIn("Unknown", result["sentiment_report"])
            self.assertIn("未接入社交媒体", result["sentiment_report"])
            saved = json.loads(Path(self.temp.name, "sentiment.json").read_text())
            self.assertIsNone(saved["overall_score"])
            self.assertNotIn("stocktwits", self.runtime.coverage)
            self.runtime.close()
            self.runtime.patches.clear()

    def test_trader_receives_verified_fundamentals_with_the_technical_report(self):
        import tradingagents.graph.setup as setup
        seen = {}
        def fake_trader(llm):
            return lambda state: seen.update(state) or {"trader_investment_plan": "ok"}
        with patch.object(setup, "create_trader", fake_trader):
            self.runtime.install_analysts(setup)
            setup.create_trader(None)({"market_report": "技术面", "fundamentals_report": "AWS 营业利润 177.73 亿美元"})
            self.assertIn("技术面", seen["market_report"])
            self.assertIn("177.73", seen["market_report"])
            self.runtime.close()
            self.runtime.patches.clear()

    def test_worker_missing_core_data_never_constructs_model_graph(self):
        import tradingagents.graph.trading_graph as graph_module
        def unavailable(runtime):
            runtime.prefetched = {"market": "DATA_UNAVAILABLE: blocked", "financials": "财报资料", "news": "DATA_UNAVAILABLE"}
            runtime.coverage = {"market": {"status": "unavailable", "reason": "blocked"}}
            return False
        payload = {"ticker": "TEST", "date": "2026-10-02", "account": None,
                   "model": "fixture", "maxTokens": 1000, "timeoutSeconds": 10, "bridgeUrl": "http://127.0.0.1:1/v1"}
        output = io.StringIO()
        globals_ = WORKER["main"].__globals__
        previous_mask = os.umask(0o077)
        try:
            with contextlib.chdir(self.temp.name), patch.object(sys, "stdin", io.StringIO(json.dumps(payload))), \
                 patch.dict(globals_, {"protocol_output": output}), \
                 patch.object(DataRuntime, "preflight", unavailable), \
                 patch.object(graph_module, "TradingAgentsGraph", side_effect=AssertionError("model graph invoked")):
                WORKER["main"]()
        finally:
            os.umask(previous_mask)
        result = next(json.loads(line) for line in output.getvalue().splitlines() if '"event": "result"' in line)
        self.assertEqual(result["rating"], "Not rated")
        self.assertEqual(result["quality"]["status"], "partial")
        self.assertIn("数据覆盖", result["report"])
        self.assertIn("资料不足", result["summary"])

    def test_full_graph_uses_verified_financials_and_unknown_sentiment(self):
        from types import SimpleNamespace
        from langchain_core.language_models.fake_chat_models import FakeListChatModel
        import tradingagents.graph.trading_graph as module
        from tradingagents.default_config import build_default_config
        from tradingagents.agents.analysts import sentiment_analyst as sentiment
        class FakeModel(FakeListChatModel):
            def bind_tools(self, tools, **kwargs):
                return self
            def with_structured_output(self, *args, **kwargs):
                raise NotImplementedError("offline fixture")
        fake = FakeModel(responses=["**Rating**: STRONG BUY\n研究测试，仅使用已提供的证据。"])
        self.runtime.book = FinancialBook("TEST", "2026-10-02", fixture())
        self.runtime.prefetched = {"market": "Verified market fixture", "news": "DATA_UNAVAILABLE"}
        config = build_default_config()
        config.update(results_dir=self.temp.name, data_cache_dir=self.temp.name,
                      memory_log_path=str(Path(self.temp.name, "memory.md")))
        with patch.object(module, "create_llm_client", return_value=SimpleNamespace(get_llm=lambda: fake)), \
             patch.object(sentiment.get_news, "func", lambda *args, **kwargs: "DATA_UNAVAILABLE"), \
             patch.object(sentiment, "fetch_stocktwits_messages", return_value="<stocktwits unavailable>"), \
             patch.object(sentiment, "fetch_reddit_posts", return_value="<Reddit unavailable>"), contextlib.ExitStack() as cleanup:
            self.runtime.install()
            cleanup.callback(self.runtime.close)
            cleanup.enter_context(rating_scale())
            graph = module.TradingAgentsGraph(config=config)
            graph.resolve_instrument_context = lambda *args: "Fictional TEST instrument"
            state, rating = graph.propagate("TEST", "2026-10-02")
            self.assertEqual(rating, "strong buy")
            self.assertEqual(state["final_rating"], "strong buy")
            self.assertIn("6.09", state["fundamentals_report"])
            self.assertIn("Unknown", state["sentiment_report"])
            self.assertTrue(state["final_trade_decision"])
            self.runtime.close()
            self.runtime.patches.clear()


if __name__ == "__main__":
    unittest.main()
