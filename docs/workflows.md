# Workflow YAML format (v0.0.1)

One file = one workflow. The runner (Phase 1) validates against this format before
executing anything. Deterministic steps must be reproducible: same inputs + same
parameters = same outputs. Agent steps are always logged with the model, prompt and
result, and never silently overwrite a deterministic result.

## Top-level fields

| Field | Required | Meaning |
|---|---|---|
| `workflow` | yes | `version` (format version, currently `0.0.1`), `id` (`w1`/`w2`/`w3`…), `name`, `description` |
| `inputs` | yes | Named inputs: `path` (file or glob), `kind` (`pdf`/`markdown`/`dxf`/`shp`/`geojson`/`csv`/`yaml`), `required` (bool), `note` |
| `parameters` | yes | Named parameters with `value`, `unit`, `source` (where the number came from — never an unexplained magic number) |
| `steps` | yes | Ordered list. Each step: `id`, `kind`, `name`, `runs`/`uses`, `outputs` |
| `outputs` | yes | Named outputs: `path`, `kind`, `note` |
| `audit` | yes | `log` path + `require` list: what every run must record (parameters, projection, formula, source citations) |

## Step kinds

| Kind | Meaning | Rules |
|---|---|---|
| `deterministic` | Pure computation (parse, convert, calculate, render). No model call. | Must log parameters + formula/projection; must fail loudly on CRS/unit errors, never silently emit numbers |
| `agent` | An ACP agent step (Codex / Claude Code): draft text, review a diff, propose a fix | Must log model + prompt + result; output is a *proposal* until a human or a deterministic check accepts it |
| `human_review` | A checkpoint that pauses the run | The run stops here until a human marks pass/fail; used before any compliance verdict is finalised |

## Naming

- Workflow ids: `w1`, `w2`, `w3`…; step ids: `<workflow>-<n>` (e.g. `w2-1`).
- Output files go under `out/` by default, named `<workflow-id>-<date>/…`.
- Example files: `workflows/w1-regulation-screening.yaml`,
  `workflows/w2-cad-gis-metrics.yaml`, `workflows/w3-standard-map.yaml`.

## W1 — regulation screening

Steps: `w1-1` parse regulation → extract limits with clause/page citations (deterministic);
`w1-2` compare parcel indicators against limits (deterministic); `w1-3` agent drafts the
plain-language explanation of each flagged item (agent); `w1-4` human review before the
checklist is finalised. Verdicts are only `pass` / `review` / `fail` — never "compliant"
as an absolute claim. Runner behavior: a `human_review` step pauses the run (exit 3)
after writing the draft outputs; `plan-agent run <workflow> --approve` verifies the
draft is unchanged since the pause, records the human decision in the audit log, and
only then writes the final output.

## W2 — CAD↔GIS + indicators

Steps: `w2-1` convert DXF→GeoJSON/SHP by layer (wall/window/door/dimension/axis) (deterministic);
`w2-2` compute indicators — building density, FAR, green ratio, population density,
kernel density (deterministic, sidecar); `w2-3` agent reviews conversion warnings and
proposes fixes (agent); `w2-4` write indicator CSV + run log. CRS and units are parameters,
not assumptions: a CRS/unit mismatch is an error, not a warning.

## W3 — standard map export

Steps: `w3-1` load W2 outputs + template YAML (deterministic); `w3-2` render PNG/PDF/SVG
at 300 dpi (deterministic); `w3-3` human review of the rendered map. Same data + same
template must render byte-identical output (except the embedded production date).
