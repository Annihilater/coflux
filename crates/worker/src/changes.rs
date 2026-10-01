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
///
/// `uncommitted` picks the scope (plan 20261001-changes-review-polish): false compares the
/// diff-stat base (merge-base of the default branch and HEAD, falling back to HEAD); true compares
/// HEAD, i.e. staged plus unstaged changes. Untracked files are listed in both scopes.
pub(crate) async fn list_changes(
    worktree: &str,
    default_branch: &str,
    uncommitted: bool,
) -> Result<(String, Vec<wire::DeviceChangedFile>), String> {
    let base = if uncommitted {
        head_oid(worktree).await
    } else {
        match merge_base(worktree, default_branch).await {
            Some(oid) => Some(oid),
            None => head_oid(worktree).await,
        }
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
///
/// The response always echoes `ignore_whitespace`, whatever path produced it (an error, a missing
/// side, binary content, equal sides): the echo tells the client this worker decoded the field,
/// not that a diff ran (plan 20261001-changes-review-polish).
pub(crate) async fn read_change_file(
    worktree: &str,
    request: wire::DeviceChangesFileRequest,
) -> wire::DeviceChangesFile {
    let ignore_whitespace = request.ignore_whitespace;
    let mut response = read_change_sides(worktree, request).await;
    response.ignore_whitespace = ignore_whitespace;
    response
}

async fn read_change_sides(
    worktree: &str,
    request: wire::DeviceChangesFileRequest,
) -> wire::DeviceChangesFile {
    let wire::DeviceChangesFileRequest {
        request_id,
        base,
        path,
        old_path,
        ignore_whitespace,
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
                ];
                // `-w` drops whitespace-only hunks; a patch left without any hunk then means
                // "only whitespace changed", which the client shows as such.
                if ignore_whitespace {
                    args.push("-w");
                }
                args.extend([base.as_str(), "--", path.as_str()]);
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
        // Set by `read_change_file` on every response.
        ignore_whitespace: false,
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

    /* ===== Scope and whitespace against a real repository (plan 20261001-changes-review-polish) ===== */

    use super::{list_changes, read_change_file};
    use coflux_protocol::wire;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A throwaway repository on `main`, removed on drop. Commits ignore the user's git config so a
    /// signing or hook setup cannot interfere.
    struct Repo(PathBuf);

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    impl Repo {
        fn new() -> Repo {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.subsec_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!(
                "coflux-changes-{}-{}-{nanos}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).expect("create the test repository");
            let repo = Repo(dir);
            repo.git(&["init", "-q"]);
            repo.git(&["symbolic-ref", "HEAD", "refs/heads/main"]);
            repo
        }

        fn root(&self) -> &str {
            self.0.to_str().expect("utf-8 temp path")
        }

        fn git(&self, args: &[&str]) -> String {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(&self.0)
                .args([
                    "-c",
                    "user.name=coflux",
                    "-c",
                    "user.email=coflux@example.invalid",
                    "-c",
                    "commit.gpgsign=false",
                    "-c",
                    "core.hooksPath=/dev/null",
                ])
                .args(args)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .output()
                .expect("run git");
            assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }

        fn write(&self, path: &str, content: &[u8]) {
            let full = Path::new(&self.0).join(path);
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent).expect("create parent");
            }
            std::fs::write(full, content).expect("write file");
        }

        fn commit_all(&self, message: &str) {
            self.git(&["add", "-A"]);
            self.git(&["commit", "-q", "-m", message]);
        }

        fn head(&self) -> String {
            self.git(&["rev-parse", "HEAD"])
        }
    }

    fn paths(files: &[wire::DeviceChangedFile]) -> Vec<String> {
        let mut paths: Vec<String> = files.iter().map(|file| file.path.clone()).collect();
        paths.sort();
        paths
    }

    fn file_request(base: &str, path: &str, old_path: Option<&str>, ignore_whitespace: bool) -> wire::DeviceChangesFileRequest {
        wire::DeviceChangesFileRequest {
            request_id: "r".into(),
            workspace_id: "w".into(),
            base: base.into(),
            path: path.into(),
            old_path: old_path.map(str::to_string),
            ignore_whitespace,
        }
    }

    fn hunk_count(patch: &str) -> usize {
        patch.lines().filter(|line| line.starts_with("@@ ")).count()
    }

    #[tokio::test]
    async fn uncommitted_scope_compares_head_and_branch_scope_the_merge_base() {
        let repo = Repo::new();
        repo.write("committed.txt", b"one\n");
        repo.write("unstaged.txt", b"one\n");
        repo.commit_all("base");
        let merge_base = repo.head();
        repo.git(&["checkout", "-q", "-b", "feature"]);
        repo.write("committed.txt", b"two\n");
        repo.commit_all("feature work");
        repo.write("unstaged.txt", b"two\n");
        repo.write("staged.txt", b"new\n");
        repo.git(&["add", "staged.txt"]);
        repo.write("untracked.txt", b"loose\n");

        let (base, files) = list_changes(repo.root(), "main", false).await.expect("branch scope");
        assert_eq!(base, merge_base);
        assert_eq!(paths(&files), ["committed.txt", "staged.txt", "unstaged.txt", "untracked.txt"]);

        let (base, files) = list_changes(repo.root(), "main", true).await.expect("uncommitted scope");
        assert_eq!(base, repo.head(), "the uncommitted scope compares HEAD");
        assert_eq!(paths(&files), ["staged.txt", "unstaged.txt", "untracked.txt"]);
        let unstaged = files.iter().find(|file| file.path == "unstaged.txt").unwrap();
        assert_eq!((unstaged.additions, unstaged.deletions), (1, 1));
    }

    #[tokio::test]
    async fn ignore_whitespace_drops_reindent_hunks_and_keeps_real_ones() {
        let repo = Repo::new();
        repo.write("reindent.ts", b"if (a) {\nfoo(a, b);\nbar();\n}\n");
        repo.write("mixed.ts", b"one();\ntwo();\nthree();\nfour();\nfive();\nsix();\n");
        repo.commit_all("base");
        let base = repo.head();
        repo.write("reindent.ts", b"if (a) {\n    foo(a, b);\n    bar();\n}\n");
        repo.write("mixed.ts", b"  one();\ntwo();\nthree();\nfour();\nfive();\nsix(changed);\n");

        let plain = read_change_file(repo.root(), file_request(&base, "reindent.ts", None, false)).await;
        assert!(plain.ok);
        assert!(!plain.ignore_whitespace);
        assert_eq!(hunk_count(&plain.patch), 1);

        let ignored = read_change_file(repo.root(), file_request(&base, "reindent.ts", None, true)).await;
        assert!(ignored.ok);
        assert!(ignored.ignore_whitespace);
        assert_eq!(hunk_count(&ignored.patch), 0, "a pure re-indent has no hunk under -w: {:?}", ignored.patch);
        assert_ne!(ignored.old_content, ignored.new_content, "the sides are returned whole either way");

        let plain = read_change_file(repo.root(), file_request(&base, "mixed.ts", None, false)).await;
        assert_eq!(hunk_count(&plain.patch), 2);
        let ignored = read_change_file(repo.root(), file_request(&base, "mixed.ts", None, true)).await;
        assert_eq!(hunk_count(&ignored.patch), 1, "only the real edit is left: {:?}", ignored.patch);
        assert!(ignored.patch.contains("@@ -6 +6 @@"), "{:?}", ignored.patch);
    }

    #[tokio::test]
    async fn ignore_whitespace_is_echoed_on_every_file_response() {
        let repo = Repo::new();
        repo.write("deleted.txt", b"gone\n");
        repo.write("moved-from.txt", b"same\n");
        repo.write("equal.txt", b"equal\n");
        repo.commit_all("base");
        let base = repo.head();
        std::fs::remove_file(Path::new(repo.root()).join("deleted.txt")).unwrap();
        repo.git(&["mv", "moved-from.txt", "moved-to.txt"]);
        repo.write("added.txt", b"new\n");
        repo.write("binary.bin", b"a\0b");

        let cases: Vec<(&str, wire::DeviceChangesFileRequest)> = vec![
            ("added", file_request(&base, "added.txt", None, true)),
            ("deleted", file_request(&base, "deleted.txt", None, true)),
            ("binary", file_request(&base, "binary.bin", None, true)),
            ("rename-only", file_request(&base, "moved-to.txt", Some("moved-from.txt"), true)),
            ("equal sides", file_request(&base, "equal.txt", None, true)),
            ("invalid path", file_request(&base, "../outside", None, true)),
            ("invalid base", file_request("HEAD", "added.txt", None, true)),
        ];
        for (name, request) in cases {
            let response = read_change_file(repo.root(), request).await;
            assert!(response.ignore_whitespace, "{name}: the echo must be set");
        }

        let error = read_change_file(repo.root(), file_request(&base, "../outside", None, true)).await;
        assert!(!error.ok);
        let added = read_change_file(repo.root(), file_request(&base, "added.txt", None, true)).await;
        assert!(added.ok && !added.old_exists && added.new_exists && added.patch.is_empty());
        let binary = read_change_file(repo.root(), file_request(&base, "binary.bin", None, true)).await;
        assert!(binary.ok && binary.binary);
        let not_asked = read_change_file(repo.root(), file_request(&base, "added.txt", None, false)).await;
        assert!(!not_asked.ignore_whitespace, "the echo mirrors the request, it is not a capability flag");
    }
}
