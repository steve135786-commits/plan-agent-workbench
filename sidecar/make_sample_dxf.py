#!/usr/bin/env python3
"""Build the synthetic sample plan data/plans/sample-residential-plan.dxf.

SYNTHETIC fixture only — NOT a real parcel, NOT a real project. A simple
two-room rectangular plan, drawn to the CAD-lecture layering habit:

- WALL: outer walls 12000 x 8000 mm, one inner wall, one column circle
- WINDOW: three window openings as thin rectangles on the wall lines
- DOOR: two doors, leaf line + swing arc each
- DIMENSION: dimension lines + TEXT (12000 / 8000 / 7000) + SYNTHETIC note
- AXIS: two grid axes (1 / A) with labels

R2007, drawing units mm, origin at the lower-left corner of the plan.
Re-run this script to regenerate the fixture deterministically.

Usage:
    python3 sidecar/make_sample_dxf.py [--out data/plans/sample-residential-plan.dxf]
"""

import argparse
from pathlib import Path

import ezdxf
from ezdxf.enums import TextEntityAlignment

ROOT = Path(__file__).resolve().parent.parent

# Plan geometry, millimetres. All values SYNTHETIC.
W, H = 12000, 8000          # outer plan size
INNER_X = 7000              # inner wall x
DOOR1_Y0, DOOR1_Y1 = 3500, 4400   # door gap in the inner wall (900 wide)
DOOR2_X0, DOOR2_X1 = 5500, 6400   # door gap in the south wall (900 wide)


def build(path: Path) -> None:
    doc = ezdxf.new("R2007", setup=True)
    doc.units = ezdxf.units.MM  # $INSUNITS = 4 (millimetres)
    doc.header["$MEASUREMENT"] = 1  # metric
    msp = doc.modelspace()

    for name, color in (("WALL", 7), ("WINDOW", 4), ("DOOR", 3),
                        ("DIMENSION", 2), ("AXIS", 1)):
        doc.layers.add(name, color=color)

    # --- WALL: outer walls (south wall split for the entrance door gap) ---
    msp.add_line((0, 0), (0, H), dxfattribs={"layer": "WALL"})               # west
    msp.add_line((0, H), (W, H), dxfattribs={"layer": "WALL"})               # north
    msp.add_line((W, 0), (W, H), dxfattribs={"layer": "WALL"})               # east
    msp.add_line((0, 0), (DOOR2_X0, 0), dxfattribs={"layer": "WALL"})        # south-a
    msp.add_line((DOOR2_X1, 0), (W, 0), dxfattribs={"layer": "WALL"})        # south-b
    # inner wall, split for the interior door gap
    msp.add_line((INNER_X, 0), (INNER_X, DOOR1_Y0), dxfattribs={"layer": "WALL"})
    msp.add_line((INNER_X, DOOR1_Y1), (INNER_X, H), dxfattribs={"layer": "WALL"})
    # column (tests CIRCLE conversion)
    msp.add_circle((3500, 4000), radius=200, dxfattribs={"layer": "WALL"})

    # --- WINDOW: thin rectangles straddling the wall lines ---
    for x0, x1, y0, y1 in ((2000, 3200, -120, 120),      # south wall
                           (8000, 9200, -120, 120),      # south wall
                           (4000, 5200, H - 120, H + 120)):  # north wall
        msp.add_lwpolyline([(x0, y0), (x1, y0), (x1, y1), (x0, y1)],
                           close=True, dxfattribs={"layer": "WINDOW"})

    # --- DOOR: leaf line + quarter-circle swing arc ---
    # interior door, hinge at (INNER_X, DOOR1_Y0), swings into the right room
    msp.add_line((INNER_X, DOOR1_Y0), (INNER_X + 900, DOOR1_Y0),
                 dxfattribs={"layer": "DOOR"})
    msp.add_arc((INNER_X, DOOR1_Y0), radius=900, start_angle=0, end_angle=90,
                dxfattribs={"layer": "DOOR"})
    # entrance door, hinge at (DOOR2_X0, 0), swings inward
    msp.add_line((DOOR2_X0, 0), (DOOR2_X0, 900), dxfattribs={"layer": "DOOR"})
    msp.add_arc((DOOR2_X0, 0), radius=900, start_angle=0, end_angle=90,
                dxfattribs={"layer": "DOOR"})

    # --- DIMENSION: dimension lines, extension lines, TEXT ---
    def dimline(p0, p1, e0, e1, text, tpos):
        msp.add_line(p0, p1, dxfattribs={"layer": "DIMENSION"})
        msp.add_line(e0[0], e0[1], dxfattribs={"layer": "DIMENSION"})
        msp.add_line(e1[0], e1[1], dxfattribs={"layer": "DIMENSION"})
        msp.add_text(text, dxfattribs={"layer": "DIMENSION", "height": 300}
                     ).set_placement(tpos, align=TextEntityAlignment.MIDDLE_CENTER)

    dimline((0, 8600), (W, 8600), ((0, H), (0, 8800)), ((W, H), (W, 8800)),
            "12000", (W / 2, 8700))
    dimline((-600, 0), (-600, H), ((0, 0), (-800, 0)), ((0, H), (-800, H)),
            "8000", (-700, H / 2))
    dimline((0, -600), (INNER_X, -600), ((0, 0), (0, -800)),
            ((INNER_X, 0), (INNER_X, -800)), "7000", (INNER_X / 2, -700))
    msp.add_text("SYNTHETIC SAMPLE PLAN - NOT A REAL PARCEL",
                 dxfattribs={"layer": "DIMENSION", "height": 300}
                 ).set_placement((0, 9500), align=TextEntityAlignment.LEFT)

    # --- AXIS: grid axes with labels ---
    msp.add_line((0, -1000), (0, 9000), dxfattribs={"layer": "AXIS"})
    msp.add_line((-1000, 0), (13000, 0), dxfattribs={"layer": "AXIS"})
    msp.add_text("1", dxfattribs={"layer": "AXIS", "height": 250}
                 ).set_placement((-200, 9150), align=TextEntityAlignment.MIDDLE_CENTER)
    msp.add_text("A", dxfattribs={"layer": "AXIS", "height": 250}
                 ).set_placement((13100, 0), align=TextEntityAlignment.MIDDLE_CENTER)

    path.parent.mkdir(parents=True, exist_ok=True)
    doc.saveas(path)
    print(f"wrote {path} (R2007, mm, SYNTHETIC)")


def main() -> int:
    ap = argparse.ArgumentParser(description="Build the synthetic sample DXF")
    ap.add_argument("--out", default=str(ROOT / "data/plans/sample-residential-plan.dxf"))
    args = ap.parse_args()
    build(Path(args.out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
