"""Bounded public HTTP reads, private shared caches, and a free-tier budget."""
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from urllib.parse import urlparse
import requests

HOSTS = {"data.sec.gov", "www.sec.gov", "www.federalreserve.gov",
         "www.alphavantage.co", "api.stlouisfed.org"}


class SourceUnavailable(ValueError):
    pass


class PublicClient:
    def __init__(self, directory=None, request=None, clock=time.time):
        self.directory = Path(directory or os.environ.get("TRADINGAGENTS_PUBLIC_CACHE_DIR") or "public-cache")
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        stat = self.directory.lstat()
        if not self.directory.is_dir() or self.directory.is_symlink() or stat.st_mode & 0o077:
            raise SourceUnavailable("公开数据缓存目录权限无效")
        self.request, self.clock = request, clock
        self.lock, self.next_request = threading.RLock(), 0.

    @contextmanager
    def file_lock(self, name):
        fd = os.open(self.directory / name, os.O_RDWR | os.O_CREAT, 0o600)
        with os.fdopen(fd, "r+") as handle:
            os.fchmod(handle.fileno(), 0o600)
            fcntl.flock(handle, fcntl.LOCK_EX)
            try:
                yield handle
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    def write(self, file, value):
        fd, name = tempfile.mkstemp(dir=self.directory, prefix=".public-")
        try:
            with os.fdopen(fd, "w") as handle:
                json.dump(value, handle, ensure_ascii=False)
            os.replace(name, file)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def reserve_alpha(self, key):
        name = "alpha-" + hashlib.sha256(key.encode()).hexdigest()[:16] + ".json"
        with self.file_lock(name) as handle:
            handle.seek(0)
            raw = handle.read()
            try:
                times = json.loads(raw) if raw else []
                if not isinstance(times, list) or any(type(t) not in (int, float) for t in times):
                    raise ValueError()
            except (ValueError, TypeError):
                raise SourceUnavailable("免费额度记录损坏，暂停请求以免超额") from None
            times = [t for t in times if self.clock() - 86400 < t <= self.clock()]
            if len(times) >= 25:
                raise SourceUnavailable("Alpha Vantage 免费额度已用完（滚动24小时25次）")
            times.append(self.clock())
            handle.seek(0)
            json.dump(times, handle)
            handle.truncate()
            handle.flush()
            os.fsync(handle.fileno())

    def get(self, url, *, params=None, ttl=300, revision="", alpha=False):
        address = urlparse(url)
        if address.scheme != "https" or address.hostname not in HOSTS or address.username or address.password \
                or address.port not in (None, 443) or address.query or address.fragment:
            raise SourceUnavailable("公开数据地址不在允许范围")
        params = dict(params or {})
        public = {k: v for k, v in params.items() if k.lower() not in ("apikey", "api_key")}
        digest = hashlib.sha256(json.dumps([url, public, revision], sort_keys=True).encode()).hexdigest()
        file = self.directory / (digest + ".json")
        with self.lock, self.file_lock(digest + ".lock"):
            try:
                cached = json.loads(file.read_text())
                age = self.clock() - cached["at"]
                if 0 <= age <= ttl:
                    return cached
            except (OSError, ValueError, KeyError, TypeError):
                pass
            if alpha:
                key = params.get("apikey")
                if not key:
                    raise SourceUnavailable("未配置 ALPHA_VANTAGE_API_KEY")
                self.reserve_alpha(key)
            delay = self.next_request - self.clock()
            if delay > 0:
                time.sleep(min(delay, 0.5))
            self.next_request = self.clock() + 0.5
            if address.hostname.endswith("sec.gov"):
                from tradingagents.dataflows.vendors.sec_edgar import _user_agent
                agent = _user_agent()
            else:
                agent = "ibkr-mcp-dashboard/1.0 public-research"
            headers = {"User-Agent": agent}
            if ttl == 0:
                headers.update({"Cache-Control": "no-cache", "Pragma": "no-cache"})
            try:
                with requests.Session() as session:
                    fetch = self.request or session.get
                    with fetch(url, params=params, headers=headers, timeout=(8, 20),
                               allow_redirects=False, stream=True) as response:
                        if response.status_code != 200:
                            raise SourceUnavailable(address.hostname + " HTTP " + str(response.status_code))
                        chunks, size = [], 0
                        for chunk in response.iter_content(65536):
                            size += len(chunk)
                            if size > 16 * 1024 * 1024:
                                raise SourceUnavailable("公开数据响应超出大小限制")
                            chunks.append(chunk)
                        body = b"".join(chunks).decode("utf-8-sig", errors="replace")
            except requests.RequestException as error:
                raise SourceUnavailable(address.hostname + " " + type(error).__name__) from None
            if alpha:
                parsed = json.loads(body)
                if any(k in parsed for k in ("Information", "Note", "Error Message")):
                    raise SourceUnavailable("Alpha Vantage 请求被拒绝或已达到免费额度")
            value = {"body": body, "at": self.clock(),
                     "fetchedAt": datetime.fromtimestamp(self.clock(), timezone.utc).isoformat(), "url": url}
            self.write(file, value)
            return value

    def json(self, url, **kwargs):
        result = self.get(url, **kwargs)
        return json.loads(result["body"]), result
