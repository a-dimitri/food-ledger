"""Catalogue scaling — turn a saved food + a numeric quantity into entry fields.

A catalogue item ("food") is an *input template*, not a live link. Its `per`
map holds the nutrients for ONE unit; `scale` multiplies those by a quantity to
produce a plain entry dict of the same absolute shape the store already holds
(see core.compute). The entry is a self-contained snapshot: editing or deleting
the catalogue item later never rewrites past entries.

Pure function over plain dicts — no Firestore dependency, so it is unit-testable
and shared by the MCP server (and mirrored trivially in the web form's JS).
"""

from __future__ import annotations

from typing import Any, Optional

from .nutrients import NUTRIENT_KEYS

Food = dict[str, Any]


def _fmt_qty(qty: float) -> str:
    """'2' for whole multipliers, '1.5' otherwise — for the quantity label."""
    return str(int(qty)) if float(qty).is_integer() else f"{qty:g}"


def quantity_label(qty: float, unit: Optional[str]) -> str:
    """Human-readable quantity string, e.g. '2 × serving' or '1.5 × 100g'."""
    return f"{_fmt_qty(qty)} × {unit}" if unit else _fmt_qty(qty)


def scale(item: Food, qty: float, *, date: str, time: Optional[str] = None,
          ndigits: int = 2) -> dict[str, Any]:
    """Materialise a catalogue item at `qty` units into an entry dict.

    Copies name/source across, fills the free-text `quantity` field with a
    readable label, and multiplies each present nutrient in `item['per']` by
    `qty`. Absent nutrients stay absent. Returns only set fields (no None), ready
    to hand to Store.add_entry.
    """
    per = item.get("per") or {}
    fields: dict[str, Any] = {
        "date": date,
        "food": item["name"],
        "quantity": quantity_label(qty, item.get("unit")),
    }
    if time:
        fields["time"] = time
    if item.get("source"):
        fields["source"] = item["source"]
    for k in NUTRIENT_KEYS:
        v = per.get(k)
        if v is not None:
            fields[k] = round(float(v) * qty, ndigits)
    return fields
