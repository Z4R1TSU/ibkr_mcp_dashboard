"""Re-evaluate recorded evidence; apply only after current hard checks pass."""
import argparse
from datetime import datetime, timezone
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "integrations/tradingagents"))
import worker
from data_runtime import DataRuntime
from financials import FinancialBook
from rating_scale import RATINGS, _RATING_LINE


def read(path):
    return json.loads(path.read_text())


def atomic(path, text):
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".repair-")
    try:
        with os.fdopen(fd, "w") as output:
            output.write(text)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def prepare(source, destination):
    previous = read(source / "result.json")
    if previous.get("revision") != worker.REVISION:
        raise ValueError("研究版本不匹配，不能自动恢复")
    state = read(next(source.glob("upstream/**/full_states_log_*.json")))
    rating = state.get("final_rating")
    if rating not in RATINGS:
        raise ValueError("原模型没有可恢复的评级")
    label = _RATING_LINE.search(state["final_trade_decision"])
    if not label or " ".join(label[1].lower().split()) != rating:
        raise ValueError("原评级字段和结论文本不一致")
    ticker, date = state["company_of_interest"], state["trade_date"]
    data = DataRuntime(ticker, date, destination, read(source / "market-context.json"))
    data.coverage = read(source / "data-coverage.json")
    if any(data.coverage.get(k, {}).get("status") != "available" for k in ("quote", "market", "financials", "disclosures")):
        raise ValueError("原任务核心数据不完整，不能恢复评级")
    data.prices.restore_facts(read(source / "price-facts.json"))
    return prepare_recorded(data, state, rating, previous, source, destination)


def prepare_recorded(data, state, rating, previous, source, destination):
    evidence = read(source / "source-evidence.json")
    data.source_records = {r["id"]: r for r in evidence["records"]}
    facts = read(source / "financial-facts.json")
    book = SimpleNamespace(rows=facts["statements"], metrics=lambda: facts["metrics"])
    book.latest_period = max(r["end"] for r in book.rows["income_statement"]["Revenue"])
    book.check_report = lambda text: FinancialBook.check_report(book, text)
    data.book = book
    data.sec.latest_period = max((r.get("period") or "" for r in evidence["records"]
                                 if r["source"] in ("SEC 业绩公告", "SEC Company Facts")), default=book.latest_period)
    for name in ("market_report", "news_report", "investment_plan", "trader_investment_plan", "final_trade_decision"):
        if data.prices.check(state[name]):
            raise ValueError("原报告存在明确价格错误，不能直接恢复原评级")
    if book.check_report("\n".join(v for v in state.values() if isinstance(v, str))):
        raise ValueError("原报告未通过财务核验")
    data.prefetched = {k: state.get(k + "_report", "") for k in ("market", "news", "fundamentals")}
    for name in ("market_report", "news_report"):
        state[name] = data.guard_report(name, state[name])
    state, checked_rating = worker.finalize_state(data, state, rating)
    if checked_rating != rating:
        raise ValueError("重新校验没有保留评级，停止恢复")
    payload = {"ticker": data.ticker, "date": data.as_of, "model": previous["model"],
               "account": read(source / "account-context.json")}
    result = worker.build_result(data, state, rating, payload, importlib.metadata.version("tradingagents"))
    note = "> 已更正系统价格校验误判；保留原研究数据时点，此次没有重新调用模型。\n\n"
    for key in ("report", "summary"):
        title, rest = result[key].split("\n", 1)
        result[key] = title + "\n\n" + note + rest.lstrip("\n")
    (destination / "report.md").write_text(result["report"])
    (destination / "result.json").write_text(json.dumps(result, ensure_ascii=False))
    return result


def apply(source, prepared, result):
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive = source / "corrections" / stamp
    archive.mkdir(parents=True, mode=0o700)
    names = ("report.md", "result.json", "data-coverage.json", "price-validation.json",
             "price-facts.json", "price-stage-validation.json")
    for name in names:
        if (source / name).exists():
            shutil.copyfile(source / name, archive / name)
            os.chmod(archive / name, 0o600)
    latest = source.parent / "latest.json"
    current = read(latest) if latest.exists() else None
    if current and current["id"] == source.name:
        shutil.copyfile(latest, archive / "latest.json")
        os.chmod(archive / "latest.json", 0o600)
    for name in [n for n in names if n != "result.json"] + ["result.json"]:
        if (prepared / name).exists():
            atomic(source / name, (prepared / name).read_text())
    correction = {"at": stamp, "reason": "修正价格比较主体误判", "rating": result["rating"],
                  "modelCalls": 0, "originalDataTimePreserved": True, "backup": str(archive)}
    atomic(source / "correction.json", json.dumps(correction, ensure_ascii=False))
    # A new research task may have become the chat's latest while preparing.
    current = read(latest) if latest.exists() else None
    if current and current["id"] == source.name:
        current.update(rating=result["rating"], status="partial" if result["quality"]["status"] == "partial" else "completed",
                       stage="校验误判已更正，评级与报告已保存", correctedAt=stamp)
        atomic(latest, json.dumps(current, ensure_ascii=False))
    return correction


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    source = args.directory.resolve()
    if not source.is_relative_to((ROOT / "data/research").resolve()):
        raise ValueError("只恢复本项目已有研究目录")
    output_root = ROOT / "data/research-verification"
    output_root.mkdir(exist_ok=True, mode=0o700)
    prepared = Path(tempfile.mkdtemp(prefix="rating-correction-", dir=output_root))
    result = prepare(source, prepared)
    correction = apply(source, prepared, result) if args.apply else None
    print(json.dumps({"rating": result["rating"], "validation": result["validation"],
                      "preview": str(prepared), "applied": bool(correction), "modelCalls": 0}, ensure_ascii=False))


if __name__ == "__main__":
    main()
