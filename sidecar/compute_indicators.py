#!/usr/bin/env python3
"""W2 step w2-2 demo: compute planning indicators from a synthetic parcel.

Phase 0 / minimal demo only. Stdlib only — no GeoPandas needed for this
step. It reads the post-conversion CSV form of a parcel (what w2-1 would
produce from a DXF) and writes indicators.csv + run-log.md.

Rules from workflows/w2-cad-gis-metrics.yaml, enforced here:
- every indicator logs its formula and parameter values;
- CRS / units are parameters, not assumptions: a units mismatch is a
  hard error, never a silent conversion;
- all inputs are SYNTHETIC examples, not real regulation or parcel data.

Usage:
    python3 sidecar/compute_indicators.py
    python3 sidecar/compute_indicators.py --parcel data/parcels/synthetic-parcel-a.csv \
        --buildings data/parcels/synthetic-buildings.csv --out out/w2

Kernel density (Gaussian, bandwidth h = 300 m from the W2 YAML):
    density(p) = (1 / (n * h^2)) * sum_i  exp(-d_i^2 / (2*h^2)) / (2*pi)
evaluated at the parcel centroid. Building points are local planar
metres around the centroid — NOT lon/lat, so the YAML default
EPSG:4326 does not apply to them; the run log says so explicitly.
"""

import argparse
import csv
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Parameters from workflows/w2-cad-gis-metrics.yaml (with their sources).
HOUSEHOLD_SIZE = 3.0          # persons/household — configurable planning assumption
KERNEL_BANDWIDTH_M = 300.0    # m — kernel density bandwidth for the demo
EXPECTED_UNITS = "m2"         # area units the CSV must declare


def read_parcel(path: Path) -> dict:
    with open(path, newline="", encoding="utf-8") as f:
        row = next(csv.DictReader(f))
    if row.get("units", "").strip() != EXPECTED_UNITS:
        raise ValueError(
            f"units mismatch: parcel declares {row.get('units')!r}, "
            f"expected {EXPECTED_UNITS!r} — refusing to compute"
        )
    fields = ("site_area_m2", "footprint_m2", "floor_area_m2",
              "green_area_m2", "households")
    values = {k: float(row[k]) for k in fields}
    if values["site_area_m2"] <= 0:
        raise ValueError("site_area_m2 must be > 0")
    for k in ("footprint_m2", "floor_area_m2", "green_area_m2"):
        if not 0 <= values[k] <= values["site_area_m2"] * 10:
            raise ValueError(f"{k}={values[k]} looks out of range for this parcel")
    values["household_size"] = float(row.get("household_size", HOUSEHOLD_SIZE))
    values["parcel_id"] = row.get("parcel_id", "SYNTHETIC-A")
    return values


def read_buildings(path: Path) -> list:
    points = []
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            points.append((float(row["x_m"]), float(row["y_m"])))
    if not points:
        raise ValueError("no building points in buildings CSV")
    return points


def kernel_density_at(points, cx: float, cy: float, h: float) -> float:
    """Gaussian KDE, points per m^2, evaluated at (cx, cy)."""
    n = len(points)
    total = 0.0
    for x, y in points:
        d2 = (x - cx) ** 2 + (y - cy) ** 2
        total += math.exp(-d2 / (2 * h * h)) / (2 * math.pi)
    return total / (n * h * h)


def compute(parcel: dict, points: list) -> list:
    site = parcel["site_area_m2"]
    population = parcel["households"] * parcel["household_size"]
    kde_m2 = kernel_density_at(points, 0.0, 0.0, KERNEL_BANDWIDTH_M)
    return [
        ("building_density_pct", parcel["footprint_m2"] / site * 100,
         "footprint_m2 / site_area_m2 * 100"),
        ("far", parcel["floor_area_m2"] / site,
         "floor_area_m2 / site_area_m2"),
        ("green_ratio_pct", parcel["green_area_m2"] / site * 100,
         "green_area_m2 / site_area_m2 * 100"),
        ("population_persons", population,
         "households * household_size"),
        ("population_density_per_ha", population / (site / 10_000),
         "population / (site_area_m2 / 10000)"),
        ("population_density_per_km2", population / (site / 1_000_000),
         "population / (site_area_m2 / 1000000)"),
        ("kernel_density_points_per_m2", kde_m2,
         "Gaussian KDE at centroid, h=300 m, n=5 points"),
        ("kernel_density_points_per_km2", kde_m2 * 1_000_000,
         "kernel_density_points_per_m2 * 1000000"),
    ]


def main() -> int:
    ap = argparse.ArgumentParser(description="W2 w2-2 demo: planning indicators")
    ap.add_argument("--parcel", default=str(ROOT / "data/parcels/synthetic-parcel-a.csv"))
    ap.add_argument("--buildings", default=str(ROOT / "data/parcels/synthetic-buildings.csv"))
    ap.add_argument("--out", default=str(ROOT / "out/w2"))
    args = ap.parse_args()

    parcel = read_parcel(Path(args.parcel))
    points = read_buildings(Path(args.buildings))
    rows = compute(parcel, points)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "indicators.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["indicator", "value", "formula", "source"])
        for name, value, formula in rows:
            w.writerow([name, f"{value:.6g}", formula, "SYNTHETIC demo — workflows/w2-cad-gis-metrics.yaml"])

    log_lines = [
        "# W2 run log — w2-2 demo (SYNTHETIC)",
        "",
        f"parcel: {parcel['parcel_id']} (data/parcels/synthetic-parcel-a.csv)",
        f"site_area_m2: {parcel['site_area_m2']:.0f}  footprint_m2: {parcel['footprint_m2']:.0f}  "
        f"floor_area_m2: {parcel['floor_area_m2']:.0f}  green_area_m2: {parcel['green_area_m2']:.0f}",
        f"households: {parcel['households']:.0f}  household_size: {parcel['household_size']} persons/household",
        f"building points: {len(points)} (data/parcels/synthetic-buildings.csv), "
        f"kernel bandwidth h: {KERNEL_BANDWIDTH_M:.0f} m",
        "",
        "## Indicators",
    ]
    for name, value, formula in rows:
        log_lines.append(f"- {name}: {value:.6g}  — {formula}")
    log_lines += [
        "",
        "## CRS / units — read before reusing these numbers",
        "- Areas are square metres (units field in the CSV, checked by the script).",
        "- Kernel-density points are local planar metres around the parcel centroid.",
        "  The W2 YAML default CRS EPSG:4326 does NOT apply to them — do not mix",
        "  these coordinates with lon/lat data. Real runs must set the project CRS first.",
        "- W2 step w2-1 (DXF -> GeoJSON/SHP, needs ezdxf) is NOT in this demo;",
        "  the CSV here stands in for its output. Step w2-3 (agent review) is also",
        "  not run — nothing here is a compliance verdict.",
        "- All values are SYNTHETIC examples from the workflow YAML, not real",
        "  regulation clauses or a real parcel.",
    ]
    (out / "run-log.md").write_text("\n".join(log_lines) + "\n", encoding="utf-8")

    for name, value, _ in rows:
        print(f"{name}: {value:.6g}")
    print(f"wrote {out / 'indicators.csv'} and {out / 'run-log.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
