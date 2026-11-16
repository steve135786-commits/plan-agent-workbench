/* PlanAgent integration tests — run inside a real VS Code via
 * @vscode/test-electron (test/integration/runTest.js). These cover what
 * the unit tests cannot: activation, command registration, and commands
 * executed through the extension host against the real repo workspace.
 * The long workflow runs are covered by the scripted harness in
 * src/test/cliRunner.test.ts instead (they take minutes in W2's case).
 */
const assert = require("assert");
const vscode = require("vscode");

suite("PlanAgent integration", () => {
  test("extension activates", async () => {
    const ext = vscode.extensions.getExtension("plan-agent.plan-agent");
    assert.ok(ext, "extension plan-agent.plan-agent not found");
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });

  test("all five commands are registered", async () => {
    const cmds = await vscode.commands.getCommands(true);
    for (const c of [
      "planAgent.runWorkflow",
      "planAgent.approvePausedRun",
      "planAgent.openOutputs",
      "planAgent.showAuditLog",
      "planAgent.agentStatus",
    ]) {
      assert.ok(cmds.includes(c), `command not registered: ${c}`);
    }
  });

  test("agentStatus runs with no agent configured", async () => {
    // Must not throw; with no agent it reports "not configured".
    await vscode.commands.executeCommand("planAgent.agentStatus");
  });

  test("showAuditLog opens the w1 audit log", async () => {
    await vscode.commands.executeCommand("planAgent.showAuditLog", "w1");
    const doc = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
    assert.ok(doc, "no active text editor after showAuditLog");
    assert.ok(
      doc.fileName.endsWith("out/w1/audit.log"),
      `active editor is ${doc.fileName}, expected out/w1/audit.log`,
    );
  });
});
