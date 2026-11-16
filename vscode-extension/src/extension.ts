/**
 * PlanAgent Workbench — VS Code extension (v0.1).
 *
 * Thin editor shell over the local `plan-agent` CLI: it discovers the
 * CLI, runs workflows, surfaces the human-review gate, and reads run
 * state from the files the CLI wrote (review-state.json, audit.log).
 * It never writes workflow outputs itself and never fakes agent output
 * — approval always goes through the CLI's `run --approve` path
 * (hash verification + recorded decision).
 */

import * as vscode from "vscode";
import { join, relative } from "node:path";
import { outcomeForExitCode, outcomeLabel, statusBarText, type RunOutcome } from "./exitCodes";
import { getWorkflowStatus, listOutputFiles, listWorkflows, type WorkflowInfo } from "./workflowState";
import { lastErrorLine, resolveCli, runCli, type CliResolved } from "./cliRunner";

interface LastRun {
  workflowId: string;
  outcome: RunOutcome;
  /** ISO timestamp, so a restored status always says when it ran. */
  at: string;
}

const LAST_RUN_KEY = "planAgent.lastRun";

class WorkflowTreeItem extends vscode.TreeItem {
  constructor(
    public readonly workflow: WorkflowInfo,
    status: string,
    detail: string,
  ) {
    super(`${workflow.id} — ${workflow.name}`, vscode.TreeItemCollapsibleState.None);
    this.description = status;
    this.tooltip = `${workflow.id} — ${workflow.name}\n${workflow.description}\nStatus: ${status}\n${detail}`;
    this.command = { command: "planAgent.openOutputs", title: "Open Outputs", arguments: [workflow.id] };
    this.contextValue = "planAgentWorkflow";
  }
}

class WorkflowTreeProvider implements vscode.TreeDataProvider<WorkflowTreeItem> {
  private readonly emitter = new vscode.EventEmitter<WorkflowTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly getRoot: () => string | null) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(item: WorkflowTreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(): WorkflowTreeItem[] {
    const root = this.getRoot();
    if (!root) return [];
    return listWorkflows(root).map((w) => {
      const s = getWorkflowStatus(root, w.id);
      return new WorkflowTreeItem(w, s.status, s.detail);
    });
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("PlanAgent");
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "planAgent.runWorkflow";
  statusBar.tooltip = "PlanAgent: run a workflow";
  const treeProvider = new WorkflowTreeProvider(() => getWorkspaceRoot());
  context.subscriptions.push(
    channel,
    statusBar,
    vscode.window.registerTreeDataProvider("planAgent.workflows", treeProvider),
  );

  // Restore the last run's status bar (with its time — never a bare
  // stale claim from a previous session).
  const last = context.globalState.get<LastRun>(LAST_RUN_KEY);
  if (last) {
    const at = new Date(last.at);
    statusBar.text = statusBarText(last.workflowId, last.outcome, at);
    statusBar.tooltip = `PlanAgent: ${last.workflowId} ${outcomeLabel(last.outcome)} at ${at.toLocaleString()}`;
    statusBar.show();
  }

  function getWorkspaceRoot(): string | null {
    const configured = vscode.workspace.getConfiguration("planAgent").get<string>("workspaceRoot", "");
    if (configured.trim() !== "") return configured.trim();
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) return (folders[0] as vscode.WorkspaceFolder).uri.fsPath;
    return null;
  }

  function getCli(): CliResolved | null {
    const root = getWorkspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage("PlanAgent: no workspace folder open — open the plan-agent-workbench repo first.");
      return null;
    }
    const cliPath = vscode.workspace.getConfiguration("planAgent").get<string>("cliPath", "");
    try {
      return resolveCli(root, cliPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`PlanAgent: ${msg}`);
      return null;
    }
  }

  function setLastRun(workflowId: string, outcome: RunOutcome): void {
    const at = new Date();
    const record: LastRun = { workflowId, outcome, at: at.toISOString() };
    void context.globalState.update(LAST_RUN_KEY, record);
    statusBar.text = statusBarText(workflowId, outcome, at);
    statusBar.tooltip = `PlanAgent: ${workflowId} ${outcomeLabel(outcome)} at ${at.toLocaleString()}`;
    statusBar.show();
    treeProvider.refresh();
  }

  async function pickWorkflow(placeHolder: string): Promise<WorkflowInfo | undefined> {
    const root = getWorkspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage("PlanAgent: no workspace folder open — open the plan-agent-workbench repo first.");
      return undefined;
    }
    const workflows = listWorkflows(root);
    if (workflows.length === 0) {
      void vscode.window.showErrorMessage(`PlanAgent: no workflows found in ${join(root, "workflows")}.`);
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      workflows.map((w) => {
        const s = getWorkflowStatus(root, w.id);
        return { label: `${w.id} — ${w.name}`, description: s.status, detail: w.description, workflow: w };
      }),
      { placeHolder },
    );
    return picked?.workflow;
  }

  async function runApprove(workflow: WorkflowInfo): Promise<void> {
    const cli = getCli();
    if (!cli) return;
    const yamlRel = relative(cli.workspaceRoot, workflow.yamlPath);
    channel.appendLine(`$ plan-agent run ${yamlRel} --approve`);
    channel.show(true);
    const result = await runCli(cli, ["run", yamlRel, "--approve"], {
      onData: (chunk) => channel.append(chunk),
    });
    if (result.code === 0) {
      setLastRun(workflow.id, "done");
      void vscode.window.showInformationMessage(`PlanAgent: ${workflow.id} approved — final outputs written.`);
    } else {
      setLastRun(workflow.id, "error");
      void vscode.window.showErrorMessage(`PlanAgent: approve failed — ${lastErrorLine(result)}`);
    }
  }

  async function runWorkflowCmd(workflowId?: string): Promise<void> {
    const cli = getCli();
    if (!cli) return;
    let workflow: WorkflowInfo | undefined;
    if (workflowId) {
      const root = getWorkspaceRoot();
      workflow = root ? listWorkflows(root).find((w) => w.id === workflowId) : undefined;
      if (!workflow) {
        void vscode.window.showErrorMessage(`PlanAgent: unknown workflow '${workflowId}'.`);
        return;
      }
    } else {
      workflow = await pickWorkflow("Run which workflow?");
      if (!workflow) return;
    }
    const yamlRel = relative(cli.workspaceRoot, workflow.yamlPath);
    channel.appendLine(`$ plan-agent run ${yamlRel}`);
    channel.show(true);
    const result = await runCli(cli, ["run", yamlRel], {
      onData: (chunk) => channel.append(chunk),
    });
    const outcome = outcomeForExitCode(result.code);
    setLastRun(workflow.id, outcome);
    if (outcome === "paused") {
      const choice = await vscode.window.showInformationMessage(
        `PlanAgent: ${workflow.id} paused for human review — draft written, nothing finalised yet.`,
        "Review draft",
        "Approve",
      );
      if (choice === "Review draft") {
        await openOutputsCmd(workflow.id);
      } else if (choice === "Approve") {
        await runApprove(workflow);
      }
    } else if (outcome === "done") {
      void vscode.window.showInformationMessage(`PlanAgent: ${workflow.id} done.`);
    } else {
      void vscode.window.showErrorMessage(`PlanAgent: ${workflow.id} ${outcomeLabel(outcome)} — ${lastErrorLine(result)}`);
    }
  }

  async function approvePausedRunCmd(workflowId?: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage("PlanAgent: no workspace folder open — open the plan-agent-workbench repo first.");
      return;
    }
    let workflow: WorkflowInfo | undefined;
    if (workflowId) {
      workflow = listWorkflows(root).find((w) => w.id === workflowId);
    } else {
      const paused = listWorkflows(root).filter((w) => getWorkflowStatus(root, w.id).status === "paused");
      if (paused.length === 0) {
        void vscode.window.showInformationMessage("PlanAgent: no paused run — nothing to approve.");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        paused.map((w) => ({ label: `${w.id} — ${w.name}`, detail: w.description, workflow: w })),
        { placeHolder: "Approve which paused run?" },
      );
      workflow = picked?.workflow;
    }
    if (!workflow) return;
    if (getWorkflowStatus(root, workflow.id).status !== "paused") {
      void vscode.window.showInformationMessage(`PlanAgent: ${workflow.id} is not paused — nothing to approve.`);
      return;
    }
    await runApprove(workflow);
  }

  async function openOutputsCmd(workflowId?: string, filePath?: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage("PlanAgent: no workspace folder open — open the plan-agent-workbench repo first.");
      return;
    }
    let workflow: WorkflowInfo | undefined;
    if (workflowId) {
      workflow = listWorkflows(root).find((w) => w.id === workflowId);
    } else {
      workflow = await pickWorkflow("Open outputs of which workflow?");
    }
    if (!workflow) return;
    const files = listOutputFiles(root, workflow.id);
    if (files.length === 0) {
      void vscode.window.showInformationMessage(`PlanAgent: ${workflow.id} has no outputs yet — run it first.`);
      return;
    }
    let target = filePath ? files.find((f) => f.path === filePath) : undefined;
    if (!target && !filePath) {
      const picked = await vscode.window.showQuickPick(
        files.map((f) => ({ label: f.label, description: f.path, file: f })),
        { placeHolder: `Open which ${workflow.id} output?` },
      );
      target = picked?.file;
    }
    if (!target) return;
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(target.path));
  }

  async function showAuditLogCmd(workflowId?: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage("PlanAgent: no workspace folder open — open the plan-agent-workbench repo first.");
      return;
    }
    let workflow: WorkflowInfo | undefined;
    if (workflowId) {
      workflow = listWorkflows(root).find((w) => w.id === workflowId);
    } else {
      workflow = await pickWorkflow("Show the audit log of which workflow?");
    }
    if (!workflow) return;
    const auditPath = join(root, "out", workflow.id, "audit.log");
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(auditPath));
      await vscode.window.showTextDocument(doc);
    } catch {
      void vscode.window.showInformationMessage(`PlanAgent: ${workflow.id} has no audit log yet — run it first.`);
    }
  }

  async function agentStatusCmd(): Promise<void> {
    const cli = getCli();
    if (!cli) return;
    const result = await runCli(cli, ["agent", "--status"]);
    if (result.code === 0) {
      const lines = result.stdout.trim().split("\n");
      const agent = lines.find((l) => l.startsWith("agent:")) ?? "agent: (unknown)";
      const source = lines.find((l) => l.startsWith("source:")) ?? "";
      const fake = lines.some((l) => l.trim() === "fake: yes");
      channel.appendLine(`$ plan-agent agent --status\n${result.stdout}`);
      void vscode.window.showInformationMessage(
        `PlanAgent: ACP agent configured — ${agent.replace("agent: ", "")}${source ? ` (${source.replace("source: ", "")})` : ""}${fake ? " [test fake agent]" : ""}.`,
      );
    } else {
      channel.appendLine(`$ plan-agent agent --status\n${result.stderr}`);
      void vscode.window.showInformationMessage(
        "PlanAgent: no ACP agent configured — agent steps will be skipped, never faked. " +
          "Set PLAN_AGENT_COMMAND or add plan-agent.config.json (see docs/acp-client.md).",
      );
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("planAgent.runWorkflow", (id?: string) => runWorkflowCmd(id)),
    vscode.commands.registerCommand("planAgent.approvePausedRun", (id?: string) => approvePausedRunCmd(id)),
    vscode.commands.registerCommand("planAgent.openOutputs", (id?: string, file?: string) => openOutputsCmd(id, file)),
    vscode.commands.registerCommand("planAgent.showAuditLog", (id?: string) => showAuditLogCmd(id)),
    vscode.commands.registerCommand("planAgent.agentStatus", () => agentStatusCmd()),
  );
}

export function deactivate(): void {
  // Nothing to clean up: runs are child processes of the CLI, not the extension.
}
