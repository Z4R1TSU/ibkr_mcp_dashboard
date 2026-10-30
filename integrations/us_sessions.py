"""US equity session dates shared by research and the local market adapter."""
from datetime import date, datetime, timedelta
from functools import lru_cache
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
EXCEPTIONS = {"2001-09-11", "2001-09-12", "2001-09-13", "2001-09-14",
              "2004-06-11", "2007-01-02", "2012-10-29", "2012-10-30",
              "2018-12-05", "2025-01-09"}


@lru_cache
def holidays(year):
    def observed(month, day, saturday=True):
        d = date(year, month, day)
        return d + timedelta(days=1 if d.weekday() == 6 else -1 if saturday and d.weekday() == 5 else 0)
    def nth(month, weekday, n):
        d = date(year, month, 1)
        return d + timedelta(days=(weekday - d.weekday()) % 7 + 7 * (n - 1))
    a, b, c = year % 19, year // 100, year % 100
    h = (19 * a + b - b // 4 - ((b - (b + 8) // 25 + 1) // 3) + 15) % 30
    l = (32 + 2 * (b % 4) + 2 * (c // 4) - h - c % 4) % 7
    m = (a + 11 * h + 22 * l) // 451
    e = h + l - 7 * m + 114
    easter = date(year, e // 31, e % 31 + 1)
    memorial = date(year, 5, 31)
    days = {observed(1, 1, False), nth(2, 0, 3), easter - timedelta(days=2),
            memorial - timedelta(days=memorial.weekday()), observed(7, 4),
            nth(9, 0, 1), nth(11, 3, 4), observed(12, 25)}
    if year >= 1998:
        days.add(nth(1, 0, 3))
    if year >= 2022:
        days.add(observed(6, 19))
    return days


def trading_day(day):
    return day.weekday() < 5 and day not in holidays(day.year) and day.isoformat() not in EXCEPTIONS


def close_hour(day):
    if day.month == 11 and day.weekday() == 4 and 23 <= day.day <= 29:
        return 13
    return 13 if (day.month, day.day) in {(7, 3), (12, 24)} else 16


def latest_settled(as_of, now=None):
    now = (now or datetime.now(NY)).astimezone(NY)
    day = min(date.fromisoformat(as_of), now.date())
    if day == now.date() and now.hour * 60 + now.minute < close_hour(day) * 60 + 15:
        day -= timedelta(days=1)
    while not trading_day(day):
        day -= timedelta(days=1)
    return day.isoformat()
