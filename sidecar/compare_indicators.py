#!/usr/bin/env python3
"""W1 step w1-2: compare parcel indicators against regulation limits.

Reads the parcel CSV (same reader as compute_indicators.py — the
formulas below are the same ones) and out/w1/limits.json, and writes
out/w1/checklist-draft.csv: one row per item with item, indicator
value, limit, unit, status (pass / review / fail), clause, page and
notes. Stdlib only.

Status rules, from the limit direction in limits.json:
- max limit: value <= limit is pass, value > limit is fail;
- min limit: value >= limit is pass, value < limit is fail.
A value exactly at the limit is pass — the row note says so.

The parcel CSV carries no height value, so the height row is always
status review with reason "parcel has no height value — cannot
evaluate". A height is never invented here.

Usage:
    python3 sidecar/compare_indicators.py \
        --parcel data/parcels/synthetic-parcel-a.csv \
        --limits out/w1/limits.json --out out/w1
"""

import argparse
import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from compute_indicators import read_parcel  # noqa: E402  (same parcel reader as W2)

# Limit name -> checklist item name. The parcel CSV has no height column,
# so height_limit maps to an item whose value is always missing.
ITEM_NAMES = {
    "far_limit": "far",
    "density_limit": "building_density",
    "green_ratio_min": "green_ratio",
    "height_limit": "building_height",
}


def fail(msg: str) -> int:
    print(f"ERROR: {msg}", file=sys.stderr)
    return 1


def parcel_indicators(parcel: dict) -> dict:
    """The same formulas as compute_indicators.compute (W2 w2-2)."""
    site = parcel["site_area_m2"]
    return {
        "far": parcel["floor_area_m2"] / site,
        "building_density": parcel["footprint_m2"] / site * 100,
        "green_ratio": parcel["green_area_m2"] / site * 100,
        # building_height: no height value in the parcel CSV — see below.
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="W1 w1-2: compare indicators against limits")
    ap.add_argument("--parcel", default=str(ROOT / "data/parcels/synthetic-parcel-a.csv"))
    ap.add_argument("--limits", default=str(ROOT / "out/w1/limits.json"))
    ap.add_argument("--out", default=str(ROOT / "out/w1"))
    args = ap.parse_args()

    parcel_path = Path(args.parcel)
    if not parcel_path.is_file():
        return fail(f"parcel file not found: {parcel_path}")
    limits_path = Path(args.limits)
    if not limits_path.is_file():
        return fail(f"limits file not found: {limits_path} — run w1-1 first")

    try:
        parcel = read_parcel(parcel_path)
    except ValueError as e:
        return fail(str(e))
    values = parcel_indicators(parcel)

    try:
        limits = json.loads(limits_path.read_text(encoding="utf-8"))["limits"]
    except (json.JSONDecodeError, KeyError) as e:
        return fail(f"cannot read limits from {limits_path}: {e}")

    rows = []
    for entry in limits:
        name = entry["name"]
        if name not in ITEM_NAMES:
            return fail(f"limits.json names unknown limit {name!r}")
        item = ITEM_NAMES[name]
        limit = float(entry["value"])
        direction = entry["direction"]
        if direction not in ("max", "min"):
            return fail(f"limit {name!r} has unknown direction {direction!r}")

        if item == "building_height":
            rows.append({
                "item": item, "indicator_value": "", "limit": f"{limit:g}",
                "unit": entry["unit"], "status": "review",
                "clause": entry["clause"], "page": entry["page"],
                "notes": "parcel has no height value — cannot evaluate",
            })
            continue

        value = values[item]
        if direction == "max":
            status = "pass" if value <= limit else "fail"
            note = "at the limit — pass (value equals limit, not above it)" if value == limit else ""
        else:
            status = "pass" if value >= limit else "fail"
            note = "minimum limit — value above the minimum" if status == "pass" else ""
        rows.append({
            "item": item, "indicator_value": f"{value:.6g}", "limit": f"{limit:g}",
            "unit": entry["unit"], "status": status,
            "clause": entry["clause"], "page": entry["page"],
            "notes": note,
        })

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "checklist-draft.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["item", "indicator_value", "limit", "unit", "status",
                    "clause", "page", "notes"])
        for r in rows:
            w.writerow([r["item"], r["indicator_value"], r["limit"], r["unit"],
                        r["status"], r["clause"], r["page"], r["notes"]])

    for r in rows:
        val = r["indicator_value"] or "(no value)"
        print(f"{r['item']}: {val} vs {r['limit']} {r['unit']} — {r['status']} "
              f"(clause {r['clause']}, page {r['page']})")
    print(f"wrote {out / 'checklist-draft.csv'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
