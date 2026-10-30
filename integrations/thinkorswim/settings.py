"""Configuration and private, atomic storage. Never log configuration values."""
import json
import os
import secrets
import stat
from pathlib import Path
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[2]
WS_URL = "wss://thinkorswim-services.schwab.com/Services/WsJson"
ORIGIN = "https://trade.thinkorswim.com"


def settings():
    env = {**dotenv_values(ROOT / ".env"), **os.environ}
    directory = Path(env.get("TOS_DATA_DIR") or ROOT / "data/thinkorswim").resolve()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory, 0o700)
    port = int(env.get("TOS_PORT") or 8051)
    if not 1024 <= port <= 65535:
        raise ValueError("Invalid TOS_PORT")
    return {"directory": directory, "port": port,
            "proxy": env.get("TOS_HTTP_PROXY") or env.get("TRADINGAGENTS_HTTP_PROXY") or env.get("IBKR_HTTP_PROXY") or None,
            "history_range": env.get("TOS_HISTORY_RANGE") or "YEAR5",
            "adjustment": env.get("TOS_HISTORY_ADJUSTMENT") or "unknown",
            "expiry": env.get("TOS_OPTION_EXPIRY") or None,
            "strikes": min(20, max(2, int(env.get("TOS_OPTION_STRIKES") or 10)))}


def private_json(path, value):
    temporary = path.with_name(path.name + "." + secrets.token_hex(4) + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(value, output, ensure_ascii=False, allow_nan=False)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def read_private(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
        raise ValueError("Private file permissions invalid")
    return json.loads(path.read_text())


def api_key(directory):
    path = directory / "api-key.json"
    if not path.exists():
        private_json(path, {"key": secrets.token_urlsafe(32)})
    return read_private(path)["key"]
