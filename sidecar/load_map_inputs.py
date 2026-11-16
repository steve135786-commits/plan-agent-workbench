#!/usr/bin/env python3
"""w3-1: load W2 outputs + map template, validate, write map-inputs.json.

Reads plan.geojson + indicators.csv + run-log.md from a W2 output
directory and templates/standard-map.yaml, cross-checks the template
against the workflow parameters (page size, nominal scale), and writes
out/w3/map-inputs.json — the single resolved input for w3-2 (render).

Fails loudly (exit 1, writes nothing) on: missing W2 files, a GeoJSON
with zero features, an indicators CSV missing a required indicator,
a run-log that is missing or empty, a template with no version, or a
template whose page size / nominal scale disagrees with the workflow
parameters. All values here are SYNTHETIC demo values.

Usage:
    load_map_inputs.py --w2-dir out/w2 --template templates/standard-map.yaml \
        --out out/w3 --dpi 300 --page-size A3 --scale 1000
"""

import argparse
import csv
import hashlib
import json
import sys
from pathlib import Path

import yaml

REQUIRED_INDICATORS = (
    "building_density_pct",
    "far",
    "green_ratio_pct",
    "population_persons",
    "population_density_per_ha",
)
REQUIRED_LEGEND_LAYERS = ("WALL", "WINDOW", "DOOR", "DIMENSION", "AXIS")


def fail(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def file_record(path: Path) -> dict:
    return {
        "path": str(path),
        "sha256": sha256(path),
        "bytes": path.stat().st_size,
    }


def read_indicators(path: Path) -> dict:
    values: dict = {}
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            name = (row.get("indicator") or "").strip()
            if not name:
                continue
            try:
                values[name] = float(row["value"])
            except (KeyError, ValueError):
                fail(f"indicators.csv: indicator {name!r} has no numeric value")
    for name in REQUIRED_INDICATORS:
        if name not in values:
            fail(f"indicators.csv: required indicator {name!r} is missing")
    return values


def geometry_bounds(features: list) -> dict:
    xs: list = []
    ys: list = []

    def add_coord(c):
        xs.append(float(c[0]))
        ys.append(float(c[1]))

    for feat in features:
        geom = feat.get("geometry") or {}
        gtype = geom.get("type")
        coords = geom.get("coordinates")
        if coords is None:
            continue
        if gtype == "Point":
            add_coord(coords)
        elif gtype == "LineString":
            for c in coords:
                add_coord(c)
        elif gtype == "Polygon":
            for ring in coords:
                for c in ring:
                    add_coord(c)
        else:
            fail(f"plan.geojson: unsupported geometry type {gtype!r}")
    if not xs:
        fail("plan.geojson: no coordinates found in any feature")
    return {
        "xmin_m": min(xs),
        "xmax_m": max(xs),
        "ymin_m": min(ys),
        "ymax_m": max(ys),
        "width_m": max(xs) - min(xs),
        "height_m": max(ys) - min(ys),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="w3-1: load W2 outputs + map template")
    ap.add_argument("--w2-dir", required=True, help="W2 output directory (out/w2)")
    ap.add_argument("--template", required=True, help="map template YAML")
    ap.add_argument("--out", required=True, help="output directory (out/w3)")
    ap.add_argument("--dpi", required=True, type=int, help="raster DPI (workflow parameter)")
    ap.add_argument("--page-size", required=True, help="page size, e.g. A3 (workflow parameter)")
    ap.add_argument("--scale", required=True, type=int, help="nominal scale denominator, e.g. 1000 (workflow parameter)")
    args = ap.parse_args()

    w2_dir = Path(args.w2_dir)
    template_path = Path(args.template)
    out_dir = Path(args.out)

    if not w2_dir.is_dir():
        fail(f"W2 output directory missing: {w2_dir} — run workflow w2 first")
    geojson_path = w2_dir / "plan.geojson"
    indicators_path = w2_dir / "indicators.csv"
    run_log_path = w2_dir / "run-log.md"
    for p, what in (
        (geojson_path, "plan.geojson"),
        (indicators_path, "indicators.csv"),
        (run_log_path, "run-log.md"),
    ):
        if not p.is_file() or p.stat().st_size == 0:
            fail(f"W2 output missing or empty: {p} ({what}) — run workflow w2 first")
    if not template_path.is_file():
        fail(f"map template missing: {template_path}")

    try:
        geo = json.loads(geojson_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        fail(f"plan.geojson: invalid JSON: {e}")
    features = geo.get("features")
    if not isinstance(features, list) or not features:
        fail("plan.geojson: zero features — refusing to render an empty map")
    layers: dict = {}
    for feat in features:
        props = feat.get("properties") or {}
        layer = props.get("layer")
        if not isinstance(layer, str) or not layer:
            fail("plan.geojson: a feature has no layer property")
        layers.setdefault(layer, {"features": 0, "geometry_types": {}})
        layers[layer]["features"] += 1
        gtype = (feat.get("geometry") or {}).get("type", "unknown")
        layers[layer]["geometry_types"][gtype] = (
            layers[layer]["geometry_types"].get(gtype, 0) + 1
        )
    bounds = geometry_bounds(features)

    indicators = read_indicators(indicators_path)

    try:
        template = yaml.safe_load(template_path.read_text(encoding="utf-8"))
    except yaml.YAMLError as e:
        fail(f"map template: invalid YAML: {e}")
    if not isinstance(template, dict) or "template" not in template:
        fail("map template: top-level 'template' mapping missing")
    t = template["template"]
    version = t.get("version")
    if not version:
        fail("map template: 'template.version' is required")
    page = t.get("page") or {}
    if page.get("size") != args.page_size:
        fail(
            f"map template page size {page.get('size')!r} disagrees with "
            f"workflow parameter {args.page_size!r} — refusing to render"
        )
    scale = t.get("scale") or {}
    if scale.get("nominal") != args.scale:
        fail(
            f"map template nominal scale {scale.get('nominal')!r} disagrees with "
            f"workflow parameter {args.scale!r} — refusing to render"
        )
    if scale.get("mode") not in ("fit",):
        fail(f"map template: unsupported scale mode {scale.get('mode')!r} (want 'fit')")
    legend_layers = [e.get("layer") for e in (t.get("legend") or [])]
    for layer in REQUIRED_LEGEND_LAYERS:
        if layer not in legend_layers:
            fail(f"map template: legend has no entry for layer {layer!r}")
    layout = t.get("layout") or {}
    if "map_frame" not in layout or "side_panel" not in layout:
        fail("map template: layout.map_frame and layout.side_panel are required")

    out_dir.mkdir(parents=True, exist_ok=True)
    result = {
        "workflow": "w3",
        "step": "w3-1",
        "template": {
            "file": str(template_path),
            "version": str(version),
            "name": t.get("name"),
        },
        "w2_outputs": {
            "plan_geojson": file_record(geojson_path),
            "indicators_csv": file_record(indicators_path),
            "run_log": file_record(run_log_path),
            "run_log_reference": f"{run_log_path} (sha256 {sha256(run_log_path)[:16]}...)",
        },
        "parameters": {
            "dpi": args.dpi,
            "page_size": args.page_size,
            "scale_nominal": args.scale,
            "scale_mode": scale.get("mode"),
        },
        "plan": {
            "feature_count": len(features),
            "layers": layers,
            "bounds_m": bounds,
        },
        "indicators": indicators,
        "template_resolved": t,
    }
    (out_dir / "map-inputs.json").write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(
        f"w3-1 OK: {len(features)} features in {len(layers)} layers "
        f"(bounds {bounds['width_m']:.1f} x {bounds['height_m']:.1f} m), "
        f"template {t.get('name')} v{version}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
