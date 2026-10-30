"""Fiscal period ends come from explicit filing text and statement headers."""
from datetime import datetime
import re
from public_data import SourceUnavailable

MONTHS = {name: i for i, name in enumerate(
    ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), 1)}
MONTH = r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?"
DATE = rf"(?:{MONTH}\s+\d{{1,2}},?\s+\d{{4}}|\d{{4}}-\d{{2}}-\d{{2}})"
ENDED = r"(?:(?:quarter|year|period)s?|(?:three|six|nine|twelve|3|6|9|12|13|26|39|52|53)\s+(?:months?|weeks?))\s+ended"
# "...Quarterly Report on Form 10-Q for the quarter ended X" cites another
# filing's period, not the period this release reports.
CITED = re.compile(r"(?:Form\s*10-?[KQ]|Annual Report|Quarterly Reports?)[^.]{0,80}$", re.I)


def date_value(text):
    clean = " ".join(text.replace(",", "").replace(".", "").split())
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", clean):
            return datetime.strptime(clean, "%Y-%m-%d").date().isoformat()
        month, day, year = clean.split()
        return datetime(int(year), MONTHS[month[:3].lower()], int(day)).date().isoformat()
    except (ValueError, KeyError):
        return None


def text_periods(text, source):
    normalized = " ".join(text.split())
    rows = []
    for match in re.finditer(ENDED + r"\s+(" + DATE + r")", normalized, re.I):
        value = date_value(match[1])
        if value and not CITED.search(normalized[max(0, match.start() - 160):match.start()]):
            rows.append({"period": value, "source": source, "locator": f"text:{match.start()}",
                         "text": match[0]})
    return rows


def resolve_period(release_soup, release_text, primary_text="", filed=None):
    item = re.search(r"\bItem\s*2\.02\b", primary_text, re.I)
    primary = []
    if item:
        section = primary_text[item.end():]
        section = re.split(r"\bItem\s*\d+\.\d+\b", section, maxsplit=1, flags=re.I)[0]
        primary = text_periods(section, "8-K Item 2.02")
    release = text_periods(release_text, "业绩公告正文")
    for index, table in enumerate(release_soup.find_all("table")):
        if table.find("table"):
            continue
        rows = table.find_all("tr")
        header = " ".join(row.get_text(" ", strip=True) for row in rows[:6])
        if not re.search(ENDED, header, re.I):
            continue
        if not re.search(r"revenue|income|earnings|cash flows|operating activities", table.get_text(" ", strip=True), re.I):
            continue
        # Read dates cell by cell: headers often split "July 26," and "2026"
        # across rows, and joining rows would pair a day with the wrong year.
        cells = [cell.get_text(" ", strip=True) for row in rows[:6] for cell in row.find_all(["th", "td"])]
        for match in (m for cell in cells for m in re.finditer(DATE, cell, re.I)):
            value = date_value(match[0])
            if value:
                release.append({"period": value, "source": "业绩公告财务表头",
                                "locator": f"table:{index}/header", "text": header[:500]})
    # A results filing reports completed periods; later dates are fiscal-year
    # ends or outlook mentions, not the reported period.
    if filed:
        primary = [r for r in primary if r["period"] <= filed]
        release = [r for r in release if r["period"] <= filed]
    left = max((r["period"] for r in primary), default=None)
    right = max((r["period"] for r in release), default=None)
    if left and right and left != right:
        raise SourceUnavailable(f"8-K 与公告报表期间冲突：{left} / {right}")
    period = left or right
    evidence = [r for r in primary + release if r["period"] == period]
    return period, evidence
