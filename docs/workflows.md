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
| `agent` | An ACP agent step (Codex / Claude Code): draft text, review a diff, propose a fix | Must log model + prompt + result; output is a *proposal* until a human or a deterministic check accepts it. Runs through the ACP client when an agent is configured (docs/acp-client.md); otherwise skipped with an explicit audit entry, never faked |
| `human_review` | A checkpoint that pauses the run | The run stops here until a human marks pass/fail; used before any compliance verdict is finalised |

## Naming

- Workflow ids: `w1`, `w2`, `w3`…; step ids: `<workflow>-<n>` (e.g. `w2-1`).
- Output files go under `out/` by default, named `<workflow-id>-<date>/…`.
- Example files: `workflows/w1-regulation-screening.yaml`,
  `workflows/w2-cad-gis-metrics.yaml`, `workflows/w3-standard-map.yaml`.

## W1 — regulation screening

Steps: `w1-1` parse regulation → extract limits with clause/page citations (deterministic);
`w1-2` compare parcel indicators against limits (deterministic); `w1-3` agent drafts the
plain-language explanation of each flagged item (agent — runs through the ACP client when
an agent is configured, prompt template `prompts/w1-explanations.md`; skipped with an
explicit audit entry when none is); `w1-4` human review before the
checklist is finalised. Verdicts are only `pass` / `review` / `fail` — never "compliant"
as an absolute claim. Runner behavior: a `human_review` step pauses the run (exit 3)
after writing the draft outputs; `plan-agent run <workflow> --approve` verifies the
draft is unchanged since the pause, records the human decision in the audit log, and
only then writes the final output.

## W2 — CAD↔GIS + indicators

Steps: `w2-1` convert DXF→GeoJSON/SHP by layer (wall/window/door/dimension/axis) (deterministic);
`w2-2` compute indicators — building density, FAR, green ratio, population density,
kernel density (deterministic, sidecar); `w2-3` agent reviews conversion warnings and
proposes fixes (agent — runs through the ACP client when an agent is configured, prompt
template `prompts/w2-review.md`; skipped with an explicit audit entry when none is);
`w2-4` write indicator CSV + run log. CRS and units are parameters,
not assumptions: a CRS/unit mismatch is an error, not a warning.

## W3 — standard map export

Steps: `w3-1` load W2 outputs + template YAML (deterministic); `w3-2` render PNG/PDF/SVG
at 300 dpi (deterministic); `w3-3` human review of the rendered map. Same data + same
template renders the same drawing; per-format byte identity: the PNG is byte-identical
and the PDF is byte-identical (its CreationDate/ModDate are set to the production
date), but the SVG is only visually identical — matplotlib embeds a wall-clock
timestamp and random clip-path ids in it, so its bytes differ run to run. The
production date is the one sanctioned difference in the drawing itself.

Scale honesty: the nominal scale is 1:1000, but a 14 m demo parcel at 1:1000 is 14 mm
wide on A3 — unreadable. The renderer fits the plan into the map frame at the smallest
standard scale that fits and prints THAT scale on the map and in the audit log; the
scale bar is drawn in ground metres at the plotted scale, never at the nominal one.

## Human review gate — the general contract

A `human_review` step pauses the run (exit 3) and `--approve` finalises it. The contract
is the same for every workflow; only the finalisation differs:

- **The draft is whatever the deterministic steps before the gate produced** in the
  workflow's output directory. At pause time every file there (except `audit.log` and
  `review-state.json`) is hashed (sha256) into `review-state.json`, together with the
  workflow YAML hash, the step id, and the pause timestamp.
- **A run with no draft files fails loudly** instead of pausing — a gate with nothing
  to review is a repo bug.
- **`--approve` verifies the draft is byte-identical** (workflow YAML hash + every file
  hash in `review-state.json`), records the human decision (approver = OS username,
  timestamp) in the audit log, and only then finalises. It refuses on: no paused run,
  already approved, changed workflow YAML, any changed/missing draft file, or a
  missing declared final output. There is no auto-approval and no way to approve a
  changed draft.
- **Finalisation, per workflow:**
  - W1: the final `checklist.md` is *derived* from the draft at approve time (it does
    not exist at pause time); `--approve` refuses to overwrite an existing one.
  - W3 (and later workflows without a derived final file): the draft outputs are
    marked final *in place* — no re-render, which would change the production date
    and break the hash. The human_review step's declared outputs plus any other
    declared workflow outputs present in the draft are finalised together (W3:
    `map.png` + `map.pdf` + `map.svg` share one approved render).
- **W1-only extra:** at pause time the runner also copies `checklist-draft.csv` to the
  declared `checklist_csv` output, so the machine-readable copy exists alongside the
  draft.
