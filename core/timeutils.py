"""Timezone helpers.

The legacy build_tracker.py hard-coded Sydney at UTC+10, which is wrong for
roughly half the year (AEDT is UTC+11 from early Oct to early Apr). We use the
IANA zone instead so day boundaries are correct year-round.
"""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

SYDNEY = ZoneInfo("Australia/Sydney")


def sydney_today() -> str:
    """Today's date in Sydney, as an ISO 'YYYY-MM-DD' string."""
    return datetime.now(SYDNEY).date().isoformat()


def sydney_now() -> str:
    """Current Sydney wall-clock time as 'HH:MM' (24-hour)."""
    return datetime.now(SYDNEY).strftime("%H:%M")
