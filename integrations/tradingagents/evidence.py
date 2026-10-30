"""Source retrieval and analytical sufficiency are separate facts."""
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib


@dataclass
class SourceResult:
    text: str
    records: list = field(default_factory=list)
    quality: str = "verified"  # verified / partial / unavailable
    reason: str = ""


def instant(value):
    if not value:
        return None
    try:
        stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return stamp.astimezone(timezone.utc) if stamp.tzinfo else None
    except (ValueError, TypeError):
        return None


def record(source, url, fetched_at, published_at=None, *, period=None, unit=None,
           revision=None, quality="verified", content_level="structured", **extra):
    if content_level == "headline":
        quality = "partial"
    identity = url + "|" + str(revision or "") + "|" + str(extra.get("locator", ""))
    return {"id": hashlib.sha256(identity.encode()).hexdigest()[:16],
            "source": source, "url": url, "fetchedAt": fetched_at,
            "publishedAt": published_at, "period": period, "unit": unit,
            "revision": revision, "retrievalStatus": "retrieved",
            "verificationStatus": quality, "contentLevel": content_level, **extra}


def citation(row):
    return (f"来源：[{row['source']}]({row['url']})｜发布：{row.get('publishedAt') or '未知'}"
            f"｜期间：{row.get('period') or '不适用'}｜版本：{row.get('revision') or '未知'}")
