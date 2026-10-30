"""Print only market capability summaries, never broker or local API credentials."""
import json
import sys
from pathlib import Path
from urllib.request import build_opener, ProxyHandler, Request
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "integrations/thinkorswim"))
from settings import settings, read_private

config = settings()
key = read_private(config["directory"] / "api-key.json")["key"]
opener = build_opener(ProxyHandler({}))
base = "http://127.0.0.1:" + str(config["port"])
def get(path):
    request = Request(base + path, headers={"Authorization": "Bearer " + key})
    try:
        with opener.open(request, timeout=10) as response:
            return json.load(response)
    except Exception:
        return None

status = get("/v1/status")
print(json.dumps({"status": status}, ensure_ascii=False))
for symbol, row in (get("/v1/quotes") or {}).get("quotes", {}).items():
    print(json.dumps({"symbol": symbol, "isDelayed": row["isDelayed"],
        "receivedAt": row["receivedAt"], "sourceTime": row["sourceTime"], "fields": row["returnedFields"]}))
for symbol in ("AAPL", "SPY"):
    value = get("/v1/history?symbol=" + symbol)
    if value:
        print(json.dumps({"history": symbol, "bars": value["count"], "latestDate": value["latestDate"],
            "earliestDate": value["bars"][0]["date"] if value["bars"] else None, "adjustment": value["adjustment"]}))
chain = (get("/v1/options") or {}).get("chain")
if chain:
    print(json.dumps({"options": "SPY", "series": chain["series"]["name"],
        "strikes": len(chain["pairs"]), "contracts": len(chain["quotes"]),
        "minStrike": chain["minStrike"], "maxStrike": chain["maxStrike"],
        "fields": sorted({f for q in chain["quotes"].values() for f in q["returnedFields"]})}))
raise SystemExit(0 if status and status.get("connected") else 2)
