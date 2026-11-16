#!/usr/bin/env python3
"""W1 step w1-1: parse an example regulation and extract its limits.

Reads data/regulations/example-regulation.md (SYNTHETIC) and writes
out/w1/limits.json: one entry per limit with name, value, unit, clause
number, page, direction (max/min) and source citation. Stdlib only.

Each limit lives in the regulation twice: as prose and as a
machine-readable marker line, e.g.
    <!-- limit: far_limit = 2.5 | clause 3.2 | page 12 | max -->
The marker is what this script reads; the prose is what a human reads.

Cross-check: the runner passes the workflow parameter values with
--expect name=value (repeatable). Every expected limit must be found
in the regulation with exactly the expected value; a missing limit,
a value mismatch, a duplicate marker, or an unknown limit name is a
hard error (exit 1, write nothing) — a regulation that disagrees with
the workflow parameters must never silently produce limits.

Usage:
    python3 sidecar/parse_regulation.py \
        --regulation data/regulations/example-regulation.md --out out/w1 \
        --expect far_limit=2.5 --expect density_limit=35 \
        --expect green_ratio_min=30 --expect height_limit=60
"""

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Units are intrinsic to the limit name; the workflow only carries values.
KNOWN_LIMITS = {
    "far_limit": "ratio",
    "density_limit": "percent",
    "green_ratio_min": "percent",
    "height_limit": "m",
}

MARKER_RE = re.compile(
    r"<!--\s*limit:\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([0-9]+(?:\.[0-9]+)?)"
    r"\s*\|\s*clause\s+([0-9]+(?:\.[0-9]+)?)\s*\|\s*page\s+([0-9]+)"
    r"\s*\|\s*(max|min)\s*-->"
)
VERSION_RE = re.compile(r"^Version:\s*(.+?)\s*$", re.MULTILINE)
TOLERANCE = 1e-9


def fail(msg: str) -> int:
    print(f"ERROR: {msg}", file=sys.stderr)
    return 1


def parse_expect(raw: list) -> dict:
    expected = {}
    for item in raw:
        if "=" not in item:
            raise ValueError(f"--expect must be name=value, got {item!r}")
        name, value = item.split("=", 1)
        name = name.strip()
        if name not in KNOWN_LIMITS:
            raise ValueError(f"--expect names unknown limit {name!r}")
        try:
            expected[name] = float(value)
        except ValueError:
            raise ValueError(f"--expect value for {name} is not a number: {value!r}")
    return expected


def main() -> int:
    ap = argparse.ArgumentParser(description="W1 w1-1: parse regulation, extract limits")
    ap.add_argument("--regulation", default=str(ROOT / "data/regulations/example-regulation.md"))
    ap.add_argument("--out", default=str(ROOT / "out/w1"))
    ap.add_argument("--expect", action="append", default=[],
                    help="workflow parameter to cross-check, as name=value (repeatable)")
    args = ap.parse_args()

    try:
        expected = parse_expect(args.expect)
    except ValueError as e:
        return fail(str(e))

    reg_path = Path(args.regulation)
    if not reg_path.is_file():
        return fail(f"regulation file not found: {reg_path}")
    text = reg_path.read_text(encoding="utf-8")

    version_match = VERSION_RE.search(text)
    if not version_match:
        return fail(f"no 'Version:' line in {reg_path} — cannot record the regulation version")
    version = version_match.group(1)

    found = {}
    for m in MARKER_RE.finditer(text):
        name, value, clause, page, direction = m.groups()
        if name not in KNOWN_LIMITS:
            return fail(f"regulation declares unknown limit {name!r} (clause {clause})")
        if name in found:
            return fail(f"duplicate marker for limit {name!r} — refusing to parse")
        found[name] = {
            "name": name,
            "value": float(value),
            "unit": KNOWN_LIMITS[name],
            "clause": clause,
            "page": int(page),
            "direction": direction,
            "source": f"{reg_path} clause {clause}, page {page} (SYNTHETIC)",
        }

    for name, want in expected.items():
        if name not in found:
            return fail(f"expected limit {name!r} not found in {reg_path}")
        got = found[name]["value"]
        if abs(got - want) > TOLERANCE:
            return fail(
                f"limit mismatch for {name!r}: regulation says {got:g}, "
                f"workflow parameter says {want:g} — refusing to parse"
            )

    ordered = [found[name] for name in expected] + [
        found[name] for name in found if name not in expected
    ]
    payload = {
        "regulation": {"file": str(reg_path), "version": version},
        "limits": ordered,
    }

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "limits.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    for entry in ordered:
        print(f"{entry['name']}: {entry['value']:g} {entry['unit']} "
              f"(clause {entry['clause']}, page {entry['page']}, {entry['direction']})")
    print(f"wrote {out / 'limits.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
