import contextlib
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import sys
import threading

# Some Linux Python builds omit the standard SQLite extension.
try:
    import sqlite3
except ModuleNotFoundError as error:
    if error.name not in ("sqlite3", "_sqlite3"):
        raise
    import pysqlite3
    sys.modules["sqlite3"] = pysqlite3

REVISION = "8b22d43d01d9ddda5d686d093d5385884622f3de"
protocol_output = sys.stdout
output_lock = threading.Lock()


def emit(event, **fields):
    with output_lock:
        print(json.dumps({"event": event, **fields}, ensure_ascii=False), file=protocol_output, flush=True)


class AccountContext:
    def __init__(self, facts):
        self.facts = facts

    def render(self, ticker):
        return (
            "以下是研究启动时的只读账户事实，不是下单权限或历史持仓。"
            "必须保留快照时效、币种、股票与期权区别；null 是未知而不是零。"
            "现金不等于可用于交易的资金，不能自行计算未核实的换汇或保证金。\n"
            "navWeight 是小数比例；保证金缓冲率只能用 excessLiquidity / equityWithLoan。"
            "独立报价、持仓估值与平均成本的时间和单位不可混用。\n"
            + json.dumps(self.facts, ensure_ascii=False)
        )

    def fingerprint(self):
        return hashlib.sha256(json.dumps(self.facts, sort_keys=True).encode()).hexdigest()[:12]


def configure_bridge_client(timeout_seconds=1805):
    from dataclasses import replace
    from tradingagents.llm_clients.openai_client import LocalCompatibleChatOpenAI, OPENAI_COMPATIBLE_PROVIDERS

    class BridgeChatModel(LocalCompatibleChatOpenAI):
        use_responses_api: bool = False
        request_timeout: float = timeout_seconds

    OPENAI_COMPATIBLE_PROVIDERS["openai_compatible"] = replace(
        OPENAI_COMPATIBLE_PROVIDERS["openai_compatible"], chat_class=BridgeChatModel
    )


def partial_state(data, reason="关键行情、财报或新闻不可用"):
    return {
        "final_trade_decision": f"资料不足，暂不评级。{reason}；本次仅保存可用资料，不生成配置或价格建议。",
        "market_report": data.prefetched.get("market", "未知"),
        "fundamentals_report": data.prefetched.get("financials", "未知"),
        "news_report": data.prefetched.get("news", "未知"),
        "sentiment_report": "**Overall Sentiment:** Unknown\n**Score:** N/A\n未完成有效样本评估。",
        "investment_plan": "资料不足，未进行方向性多空结论。",
        "trader_investment_plan": "资料不足，不生成仓位或交易方案。",
    }


def finalize_state(data, state, rating):
    validation, errors, warnings = {}, [], []
    for name in ("market_report", "news_report", "sentiment_report", "investment_plan",
                 "trader_investment_plan", "final_trade_decision"):
        checked = data.prices.inspect(state.get(name, ""))
        state[name] = checked["text"]
        failures = [i for i in checked["issues"] if i["severity"] == "error"]
        errors.extend(failures)
        warnings.extend(i for i in checked["issues"] if i["severity"] != "error")
        validation[name] = {**checked, "errors": [i["message"] for i in failures],
                            "stage": data.price_guards.get(name)}
    if not data.prices.valid or "latest" not in data.prices.facts:
        errors.append({"code": "missing_quote", "message": "缺少已核验的研究启动报价"})
    financial_errors = data.book.check_report("\n".join(v for v in state.values() if isinstance(v, str)))
    corrected = [name for name, trace in data.price_guards.items() if trace["status"] == "corrected"]
    data.validation = {"status": "blocked" if errors or financial_errors else "corrected" if corrected else "passed",
                       "correctedSections": corrected, "unverifiedStatements": len(warnings)}
    return finish_validation(data, state, rating, validation, errors, financial_errors, corrected)


def finish_validation(data, state, rating, validation, errors, financial_errors, corrected):
    data.coverage["price_validation"] = {"status": "unavailable" if errors else "available",
        "reason": errors[0]["message"] if errors else "局部价格表述已修正" if corrected else ""}
    if financial_errors:
        data.coverage["financial_validation"] = {"status": "unavailable", "reason": financial_errors[0]}
    (data.directory / "price-validation.json").write_text(
        json.dumps(validation, ensure_ascii=False), encoding="utf-8")
    (data.directory / "price-facts.json").write_text(
        json.dumps(data.prices.facts, ensure_ascii=False), encoding="utf-8")
    if errors or financial_errors:
        reason = errors[0]["message"] if errors else financial_errors[0]
        return partial_state(data, reason), "Not rated"
    return {name: data.prices.render(value) if isinstance(value, str) else value
            for name, value in state.items()}, rating


def main():
    os.umask(0o077)
    os.environ["PYTHON_DOTENV_DISABLED"] = "1"
    payload = json.loads(sys.stdin.read(524289))
    ticker = payload["ticker"]
    if not re.fullmatch(r"[A-Z0-9][A-Z0-9.\-]{0,19}", ticker) or ".." in ticker:
        raise ValueError("Invalid research ticker")
    with contextlib.redirect_stdout(sys.stderr):
        from tradingagents import __version__
        from tradingagents.default_config import build_default_config
        from tradingagents.graph.trading_graph import TradingAgentsGraph
        from langchain_core.callbacks import BaseCallbackHandler

        provenance = json.loads(importlib.metadata.distribution("tradingagents").read_text("direct_url.json") or "{}")
        if __version__ != "0.5.2" or REVISION not in provenance.get("url", ""):
            raise RuntimeError("Install the pinned TradingAgents requirements")
        configure_bridge_client(payload["timeoutSeconds"])

        class Progress(BaseCallbackHandler):
            def on_chat_model_start(self, serialized, messages, *, metadata=None, **kwargs):
                stage = (metadata or {}).get("langgraph_node", "模型分析")
                emit("progress", stage=str(stage)[:80])

            def on_tool_start(self, serialized, input_str, **kwargs):
                emit("progress", stage="查询 " + str((serialized or {}).get("name", "公开数据"))[:70])

        config = build_default_config()
        config.update({
            "llm_provider": "openai_compatible",
            "deep_think_llm": payload["model"],
            "quick_think_llm": payload["model"],
            "backend_url": payload["bridgeUrl"],
            "output_language": "简体中文",
            "max_tokens": payload["maxTokens"],
            "llm_max_retries": 0,
            "checkpoint_enabled": False,
            "results_dir": str(Path.cwd() / "upstream"),
            "data_cache_dir": str(Path.cwd() / "cache"),
            "memory_log_path": str(Path.cwd() / "research-memory.md"),
        })
        news_vendor = os.environ.get("TRADINGAGENTS_NEWS_VENDOR", "yfinance")
        if news_vendor not in ("yfinance", "alpha_vantage"):
            raise ValueError("TRADINGAGENTS_NEWS_VENDOR must be yfinance or alpha_vantage")
        config["data_vendors"]["news_data"] = news_vendor
        # -I intentionally omits cwd. Import only our trusted adapter directory.
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from data_runtime import DataRuntime
        from rating_scale import RATINGS, rating_scale
        from tradingagents.dataflows.config import run_config
        analysts = ("market", "social", "news", "fundamentals")
        account = AccountContext(payload["account"]) if payload.get("account") is not None else None
        data = DataRuntime(ticker, payload["date"], Path.cwd(), payload.get("marketContext"))
        Path("account-context.json").write_text(json.dumps(payload.get("account"), ensure_ascii=False), encoding="utf-8")
        emit("progress", stage="核验行情、财报与新闻覆盖")
        try:
            data.install()
            with run_config(config), rating_scale():
                if data.preflight():
                    graph = TradingAgentsGraph(config=config, selected_analysts=analysts, callbacks=[Progress()])
                    state, rating = graph.propagate(ticker, payload["date"], portfolio=account)
                    state, rating = finalize_state(data, state, rating)
                else:
                    state, rating = partial_state(data), "Not rated"
        finally:
            data.close()
        emit("result", **build_result(data, state, rating, payload, __version__))


def build_result(data, state, rating, payload, engine_version):
    from rating_scale import RATINGS
    ticker = payload["ticker"]
    analysts = ("market", "social", "news", "fundamentals")
    quality = data.quality()
    if rating not in RATINGS and rating not in ("Not rated", "REVIEW"):
        raise ValueError("TradingAgents returned an unsupported research rating")
    (data.directory / "data-coverage.json").write_text(json.dumps(data.coverage, ensure_ascii=False), encoding="utf-8")
    final = state.get("final_trade_decision", "")
    if not isinstance(final, str) or not final.strip():
        raise RuntimeError("TradingAgents returned no final research report")
    required_reports = ("market_report", "sentiment_report", "news_report", "fundamentals_report",
                        "investment_plan", "trader_investment_plan")
    if any(not isinstance(state.get(name), str) or not state[name].strip() for name in required_reports):
        raise RuntimeError("TradingAgents did not complete every required research stage")
    sections = [
        ("综合研究结论", final),
        ("技术面研究", state.get("market_report", "")),
        ("基本面研究", state.get("fundamentals_report", "")),
        ("新闻研究", state.get("news_report", "")),
        ("市场情绪研究", state.get("sentiment_report", "")),
        ("多空研究汇总", state.get("investment_plan", "")),
        ("情景方案（非交易执行）", state.get("trader_investment_plan", "")),
    ]
    header = (
        f"# {ticker} · TradingAgents 只读研究\n\n"
        f"研究日期：{payload['date']}（纽约日期）｜模型：{payload['model']}\n"
        f"研究评级：{rating if rating in RATINGS else '评级待复核' if rating == 'REVIEW' else '暂不评级'}\n"
        f"引擎：TradingAgents {engine_version} / {REVISION[:7]}\n\n"
        f"数据状态：{'部分研究，存在数据缺口' if quality['status'] == 'partial' else '关键数据已核验'}。\n\n"
        "本报告仅为研究。评级、仓位与价格方案均未执行，系统没有下单接口。"
        "公开数据可能延迟或缺失；具体缺口以各分析章节为准。\n\n"
    )
    if payload.get("account") is None:
        header += "账户上下文：未提供持仓快照，本次只研究公开标的，不推定用户空仓。\n\n"
    else:
        facts = payload["account"]
        freshness = "旧快照，可能已过期" if facts.get("stale") else "研究启动时读取的持仓快照"
        header += f"账户上下文：{facts.get('fetchedAt', '未知时间')}（{freshness}）。\n\n"
    header += data.prices.header() + "\n" + data.freshness_report()
    summary = header + data.missing_notice() + "## 综合研究结论\n\n" + final
    def render(rows):
        return header + data.coverage_report() + "\n\n" + "\n\n".join(
            "## " + title + "\n\n" + (text or "本次未生成此章节。") for title, text in rows)
    report = render(sections)
    (data.directory / "report.md").write_text(report, encoding="utf-8")
    # Chat delivery drops the raw statements and release excerpt (about 60% of
    # the text); the agents saw them and the full report keeps them.
    brief = data.financial_brief()
    message_report = report if not brief else render(
        [(title, brief if title == "基本面研究" else text) for title, text in sections]
    ) + "\n\n完整版（含财务三表与业绩公告原文摘录）保存在服务器研究目录，未通过聊天发送。"
    return dict(summary=summary, report=report, messageReport=message_report, rating=str(rating), revision=REVISION,
         model=payload["model"], analysts=list(analysts), quality=quality, validation=getattr(data, "validation", {"status": "blocked"}))

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        token = os.environ.get("OPENAI_COMPATIBLE_API_KEY", "")
        detail = str(error).replace(token, "[redacted]") if token else str(error)
        bridge_code = getattr(error, "code", None) if getattr(error, "type", None) == "research_bridge_error" else None
        emit("error", errorType=type(error).__name__, detail=detail[:500], bridgeCode=bridge_code)
        sys.exit(1)
