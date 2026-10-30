"""Read-only source acceptance probe. No model, account, or messaging calls."""
from datetime import datetime, timezone, timedelta
import json
import os
from pathlib import Path
import re
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
os.umask(0o077)
import worker  # same SQLite compatibility as the production worker
from public_data import PublicClient
from sec_sources import SecSources, NY
from news_sources import NewsSources

symbol = sys.argv[1] if len(sys.argv) > 1 else "GOOG"
if not re.fullmatch(r"[A-Z][A-Z0-9.-]{0,19}", symbol):
    raise SystemExit("Invalid symbol")
cutoff = datetime.now(timezone.utc)
client = PublicClient()
sec = SecSources(symbol, cutoff, client)
news = NewsSources(symbol, cutoff, client, sec)
start = (cutoff.astimezone(NY) - timedelta(days=7)).date().isoformat()
tasks = [("financials", sec.financials), ("insiders", sec.insiders),
         ("company_news", lambda: news.company(start)), ("policy_news", news.global_news)]
failed = False
for name, function in tasks:
    try:
        result = function()
        Path(name + ".md").write_text(result.text, encoding="utf-8")
        Path(name + ".json").write_text(json.dumps(result.records, ensure_ascii=False), encoding="utf-8")
        row = {"source": name, "quality": result.quality, "reason": result.reason,
               "records": len(result.records), "latestPeriod": sec.latest_period,
               "formalPeriod": sec.book.latest_period if sec.book else None}
        if name == "financials":
            sec.book.save(Path.cwd())
        failed |= name == "financials" and result.quality != "verified"
    except Exception as error:
        row = {"source": name, "quality": "unavailable", "reason": str(error)[:200]}
        failed |= name == "financials"
    print(json.dumps(row, ensure_ascii=False), flush=True)
raise SystemExit(1 if failed else 0)
