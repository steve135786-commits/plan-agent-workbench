//! How the app finds and runs the CLI: it shells out to the local
//! `plan-agent` build (node <cliPath> <args>, cwd = workspace root) and
//! streams the output back to the frontend as `run-log` events.
//! Same semantics as vscode-extension/src/cliRunner.ts — exit codes
//! 0 done, 1 error, 2 usage, 3 paused for human review.

use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use tauri::{AppHandle, Emitter, Runtime};

#[derive(Debug, Clone, Serialize)]
pub struct CliResolved {
    pub cli_path: String,
    pub node_cmd: String,
    pub workspace_root: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, Serialize)]
struct RunLogEvent {
    workflow_id: String,
    stream: String,
    text: String,
}

/// Resolve the CLI entry point. No hardcoded machine paths: cliPath comes
/// from the settings, defaulting to <workspaceRoot>/dist/cli.js. Returns
/// a one-line error telling the user to build the CLI when it is missing.
pub fn resolve_cli(workspace_root: &str, cli_path_setting: &str) -> Result<CliResolved, String> {
    let cli_path = if cli_path_setting.trim().is_empty() {
        Path::new(workspace_root).join("dist").join("cli.js")
    } else {
        PathBuf::from(cli_path_setting.trim())
    };
    if !cli_path.is_file() {
        return Err(format!(
            "PlanAgent CLI not found at {} — build it first: npm install && npm run build (in {})",
            cli_path.display(),
            workspace_root
        ));
    }
    Ok(CliResolved {
        cli_path: cli_path.to_string_lossy().into_owned(),
        node_cmd: "node".to_string(),
        workspace_root: workspace_root.to_string(),
    })
}

/// Exit-code interpretation for `plan-agent run` (see docs/workflows.md).
pub fn outcome_for_exit_code(code: i32) -> &'static str {
    match code {
        0 => "done",
        3 => "paused",
        2 => "usage",
        _ => "error",
    }
}

/// Last non-empty line of stderr (or stdout) — the one-line error to show.
pub fn last_error_line(result: &RunResult) -> String {
    let text = if result.stderr.trim().is_empty() {
        &result.stdout
    } else {
        &result.stderr
    };
    text.lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim().to_string())
        .unwrap_or_else(|| "unknown error".to_string())
}

pub(crate) fn run_cli_streaming<R: Runtime>(
    app: &AppHandle<R>,
    resolved: &CliResolved,
    args: &[&str],
    workflow_id: &str,
) -> RunResult {
    let mut child = match Command::new(&resolved.node_cmd)
        .arg(&resolved.cli_path)
        .args(args)
        .current_dir(&resolved.workspace_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return RunResult {
                code: 1,
                stdout: String::new(),
                stderr: format!(
                    "ERROR: could not run the CLI ({} {}): {}\n",
                    resolved.node_cmd, resolved.cli_path, e
                ),
            };
        }
    };

    let (tx, rx) = mpsc::channel::<(String, String)>();
    // ChildStdout and ChildStderr are different types, so erase them to
    // Box<dyn Read> before iterating over both streams the same way.
    let stdout: Option<Box<dyn Read + Send>> =
        child.stdout.take().map(|h| Box::new(h) as Box<dyn Read + Send>);
    let stderr: Option<Box<dyn Read + Send>> =
        child.stderr.take().map(|h| Box::new(h) as Box<dyn Read + Send>);
    let mut readers = vec![];
    for (stream, handle) in [("stdout", stdout), ("stderr", stderr)] {
        if let Some(h) = handle {
            let tx = tx.clone();
            let stream = stream.to_string();
            readers.push(std::thread::spawn(move || {
                let reader = BufReader::new(h);
                for line in reader.lines() {
                    match line {
                        Ok(l) => {
                            if tx.send((stream.clone(), l + "\n")).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            }));
        }
    }
    drop(tx);

    let mut out = String::new();
    let mut err = String::new();
    while let Ok((stream, text)) = rx.recv() {
        if stream == "stdout" {
            out.push_str(&text);
        } else {
            err.push_str(&text);
        }
        // Only runs stream log events; status checks (empty workflow_id)
        // stay silent so they don't pollute the run log pane.
        if !workflow_id.is_empty() {
            let _ = app.emit(
                "run-log",
                RunLogEvent {
                    workflow_id: workflow_id.to_string(),
                    stream,
                    text,
                },
            );
        }
    }
    for r in readers {
        let _ = r.join();
    }
    let code = child.wait().map(|s| s.code().unwrap_or(1)).unwrap_or(1);
    RunResult {
        code,
        stdout: out,
        stderr: err,
    }
}

/// `plan-agent agent --status` without spawning any agent (no model call,
/// no cost). Parses the CLI's `configured: yes` / `agent:` / `source:` /
/// `fake:` lines; exit 1 means "not configured" (or a refused fake).
#[derive(Debug, Clone, Serialize)]
pub struct AgentStatus {
    pub configured: bool,
    pub agent: Option<String>,
    pub source: Option<String>,
    pub fake: bool,
    pub error: Option<String>,
}

pub fn parse_agent_status(result: &RunResult) -> AgentStatus {
    if result.code != 0 {
        return AgentStatus {
            configured: false,
            agent: None,
            source: None,
            fake: false,
            error: Some(last_error_line(result)),
        };
    }
    let mut agent = None;
    let mut source = None;
    let mut fake = false;
    for line in result.stdout.lines() {
        if let Some(v) = line.strip_prefix("agent: ") {
            agent = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("source: ") {
            source = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("fake: ") {
            fake = v.trim() == "yes";
        }
    }
    AgentStatus {
        configured: true,
        agent,
        source,
        fake,
        error: None,
    }
}

#[tauri::command]
pub fn agent_status(
    app: AppHandle,
    cli_path: String,
    workspace_root: String,
) -> Result<AgentStatus, String> {
    let resolved = resolve_cli(&workspace_root, &cli_path)?;
    let result = run_cli_streaming(&app, &resolved, &["agent", "--status"], "");
    if std::env::var("PLAN_AGENT_DEBUG").is_ok() {
        eprintln!("plan-agent: agent_status -> code={}", result.code);
    }
    Ok(parse_agent_status(&result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_code_meanings() {
        assert_eq!(outcome_for_exit_code(0), "done");
        assert_eq!(outcome_for_exit_code(3), "paused");
        assert_eq!(outcome_for_exit_code(2), "usage");
        assert_eq!(outcome_for_exit_code(1), "error");
        assert_eq!(outcome_for_exit_code(99), "error");
    }

    #[test]
    fn resolve_cli_missing_reports_build_command() {
        let err = resolve_cli("/nonexistent-root", "").unwrap_err();
        assert!(err.contains("not found"), "{err}");
        assert!(err.contains("npm run build"), "{err}");
    }

    #[test]
    fn resolve_cli_default_path_is_dist_cli_js() {
        let dir = std::env::temp_dir().join("plan-agent-test-cli-resolve");
        let _ = std::fs::create_dir_all(dir.join("dist"));
        let cli = dir.join("dist").join("cli.js");
        std::fs::write(&cli, "x").unwrap();
        let r = resolve_cli(dir.to_str().unwrap(), "").unwrap();
        assert_eq!(r.cli_path, cli.to_string_lossy());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn agent_status_parses_configured_output() {
        let r = RunResult {
            code: 0,
            stdout: "configured: yes\nagent: codex (npx -y @agentclientprotocol/codex-acp)\nsource: env PLAN_AGENT_COMMAND\nfake: no\n".into(),
            stderr: String::new(),
        };
        let s = parse_agent_status(&r);
        assert!(s.configured);
        assert_eq!(
            s.agent.as_deref(),
            Some("codex (npx -y @agentclientprotocol/codex-acp)")
        );
        assert_eq!(s.source.as_deref(), Some("env PLAN_AGENT_COMMAND"));
        assert!(!s.fake);
        assert!(s.error.is_none());
    }

    #[test]
    fn agent_status_not_configured_reports_error_line() {
        let r = RunResult {
            code: 1,
            stdout: String::new(),
            stderr: "ERROR: no ACP agent configured — set PLAN_AGENT_COMMAND\n".into(),
        };
        let s = parse_agent_status(&r);
        assert!(!s.configured);
        assert!(s.error.unwrap().contains("no ACP agent configured"));
    }

    #[test]
    fn last_error_line_prefers_stderr_tail() {
        let r = RunResult {
            code: 1,
            stdout: "some stdout\n".into(),
            stderr: "first\nERROR: the real problem\n\n".into(),
        };
        assert_eq!(last_error_line(&r), "ERROR: the real problem");
    }
}
