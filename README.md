# PlanAgent Workbench

> An open-source ACP client + deterministic workflow engine for urban planning and GIS professionals.
> Connects Codex / Claude Code via the Agent Client Protocol (ACP) and runs auditable workflows:
> planning-regulation screening, CAD↔GIS conversion, density / FAR / green-ratio calculation,
> kernel-density analysis, and standards-compliant map export.

**Status: v0.1.0, Phase 1 — W1, W2 and W3 run end-to-end, ACP client connected.**
`plan-agent run workflows/w1-regulation-screening.yaml` parses the synthetic regulation,
screens the synthetic parcel and pauses at the human-review gate (exit 3);
`plan-agent run ... --approve` finalises the checklist after verifying the
draft is unchanged. `plan-agent run workflows/w2-cad-gis-metrics.yaml`
validates the YAML, converts the synthetic DXF to GeoJSON/SHP, computes the
8 indicators and writes the audit log (`out/w2/`). `plan-agent run
workflows/w3-standard-map.yaml` renders the W2 plan as an A3 standard map
(PNG 300 dpi / PDF / SVG) and pauses at the human-review gate; `--approve`
finalises the rendered maps in place. Agent steps (w1-3, w2-3)
run through the ACP client when an agent is configured
(`PLAN_AGENT_COMMAND` or `plan-agent.config.json`, see
[docs/acp-client.md](docs/acp-client.md)) and are skipped — logged, never
faked — when none is. See [docs/workflows.md](docs/workflows.md).

---

## What this is

- A **workbench for planning work**, not a generic chat shell. Every run is a workflow
  (YAML) made of deterministic steps and agent steps, with an audit log that can be replayed.
- Built for real planning tasks: read a regulation, check a parcel against it, convert CAD↔GIS,
  compute planning indicators, export a standard map.
- **Auditable by design**: every check cites its source clause / page; every number logs the
  parameters, projection and formula used. No black-box "AI says compliant".

## What this is not

- Not a generic AI chat client, not a notes app, not a question bank.
- No online map service, no account system, no cloud storage.
- No polished Tauri desktop yet — the `tauri-app/` shell is v0.1 (same CLI, same review gate); the fancy desktop comes after v0.2.
- It does **not** promise "AI automatically certifies compliance". It is a screening assistant;
  a human reviews the result.

## Architecture

```
┌─────────────────────────────┐
│  plan-agent CLI (TypeScript)│  ← ACP client core (JSON-RPC over stdio)
│  src/cli.ts                 │  ← workflow runner, session + audit log
└──────────────┬──────────────┘
               │ spawns
┌──────────────▼──────────────┐
│  GIS sidecar (Python)       │  ← GeoPandas / Shapely / PyProj / GDAL
│  sidecar/                   │  ← indicator math, CAD↔GIS conversion, map export
└─────────────────────────────┘
               │
┌──────────────▼──────────────┐
│  workflows/*.yaml           │  ← deterministic workflow definitions (W1–W3)
└─────────────────────────────┘
```

## Quickstart

```bash
# 1. Prerequisites: Node.js 20+, Python 3.11+
npm install
npm run build

# 2. GIS sidecar — use a repo-local venv so the Python packages survive
#    a VM replacement (system-wide pip installs do not). The runner uses
#    .venv/bin/python when the venv exists, else the system python3.
python3 -m venv .venv && .venv/bin/pip install -r sidecar/requirements.txt

# 3. (Optional) Connect an ACP agent so the agent steps run instead of
#    being skipped. No agent is bundled; point at your own install:
export PLAN_AGENT_COMMAND="npx -y @agentclientprotocol/codex-acp"
# Smoke-test the client (--fake tests against the built-in fake agent,
# no login needed; without --fake it uses the configured agent):
plan-agent agent --prompt "Say hello in one sentence." --fake

# 4. See the three MVP workflows
plan-agent demo

# 5. Run W2 end-to-end (validates the YAML, converts the DXF, computes
#    indicators, writes the audit log; exit 0 on success)
plan-agent run workflows/w2-cad-gis-metrics.yaml
# Expected outputs in out/w2/: plan.geojson, plan.shp (+ plan_polygons.shp,
# plan_points.shp — a shapefile holds one geometry type), indicators.csv,
# run-log.md, conversion-log.md, audit.log
# Note: coordinates are local planar metres from the synthetic plan, NOT
# lon/lat; no .prj is written because the YAML default EPSG:4326 does not
# apply to them.

# 6. Run W1 end-to-end (parses the regulation, screens the parcel, then
#    PAUSES at the human-review gate — exit 3, not an error)
plan-agent run workflows/w1-regulation-screening.yaml
# Expected outputs in out/w1/: limits.json, checklist-draft.csv,
# checklist.csv (machine-readable copy of the draft), review-state.json,
# audit.log — but NOT checklist.md or explanations.md yet.
# Finalise it after reviewing the draft:
plan-agent run workflows/w1-regulation-screening.yaml --approve
# Writes out/w1/checklist.md and records the approval (OS username +
# timestamp) in audit.log. Approving a changed draft is refused.

# 7. Run W3 end-to-end (needs a W2 run first — it renders out/w2/).
#    Loads the W2 outputs + the map template, renders the A3 map, then
#    PAUSES at the human-review gate — exit 3, not an error.
plan-agent run workflows/w3-standard-map.yaml
# Expected outputs in out/w3/: map-inputs.json, map.png (300 dpi, A3),
# map.pdf, map.svg, review-state.json, audit.log. The rendered maps are
# drafts at this point — finalise them after reviewing:
plan-agent run workflows/w3-standard-map.yaml --approve
# Marks the rendered maps final in place (no re-render) and records the
# approval in audit.log. Approving a changed draft is refused.
# Scale note: the nominal scale is 1:1000, but the 14 m demo parcel is
# fitted to the map frame at 1:50 — the map, the scale bar and the audit
# log all show the plotted scale, never the nominal one.
```

## The three MVP workflows

| ID | Workflow | Input | Output |
|----|----------|-------|--------|
| W1 | Regulation screening | Regulation PDF/text + parcel indicator table | Markdown + CSV checklist (pass / review / fail), every item cited — runs end-to-end; pauses at the human-review gate (exit 3), `--approve` finalises; w1-3 agent explanations run when an agent is configured, skipped (logged) when not |
| W2 | CAD↔GIS + indicators | DXF / SHP / GeoJSON | GeoJSON + SHP (lines in plan.shp, polygons/points in companion files) + indicator CSV (density, FAR, green ratio, population density, kernel density) + run log + audit log — runs end-to-end; w2-3 agent review runs when an agent is configured, skipped (logged) when not |
| W3 | Standard map export | W2 results + map template YAML | PNG (300 dpi) / PDF / SVG with title, legend, scale bar, north arrow, frame, source, date — runs end-to-end; pauses at the human-review gate (exit 3), `--approve` finalises the rendered maps in place; plotted at 1:50 (nominal 1:1000, fitted to the frame — the scale bar is at the plotted scale) |

Workflow format (fields, step types, audit rules): [docs/workflows.md](docs/workflows.md).
Example files: [workflows/w1-regulation-screening.yaml](workflows/w1-regulation-screening.yaml),
[workflows/w2-cad-gis-metrics.yaml](workflows/w2-cad-gis-metrics.yaml),
[workflows/w3-standard-map.yaml](workflows/w3-standard-map.yaml).

## VS Code extension

`vscode-extension/` — run the workflows from the editor instead of the
terminal: `PlanAgent: Run Workflow` (quick-pick W1/W2/W3, output in the
PlanAgent channel), `PlanAgent: Approve Paused Run`,
`PlanAgent: Open Outputs`, `PlanAgent: Show Audit Log`,
`PlanAgent: Agent Status` (runs `plan-agent agent --status` — reports
the configured agent without spending a model call). A PlanAgent tree
in the Explorer shows each workflow's status from `review-state.json`
/ `audit.log` (never invented), and the status bar shows the last run
result with the time it ran. When a run pauses at the human-review
gate, the editor offers Review draft / Approve — approval always goes
through the CLI's `--approve` path. Settings: `planAgent.cliPath`,
`planAgent.workspaceRoot` (both optional; no machine paths hardcoded).
Build and package: `cd vscode-extension && npm install && npm run
compile && npx vsce package`. Verified: 13/13 unit tests (including a
real W1 pause → approve harness), 4/4 integration tests in a real
VS Code 1.146.0 headless run; not yet clicked through by hand in a
real window — see [vscode-extension/README.md](vscode-extension/README.md).

## Desktop app (Tauri 2)

`tauri-app/` — a desktop window over the same CLI: workflow list with a
Run button each, a streaming run log, a status line with the last run
result and time, and an in-app outputs view (checklist.md rendered,
indicators.csv as a table, map.png as an image, map.pdf embedded,
audit.log as text). When a run pauses at the human-review gate, a review
dialog shows the actual draft — the W1 checklist table, the W2 indicator
table, or the W3 rendered map — with Review draft / Approve; approval
always goes through the CLI's `--approve` path. An agent status panel
runs `plan-agent agent --status` (no model call). Settings (CLI path,
workspace root) persist in the Tauri app config directory; no machine
paths are hardcoded. Build: `cd tauri-app && npm install && npm run
tauri:dev` (or `npm run tauri:build` for the .deb / .AppImage bundle);
Linux needs libwebkit2gtk-4.1-dev and friends — see
[tauri-app/README.md](tauri-app/README.md). Verified: 19/19 Rust tests
(including an end-to-end W1 pause → approve → W2 run harness against
the real CLI, plus an agent `--status` round-trip), frontend build 0
errors; the window launch is smoke-tested headless under xvfb
(`tauri-app/scripts/smoke-test.sh`: window opens, frontend JS runs, 3
workflows list, per-workflow statuses and the agent chip load) — not
yet clicked through by hand in a real window, and not yet tested
against a real ACP agent binary. All three Linux bundles build
(`.deb`, `.rpm`, `.AppImage`); the `.deb` was installed and the
packaged release binary launched headless (bundled frontend, same
init flow) and then uninstalled.

## Roadmap

- **Phase 0 (weeks 1–2):** repo, README, workflow YAML format, v0.0.1 — done
- **Phase 1 (weeks 3–6):** ACP client connects to Codex CLI; W2, W1 and W3 run end-to-end; v0.1.0 — *W1 + W2 + W3 done, ACP client connected (verified against the test fake agent; not yet tested against a real agent binary)*
- **Phase 2 (weeks 7–10):** VS Code extension v0.1; demo video; v0.2.0 — *extension v0.1 done (verified headless; not yet used by hand in a real window)*
- **Phase 3 (weeks 11–16):** Tauri 2 desktop app v0.1 (same CLI, same review gate, in-app outputs); publish, collect adoption evidence, release every 1–2 weeks
- **Phase 4 (months 4–6):** apply to OpenAI Codex for Open Source when the evidence is ready

## Contributing

Issues and PRs welcome. Workflow changes must keep the audit trail: no step may silently
produce a number — parameters, projection and formula go in the log. English first in docs;
Chinese welcome alongside.

## License

Apache-2.0 — see [LICENSE](LICENSE).

---

# PlanAgent Workbench（规划 Agent 工作台）

> 开源 ACP 客户端 + 确定性规划工作流引擎，面向城乡规划 / GIS 从业者。
> 接 Codex / Claude Code，通过 Agent Client Protocol 跑可审计的工作流：
> 规范合规初筛、CAD↔GIS 互转、建筑密度 / 容积率 / 绿地率 / 核密度计算、标准出图。

**当前状态：v0.1.0，Phase 1——W1、W2、W3 已跑通，ACP 客户端已接通。**`plan-agent run
workflows/w1-regulation-screening.yaml` 解析合成规范、核查合成地块，
然后在人工复核关卡暂停（exit 3）；`plan-agent run ... --approve`
在核对草稿没被改动后才定稿。`plan-agent run
workflows/w2-cad-gis-metrics.yaml` 校验 YAML、把合成 DXF 转成 GeoJSON/SHP、
算出 8 个指标、写审计日志（`out/w2/`）。`plan-agent run
workflows/w3-standard-map.yaml` 把 W2 的图渲成 A3 标准图（PNG 300 dpi /
PDF / SVG），同样在人工复核关卡暂停；`--approve` 原地定稿，不重渲。
Agent 步骤（w1-3、w2-3）在配好 Agent 后走 ACP 客户端运行（`PLAN_AGENT_COMMAND`
或 `plan-agent.config.json`，见 [docs/acp-client.md](docs/acp-client.md)），
没配就跳过——只记日志、不编造结果。格式定义见
[docs/workflows.md](docs/workflows.md)。

## 这是什么

- **给规划活用的工作台**，不是通用聊天壳。每一次运行都是一份工作流（YAML），
  由确定性步骤 + Agent 步骤组成，全程留审计日志、可回放。
- 为真实规划任务而做：读规范、按条文核地块、CAD↔GIS 互转、算规划指标、出标准图。
- **可审计是底线**：每项检查都引用原文条款/页码；每个数字都记录参数、投影和计算口径。
  不做“AI 直接判合规”的黑盒承诺。

## 这不是什么

- 不是通用 AI 聊天客户端，不是笔记应用，不是题库。
- 没有在线地图服务、没有账号系统、没有云端存储。
- Tauri 精美桌面还没做——`tauri-app/` 目前是 v0.1 的壳（同一个 CLI、同一道复核关卡），精美桌面留到 v0.2 之后。
- 不承诺“AI 自动出合规结论”，只做可复核的初筛，结论由人复核。

## 架构

同上英文版架构图：TS 写 ACP 客户端核心（JSON-RPC over stdio），Python 写 GIS 计算 sidecar
（GeoPandas / Shapely / PyProj / GDAL），工作流用 YAML 定义。

## 快速上手

```bash
npm install && npm run build
# GIS sidecar 用仓库内 venv 装，换虚拟机也不丢（系统级 pip 装的会丢）；
# runner 优先用 .venv/bin/python，没有 venv 就用系统 python3。
python3 -m venv .venv && .venv/bin/pip install -r sidecar/requirements.txt
# （可选）接 ACP Agent，让 Agent 步骤真正跑起来而不是跳过。不自带 Agent，
# 指到你自己装好的：
export PLAN_AGENT_COMMAND="npx -y @agentclientprotocol/codex-acp"
# 冒烟测试（--fake 用内置假 Agent，不用登录；不加 --fake 则用配好的 Agent）：
plan-agent agent --prompt "Say hello in one sentence." --fake
plan-agent demo
# W2 全流程跑通（校验 YAML、转 DXF、算指标、写审计日志；成功返回 0）
plan-agent run workflows/w2-cad-gis-metrics.yaml
# out/w2/ 里应有：plan.geojson、plan.shp（另有 plan_polygons.shp、
# plan_points.shp——一个 shapefile 只存一种几何类型）、indicators.csv、
# run-log.md、conversion-log.md、audit.log
# 注意：坐标是合成图的局部平面米，不是经纬度；YAML 默认的 EPSG:4326
# 不适用，所以不写 .prj。
# W1 全流程跑通（解析规范、核查地块，然后在人工复核关卡暂停——exit 3，
# 不是报错）
plan-agent run workflows/w1-regulation-screening.yaml
# out/w1/ 里应有：limits.json、checklist-draft.csv、checklist.csv（草稿的
# 机器可读副本）、review-state.json、audit.log——但还没有 checklist.md
# 和 explanations.md。看完草稿后定稿：
plan-agent run workflows/w1-regulation-screening.yaml --approve
# 写出 out/w1/checklist.md，并在 audit.log 里记录审批人（系统用户名）
# 与时间；草稿被改动过就拒绝审批。
# W3 全流程跑通（先要有 W2 的结果——它渲的是 out/w2/；加载 W2 结果与
# 出图模板、渲 A3 图，然后在人工复核关卡暂停——exit 3，不是报错）
plan-agent run workflows/w3-standard-map.yaml
# out/w3/ 里应有：map-inputs.json、map.png（300 dpi，A3）、map.pdf、
# map.svg、review-state.json、audit.log。此时的图还是草稿，看完再定稿：
plan-agent run workflows/w3-standard-map.yaml --approve
# 原地把渲好的图标记为定稿（不重渲），并在 audit.log 里记录审批。
# 比例尺说明：名义比例尺是 1:1000，但 14 米的演示地块按 1:50 适配图框
# 绘制——图上、比例尺条和审计日志里写的都是实际绘制比例尺。
```

## 三条 MVP 工作流

| 编号 | 工作流 | 输入 | 输出 |
|------|--------|------|------|
| W1 | 规范合规初筛 | 规范 PDF/文本 + 地块指标表 | Markdown + CSV 检查表（通过 / 存疑 / 不通过），每项带原文引用——已跑通；在人工复核关卡暂停（exit 3），`--approve` 定稿；w1-3 Agent 讲解在配好 Agent 后运行，没配就跳过（只记日志） |
| W2 | CAD↔GIS 互转 + 指标计算 | DXF / SHP / GeoJSON | GeoJSON + SHP（线在 plan.shp，多边形/点在 companion 文件）+ 指标 CSV + 计算过程日志 + 审计日志——已跑通；w2-3 Agent 复核在配好 Agent 后运行，没配就跳过（只记日志） |
| W3 | 标准出图 | W2 结果 + 出图模板 YAML | PNG（300 dpi）/ PDF / SVG，带图名、图例、比例尺、指北针、图框、来源、日期——已跑通；在人工复核关卡暂停（exit 3），`--approve` 原地定稿；按 1:50 绘制（名义 1:1000，适配图框，比例尺条按实际比例尺画） |

## VS Code 插件

`vscode-extension/`——不用终端，在编辑器里跑工作流：`PlanAgent: Run Workflow`（选 W1/W2/W3，输出进 PlanAgent 通道）、`PlanAgent: Approve Paused Run`、`PlanAgent: Open Outputs`、`PlanAgent: Show Audit Log`、`PlanAgent: Agent Status`（跑 `plan-agent agent --status`，只报配置、不花模型调用）。资源管理器里的 PlanAgent 树按 `review-state.json` / `audit.log` 显示每条工作流的状态（不确定的写 unknown，不编状态），状态栏显示上次运行结果和时间。跑到人工复核关卡暂停时，编辑器会弹“看草稿 / 批准”，批准永远走 CLI 的 `--approve` 路径。设置：`planAgent.cliPath`、`planAgent.workspaceRoot`（都可选，不写死本机路径）。构建打包：`cd vscode-extension && npm install && npm run compile && npx vsce package`。已验证：单元测试 13/13（含真实 W1 暂停→批准全程）、真 VS Code 1.146.0 无头集成测试 4/4；还没在真实窗口里手工点过——见 [vscode-extension/README.md](vscode-extension/README.md)。

## 桌面版（Tauri 2）

`tauri-app/`——同一个 CLI 的桌面窗口：工作流列表各带 Run 按钮、实时滚动的运行日志、带时间的上次运行状态、站内产物查看（checklist.md 渲染、indicators.csv 表格、map.png 图片、map.pdf 内嵌、audit.log 文本）。跑到人工复核关卡暂停时弹复核对话框，里面是真正的草稿——W1 检查表、W2 指标表或 W3 渲染图——“看草稿 / 批准”两个按钮，批准永远走 CLI 的 `--approve` 路径。Agent 状态面板跑 `plan-agent agent --status`（不花模型调用）。设置（CLI 路径、工作区根目录）存在 Tauri 应用配置目录里，不写死本机路径。构建：`cd tauri-app && npm install && npm run tauri:dev`（打包用 `npm run tauri:build`，出 .deb / .AppImage）；Linux 要装 libwebkit2gtk-4.1-dev 等系统依赖——见 [tauri-app/README.md](tauri-app/README.md)。已验证：Rust 测试 19/19（含真实 W1 暂停→批准→W2 运行的全程 harness、Agent `--status` 往返），前端构建 0 报错；窗口启动在 xvfb 下无头冒烟测过（`tauri-app/scripts/smoke-test.sh`：窗口打开、前端 JS 跑起来、3 条工作流列出、各状态与 Agent 面板加载），还没在真实窗口里手工点过，也没对真实 ACP Agent 二进制测过。

## 路线图

- **Phase 0（第 1–2 周）：**建库、README、工作流 YAML 格式、v0.0.1——已完成
- **Phase 1（第 3–6 周）：**ACP 客户端连通 Codex CLI；W2、W1、W3 先后跑通；v0.1.0——*W1 + W2 + W3 已跑通，ACP 客户端已接通（只在内置假 Agent 上验过，还没对真实 Agent 二进制测过）*
- **Phase 2（第 7–10 周）：**VS Code 插件 v0.1；演示视频；v0.2.0——*插件 v0.1 已做完（无头验证通过，还没在真实窗口里手工用过）*
- **Phase 3（第 11–16 周）：**Tauri 2 桌面版 v0.1（同一个 CLI、同一道复核关卡、站内看产物）；发布、收集采用证据、每 1–2 周发一版
- **Phase 4（第 4–6 个月）：**证据够了再申 OpenAI Codex for Open Source

## 许可证

Apache-2.0 — see [LICENSE](LICENSE).
