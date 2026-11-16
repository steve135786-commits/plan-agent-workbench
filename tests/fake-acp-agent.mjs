#!/usr/bin/env node
/**
 * FAKE ACP AGENT — TEST ONLY. Not a real model, no network, no tools.
 *
 * A minimal ACP v1 agent built on the same official SDK as the client,
 * so the client + workflow wiring can be verified end-to-end without a
 * real agent login or API key. It answers prompts deterministically:
 *
 * - If the prompt contains a checklist draft (CSV rows with a status
 *   column of pass / review / fail), it writes one plain-language
 *   paragraph per row. That is the only "smart" thing it does.
 * - Otherwise it returns a canned response.
 *
 * Its output always starts with a "FAKE AGENT RESPONSE — test only"
 * marker line, and it must never be used in a real run: plan-agent
 * refuses this script unless PLAN_AGENT_FAKE=1 is set or the
 * `--fake` flag is passed (see src/acp-client.ts).
 *
 * Probe tokens (verify the client's deny-by-default contract):
 * - "PLAN_AGENT_PROBE_FS" — the fake attempts an fs/read_text_file
 *   call and reports whether the client denied it.
 * - "PLAN_AGENT_PROBE_PERMISSION" — the fake requests a permission
 *   and reports the outcome.
 *
 * Run directly: node tests/fake-acp-agent.mjs  (needs `npm install` first)
 */
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { isAbsolute } from "node:path";

const FAKE_NAME = "plan-agent-fake";
const FAKE_VERSION = "0.1.0";
const MARKER = "FAKE AGENT RESPONSE — test only, not a real model.";

function promptText(params) {
  const blocks = params.prompt ?? [];
  return blocks
    .map((b) => (b.type === "text" ? b.text : `[${b.type} block]`))
    .join("\n");
}

/**
 * Parse checklist-draft rows out of the prompt text. A row looks like:
 *   far,2.5,2.5,ratio,pass,3.2,12,at the limit — pass
 * Returns null when no such rows are found.
 */
function parseChecklistRows(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const m = line.match(
      /^([^,]+),([^,]*),([^,]+),([^,]+),(pass|review|fail),([^,]+),([^,]+)(?:,(.*))?$/,
    );
    if (!m) continue;
    const [, item, value, limit, unit, status, clause, page, notes] = m;
    if (item === "item") continue; // CSV header
    rows.push({ item, value, limit, unit, status, clause, page, notes: notes ?? "" });
  }
  return rows.length > 0 ? rows : null;
}

function explainRows(rows) {
  const out = [];
  for (const r of rows) {
    const value = r.value === "" ? "no value was recorded for this item" : r.value;
    let verdict;
    if (r.status === "pass") {
      verdict = `This item is within the limit.`;
    } else if (r.status === "review") {
      verdict = r.notes
        ? `This item needs a human to look at it: ${r.notes}.`
        : `This item needs a human to look at it.`;
    } else {
      verdict = `This item is outside the limit and needs attention.`;
    }
    out.push(
      `### ${r.item}\n\n${value} against a limit of ${r.limit} ${r.unit} — ${r.status}. ` +
        `(Regulation clause ${r.clause}, page ${r.page}.) ${verdict}`,
    );
  }
  return out.join("\n\n");
}

class FakeAgent {
  constructor() {
    this.sessions = new Set();
  }

  async initialize(_params) {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
      agentInfo: { name: FAKE_NAME, version: FAKE_VERSION },
    };
  }

  async newSession(params) {
    if (!isAbsolute(params.cwd)) {
      throw acp.RequestError.invalidParams(
        { cwd: params.cwd },
        `cwd must be an absolute path: ${params.cwd}`,
      );
    }
    const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    this.sessions.add(sessionId);
    return { sessionId };
  }

  async prompt(params, cx) {
    if (!this.sessions.has(params.sessionId)) {
      throw acp.RequestError.sessionNotFound(params.sessionId);
    }
    const text = promptText(params);
    const probeLines = [];

    if (text.includes("PLAN_AGENT_PROBE_FS")) {
      try {
        await cx.request(acp.methods.client.fs.readTextFile, {
          path: "README.md",
        });
        probeLines.push("fs probe: ALLOWED (unexpected — the client should deny file reads)");
      } catch (err) {
        probeLines.push(`fs probe: DENIED (${err instanceof Error ? err.message : String(err)})`);
      }
    }

    if (text.includes("PLAN_AGENT_PROBE_PERMISSION")) {
      const res = await cx.request(acp.methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "fake_call_1",
          title: "Fake edit (probe only)",
          kind: "edit",
          status: "pending",
          locations: [{ path: "/tmp/fake-probe.txt" }],
          rawInput: { path: "/tmp/fake-probe.txt", content: "probe" },
        },
        options: [
          { kind: "allow_once", name: "Allow", optionId: "allow" },
          { kind: "reject_once", name: "Reject", optionId: "reject" },
        ],
      });
      probeLines.push(`permission probe: outcome = ${JSON.stringify(res.outcome)}`);
    }

    const rows = parseChecklistRows(text);
    const body = rows
      ? explainRows(rows)
      : "I received your prompt and have no checklist rows to explain. " +
        "(This is the plan-agent test fake agent; it only drafts explanations from a checklist draft.)";
    const full = [MARKER, "", body, ...probeLines].join("\n");

    await cx.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: full },
      },
    });
    return { stopReason: "end_turn" };
  }
}

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(input, output);
const fake = new FakeAgent();

acp
  .agent({ name: FAKE_NAME })
  .onRequest("initialize", (ctx) => fake.initialize(ctx.params))
  .onRequest("session/new", (ctx) => fake.newSession(ctx.params))
  .onRequest("session/prompt", (ctx) => fake.prompt(ctx.params, ctx.client))
  .onRequest("session/close", () => ({}))
  .onRequest("authenticate", () => ({}))
  .connect(stream);
