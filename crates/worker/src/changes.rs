//! Workspace changes for the desktop changes view (plan 20260929-changes-file-tree).
//!
//! The worker owns "what changed and against what base": one request lists every changed file
//! against the same base `git::diff_stat` uses (merge-base of the default branch and HEAD, falling
//! back to HEAD) plus every untracked file, with line counts read the same way the diff stat reads
//! them. A second request returns one file's two sides whole, plus git's `-U0` patch between them,
//! always against the base the list returned.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;

use coflux_protocol::wire::{self, DeviceChangeStatus};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::git::{count_untracked_lines, merge_base, UNTRACKED_COUNT_MAX_BYTES};

/// Largest side the content request returns. Two sides plus a `-U0` patch of a full rewrite stay
/// well below `MAX_DEVICE_FRAME_BYTES` (30 MiB); the client's large-diff guard sits far below this.
pub(crate) const MAX_SIDE_BYTES: u64 = 6 * 1024 * 1024;

const ZERO_OID_CHAR: char = '0';

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChangeStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

impl ChangeStatus {
    fn wire(self) -> DeviceChangeStatus {
        match self {
            ChangeStatus::Added => DeviceChangeStatus::Added,
            ChangeStatus::Modified => DeviceChangeStatus::Modified,
            ChangeStatus::Deleted => DeviceChangeStatus::Deleted,
            ChangeStatus::Renamed => DeviceChangeStatus::Renamed,
        }
    }
}

/// One record of `git diff -z --raw` joined with its `--numstat` counts.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RawChange {
    path: String,
    old_path: Option<String>,
    status: ChangeStatus,
    old_oid: Option<String>,
    gitlink: bool,
    additions: u32,
    deletions: u32,
    binary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NumStat {
    path: String,
    additions: u32,
    deletions: u32,
    binary: bool,
}

/// Parses the combined output of `git diff -z -M --raw --numstat --no-abbrev`. Git prints every raw
/// record first, then every numstat record, with NUL-terminated fields, so paths with spaces,
/// newlines or non-ASCII bytes survive untouched.
fn parse_raw_numstat(output: &str) -> Vec<RawChange> {
    let mut tokens = output.split('\0');
    let mut raw: Vec<RawChange> = Vec::new();
    let mut stats: Vec<NumStat> = Vec::new();
    while let Some(token) = tokens.next() {
        if token.is_empty() {
            continue;
        }
        if let Some(header) = token.strip_prefix(':') {
            // ":<old mode> <new mode> <old oid> <new oid> <status>"
            let fields: Vec<&str> = header.split(' ').collect();
            if fields.len() < 5 {
                continue;
            }
            let (old_mode, new_mode, old_oid, letter) = (fields[0], fields[1], fields[2], fields[4]);
            let gitlink = old_mode == "160000" || new_mode == "160000";
            let old_oid = (!old_oid.chars().all(|c| c == ZERO_OID_CHAR)).then(|| old_oid.to_string());
            let kind = letter.chars().next().unwrap_or('M');
            let (path, old_path, status) = match kind {
                'R' => {
                    let from = tokens.next().unwrap_or_default().to_string();
                    let to = tokens.next().unwrap_or_default().to_string();
                    (to, Some(from), ChangeStatus::Renamed)
                }
                'C' => {
                    // Copies only appear with -C; the destination is a new file.
                    let _from = tokens.next();
                    let to = tokens.next().unwrap_or_default().to_string();
                    (to, None, ChangeStatus::Added)
                }
                'A' => (tokens.next().unwrap_or_default().to_string(), None, ChangeStatus::Added),
                'D' => (tokens.next().unwrap_or_default().to_string(), None, ChangeStatus::Deleted),
                _ => (tokens.next().unwrap_or_default().to_string(), None, ChangeStatus::Modified),
            };
            if path.is_empty() {
                continue;
            }
            let old_oid = if kind == 'C' { None } else { old_oid };
            raw.push(RawChange {
                path,
                old_path,
                status,
                old_oid,
                gitlink,
                additions: 0,
                deletions: 0,
                binary: false,
            });
            continue;
        }
        // "<added>\t<deleted>\t<path>" or, for a rename, "<added>\t<deleted>\t" + old + new.
        let mut parts = token.splitn(3, '\t');
        let (Some(added), Some(deleted), Some(rest)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let path = if rest.is_empty() {
            let _from = tokens.next();
            tokens.next().unwrap_or_default().to_string()
        } else {
            rest.to_string()
        };
        let binary = added == "-" && deleted == "-";
        stats.push(NumStat {
            path,
            additions: added.parse().unwrap_or(0),
            deletions: deleted.parse().unwrap_or(0),
            binary,
        });
    }

    let mut by_path: HashMap<String, NumStat> = HashMap::with_capacity(stats.len());
    for stat in stats {
        by_path.insert(stat.path.clone(), stat);
    }
    // An unmerged path is reported twice (an `U` record plus the real pair); keep one entry per path,
    // the later record winning.
    let mut index: HashMap<String, usize> = HashMap::with_capacity(raw.len());
    let mut changes: Vec<RawChange> = Vec::with_capacity(raw.len());
    for mut change in raw {
        if let Some(stat) = by_path.get(&change.path) {
            change.additions = stat.additions;
            change.deletions = stat.deletions;
            change.binary = stat.binary;
        }
        if change.gitlink {
            change.binary = true;
        }
        match index.get(&change.path) {
            Some(&at) => changes[at] = change,
            None => {
                index.insert(change.path.clone(), changes.len());
                changes.push(change);
            }
        }
    }
    changes
}

async fn git_bytes(worktree: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let output = Command::new("git")
        .arg("--literal-pathspecs")
        .arg("-C")
        .arg(worktree)
        .args(args)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|error| format!("无法运行 git：{error}"))?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = stderr.trim();
        let message = if message.is_empty() { "git 执行失败" } else { message };
        Err(message.chars().take(400).collect())
    }
}

/// `git rev-parse` of HEAD as a full object id; None on an unborn branch.
async fn head_oid(worktree: &str) -> Option<String> {
    let out = git_bytes(worktree, &["rev-parse", "--verify", "-q", "HEAD^{commit}"])
        .await
        .ok()?;
    let oid = String::from_utf8_lossy(&out).trim().to_string();
    (!oid.is_empty()).then_some(oid)
}

/// Sizes of base-side blobs through one `git cat-file --batch-check`, never a process per file.
async fn blob_sizes(worktree: &str, oids: Vec<String>) -> HashMap<String, u64> {
    let mut sizes = HashMap::new();
    if oids.is_empty() {
        return sizes;
    }
    let Ok(mut child) = Command::new("git")
        .arg("-C")
        .arg(worktree)
        .args(["cat-file", "--batch-check"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    else {
        return sizes;
    };
    let Some(mut stdin) = child.stdin.take() else {
        return sizes;
    };
    let mut input = oids.join("\n");
    input.push('\n');
    // Write concurrently with reading stdout, or a long list could fill both pipes and deadlock.
    let writer = tokio::spawn(async move {
        let _ = stdin.write_all(input.as_bytes()).await;
        let _ = stdin.shutdown().await;
    });
    let output = child.wait_with_output().await;
    let _ = writer.await;
    let Ok(output) = output else {
        return sizes;
    };
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        // "<oid> <type> <size>" or "<oid> missing"
        let mut fields = line.split(' ');
        let (Some(oid), Some(_kind), Some(size)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        if let Ok(size) = size.parse::<u64>() {
            sizes.insert(oid.to_string(), size);
        }
    }
    sizes
}

fn worktree_size(worktree: &str, rel: &str) -> u64 {
    std::fs::symlink_metadata(Path::new(worktree).join(rel))
        .map(|meta| meta.len())
        .unwrap_or(0)
}

/// Lists every changed file of a worktree. Untracked files are counted by reading them directly,
/// exactly like `git::diff_stat` does, so the totals match the dock's `+X −Y`; files that stat skips
/// (over 1 MB, or containing NUL) are still listed, with zero lines.
pub(crate) async fn list_changes(worktree: &str, default_branch: &str) -> Result<(String, Vec<wire::DeviceChangedFile>), String> {
    let base = match merge_base(worktree, default_branch).await {
        Some(oid) => Some(oid),
        None => head_oid(worktree).await,
    };

    let mut files: Vec<wire::DeviceChangedFile> = Vec::new();
    let mut listed: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Some(base) = base.as_deref() {
        let out = git_bytes(
            worktree,
            &[
                "diff",
                "--no-color",
                "--no-ext-diff",
                "-z",
                "-M",
                "--raw",
                "--numstat",
                "--no-abbrev",
                base,
            ],
        )
        .await?;
        let changes = parse_raw_numstat(&String::from_utf8_lossy(&out));
        let oids: Vec<String> = changes
            .iter()
            .filter_map(|change| change.old_oid.clone())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        let old_sizes = blob_sizes(worktree, oids).await;
        for change in changes {
            let old_size = change
                .old_oid
                .as_ref()
                .and_then(|oid| old_sizes.get(oid).copied())
                .unwrap_or(0);
            let new_size = if change.status == ChangeStatus::Deleted {
                0
            } else {
                worktree_size(worktree, &change.path)
            };
            listed.insert(change.path.clone());
            files.push(wire::DeviceChangedFile {
                path: change.path,
                old_path: change.old_path,
                status: change.status.wire() as i32,
                additions: change.additions,
                deletions: change.deletions,
                binary: change.binary,
                size: old_size.max(new_size),
            });
        }
    }

    let out = git_bytes(worktree, &["ls-files", "--others", "--exclude-standard", "-z"]).await?;
    for rel in String::from_utf8_lossy(&out).split('\0').filter(|s| !s.is_empty()) {
        // A path deleted from the index but still on disk is both a deletion and untracked; the
        // tree lists it once, as the deletion git diff reports.
        if listed.contains(rel) {
            continue;
        }
        let path = Path::new(worktree).join(rel);
        let meta = std::fs::metadata(&path).ok();
        let size = meta
            .as_ref()
            .map(|meta| meta.len())
            .or_else(|| std::fs::symlink_metadata(&path).ok().map(|meta| meta.len()))
            .unwrap_or(0);
        let mut additions = 0u32;
        let mut binary = false;
        // Count exactly what `git::diff_stat` counts; the skip applies to counting only.
        if let Some(meta) = meta.as_ref().filter(|meta| meta.is_file()) {
            if meta.len() <= UNTRACKED_COUNT_MAX_BYTES {
                if let Ok(data) = std::fs::read(&path) {
                    match count_untracked_lines(&data) {
                        Some(lines) => additions = u32::try_from(lines).unwrap_or(0),
                        None => binary = true,
                    }
                }
            }
        }
        files.push(wire::DeviceChangedFile {
            path: rel.to_string(),
            old_path: None,
            status: DeviceChangeStatus::Untracked as i32,
            additions,
            deletions: 0,
            binary,
            size,
        });
    }

    Ok((base.unwrap_or_default(), files))
}

fn is_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// A worktree-relative path: no absolute, empty, `.` or `..` segments, and no NUL.
fn valid_relative_path(value: &str) -> bool {
    if value.is_empty() || value.contains('\0') || value.starts_with('/') {
        return false;
    }
    value.split('/').all(|segment| !segment.is_empty() && segment != "." && segment != "..")
        && Path::new(value)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

/// The base-side blob of `path`, or None when the base has no such blob.
async fn read_base_blob(worktree: &str, base: &str, path: &str) -> Result<Option<Vec<u8>>, String> {
    let spec = format!("{base}:{path}");
    let Ok(size) = git_bytes(worktree, &["cat-file", "-s", &spec]).await else {
        return Ok(None);
    };
    let size: u64 = String::from_utf8_lossy(&size).trim().parse().unwrap_or(0);
    if size > MAX_SIDE_BYTES {
        return Err(too_large());
    }
    match git_bytes(worktree, &["cat-file", "blob", &spec]).await {
        Ok(data) => Ok(Some(data)),
        // A gitlink or a tree at that path: nothing to show as text.
        Err(_) => Ok(None),
    }
}

/// The working-tree side of `path`. A symlink reads as its target, the way git stores it.
fn read_worktree_file(worktree: &str, path: &str) -> Result<Option<Vec<u8>>, String> {
    let root = std::fs::canonicalize(worktree).map_err(|error| error.to_string())?;
    let joined = root.join(path);
    let Ok(meta) = std::fs::symlink_metadata(&joined) else {
        return Ok(None);
    };
    // The parent must resolve inside the worktree, so a symlinked directory cannot lead outside it.
    let parent = joined.parent().map(Path::to_path_buf).unwrap_or_else(|| root.clone());
    let real_parent: PathBuf = std::fs::canonicalize(&parent).map_err(|error| error.to_string())?;
    if !real_parent.starts_with(&root) {
        return Err("路径越界".into());
    }
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(&joined).map_err(|error| error.to_string())?;
        return Ok(Some(target.to_string_lossy().into_owned().into_bytes()));
    }
    if !meta.is_file() {
        return Ok(None);
    }
    if meta.len() > MAX_SIDE_BYTES {
        return Err(too_large());
    }
    std::fs::read(&joined).map(Some).map_err(|error| error.to_string())
}

fn too_large() -> String {
    format!("文件超过 {} MB，不显示内容", MAX_SIDE_BYTES / (1024 * 1024))
}

fn looks_binary(data: &[u8]) -> bool {
    // Git's heuristic: a NUL within the first 8000 bytes.
    data.iter().take(8000).any(|&byte| byte == 0)
}

fn file_error(request_id: String, error: String) -> wire::DeviceChangesFile {
    wire::DeviceChangesFile {
        request_id,
        ok: false,
        error: Some(error),
        ..Default::default()
    }
}

/// One changed file's two sides and the `-U0` patch between them, against the list's base.
pub(crate) async fn read_change_file(
    worktree: &str,
    request: wire::DeviceChangesFileRequest,
) -> wire::DeviceChangesFile {
    let wire::DeviceChangesFileRequest {
        request_id,
        base,
        path,
        old_path,
        ..
    } = request;
    if !base.is_empty() && !is_object_id(&base) {
        return file_error(request_id, "base 无效".into());
    }
    if !valid_relative_path(&path) || old_path.as_deref().is_some_and(|old| !valid_relative_path(old)) {
        return file_error(request_id, "路径无效".into());
    }
    let old_side_path = old_path.as_deref().unwrap_or(&path);

    let old = if base.is_empty() {
        None
    } else {
        match read_base_blob(worktree, &base, old_side_path).await {
            Ok(old) => old,
            Err(error) => return file_error(request_id, error),
        }
    };
    let new = match read_worktree_file(worktree, &path) {
        Ok(new) => new,
        Err(error) => return file_error(request_id, error),
    };

    let binary = old.as_deref().is_some_and(looks_binary) || new.as_deref().is_some_and(looks_binary);
    let mut patch = String::new();
    if !binary {
        if let (Some(old), Some(new)) = (old.as_ref(), new.as_ref()) {
            if old != new {
                let mut args = vec![
                    "diff",
                    "--no-color",
                    "--no-ext-diff",
                    "--no-textconv",
                    "-U0",
                    "-M",
                    "--src-prefix=a/",
                    "--dst-prefix=b/",
                    base.as_str(),
                    "--",
                    path.as_str(),
                ];
                if let Some(old_path) = old_path.as_deref() {
                    args.push(old_path);
                }
                match git_bytes(worktree, &args).await {
                    Ok(out) => patch = String::from_utf8_lossy(&out).into_owned(),
                    Err(error) => return file_error(request_id, error),
                }
            }
        }
    }

    let text = |side: &Option<Vec<u8>>| {
        if binary {
            String::new()
        } else {
            side.as_deref()
                .map(|data| String::from_utf8_lossy(data).into_owned())
                .unwrap_or_default()
        }
    };
    wire::DeviceChangesFile {
        request_id,
        ok: true,
        error: None,
        old_exists: old.is_some(),
        new_exists: new.is_some(),
        old_content: text(&old),
        new_content: text(&new),
        patch,
        binary,
    }
}

#[cfg(test)]
mod tests {
    use super::{is_object_id, parse_raw_numstat, valid_relative_path, ChangeStatus};

    const OLD: &str = "1111111111111111111111111111111111111111";
    const ZERO: &str = "0000000000000000000000000000000000000000";

    fn raw(old_mode: &str, new_mode: &str, old: &str, status: &str) -> String {
        format!(":{old_mode} {new_mode} {old} {ZERO} {status}")
    }

    #[test]
    fn parses_modified_added_deleted_and_binary_records() {
        let output = [
            raw("100644", "100644", OLD, "M"),
            "src/a b.ts".into(),
            raw("000000", "100644", ZERO, "A"),
            "新文件.md".into(),
            raw("100644", "000000", OLD, "D"),
            "old.bin".into(),
            "3\t1\tsrc/a b.ts".into(),
            "2\t0\t新文件.md".into(),
            "-\t-\told.bin".into(),
            String::new(),
        ]
        .join("\0");
        let changes = parse_raw_numstat(&output);
        assert_eq!(changes.len(), 3);
        assert_eq!(changes[0].path, "src/a b.ts");
        assert_eq!(changes[0].status, ChangeStatus::Modified);
        assert_eq!((changes[0].additions, changes[0].deletions), (3, 1));
        assert_eq!(changes[0].old_oid.as_deref(), Some(OLD));
        assert_eq!(changes[1].path, "新文件.md");
        assert_eq!(changes[1].status, ChangeStatus::Added);
        assert_eq!(changes[1].old_oid, None);
        assert_eq!(changes[2].status, ChangeStatus::Deleted);
        assert!(changes[2].binary);
        assert_eq!((changes[2].additions, changes[2].deletions), (0, 0));
    }

    #[test]
    fn parses_renames_with_both_paths() {
        let output = [
            raw("100644", "100644", OLD, "R087"),
            "dir/old name.ts".into(),
            "dir/new name.ts".into(),
            "4\t2\t".into(),
            "dir/old name.ts".into(),
            "dir/new name.ts".into(),
            String::new(),
        ]
        .join("\0");
        let changes = parse_raw_numstat(&output);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "dir/new name.ts");
        assert_eq!(changes[0].old_path.as_deref(), Some("dir/old name.ts"));
        assert_eq!(changes[0].status, ChangeStatus::Renamed);
        assert_eq!((changes[0].additions, changes[0].deletions), (4, 2));
    }

    #[test]
    fn gitlinks_are_binary_and_unmerged_paths_are_listed_once() {
        let output = [
            raw("160000", "160000", OLD, "M"),
            "vendor/sub".into(),
            raw("000000", "000000", ZERO, "U"),
            "conflict.txt".into(),
            raw("100644", "100644", OLD, "M"),
            "conflict.txt".into(),
            "1\t1\tvendor/sub".into(),
            "5\t2\tconflict.txt".into(),
            String::new(),
        ]
        .join("\0");
        let changes = parse_raw_numstat(&output);
        assert_eq!(changes.len(), 2);
        assert!(changes[0].binary);
        assert_eq!(changes[1].path, "conflict.txt");
        assert_eq!(changes[1].old_oid.as_deref(), Some(OLD));
        assert_eq!((changes[1].additions, changes[1].deletions), (5, 2));
    }

    #[test]
    fn validates_request_paths_and_bases() {
        assert!(valid_relative_path("a/b c/d.ts"));
        assert!(valid_relative_path("中文/文件.md"));
        for bad in ["", "/etc/passwd", "../x", "a/../b", "a//b", "./a", "a/", "a\0b"] {
            assert!(!valid_relative_path(bad), "{bad:?} must be rejected");
        }
        assert!(is_object_id(OLD));
        assert!(!is_object_id("HEAD"));
        assert!(!is_object_id("--output=/tmp/x"));
    }
}
