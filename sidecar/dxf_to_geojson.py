#!/usr/bin/env python3
"""W2 step w2-1: convert a DXF floor plan to GeoJSON (+ SHP) by layer.

Reads data/plans/sample-residential-plan.dxf (SYNTHETIC) and writes
out/w2/plan.geojson, out/w2/conversion-log.md and, when pyshp is
available, shapefiles. Stdlib-only except ezdxf (and pyshp for SHP).

Rules from workflows/w2-cad-gis-metrics.yaml, enforced here:
- CRS / units are parameters, not assumptions: a units mismatch is a
  hard error (exit 1, write nothing), never a silent conversion;
- every conversion warning is logged (conversion-log.md) and printed;
- coordinates are local planar metres relative to the plan origin
  (0,0 = lower-left corner). They are NOT lon/lat: the W2 YAML
  default CRS EPSG:4326 does NOT apply to them, and no .prj file is
  written — a 4326 .prj on metre coordinates would be a lie;
- a shapefile holds a single geometry type, so lines go in plan.shp,
  polygons in plan_polygons.shp and points in plan_points.shp;
- all inputs are SYNTHETIC examples, not a real parcel.

Supported entities: LINE, LWPOLYLINE, POLYLINE, CIRCLE, ARC, TEXT.
Anything else is skipped with a warning, never silently dropped.

Usage:
    python3 sidecar/dxf_to_geojson.py [--dxf data/plans/sample-residential-plan.dxf]
        [--out out/w2] [--units mm] [--no-shp]
"""

import argparse
import json
import sys
from pathlib import Path

import ezdxf
from ezdxf import path as ezdxf_path

ROOT = Path(__file__).resolve().parent.parent

# DXF $INSUNITS codes and the mm->m conversion factor for each.
UNITS = {"mm": (4, 0.001), "m": (6, 1.0)}
EXPECTED_LAYERS = ("WALL", "WINDOW", "DOOR", "DIMENSION", "AXIS")
PATH_TYPES = ("LINE", "LWPOLYLINE", "POLYLINE", "CIRCLE", "ARC")
MAX_COORD_M = 1_000_000  # sanity bound for converted coordinates, metres


def fail(msg: str) -> int:
    print(f"ERROR: {msg}", file=sys.stderr)
    return 1


def convert_points(points, factor: float) -> list:
    """Vec3 drawing-unit points -> [x, y] metres, rounded to 1 um."""
    return [[round(p.x * factor, 6), round(p.y * factor, 6)] for p in points]


def entity_geometry(entity, factor: float):
    """Return (geojson_type, coordinates) or None when not convertible."""
    if entity.dxftype() == "TEXT":
        ins = entity.dxf.insert
        return "Point", [round(ins.x * factor, 6), round(ins.y * factor, 6)]
    try:
        pts = list(ezdxf_path.make_path(entity).flattening(10))
    except Exception:
        return None
    if len(pts) < 2:
        return None
    coords = convert_points(pts, factor)
    if coords[0] == coords[-1] and len(coords) >= 4:
        return "Polygon", [coords]  # closed ring
    return "LineString", coords


def main() -> int:
    ap = argparse.ArgumentParser(description="W2 w2-1: DXF -> GeoJSON (+SHP)")
    ap.add_argument("--dxf", default=str(ROOT / "data/plans/sample-residential-plan.dxf"))
    ap.add_argument("--out", default=str(ROOT / "out/w2"))
    ap.add_argument("--units", default="mm", choices=sorted(UNITS))
    ap.add_argument("--no-shp", action="store_true",
                    help="skip shapefile output even when pyshp is installed")
    args = ap.parse_args()

    if args.units not in UNITS:
        return fail(f"unsupported units {args.units!r} (expected one of {sorted(UNITS)})")
    expected_insunits, factor = UNITS[args.units]

    dxf_path = Path(args.dxf)
    if not dxf_path.is_file():
        return fail(f"DXF input not found: {dxf_path}")
    try:
        doc = ezdxf.readfile(str(dxf_path))
    except Exception as exc:
        return fail(f"cannot read DXF {dxf_path}: {exc}")

    # Fail loud on units mismatch — before writing anything.
    declared = doc.header.get("$INSUNITS", 0)
    if declared != expected_insunits:
        return fail(
            f"units mismatch: DXF declares $INSUNITS={declared}, "
            f"expected {expected_insunits} ({args.units}) — refusing to convert"
        )

    warnings: list = []
    features: list = []
    layer_counts: dict = {}
    entities = sorted(doc.modelspace(), key=lambda e: e.dxf.handle)
    for entity in entities:
        dtype = entity.dxftype()
        layer = entity.dxf.layer
        handle = entity.dxf.handle
        if dtype not in PATH_TYPES and dtype != "TEXT":
            warnings.append(
                f"skipped unsupported entity type {dtype} on layer {layer} "
                f"(handle {handle}) — no geometry written for it"
            )
            continue
        geom = entity_geometry(entity, factor)
        if geom is None:
            warnings.append(
                f"skipped {dtype} on layer {layer} (handle {handle}) — "
                "could not build geometry from it"
            )
            continue
        gtype, coords = geom
        if gtype != "Point":
            for x, y in (coords[0] if gtype == "Polygon" else coords):
                if abs(x) > MAX_COORD_M or abs(y) > MAX_COORD_M:
                    warnings.append(
                        f"out-of-range coordinate in {dtype} on layer {layer} "
                        f"(handle {handle}): ({x}, {y}) m — kept, check the plan"
                    )
                    break
        props = {"layer": layer, "dxf_type": dtype, "handle": handle}
        if dtype == "TEXT":
            props["text"] = entity.dxf.text
        features.append({
            "type": "Feature",
            "properties": props,
            "geometry": {"type": gtype, "coordinates": coords},
        })
        layer_counts[layer] = layer_counts.get(layer, 0) + 1

    for layer in EXPECTED_LAYERS:
        if layer_counts.get(layer, 0) == 0:
            warnings.append(
                f"empty layer {layer} — no features converted from it "
                "(expected a layer in the CAD-lecture habit; check the DXF)"
            )

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    geojson = {
        "type": "FeatureCollection",
        "name": "plan.geojson — SYNTHETIC sample plan",
        "units": f"m (converted from {args.units}, factor {factor})",
        "coordinate_note": (
            "Local planar metres relative to the plan origin "
            "(0,0 = lower-left corner). NOT lon/lat; the W2 YAML default "
            "EPSG:4326 does NOT apply. Real runs must set the project CRS first."
        ),
        "features": features,
    }
    (out / "plan.geojson").write_text(
        json.dumps(geojson, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    # --- SHP output (one geometry type per file) ---
    shp_status = []
    if args.no_shp:
        shp_status.append("SHP skipped by --no-shp flag")
    else:
        try:
            import shapefile
        except ImportError:
            warnings.append("SHP deferred: pyshp is not installed — GeoJSON only")
            shp_status.append("SHP deferred: pyshp not installed")
        else:
            by_type = {"LineString": [], "Polygon": [], "Point": []}
            for f in features:
                by_type[f["geometry"]["type"]].append(f)
            targets = (("plan.shp", "LineString", shapefile.POLYLINE),
                       ("plan_polygons.shp", "Polygon", shapefile.POLYGON),
                       ("plan_points.shp", "Point", shapefile.POINT))
            for fname, gtype, stype in targets:
                group = by_type[gtype]
                if not group:
                    shp_status.append(f"{fname}: no {gtype} features, file not written")
                    continue
                w = shapefile.Writer(str(out / fname), shapeType=stype)
                w.autoBalance = 1
                w.field("LAYER", "C", size=20)
                w.field("DXFTYPE", "C", size=12)
                w.field("HANDLE", "C", size=12)
                w.field("TEXT", "C", size=80)
                for f in group:
                    coords = f["geometry"]["coordinates"]
                    if gtype == "LineString":
                        w.line([coords])
                    elif gtype == "Polygon":
                        w.poly(coords)
                    else:
                        w.point(*coords)
                    p = f["properties"]
                    w.record(p["layer"], p["dxf_type"], p["handle"],
                             p.get("text", ""))
                w.close()
                shp_status.append(f"{fname}: {len(group)} {gtype} features")
            shp_status.append(
                "no .prj written: coordinates are local planar metres "
                "with no real CRS — a 4326 .prj would be wrong"
            )

    # --- conversion log ---
    log_lines = [
        "# W2 conversion log — w2-1 (SYNTHETIC)",
        "",
        f"source: {dxf_path} (R2007, $INSUNITS={declared} = {args.units})",
        f"units conversion: {args.units} -> m, factor {factor}",
        f"features converted: {len(features)}",
        "",
        "## Features per layer",
    ]
    for layer in sorted(layer_counts):
        log_lines.append(f"- {layer}: {layer_counts[layer]}")
    log_lines += ["", "## Shapefiles"]
    log_lines += [f"- {s}" for s in shp_status]
    log_lines += ["", "## Warnings"]
    if warnings:
        log_lines += [f"- {w}" for w in warnings]
    else:
        log_lines.append("- none")
    log_lines += [
        "",
        "## CRS / units — read before reusing these coordinates",
        "- Coordinates are local planar metres relative to the plan origin.",
        "  The W2 YAML default CRS EPSG:4326 does NOT apply — do not mix",
        "  these coordinates with lon/lat data. Real runs must set the",
        "  project CRS first.",
        "- All values are SYNTHETIC examples, not a real parcel.",
    ]
    (out / "conversion-log.md").write_text("\n".join(log_lines) + "\n",
                                            encoding="utf-8")

    print(f"converted {len(features)} features from {dxf_path}")
    for layer in sorted(layer_counts):
        print(f"  {layer}: {layer_counts[layer]}")
    for s in shp_status:
        print(f"  SHP: {s}")
    if warnings:
        print(f"{len(warnings)} warning(s) — see {out / 'conversion-log.md'}")
        for w in warnings:
            print(f"  WARNING: {w}")
    print(f"wrote {out / 'plan.geojson'} and {out / 'conversion-log.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
