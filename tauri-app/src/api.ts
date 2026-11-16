import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface Settings {
  cli_path: string;
  workspace_root: string;
}

export interface WorkflowInfo {
  id: string;
  name: string;
  description: string;
  yaml_path: string;
}

export interface WorkflowStatusInfo {
  status: string;
  detail: string;
}

export interface OutputFile {
  label: string;
  path: string;
}

export interface FileContent {
  kind: string;
  mime: string;
  text: string | null;
  base64: string | null;
  size: number;
}

export interface DraftRow {
  cells: string[];
}

export interface Draft {
  kind: string;
  headers: string[];
  rows: DraftRow[];
  image_base64: string | null;
  note: string;
}

export interface RunOutcome {
  code: number;
  outcome: string;
  stdout: string;
  stderr: string;
}

export interface AgentStatus {
  configured: boolean;
  agent: string | null;
  source: string | null;
  fake: boolean;
  error: string | null;
}

export interface RunLogEvent {
  workflow_id: string;
  stream: string;
  text: string;
}

// Invoke argument keys are camelCase: Tauri converts the Rust
// snake_case parameter names (workspace_root -> workspaceRoot, cli_path
// -> cliPath, workflow_id -> workflowId). Single-word params are the
// same on both sides.

export const getSettings = () => invoke<Settings>("get_settings");
export const saveSettings = (settings: Settings) =>
  invoke<void>("save_settings", { settings });
export const pickFolder = () => invoke<string | null>("pick_folder");

export const listWorkflows = (workspace_root: string) =>
  invoke<WorkflowInfo[]>("list_workflows", { workspaceRoot: workspace_root });
export const workflowStatus = (workspace_root: string, workflow_id: string) =>
  invoke<WorkflowStatusInfo>("workflow_status", { workspaceRoot: workspace_root, workflowId: workflow_id });
export const listOutputs = (workspace_root: string, workflow_id: string) =>
  invoke<OutputFile[]>("list_outputs", { workspaceRoot: workspace_root, workflowId: workflow_id });
export const readOutput = (workspace_root: string, path: string) =>
  invoke<FileContent>("read_output", { workspaceRoot: workspace_root, path });
export const draftForReview = (workspace_root: string, workflow_id: string) =>
  invoke<Draft>("draft_for_review", { workspaceRoot: workspace_root, workflowId: workflow_id });

export const runWorkflow = (cli_path: string, workspace_root: string, workflow_id: string) =>
  invoke<RunOutcome>("run_workflow", { cliPath: cli_path, workspaceRoot: workspace_root, workflowId: workflow_id });
export const approveWorkflow = (cli_path: string, workspace_root: string, workflow_id: string) =>
  invoke<RunOutcome>("approve_workflow", { cliPath: cli_path, workspaceRoot: workspace_root, workflowId: workflow_id });
export const agentStatus = (cli_path: string, workspace_root: string) =>
  invoke<AgentStatus>("agent_status", { cliPath: cli_path, workspaceRoot: workspace_root });

export const onRunLog = (handler: (e: RunLogEvent) => void): Promise<UnlistenFn> =>
  listen<RunLogEvent>("run-log", (event) => handler(event.payload));

/** Outcome labels — same words as the CLI / VS Code extension. */
export function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case "done":
      return "done";
    case "paused":
      return "paused for human review";
    case "usage":
      return "usage error";
    default:
      return "failed";
  }
}

/** "18:02" local time for the status line. */
export function shortTime(at: Date): string {
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
