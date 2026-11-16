//! Workflow discovery, run-state detection, output reading and the
//! run/approve commands. All state is read from files the CLI wrote
//! (review-state.json, audit.log, checklist-draft.csv, indicators.csv,
//! map.png) — when a status cannot be determined it is "unknown", never
//! invented. Same semantics as vscode-extension/src/workflowState.ts.

use crate::cli::{outcome_for_exit_code, resolve_cli};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Runtime};

#[derive(Debug, Clone, Serialize)]
pub struct WorkflowInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub yaml_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkflowStatusInfo {
    pub status: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct OutputFile {
    pub label: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileContent {
    /// "text" | "image" | "pdf" — how the frontend should render it.
    pub kind: String,
    pub mime: String,
    pub text: Option<String>,
    pub base64: Option<String>,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DraftRow {
    pub cells: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Draft {
    /// "checklist" | "indicators" | "map" | "none"
    pub kind: String,
    pub headers: Vec<String>,
    pub rows: Vec<DraftRow>,
    pub image_base64: Option<String>,
    pub note: String,
}

/// Workflow ids are `<workflow>-<n>`-style slugs; reject anything that
/// could escape the workflows/ directory.
fn valid_workflow_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn extract_description(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.iter().position(|l| {
        let t = l.trim_start();
        t.starts_with("description:") && t.contains('>')
    });
    let Some(start) = start else {
        return String::new();
    };
    let mut parts = vec![];
    for line in &lines[start + 1..] {
        if !line.starts_with("  ") || line.trim().is_empty() {
            break;
        }
        parts.push(line.trim());
    }
    parts.join(" ")
}

fn yaml_field(text: &str, field: &str) -> Option<String> {
    for line in text.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix(&format!("{field}:")) {
            let v = rest.trim().trim_matches('"');
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// Workflows defined by workflows/*.yaml, sorted by id.
pub fn list_workflows_inner(workspace_root: &str) -> Vec<WorkflowInfo> {
    let dir = Path::new(workspace_root).join("workflows");
    let Ok(entries) = fs::read_dir(&dir) else {
        return vec![];
    };
    let mut out = vec![];
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map(|e| e != "yaml").unwrap_or(true) {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let id = yaml_field(&text, "id").unwrap_or_else(|| {
            path.file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        });
        let name = yaml_field(&text, "name").unwrap_or_else(|| id.clone());
        out.push(WorkflowInfo {
            id,
            name,
            description: extract_description(&text),
            yaml_path: path.to_string_lossy().into_owned(),
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Derive a workflow's run status from out/<id>/ (never invented).
pub fn workflow_status_inner(workspace_root: &str, workflow_id: &str) -> WorkflowStatusInfo {
    let out_dir = Path::new(workspace_root).join("out").join(workflow_id);
    if !out_dir.exists() {
        return WorkflowStatusInfo {
            status: "not-run".into(),
            detail: "never run (no out directory)".into(),
        };
    }
    let state_path = out_dir.join("review-state.json");
    if state_path.exists() {
        match fs::read_to_string(&state_path)
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        {
            Some(v) => {
                let status = v.get("status").and_then(|s| s.as_str()).unwrap_or("");
                match status {
                    "paused" => {
                        return WorkflowStatusInfo {
                            status: "paused".into(),
                            detail: format!(
                                "paused at {}",
                                v.get("paused_at")
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("unknown time")
                            ),
                        };
                    }
                    "approved" => {
                        return WorkflowStatusInfo {
                            status: "approved".into(),
                            detail: format!(
                                "approved by {} at {}",
                                v.get("approver")
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("unknown"),
                                v.get("approved_at")
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("unknown time")
                            ),
                        };
                    }
                    _ => {
                        return WorkflowStatusInfo {
                            status: "unknown".into(),
                            detail: "review-state.json has an unexpected status".into(),
                        };
                    }
                }
            }
            None => {
                return WorkflowStatusInfo {
                    status: "unknown".into(),
                    detail: "review-state.json is unreadable".into(),
                };
            }
        }
    }
    let audit_path = out_dir.join("audit.log");
    if audit_path.exists() {
        match fs::read_to_string(&audit_path) {
            Ok(audit) => {
                if audit.contains("exit 0: all steps completed") {
                    return WorkflowStatusInfo {
                        status: "done".into(),
                        detail: "all steps completed (audit.log)".into(),
                    };
                }
                if audit.contains("## Result — FAILED") {
                    return WorkflowStatusInfo {
                        status: "failed".into(),
                        detail: "last run failed (audit.log)".into(),
                    };
                }
                return WorkflowStatusInfo {
                    status: "unknown".into(),
                    detail: "audit.log exists but records no final result".into(),
                };
            }
            Err(_) => {
                return WorkflowStatusInfo {
                    status: "unknown".into(),
                    detail: "audit.log is unreadable".into(),
                };
            }
        }
    }
    WorkflowStatusInfo {
        status: "unknown".into(),
        detail: "out directory exists but has no audit log".into(),
    }
}

/// Output files for a workflow: the paths its YAML declares under
/// `outputs:` plus the audit log. Only files that actually exist are
/// returned, in YAML order (audit log last).
pub fn list_outputs_inner(workspace_root: &str, workflow_id: &str) -> Vec<OutputFile> {
    let yaml_path = Path::new(workspace_root)
        .join("workflows")
        .join(format!("{workflow_id}.yaml"));
    let mut out: Vec<OutputFile> = vec![];
    let mut seen = std::collections::HashSet::new();
    let mut add = |rel: &str, out: &mut Vec<OutputFile>| {
        let full = Path::new(workspace_root).join(rel);
        if seen.contains(&full) || !full.is_file() {
            return;
        }
        seen.insert(full.clone());
        out.push(OutputFile {
            label: full
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| rel.to_string()),
            path: full.to_string_lossy().into_owned(),
        });
    };
    if let Ok(text) = fs::read_to_string(&yaml_path) {
        for line in text.lines() {
            let t = line.trim();
            if let Some(rest) = t.strip_prefix("path:") {
                let rel = rest.trim();
                if rel.starts_with("out/") {
                    add(rel, &mut out);
                }
            }
        }
        for line in text.lines() {
            let t = line.trim();
            if let Some(rest) = t.strip_prefix("log:") {
                let rel = rest.trim();
                if rel.starts_with("out/") {
                    add(rel, &mut out);
                }
            }
        }
    }
    if out.is_empty() {
        add(&format!("out/{workflow_id}/audit.log"), &mut out);
    }
    out
}

/// Minimal CSV line parser: handles double-quoted fields containing commas
/// (mirrors the extension's parseCsvLine).
pub fn parse_csv_line(line: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if quoted {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    cur.push('"');
                } else {
                    quoted = false;
                }
            } else {
                cur.push(ch);
            }
        } else if ch == '"' {
            quoted = true;
        } else if ch == ',' {
            out.push(std::mem::take(&mut cur));
        } else {
            cur.push(ch);
        }
    }
    out.push(cur);
    out
}

fn read_csv_rows(path: &Path) -> Result<(Vec<String>, Vec<DraftRow>), String> {
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut lines = text.lines();
    let header = lines.next().map(|l| parse_csv_line(l)).unwrap_or_default();
    let rows = lines
        .filter(|l| !l.trim().is_empty())
        .map(|l| DraftRow {
            cells: parse_csv_line(l),
        })
        .collect();
    Ok((header, rows))
}

/// Resolve `path` against the workspace root and refuse anything outside
/// it — the frontend must never be able to make the backend read an
/// arbitrary file on disk.
fn resolve_output_path(workspace_root: &str, path: &str) -> Result<PathBuf, String> {
    let root = Path::new(workspace_root)
        .canonicalize()
        .map_err(|_| format!("workspace root not found: {workspace_root}"))?;
    let candidate = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        root.join(path)
    };
    let resolved = candidate
        .canonicalize()
        .map_err(|_| format!("file not found: {path}"))?;
    if !resolved.starts_with(&root) {
        return Err(format!(
            "refusing to read a file outside the workspace: {path}"
        ));
    }
    Ok(resolved)
}

fn mime_for(path: &Path) -> (&'static str, &'static str) {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => ("image", "image/png"),
        "jpg" | "jpeg" => ("image", "image/jpeg"),
        "svg" => ("image", "image/svg+xml"),
        "pdf" => ("pdf", "application/pdf"),
        "md" => ("text", "text/markdown"),
        "csv" => ("text", "text/csv"),
        "json" => ("text", "application/json"),
        "yaml" | "yml" => ("text", "text/yaml"),
        _ => ("text", "text/plain"),
    }
}

/// Read one output file for in-app rendering. Images and PDFs come back
/// base64-encoded; everything else comes back as text. Binary formats the
/// app cannot render (shapefiles, GeoJSON blobs over the text cap) are
/// refused with a plain message instead of a broken view.
pub fn read_output_inner(workspace_root: &str, path: &str) -> Result<FileContent, String> {
    let resolved = resolve_output_path(workspace_root, path)?;
    let (kind, mime) = mime_for(&resolved);
    let bytes = fs::read(&resolved).map_err(|e| e.to_string())?;
    let size = bytes.len() as u64;
    // 8 MiB cap: a map PNG is ~330 KiB; anything bigger is not a viewable
    // workflow output and should not be shoved through IPC.
    if size > 8 * 1024 * 1024 {
        return Err(format!(
            "file too large to preview in-app ({} bytes): {}",
            size,
            resolved.display()
        ));
    }
    if kind == "image" || kind == "pdf" {
        return Ok(FileContent {
            kind: kind.to_string(),
            mime: mime.to_string(),
            text: None,
            base64: Some(base64_encode(&bytes)),
            size,
        });
    }
    match String::from_utf8(bytes) {
        Ok(text) => Ok(FileContent {
            kind: "text".into(),
            mime: mime.into(),
            text: Some(text),
            base64: None,
            size,
        }),
        Err(_) => Err(format!(
            "cannot preview binary file in-app: {}",
            resolved.display()
        )),
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Draft content for the human-review dialog: the W1 checklist table, the
/// W2 indicator table, or the W3 rendered map — whatever the paused run
/// actually produced. Nothing is invented: a missing draft is "none".
pub fn draft_for_review_inner(workspace_root: &str, workflow_id: &str) -> Draft {
    let out_dir = Path::new(workspace_root).join("out").join(workflow_id);
    let draft_csv = out_dir.join("checklist-draft.csv");
    if draft_csv.exists() {
        match read_csv_rows(&draft_csv) {
            Ok((headers, rows)) => {
                return Draft {
                    kind: "checklist".into(),
                    headers,
                    rows,
                    image_base64: None,
                    note: "Draft checklist — approve only after reading every row.".into(),
                };
            }
            Err(e) => {
                return Draft {
                    kind: "none".into(),
                    headers: vec![],
                    rows: vec![],
                    image_base64: None,
                    note: format!("checklist draft unreadable: {e}"),
                };
            }
        }
    }
    let indicators = out_dir.join("indicators.csv");
    if indicators.exists() {
        match read_csv_rows(&indicators) {
            Ok((headers, rows)) => {
                return Draft {
                    kind: "indicators".into(),
                    headers,
                    rows,
                    image_base64: None,
                    note: "Draft indicators — approve only after checking the values.".into(),
                };
            }
            Err(e) => {
                return Draft {
                    kind: "none".into(),
                    headers: vec![],
                    rows: vec![],
                    image_base64: None,
                    note: format!("indicators draft unreadable: {e}"),
                };
            }
        }
    }
    let map_png = out_dir.join("map.png");
    if map_png.exists() {
        match fs::read(&map_png) {
            Ok(bytes) => {
                return Draft {
                    kind: "map".into(),
                    headers: vec![],
                    rows: vec![],
                    image_base64: Some(base64_encode(&bytes)),
                    note: "Draft map — approve only after inspecting the rendered map.".into(),
                };
            }
            Err(e) => {
                return Draft {
                    kind: "none".into(),
                    headers: vec![],
                    rows: vec![],
                    image_base64: None,
                    note: format!("draft map unreadable: {e}"),
                };
            }
        }
    }
    Draft {
        kind: "none".into(),
        headers: vec![],
        rows: vec![],
        image_base64: None,
        note: "No draft outputs found for this workflow — run it first.".into(),
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct RunOutcome {
    pub code: i32,
    pub outcome: String,
    pub stdout: String,
    pub stderr: String,
}

fn run_cli_command<R: Runtime>(
    app: &AppHandle<R>,
    cli_path: &str,
    workspace_root: &str,
    args: &[&str],
    workflow_id: &str,
) -> Result<RunOutcome, String> {
    let resolved = resolve_cli(workspace_root, cli_path)?;
    let result = crate::cli::run_cli_streaming(app, &resolved, args, workflow_id);
    Ok(RunOutcome {
        outcome: outcome_for_exit_code(result.code).to_string(),
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
    })
}

#[tauri::command]
pub fn list_workflows(workspace_root: String) -> Vec<WorkflowInfo> {
    let list = list_workflows_inner(&workspace_root);
    if std::env::var("PLAN_AGENT_DEBUG").is_ok() {
        eprintln!("plan-agent: list_workflows returned {} workflows", list.len());
    }
    list
}

#[tauri::command]
pub fn workflow_status(
    workspace_root: String,
    workflow_id: String,
) -> Result<WorkflowStatusInfo, String> {
    if !valid_workflow_id(&workflow_id) {
        return Err(format!("invalid workflow id: {workflow_id}"));
    }
    let info = workflow_status_inner(&workspace_root, &workflow_id);
    if std::env::var("PLAN_AGENT_DEBUG").is_ok() {
        eprintln!("plan-agent: workflow_status {workflow_id} -> {}", info.status);
    }
    Ok(info)
}

#[tauri::command]
pub fn list_outputs(
    workspace_root: String,
    workflow_id: String,
) -> Result<Vec<OutputFile>, String> {
    if !valid_workflow_id(&workflow_id) {
        return Err(format!("invalid workflow id: {workflow_id}"));
    }
    Ok(list_outputs_inner(&workspace_root, &workflow_id))
}

#[tauri::command]
pub fn read_output(workspace_root: String, path: String) -> Result<FileContent, String> {
    read_output_inner(&workspace_root, &path)
}

#[tauri::command]
pub fn draft_for_review(workspace_root: String, workflow_id: String) -> Result<Draft, String> {
    if !valid_workflow_id(&workflow_id) {
        return Err(format!("invalid workflow id: {workflow_id}"));
    }
    Ok(draft_for_review_inner(&workspace_root, &workflow_id))
}

/// Run a workflow through the CLI. The frontend streams the log via the
/// `run-log` event; the return value carries the final exit code and the
/// full output. Exit 3 means "paused for human review" — the drafts are
/// in out/<w>/ and nothing is finalised until --approve runs.
#[tauri::command]
pub fn run_workflow(
    app: AppHandle,
    cli_path: String,
    workspace_root: String,
    workflow_id: String,
) -> Result<RunOutcome, String> {
    if !valid_workflow_id(&workflow_id) {
        return Err(format!("invalid workflow id: {workflow_id}"));
    }
    let yaml = format!("workflows/{workflow_id}.yaml");
    run_cli_command(
        &app,
        &cli_path,
        &workspace_root,
        &["run", &yaml],
        &workflow_id,
    )
}

/// Approve a paused run through the CLI's --approve path (hash
/// verification + recorded decision). The app never finalises anything
/// itself.
#[tauri::command]
pub fn approve_workflow(
    app: AppHandle,
    cli_path: String,
    workspace_root: String,
    workflow_id: String,
) -> Result<RunOutcome, String> {
    if !valid_workflow_id(&workflow_id) {
        return Err(format!("invalid workflow id: {workflow_id}"));
    }
    let yaml = format!("workflows/{workflow_id}.yaml");
    run_cli_command(
        &app,
        &cli_path,
        &workspace_root,
        &["run", &yaml, "--approve"],
        &workflow_id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture_root() -> PathBuf {
        // Unique per test: tests run in parallel, so a fixed shared path
        // lets one test's cleanup delete another test's fixture mid-write.
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "plan-agent-tauri-test-{}-{n}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("workflows")).unwrap();
        fs::create_dir_all(dir.join("out").join("w1")).unwrap();
        fs::write(
            dir.join("workflows").join("w1.yaml"),
            "workflow:\n  version: \"0.0.1\"\n  id: w1\n  name: Regulation screening\n  description: >\n    Screen one synthetic parcel.\noutputs:\n  - name: checklist\n    path: out/w1/checklist.md\n    kind: markdown\naudit:\n  log: out/w1/audit.log\n",
        )
        .unwrap();
        dir
    }

    #[test]
    fn csv_parser_handles_quoted_commas() {
        let row = parse_csv_line("far,2.5,2.5,ratio,pass,3.2,12,\"at the limit, not above it\"");
        assert_eq!(row.len(), 8);
        assert_eq!(row[7], "at the limit, not above it");
        let row2 = parse_csv_line("a,\"b\"\"c\",d");
        assert_eq!(row2[1], "b\"c");
    }

    #[test]
    fn status_not_run_without_out_dir() {
        let root = fixture_root();
        let s = workflow_status_inner(root.to_str().unwrap(), "w2");
        assert_eq!(s.status, "not-run");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn status_paused_from_review_state() {
        let root = fixture_root();
        fs::write(
            root.join("out").join("w1").join("review-state.json"),
            r#"{"status":"paused","paused_at":"2026-11-16T10:00:00Z"}"#,
        )
        .unwrap();
        let s = workflow_status_inner(root.to_str().unwrap(), "w1");
        assert_eq!(s.status, "paused");
        assert!(s.detail.contains("2026-11-16T10:00:00Z"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn status_done_from_audit_log() {
        let root = fixture_root();
        fs::write(
            root.join("out").join("w1").join("audit.log"),
            "# w1 audit log\n\n## Result\n- exit 0: all steps completed\n",
        )
        .unwrap();
        let s = workflow_status_inner(root.to_str().unwrap(), "w1");
        assert_eq!(s.status, "done");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn status_unknown_for_unreadable_state() {
        let root = fixture_root();
        fs::write(
            root.join("out").join("w1").join("review-state.json"),
            "not json at all",
        )
        .unwrap();
        let s = workflow_status_inner(root.to_str().unwrap(), "w1");
        assert_eq!(s.status, "unknown");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_output_refuses_paths_outside_workspace() {
        let root = fixture_root();
        let outside = std::env::temp_dir().join(format!(
            "plan-agent-outside-{}.txt",
            std::process::id()
        ));
        fs::write(&outside, "secret").unwrap();
        let err = read_output_inner(root.to_str().unwrap(), outside.to_str().unwrap()).unwrap_err();
        assert!(err.contains("outside the workspace"), "{err}");
        let err2 = read_output_inner(root.to_str().unwrap(), "../outside.txt").unwrap_err();
        assert!(
            err2.contains("outside the workspace") || err2.contains("not found"),
            "{err2}"
        );
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_file(&outside);
    }

    #[test]
    fn read_output_reads_text_and_images() {
        let root = fixture_root();
        fs::write(root.join("out").join("w1").join("note.txt"), "hello\n").unwrap();
        let c = read_output_inner(root.to_str().unwrap(), "out/w1/note.txt").unwrap();
        assert_eq!(c.kind, "text");
        assert_eq!(c.text.as_deref(), Some("hello\n"));
        // Minimal 1x1 PNG.
        let png: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        fs::write(root.join("out").join("w1").join("m.png"), png).unwrap();
        let c2 = read_output_inner(root.to_str().unwrap(), "out/w1/m.png").unwrap();
        assert_eq!(c2.kind, "image");
        assert_eq!(c2.mime, "image/png");
        assert!(c2.base64.is_some());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn base64_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn invalid_workflow_ids_rejected() {
        assert!(valid_workflow_id("w1"));
        assert!(valid_workflow_id("w2-cad"));
        assert!(!valid_workflow_id("../w1"));
        assert!(!valid_workflow_id("W1"));
        assert!(!valid_workflow_id("w1; rm -rf /"));
        assert!(!valid_workflow_id(""));
    }

    #[test]
    fn draft_for_review_prefers_checklist() {
        let root = fixture_root();
        fs::write(
            root.join("out").join("w1").join("checklist-draft.csv"),
            "item,indicator_value,limit,unit,status,clause,page,notes\nfar,2.5,2.5,ratio,pass,3.2,12,\"at the limit\"\n",
        )
        .unwrap();
        let d = draft_for_review_inner(root.to_str().unwrap(), "w1");
        assert_eq!(d.kind, "checklist");
        assert_eq!(d.headers[0], "item");
        assert_eq!(d.rows.len(), 1);
        assert_eq!(d.rows[0].cells[0], "far");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn draft_for_review_indicators() {
        let root = fixture_root();
        fs::create_dir_all(root.join("out").join("w2")).unwrap();
        fs::write(
            root.join("out").join("w2").join("indicators.csv"),
            "indicator,value,formula,source\nbuilding_density,30,30/100,plan.geojson\n",
        )
        .unwrap();
        let d = draft_for_review_inner(root.to_str().unwrap(), "w2");
        assert_eq!(d.kind, "indicators");
        assert_eq!(d.headers, vec!["indicator", "value", "formula", "source"]);
        assert_eq!(d.rows.len(), 1);
        assert_eq!(d.rows[0].cells[1], "30");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn draft_for_review_map() {
        let root = fixture_root();
        fs::create_dir_all(root.join("out").join("w3")).unwrap();
        // Minimal PNG bytes (header only — the app base64-encodes whatever
        // is there; rendering validity is the CLI's job, not this test's).
        let png: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        fs::write(root.join("out").join("w3").join("map.png"), png).unwrap();
        let d = draft_for_review_inner(root.to_str().unwrap(), "w3");
        assert_eq!(d.kind, "map");
        assert!(d.image_base64.is_some());
        assert!(d.image_base64.as_deref().unwrap().starts_with("iVBORw0KGgo"));
        let _ = fs::remove_dir_all(&root);
    }

    /// End-to-end through the app's own run path against the real CLI:
    /// W1 run -> exit 3 (paused, draft written) -> --approve -> exit 0
    /// (checklist finalised), plus an agent --status round-trip.
    ///
    /// This mutates the real repo's out/w1/ (gitignored) and leaves it in
    /// the approved state, the same state it was in before the test.
    /// It assumes no ACP agent is configured on this machine (the default
    /// here); with an agent configured, the w1-3 step would attempt a
    /// real model call instead of being skipped.
    #[test]
    fn e2e_w1_pause_then_approve_through_app_path() {
        use crate::cli::{parse_agent_status, resolve_cli, run_cli_streaming};
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .expect("repo root must exist");
        let root_str = root.to_str().unwrap();
        assert!(
            root.join("dist/cli.js").is_file(),
            "repo CLI not built: run `npm install && npm run build` in the repo root first"
        );
        let resolved = resolve_cli(root_str, "").expect("default CLI path must resolve");
        let app = tauri::test::mock_app();
        let handle = app.handle();

        // The CLI's --approve refuses to overwrite an already-finalised
        // checklist.md (src/cli.ts: the final file must not exist yet), so
        // a re-run after a prior approval needs the old final removed
        // first. The approve below regenerates it deterministically, so
        // the repo ends up with the same file it started with.
        let _ = fs::remove_file(root.join("out/w1/checklist.md"));

        // 1. Run W1: must pause (exit 3) with a draft + review state.
        let run = run_cli_streaming(&handle, &resolved, &["run", "workflows/w1-regulation-screening.yaml"], "w1");
        assert_eq!(run.code, 3, "W1 run should pause for review, got {}: {}{}", run.code, run.stdout, run.stderr);
        let state = fs::read_to_string(root.join("out/w1/review-state.json"))
            .expect("review-state.json must exist after the pause");
        assert!(state.contains("\"status\": \"paused\"") || state.contains("\"status\":\"paused\""), "review state should be paused: {state}");
        assert!(root.join("out/w1/checklist-draft.csv").is_file(), "checklist draft must exist after the pause");
        let s = workflow_status_inner(root_str, "w1");
        assert_eq!(s.status, "paused");

        // 2. Approve through the app's approve path: must exit 0 and
        // finalise the checklist.
        let approved = run_cli_streaming(&handle, &resolved, &["run", "workflows/w1-regulation-screening.yaml", "--approve"], "w1");
        assert_eq!(approved.code, 0, "W1 --approve should succeed, got {}: {}{}", approved.code, approved.stdout, approved.stderr);
        let checklist = fs::read_to_string(root.join("out/w1/checklist.md"))
            .expect("checklist.md must exist after approval");
        assert!(checklist.contains("2.5"), "finalised checklist should contain the FAR value: {checklist}");
        let s2 = workflow_status_inner(root_str, "w1");
        // review-state.json says "approved" after --approve (the same
        // string the VS Code extension reports); "done" is only derived
        // from the audit log when no review state exists.
        assert_eq!(s2.status, "approved");

        // 3. W2 (no pause): straight run to exit 0, indicators regenerated.
        let w2 = run_cli_streaming(&handle, &resolved, &["run", "workflows/w2-cad-gis-metrics.yaml"], "w2");
        assert_eq!(w2.code, 0, "W2 run should finish, got {}: {}{}", w2.code, w2.stdout, w2.stderr);
        let indicators = fs::read_to_string(root.join("out/w2/indicators.csv"))
            .expect("indicators.csv must exist after W2");
        assert!(indicators.contains("building_density_pct,30"), "indicators should contain the density row: {indicators}");
        let s3 = workflow_status_inner(root_str, "w2");
        assert_eq!(s3.status, "done");

        // 4. Agent status round-trip: exit code and parsed state must agree.
        let status_run = run_cli_streaming(&handle, &resolved, &["agent", "--status"], "");
        let parsed = parse_agent_status(&status_run);
        assert_eq!(status_run.code == 0, parsed.configured, "agent --status exit {} vs parsed configured={}", status_run.code, parsed.configured);
    }
}
