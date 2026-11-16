#!/usr/bin/env python3
"""w3-2: render the standard map (PNG / PDF / SVG) from map-inputs.json.

Renders the W2 plan geometry with the template's legend colours, plus
title, legend, scale bar, north arrow, frame, data block, data source
and production date — the furniture a standard planning map carries.

Determinism: fixed fonts (DejaVu Sans, bundled with matplotlib),
fixed colours and fixed layout. Same data + same template renders
identically except the embedded production date (the one sanctioned
difference). --date overrides the production date, so two runs can be
compared byte-for-byte.

Scale honesty: the nominal scale (1:1000) would draw a 14 m parcel
14 mm wide on A3 — unreadable. The renderer fits the plan into the
map frame at the smallest standard scale that fits and prints THAT
scale on the map, in the audit log and in map-inputs.json. The scale
bar is drawn in ground metres at the plotted scale, never the nominal
one.

Fails loudly (exit 1, writes nothing) on: a missing map-inputs.json
or GeoJSON, a template with no layout, or an empty geometry set.

Usage:
    render_map.py --inputs out/w3/map-inputs.json --geojson out/w2/plan.geojson \
        --out out/w3 [--date 2026-11-16]
"""

import argparse
import json
import sys
import textwrap
from datetime import date, datetime, timezone
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import Circle, Polygon as MplPolygon, Rectangle

MM_PER_INCH = 25.4


def fail(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def mm_to_frac(mm: float, page_mm: float) -> float:
    return mm / page_mm


def pick_fit_scale(
    ground_w_m: float, ground_h_m: float, frame_w_mm: float, frame_h_mm: float,
    standard: list,
) -> int:
    """Smallest standard scale 1:N that fits the ground extent in the frame."""
    for n in sorted(standard):
        mm_per_m = 1000.0 / n
        if ground_w_m * mm_per_m <= frame_w_mm and ground_h_m * mm_per_m <= frame_h_mm:
            return int(n)
    fail(
        f"plan extent {ground_w_m:.1f} x {ground_h_m:.1f} m does not fit "
        f"the {frame_w_mm:.0f} x {frame_h_mm:.0f} mm map frame even at 1:{max(standard)}"
    )
    raise AssertionError  # unreachable; fail() exits


def draw_features(ax, features, legend_by_layer):
    """Draw every GeoJSON feature in its layer's template style."""
    drawn = 0
    for feat in features:
        geom = feat.get("geometry") or {}
        props = feat.get("properties") or {}
        layer = props.get("layer")
        style = legend_by_layer.get(layer)
        if style is None:
            fail(f"plan.geojson: layer {layer!r} has no legend entry in the template")
        gtype = geom.get("type")
        coords = geom.get("coordinates")
        colour = style["colour"]
        lw = float(style["width_pt"])
        dashed = style.get("style") == "dashed"
        ls = (0, (4, 3)) if dashed else "solid"
        if gtype == "LineString":
            xs = [c[0] for c in coords]
            ys = [c[1] for c in coords]
            ax.plot(xs, ys, color=colour, linewidth=lw, linestyle=ls,
                    solid_capstyle="butt", zorder=3)
        elif gtype == "Polygon":
            for ring in coords:
                ax.add_patch(MplPolygon(ring, closed=True, facecolor=colour,
                                        alpha=0.18, edgecolor=colour,
                                        linewidth=lw, linestyle=ls, zorder=2))
        elif gtype == "Point":
            text = props.get("text")
            if text:
                ax.text(coords[0], coords[1], str(text), fontsize=8,
                        color=colour, ha="center", va="center", zorder=4,
                        fontweight="bold" if layer == "AXIS" else "normal")
            else:
                ax.plot([coords[0]], [coords[1]], marker="o", markersize=3,
                        color=colour, zorder=4)
        else:
            fail(f"plan.geojson: unsupported geometry type {gtype!r}")
        drawn += 1
    if drawn == 0:
        fail("plan.geojson: zero features drawn — refusing to render an empty map")
    return drawn


def draw_scale_bar(ax, x0_m, y0_m, bar, mm_per_m, scale_n):
    """Alternating black/white bar, `length_m` long, in ground metres."""
    length = float(bar["length_m"])
    seg = float(bar["segment_m"])
    height_m = 0.28
    n_seg = int(round(length / seg))
    for i in range(n_seg):
        ax.add_patch(Rectangle(
            (x0_m + i * seg, y0_m), seg, height_m,
            facecolor="black" if i % 2 == 0 else "white",
            edgecolor="black", linewidth=0.8, zorder=5))
    label_every = float(bar.get("label_every_m", seg))
    x = x0_m
    while x <= x0_m + length + 1e-9:
        ax.text(x, y0_m - 0.42, f"{x - x0_m:.0f}", fontsize=8, ha="center",
                va="top", zorder=5)
        x += label_every
    ax.text(x0_m + length / 2, y0_m + height_m + 0.35,
            f"Plotted scale 1:{scale_n}  —  {bar.get('caption', 'metres (ground)')}",
            fontsize=8, ha="center", va="bottom", zorder=5)


def draw_north_arrow_panel(fig, px, pw, py_top, page_w_mm, page_h_mm, label="N"):
    """North arrow in the side panel, above the legend — never over the plan.

    The arrow used to be drawn inside the map axes at the plan's top-right
    corner, where its white fill masked the wall corner behind it. A north
    arrow must not hide plan geometry, so it now lives in the panel margin
    as a small inset axes (equal aspect, millimetre coordinates). Returns
    the figure-fraction y below the arrow, where the legend should start.
    """
    arrow_w_mm, arrow_h_mm = 18.0, 24.0
    left = px + (pw - mm_to_frac(arrow_w_mm, page_w_mm)) / 2
    top = py_top
    ax = fig.add_axes([
        left,
        top - mm_to_frac(arrow_h_mm, page_h_mm),
        mm_to_frac(arrow_w_mm, page_w_mm),
        mm_to_frac(arrow_h_mm, page_h_mm),
    ])
    ax.set_aspect("equal")
    ax.set_xlim(0, arrow_w_mm)
    ax.set_ylim(0, arrow_h_mm)
    ax.axis("off")
    ax.add_patch(Circle((9, 12), 5.5, facecolor="white",
                        edgecolor="black", linewidth=1.0, zorder=5))
    ax.annotate("", xy=(9, 17), xytext=(9, 7),
                arrowprops=dict(arrowstyle="-|>", color="black", lw=1.5),
                zorder=6)
    ax.text(9, 18.5, label, fontsize=13, fontweight="bold",
            ha="center", va="bottom", zorder=6)
    return top - mm_to_frac(arrow_h_mm, page_h_mm)


def draw_wrapped_text(fig, x, y, text, fontsize, width=50, line_step=0.016):
    """Draw figure text wrapped to fit the side panel.

    matplotlib's ``wrap=True`` does not wrap figure text, so long lines
    (source, scale note) ran off the page edge. Wrap explicitly and
    return the y below the block.
    """
    for line in textwrap.wrap(text, width=width) or [""]:
        fig.text(x, y, line, fontsize=fontsize, ha="left", va="top")
        y -= line_step
    return y


def main() -> int:
    ap = argparse.ArgumentParser(description="w3-2: render the standard map")
    ap.add_argument("--inputs", required=True, help="map-inputs.json from w3-1")
    ap.add_argument("--geojson", required=True, help="W2 plan.geojson")
    ap.add_argument("--out", required=True, help="output directory (out/w3)")
    ap.add_argument("--date", default=None,
                    help="production date YYYY-MM-DD (default: today)")
    args = ap.parse_args()

    inputs_path = Path(args.inputs)
    geojson_path = Path(args.geojson)
    out_dir = Path(args.out)
    if not inputs_path.is_file():
        fail(f"map-inputs.json missing: {inputs_path} — run w3-1 first")
    if not geojson_path.is_file():
        fail(f"plan.geojson missing: {geojson_path} — run workflow w2 first")
    inputs = json.loads(inputs_path.read_text(encoding="utf-8"))
    geo = json.loads(geojson_path.read_text(encoding="utf-8"))
    features = geo.get("features") or []
    if not features:
        fail("plan.geojson: zero features — refusing to render an empty map")

    t = inputs["template_resolved"]
    params = inputs["parameters"]
    bounds = inputs["plan"]["bounds_m"]
    indicators = inputs["indicators"]
    page = t["page"]
    layout = t.get("layout") or {}
    frame = layout.get("map_frame")
    panel = layout.get("side_panel")
    if not frame or not panel:
        fail("template: layout.map_frame and layout.side_panel are required")
    fonts = t.get("fonts") or {}
    family = fonts.get("family", "DejaVu Sans")
    plt.rcParams["font.family"] = family

    page_w_mm = float(page["width_mm"])
    page_h_mm = float(page["height_mm"])
    dpi = int(params["dpi"])
    nominal = int(params["scale_nominal"])
    standard = [int(n) for n in (t.get("scale") or {}).get("standard_scales", [50])]
    scale_n = pick_fit_scale(bounds["width_m"], bounds["height_m"],
                             float(frame["width_mm"]), float(frame["height_mm"]),
                             standard)
    mm_per_m = 1000.0 / scale_n

    if args.date:
        try:
            prod_date = date.fromisoformat(args.date)
        except ValueError:
            fail(f"--date must be YYYY-MM-DD, got {args.date!r}")
    else:
        prod_date = date.today()
    prod_date_s = prod_date.isoformat()
    pdf_when = datetime(prod_date.year, prod_date.month, prod_date.day,
                       12, 0, 0, tzinfo=timezone.utc)

    fig = plt.figure(figsize=(page_w_mm / MM_PER_INCH, page_h_mm / MM_PER_INCH))
    fig.patch.set_facecolor("white")

    # --- outer frame -------------------------------------------------------
    inset = float(layout.get("outer_frame_inset_mm", 8))
    fig.patches.append(Rectangle(
        (mm_to_frac(inset, page_w_mm), mm_to_frac(inset, page_h_mm)),
        mm_to_frac(page_w_mm - 2 * inset, page_w_mm),
        mm_to_frac(page_h_mm - 2 * inset, page_h_mm),
        fill=False, edgecolor="black", linewidth=1.5,
        transform=fig.transFigure, figure=fig, zorder=1))

    # --- title -------------------------------------------------------------
    title = t.get("title") or {}
    tx = mm_to_frac(float(frame["x_mm"]), page_w_mm)
    ty = mm_to_frac(float(layout.get("title_band_top_mm", 272)) + 12, page_h_mm)
    fig.text(tx, ty, title.get("main", "Standard Map"),
             fontsize=float(fonts.get("title_pt", 20)), fontweight="bold",
             ha="left", va="center")
    fig.text(tx, ty - 0.035, title.get("subtitle", ""),
             fontsize=float(fonts.get("subtitle_pt", 11)), ha="left", va="center")

    # --- map axes: exact plotted scale --------------------------------------
    ax = fig.add_axes([
        mm_to_frac(float(frame["x_mm"]), page_w_mm),
        mm_to_frac(float(frame["y_mm"]), page_h_mm),
        mm_to_frac(float(frame["width_mm"]), page_w_mm),
        mm_to_frac(float(frame["height_mm"]), page_h_mm),
    ])
    ax.set_aspect("equal")
    span_x_m = float(frame["width_mm"]) / mm_per_m
    span_y_m = float(frame["height_mm"]) / mm_per_m
    cx = (bounds["xmin_m"] + bounds["xmax_m"]) / 2
    cy = (bounds["ymin_m"] + bounds["ymax_m"]) / 2
    xmin, xmax = cx - span_x_m / 2, cx + span_x_m / 2
    ymin, ymax = cy - span_y_m / 2, cy + span_y_m / 2
    ax.set_xlim(xmin, xmax)
    ax.set_ylim(ymin, ymax)
    ax.set_xticks([])
    ax.set_yticks([])
    for spine in ax.spines.values():
        spine.set_linewidth(1.2)
        spine.set_color("black")

    legend_by_layer = {e["layer"]: e for e in t.get("legend", [])}
    drawn = draw_features(ax, features, legend_by_layer)

    draw_scale_bar(ax, xmin + 0.6, ymin + 0.7, t.get("scale_bar") or {},
                   mm_per_m, scale_n)

    # --- side panel: legend + data block + source + date -------------------
    px = mm_to_frac(float(panel["x_mm"]), page_w_mm)
    pw = mm_to_frac(float(panel["width_mm"]), page_w_mm)
    py_top = mm_to_frac(float(panel["y_mm"]) + float(panel["height_mm"]), page_h_mm)
    legend_pt = float(fonts.get("legend_pt", 10))
    data_pt = float(fonts.get("data_pt", 10))
    small_pt = float(fonts.get("small_pt", 8))
    y = draw_north_arrow_panel(
        fig, px, pw, py_top, page_w_mm, page_h_mm,
        (t.get("north_arrow") or {}).get("label", "N")) - 0.012
    fig.text(px, y, "Legend", fontsize=legend_pt + 2, fontweight="bold",
             ha="left", va="top")
    y -= 0.028
    for entry in t.get("legend", []):
        dashed = entry.get("style") == "dashed"
        fig.add_artist(Line2D(
            [px, px + 0.035], [y - 0.004, y - 0.004],
            color=entry["colour"], linewidth=float(entry["width_pt"]),
            linestyle=(0, (4, 3)) if dashed else "solid",
            transform=fig.transFigure, figure=fig))
        fig.text(px + 0.042, y, entry["label"], fontsize=legend_pt,
                 ha="left", va="center")
        y -= 0.026

    y -= 0.012
    data_block = t.get("data_block") or {}
    fig.text(px, y, data_block.get("title", "Key indicators (W2)"),
             fontsize=data_pt + 2, fontweight="bold", ha="left", va="top")
    y -= 0.028
    for item in data_block.get("items", []):
        name = item["indicator"]
        if name not in indicators:
            fail(f"data block: indicator {name!r} missing from W2 indicators")
        try:
            value = item["format"].format(indicators[name])
        except (KeyError, ValueError) as e:
            fail(f"data block: bad format for {name!r}: {e}")
        fig.text(px, y, f"{item['label']}: {value}", fontsize=data_pt,
                 ha="left", va="center")
        y -= 0.026

    y -= 0.012
    y = draw_wrapped_text(fig, px, y, t.get("source_line", ""), small_pt)
    y -= 0.010
    fig.text(px, y, f"{t.get('date_label', 'Production date')}: {prod_date_s}",
             fontsize=small_pt, ha="left", va="top")
    y -= 0.026
    draw_wrapped_text(
        fig, px, y,
        f"Nominal scale 1:{nominal} — fitted to 1:{scale_n} for this small "
        "demo parcel; scale bar is at the plotted scale.",
        small_pt)

    # --- save all three formats from the same figure -----------------------
    out_dir.mkdir(parents=True, exist_ok=True)
    png_path = out_dir / "map.png"
    pdf_path = out_dir / "map.pdf"
    svg_path = out_dir / "map.svg"
    fig.savefig(png_path, dpi=dpi)
    fig.savefig(pdf_path, metadata={
        "Title": title.get("main", "Standard Map"),
        "Author": "plan-agent (SYNTHETIC demo)",
        "CreationDate": pdf_when,
        "ModDate": pdf_when,
    })
    fig.savefig(svg_path)
    plt.close(fig)

    # Record the plotted scale back into map-inputs.json so the audit log
    # and any later reader see the scale that is actually on the map.
    inputs["render"] = {
        "plotted_scale": scale_n,
        "scale_nominal": nominal,
        "production_date": prod_date_s,
        "features_drawn": drawn,
        "png_px": [int(page_w_mm / MM_PER_INCH * dpi),
                   int(page_h_mm / MM_PER_INCH * dpi)],
    }
    inputs_path.write_text(json.dumps(inputs, indent=2, sort_keys=True) + "\n",
                           encoding="utf-8")
    print(f"w3-2 OK: {drawn} features drawn at plotted scale 1:{scale_n} "
          f"(nominal 1:{nominal}); map.png/pdf/svg written, {prod_date_s}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
