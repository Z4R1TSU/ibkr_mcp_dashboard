"""Calculate ratios only with a dated, directly disclosed per-share denominator."""
from decimal import Decimal
from evidence import SourceResult, record, citation


def valuation_result(book, latest_period, quote, source_records):
    prefix = "## 当前价格口径的估值\n不沿用无报价时点的供应商 PE、市值、目标价或预期 EPS。"
    if not quote:
        return SourceResult(prefix + "\n最新报价缺失。", quality="unavailable", reason="没有已核验报价")
    candidates = [r for r in book.rows["income_statement"]["Diluted EPS"]
                  if r["span"] == "annual" and r["end"] == latest_period and r["unit"] == "USD/shares"]
    if len(candidates) != 1 or candidates[0]["val"] <= 0:
        return SourceResult(prefix + "\nTTM 市盈率：未知。没有与最新披露期间一致、可核验的正值滚动年度每股收益；"
                            "不加总不同季度 EPS，也不把单季 EPS 年化。预期估值和多类别股票的总市值暂不推算。",
                            quality="partial", reason="最新期间的 TTM 每股收益或股本口径未核验")
    eps = candidates[0]
    price = quote["reference"]["value"]
    ratio = Decimal(str(price)) / Decimal(str(eps["val"]))
    source = next((r for r in source_records if r["source"] == "SEC Company Facts"), None)
    if not source:
        return SourceResult(prefix, quality="unavailable", reason="估值分母缺少原始出处")
    row = record("程序计算 / SEC", source["url"], source["fetchedAt"], source["publishedAt"],
                 period=latest_period, unit="倍", revision=eps["accn"], locator="ttm_pe",
                 value=str(ratio), formula="研究启动参考价 / 直接披露的年度 diluted EPS",
                 inputs={"price": price, "priceAt": quote["reference"]["receivedAt"], "eps": eps})
    text = prefix + f"\nTTM 市盈率：{ratio:.2f} 倍；分母期间截至 {latest_period}，GAAP 稀释 EPS。"
    return SourceResult(text + "\n" + citation(row), [row])
