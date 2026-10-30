import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import pandas as pd
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "integrations/tradingagents"))
from market_data import fetch_frame, snapshot_text


class FallbackTests(unittest.TestCase):
    def frame(self, count=210):
        return pd.DataFrame({"Date": pd.bdate_range(end="2026-10-20", periods=count),
            "Open": [100.] * count, "High": [102.] * count, "Low": [99.] * count,
            "Close": [101.] * count, "Volume": [10000.] * count})

    def test_unavailable_primary_uses_original_vendor_and_reports_actual_source(self):
        calls = []
        def fetch(symbol, as_of, vendor):
            calls.append(vendor)
            if vendor == "thinkorswim":
                raise ValueError("unverified basis")
            return self.frame()
        with patch.dict(os.environ, {"TRADINGAGENTS_MARKET_VENDOR": "thinkorswim",
                                     "TRADINGAGENTS_MARKET_FALLBACK": "alpha_vantage"}), \
             patch("market_data._fetch_frame", side_effect=fetch):
            frame = fetch_frame("AAPL", "2026-10-20")
            report = snapshot_text("AAPL", "2026-10-20", frame)
        self.assertEqual(calls, ["thinkorswim", "alpha_vantage"])
        self.assertIn("Source: alpha_vantage", report)
        self.assertIn("已使用原数据源", report)

    def test_insufficient_primary_history_also_falls_back(self):
        with patch.dict(os.environ, {"TRADINGAGENTS_MARKET_VENDOR": "thinkorswim",
                                     "TRADINGAGENTS_MARKET_FALLBACK": "yfinance"}), \
             patch("market_data._fetch_frame", side_effect=[self.frame(30), self.frame()]):
            result = fetch_frame("AAPL", "2026-10-20")
        self.assertEqual(len(result), 210)
        self.assertEqual(result.attrs["source"], "yfinance")

if __name__ == "__main__":
    unittest.main()
