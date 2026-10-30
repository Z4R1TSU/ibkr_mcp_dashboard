"""The full report must survive harmless wording; real numeric errors must not."""
from datetime import datetime, timezone
from pathlib import Path
import json
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "integrations/tradingagents"))
import worker
from price_context import PriceContext
from price_validation import guard_section
from data_runtime import DataRuntime


def prices():
    now = datetime.now(timezone.utc).isoformat()
    c = PriceContext("GOOG", {"version": 1, "symbol": "GOOG", "quote": {
        "symbol": "GOOG", "currency": "USD", "source": "thinkorswim", "status": "REALTIME", "fields": {},
        "reference": {"kind": "last", "value": 284.93, "receivedAt": now, "sourceTime": None}}})
    c.validate()
    for key, value in {"close": 321.89, "close_10_ema": 326.22, "close_50_sma": 338.117,
                       "close_200_sma": 339.26315, "boll_lb": 312.65, "macd": -6.07, "macds": -3.32}.items():
        c.add(key, value, "2026-10-28 " + key)
        if key not in ("macd", "macds"):
            c.relation(key, value)
    c.comparison("close_50_sma", "close_200_sma")
    return c


class ValidationTests(unittest.TestCase):
    def test_optional_gaps_do_not_remove_a_valid_final_rating(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = SimpleNamespace(prices=prices(), price_guards={}, directory=Path(tmp), prefetched={},
                coverage={"valuation": {"status": "unavailable"}}, book=SimpleNamespace(check_report=lambda text: []))
            state = {k: "资料已标明" for k in ("market_report", "news_report", "sentiment_report",
                                             "investment_plan", "trader_investment_plan")}
            state["final_trade_decision"] = "**Rating**: hold\n[[price:latest]]"
            result, rating = worker.finalize_state(data, state, "hold")
            self.assertEqual(rating, "hold")
            self.assertEqual(data.validation["status"], "passed")
            state["final_trade_decision"] = "**Rating**: hold\n现价999美元"
            _, rating = worker.finalize_state(data, state, "hold")
            self.assertEqual(rating, "Not rated")

    def test_market_agent_returns_only_the_checked_report_to_the_graph(self):
        import tradingagents.graph.setup as setup
        from langchain_core.messages import AIMessage
        with tempfile.TemporaryDirectory() as tmp:
            data = DataRuntime("GOOG", "2026-10-29", tmp)
            data.prices = prices()
            data.prefetched = {"market": "已取得行情"}
            raw = lambda state: {"market_report": "现价999美元", "messages": [AIMessage(content="现价999美元")]}
            model = SimpleNamespace(invoke=lambda _: SimpleNamespace(content="not json"))
            with patch.object(setup, "create_market_analyst", return_value=raw):
                try:
                    data.install_analysts(setup)
                    result = setup.create_market_analyst(model)({"messages": []})
                    self.assertNotIn("999", result["market_report"])
                    self.assertEqual(result["messages"][0].content, result["market_report"])
                    self.assertEqual(data.price_guards["market_report"]["status"], "corrected")
                finally:
                    data.close()

    def test_explicit_errors_show_the_actual_two_operands(self):
        c = prices()
        for text in ("现价321.89美元", "[[price:unknown]]", "当前股价高于50日均线",
                     "50日均线高于200日均线", "布林下轨被研究启动参考价站上"):
            self.assertEqual(c.inspect(text)["status"], "blocked", text)
        issue = c.inspect("50日均线高于200日均线")["issues"][0]
        self.assertEqual(issue["evidence"]["left"], "close_50_sma")
        self.assertEqual(issue["evidence"]["right"], "close_200_sma")
        self.assertAlmostEqual(issue["evidence"]["leftValue"], 338.117)

    def test_conditional_historical_and_nonprice_comparisons_are_not_false_claims(self):
        c = prices()
        for text in ("若当前股价高于50日均线，可以重新评估。", "去年50日均线高于200日均线。",
                     "当前股价高于50日均线的说法不成立。",
                     "流动性低于常规时段，价格可能跳空。", "波动风险高于平时。"):
            self.assertEqual(c.inspect(text)["status"], "passed", text)

    def test_exact_numbers_are_normalized_without_a_model_retry(self):
        c = prices()
        result = c.inspect("现价284.93美元。50日均线低于200日均线。", True)
        self.assertEqual(result["status"], "passed")
        self.assertIn("[[price:latest]]", result["text"])
        self.assertIn("compare.close_50_sma__close_200_sma", result["text"])

    def test_local_repair_is_attempted_once_then_uses_facts(self):
        c = prices()
        calls = []
        def rewrite(blocks, issues):
            calls.append(blocks)
            return json.dumps([{"index": blocks[0]["index"], "text": "现价999美元"}])
        result, trace = guard_section(c, "现价321.89美元", rewrite, True)
        self.assertEqual(len(calls), 1)
        self.assertTrue(trace["fallback"])
        self.assertEqual(c.inspect(result)["status"], "passed")
        self.assertNotIn("999", result)
        self.assertIn("284.93", c.render(result))

    def test_repair_cannot_hide_a_connection_failure_or_cancellation(self):
        def fail(*args):
            raise TimeoutError("cancelled")
        with self.assertRaises(TimeoutError):
            guard_section(prices(), "现价999美元", fail, True)

    def test_reported_false_positives_never_become_price_errors(self):
        c = prices()
        text = ("研究启动参考价同时位于50日和200日均线下方，意味着压力不仅限于短线。"
                "50日均线略低于200日均线，结合当前价格处于两者下方，整体排列不利于多头。\n\n"
                "1. 盘前流动性通常低于常规时段，价格可能出现跳空、滑点和快速反转。")
        result = c.inspect(text)
        self.assertEqual(result["status"], "passed")
        self.assertFalse(any(i["severity"] == "error" for i in result["issues"]))
        self.assertIn("compare.close_50_sma__close_200_sma", result["text"])


if __name__ == "__main__":
    unittest.main()
