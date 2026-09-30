import contextlib
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import sys
import threading

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
        analysts = ("market", "social", "news", "fundamentals")
        graph = TradingAgentsGraph(config=config, selected_analysts=analysts, callbacks=[Progress()])
        account = AccountContext(payload["account"]) if payload.get("account") is not None else None
        emit("progress", stage="读取公开资料与账户上下文")
        state, rating = graph.propagate(ticker, payload["date"], portfolio=account)
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
            f"引擎：TradingAgents {__version__} / {REVISION[:7]}\n\n"
            "本报告仅为研究。评级、仓位与价格方案均未执行，系统没有下单接口。"
            "公开数据可能延迟或缺失；具体缺口以各分析章节为准。\n\n"
        )
        if payload.get("account") is None:
            header += "账户上下文：未提供持仓快照，本次只研究公开标的，不推定用户空仓。\n\n"
        else:
            facts = payload["account"]
            freshness = "旧快照，可能已过期" if facts.get("stale") else "研究启动时的缓存快照"
            header += f"账户上下文：{facts.get('fetchedAt', '未知时间')}（{freshness}）。\n\n"
        summary = header + "## 综合研究结论\n\n" + final
        report = header + "\n\n".join("## " + title + "\n\n" + (text or "本次未生成此章节。") for title, text in sections)
        Path("report.md").write_text(report, encoding="utf-8")
        emit("result", summary=summary, report=report, rating=str(rating), revision=REVISION,
             model=payload["model"], analysts=list(analysts))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        token = os.environ.get("OPENAI_COMPATIBLE_API_KEY", "")
        detail = str(error).replace(token, "[redacted]") if token else str(error)
        emit("error", errorType=type(error).__name__, detail=detail[:500])
        sys.exit(1)
