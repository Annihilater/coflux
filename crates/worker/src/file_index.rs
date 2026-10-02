//! Whole-workspace file index for the desktop files view (plan 20261002-workspace-files-view).
//!
//! One request answers every entry of a workspace in one response. When the root is the top level
//! of a git worktree the index is git's view of it: tracked files, untracked files that are not
//! ignored, and ignored entries at their top-most ignored level. Otherwise it is a plain walk of
//! the root. Directories the index does not descend into (ignored directories, nested
//! repositories, submodules, a walk's `.git` and empty directories) are directory entries that
//! the client lists on demand. The index is bounded: past its entry cap, response-size budget or
//! time budget it answers `truncated` with no entries, and the client lists folders lazily.

use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use coflux_protocol::wire::{FsIndexEntry, FsIndexEntryKind};

use crate::changes::git_bytes;

/// The bounds of one index answer.
#[derive(Debug, Clone, Copy)]
pub(crate) struct IndexLimits {
    /// Most entries one answer carries.
    pub entries: usize,
    /// Rough wire size of the entries (paths plus a fixed per-entry overhead); well under the
    /// 30 MiB device frame.
    pub bytes: usize,
    /// Wall-clock budget of a walk.
    pub walk: Duration,
    /// Wall-clock budget of the git commands.
    pub git: Duration,
}

pub(crate) const DEFAULT_LIMITS: IndexLimits = IndexLimits {
    entries: 100_000,
    bytes: 8 * 1024 * 1024,
    walk: Duration::from_secs(3),
    git: Duration::from_secs(5),
};

/// Protobuf framing of one entry beside its path: tags, lengths, kind and flag.
const ENTRY_OVERHEAD_BYTES: usize = 10;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum IndexOutcome {
    /// Every entry, sorted by path.
    Complete(Vec<FsIndexEntry>),
    /// A bound was hit; nothing partial is returned.
    Truncated,
}

/// Collects entries keyed by path and stops at the limits.
struct Collector {
    entries: BTreeMap<String, (FsIndexEntryKind, bool)>,
    bytes: usize,
    limits: IndexLimits,
}

impl Collector {
    fn new(limits: IndexLimits) -> Collector {
        Collector {
            entries: BTreeMap::new(),
            bytes: 0,
            limits,
        }
    }

    /// Adds an entry unless its path is already known; false once a bound is exceeded.
    fn add(&mut self, path: &str, kind: FsIndexEntryKind, ignored: bool) -> bool {
        let path = path.trim_end_matches('/');
        if path.is_empty() || self.entries.contains_key(path) {
            return true;
        }
        self.bytes += path.len() + ENTRY_OVERHEAD_BYTES;
        self.entries.insert(path.to_string(), (kind, ignored));
        self.entries.len() <= self.limits.entries && self.bytes <= self.limits.bytes
    }

    fn finish(self) -> IndexOutcome {
        IndexOutcome::Complete(
            self.entries
                .into_iter()
                .map(|(path, (kind, ignored))| FsIndexEntry {
                    path,
                    kind: kind as i32,
                    ignored,
                })
                .collect(),
        )
    }
}

/// Indexes a workspace root with the default limits.
pub(crate) async fn index_workspace(root: &str) -> Result<IndexOutcome, String> {
    index_workspace_with(root, DEFAULT_LIMITS).await
}

pub(crate) async fn index_workspace_with(
    root: &str,
    limits: IndexLimits,
) -> Result<IndexOutcome, String> {
    let Some(real_base) = crate::ops::real_root(root) else {
        return Err("工作区根目录不可用".into());
    };
    let Some(base) = real_base.to_str().map(str::to_string) else {
        return Err("工作区路径不是 UTF-8".into());
    };
    let git = tokio::time::timeout(limits.git, async {
        if !is_git_top_level(&base, &real_base).await {
            return None;
        }
        Some(git_index(&base, limits).await)
    })
    .await;
    match git {
        // A git command that overruns its budget is dropped (and killed) with its future.
        Err(_) => Ok(IndexOutcome::Truncated),
        Ok(Some(result)) => result,
        Ok(None) => tokio::task::spawn_blocking(move || walk_index(&real_base, limits))
            .await
            .map_err(|_| "文件索引失败".to_string()),
    }
}

/// Whether `base` is the top level of a git worktree. The workspace's default branch is not the
/// signal: it is empty for directory workspaces and for repositories without one.
async fn is_git_top_level(base: &str, real_base: &Path) -> bool {
    let Ok(out) = git_bytes(base, &["rev-parse", "--show-toplevel"]).await else {
        return false;
    };
    let top = String::from_utf8_lossy(&out).trim().to_string();
    if top.is_empty() {
        return false;
    }
    std::fs::canonicalize(&top).is_ok_and(|top| top == real_base)
}

async fn git_index(base: &str, limits: IndexLimits) -> Result<IndexOutcome, String> {
    // `--stage` on the tracked set only: it is the one place the gitlink mode (160000) shows, and
    // a gitlink path has no trailing slash to tell it from a file.
    let (cached, others, ignored) = tokio::try_join!(
        git_bytes(base, &["ls-files", "--cached", "--stage", "-z"]),
        git_bytes(base, &["ls-files", "--others", "--exclude-standard", "-z"]),
        git_bytes(
            base,
            &[
                "ls-files",
                "--others",
                "--ignored",
                "--exclude-standard",
                "--directory",
                "-z",
            ],
        ),
    )?;
    Ok(git_entries(&cached, &others, &ignored, limits))
}

/// Builds the index from the three `git ls-files -z` outputs.
fn git_entries(cached: &[u8], others: &[u8], ignored: &[u8], limits: IndexLimits) -> IndexOutcome {
    let mut collector = Collector::new(limits);
    // "<mode> <oid> <stage>\t<path>"; an unmerged path appears once per stage and is kept once.
    for record in records(cached) {
        let Some((info, path)) = record.split_once('\t') else {
            continue;
        };
        let kind = if info.split(' ').next() == Some("160000") {
            FsIndexEntryKind::Directory
        } else {
            FsIndexEntryKind::File
        };
        if !collector.add(path, kind, false) {
            return IndexOutcome::Truncated;
        }
    }
    // Untracked nested repositories end in "/" even without `--directory`.
    for (output, is_ignored) in [(others, false), (ignored, true)] {
        for path in records(output) {
            let kind = if path.ends_with('/') {
                FsIndexEntryKind::Directory
            } else {
                FsIndexEntryKind::File
            };
            if !collector.add(path, kind, is_ignored) {
                return IndexOutcome::Truncated;
            }
        }
    }
    collector.finish()
}

fn records(output: &[u8]) -> impl Iterator<Item = &str> {
    output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .filter_map(|record| std::str::from_utf8(record).ok())
}

/// Breadth-first walk of a root that is not a git top level. Symlinks are leaves, never followed;
/// `.git` directories and empty directories are directory entries listed on demand; a directory
/// that cannot be read is one too, so the client shows its error when it is opened.
fn walk_index(real_base: &Path, limits: IndexLimits) -> IndexOutcome {
    let deadline = Instant::now() + limits.walk;
    let mut collector = Collector::new(limits);
    let mut queue: VecDeque<(PathBuf, String)> = VecDeque::from([(real_base.to_path_buf(), String::new())]);
    while let Some((dir, rel)) = queue.pop_front() {
        if Instant::now() >= deadline {
            return IndexOutcome::Truncated;
        }
        let Ok(read) = std::fs::read_dir(&dir) else {
            if !rel.is_empty() && !collector.add(&rel, FsIndexEntryKind::Directory, false) {
                return IndexOutcome::Truncated;
            }
            continue;
        };
        let mut empty = true;
        for child in read.flatten() {
            empty = false;
            let name = child.file_name().to_string_lossy().into_owned();
            let child_rel = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            let is_dir = child
                .path()
                .symlink_metadata()
                .is_ok_and(|meta| meta.file_type().is_dir());
            if is_dir && name != ".git" {
                queue.push_back((child.path(), child_rel));
                continue;
            }
            let kind = if is_dir {
                FsIndexEntryKind::Directory
            } else {
                FsIndexEntryKind::File
            };
            if !collector.add(&child_rel, kind, false) {
                return IndexOutcome::Truncated;
            }
        }
        if empty && !rel.is_empty() && !collector.add(&rel, FsIndexEntryKind::Directory, false) {
            return IndexOutcome::Truncated;
        }
    }
    collector.finish()
}

#[cfg(test)]
mod tests {
    use super::{index_workspace, index_workspace_with, IndexOutcome, DEFAULT_LIMITS};
    use coflux_protocol::wire::{FsIndexEntry, FsIndexEntryKind};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A throwaway directory, removed on drop.
    struct Dir(PathBuf);

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    impl Dir {
        fn new() -> Dir {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.subsec_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!(
                "coflux-index-{}-{}-{nanos}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).expect("create the test directory");
            Dir(dir)
        }

        fn repo() -> Dir {
            let dir = Dir::new();
            git(&dir.0, &["init", "-q"]);
            dir
        }

        fn root(&self) -> &str {
            self.0.to_str().expect("utf-8 temp path")
        }

        fn write(&self, path: &str, content: &[u8]) {
            let full = self.0.join(path);
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent).expect("create parent");
            }
            std::fs::write(full, content).expect("write file");
        }

        fn git(&self, args: &[&str]) {
            git(&self.0, args);
        }
    }

    /// Runs git ignoring the user's system config, so signing or hooks cannot interfere.
    fn git(dir: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args([
                "-c",
                "user.name=coflux",
                "-c",
                "user.email=coflux@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "advice.addEmbeddedRepo=false",
            ])
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    async fn complete(root: &str) -> Vec<FsIndexEntry> {
        match index_workspace(root).await.expect("index") {
            IndexOutcome::Complete(entries) => entries,
            IndexOutcome::Truncated => panic!("unexpectedly truncated"),
        }
    }

    fn find<'a>(entries: &'a [FsIndexEntry], path: &str) -> Option<&'a FsIndexEntry> {
        entries.iter().find(|entry| entry.path == path)
    }

    fn assert_entry(entries: &[FsIndexEntry], path: &str, kind: FsIndexEntryKind, ignored: bool) {
        let entry = find(entries, path).unwrap_or_else(|| panic!("{path} missing from {entries:?}"));
        assert_eq!(entry.kind, kind as i32, "{path} kind");
        assert_eq!(entry.ignored, ignored, "{path} ignored");
    }

    #[tokio::test]
    async fn lists_tracked_and_untracked_files_and_collapses_ignored_entries() {
        let repo = Dir::repo();
        repo.write(".gitignore", b"build/\n*.tmpx\nforced.txt\n");
        repo.write("src/a b.ts", b"a\n");
        repo.write("中文/文件.md", b"x\n");
        repo.write("forced.txt", b"tracked though ignored\n");
        repo.git(&["add", ".gitignore", "src", "中文"]);
        repo.git(&["add", "-f", "forced.txt"]);
        repo.git(&["commit", "-q", "-m", "init"]);
        repo.write("new.ts", b"untracked\n");
        repo.write("build/out/a.js", b"1\n");
        repo.write("build/out/b.js", b"2\n");
        repo.write("scratch.tmpx", b"ignored file\n");

        let entries = complete(repo.root()).await;
        assert_entry(&entries, "src/a b.ts", FsIndexEntryKind::File, false);
        assert_entry(&entries, "中文/文件.md", FsIndexEntryKind::File, false);
        assert_entry(&entries, ".gitignore", FsIndexEntryKind::File, false);
        assert_entry(&entries, "new.ts", FsIndexEntryKind::File, false);
        // An ignored directory is one entry; git never descends into it.
        assert_entry(&entries, "build", FsIndexEntryKind::Directory, true);
        assert!(entries.iter().all(|entry| !entry.path.starts_with("build/")), "{entries:?}");
        assert_entry(&entries, "scratch.tmpx", FsIndexEntryKind::File, true);
        // A tracked file matched by .gitignore is not ignored.
        assert_entry(&entries, "forced.txt", FsIndexEntryKind::File, false);
        // Sorted, no trailing slashes.
        let paths: Vec<&str> = entries.iter().map(|entry| entry.path.as_str()).collect();
        let mut sorted = paths.clone();
        sorted.sort();
        assert_eq!(paths, sorted);
        assert!(paths.iter().all(|path| !path.ends_with('/')));
    }

    #[tokio::test]
    async fn nested_repositories_and_gitlinks_are_directories() {
        let repo = Dir::repo();
        repo.write("top.txt", b"top\n");
        // A submodule gitlink: a committed nested repository added as an embedded repository.
        repo.write("sub/inner.txt", b"inner\n");
        git(&repo.0.join("sub"), &["init", "-q"]);
        git(&repo.0.join("sub"), &["add", "-A"]);
        git(&repo.0.join("sub"), &["commit", "-q", "-m", "inner"]);
        repo.git(&["add", "top.txt", "sub"]);
        repo.git(&["commit", "-q", "-m", "init"]);
        // An untracked nested repository.
        repo.write("nested/n.txt", b"n\n");
        git(&repo.0.join("nested"), &["init", "-q"]);

        let entries = complete(repo.root()).await;
        assert_entry(&entries, "top.txt", FsIndexEntryKind::File, false);
        assert_entry(&entries, "sub", FsIndexEntryKind::Directory, false);
        assert_entry(&entries, "nested", FsIndexEntryKind::Directory, false);
        assert!(find(&entries, "sub/inner.txt").is_none());
        assert!(find(&entries, "nested/n.txt").is_none());
    }

    #[tokio::test]
    async fn a_deleted_unstaged_tracked_file_stays_in_the_index() {
        let repo = Dir::repo();
        repo.write("gone.txt", b"bye\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "init"]);
        std::fs::remove_file(repo.0.join("gone.txt")).expect("delete");
        let entries = complete(repo.root()).await;
        assert_entry(&entries, "gone.txt", FsIndexEntryKind::File, false);
    }

    #[tokio::test]
    async fn truncates_at_the_entry_cap_and_returns_nothing_partial() {
        let repo = Dir::repo();
        for name in ["a.txt", "b.txt", "c.txt"] {
            repo.write(name, b"x\n");
        }
        let small = super::IndexLimits {
            entries: 2,
            ..DEFAULT_LIMITS
        };
        assert_eq!(
            index_workspace_with(repo.root(), small).await.expect("index"),
            IndexOutcome::Truncated
        );
        let exact = super::IndexLimits {
            entries: 3,
            ..DEFAULT_LIMITS
        };
        assert!(matches!(
            index_workspace_with(repo.root(), exact).await.expect("index"),
            IndexOutcome::Complete(entries) if entries.len() == 3
        ));

        let plain = Dir::new();
        for name in ["a.txt", "b.txt", "c.txt"] {
            plain.write(name, b"x\n");
        }
        assert_eq!(
            index_workspace_with(plain.root(), small).await.expect("index"),
            IndexOutcome::Truncated
        );
    }

    #[tokio::test]
    async fn a_directory_workspace_is_walked() {
        let dir = Dir::new();
        dir.write("notes.md", b"n\n");
        dir.write("deep/er/file.txt", b"f\n");
        dir.write("proj/.git/HEAD", b"ref: refs/heads/main\n");
        dir.write("proj/readme.md", b"r\n");
        std::fs::create_dir_all(dir.0.join("empty")).expect("empty dir");
        std::os::unix::fs::symlink(dir.0.join("deep"), dir.0.join("link")).expect("symlink");

        let entries = complete(dir.root()).await;
        assert_entry(&entries, "notes.md", FsIndexEntryKind::File, false);
        assert_entry(&entries, "deep/er/file.txt", FsIndexEntryKind::File, false);
        assert_entry(&entries, "proj/readme.md", FsIndexEntryKind::File, false);
        // `.git` is not descended into; an empty directory is listed on demand.
        assert_entry(&entries, "proj/.git", FsIndexEntryKind::Directory, false);
        assert!(find(&entries, "proj/.git/HEAD").is_none());
        assert_entry(&entries, "empty", FsIndexEntryKind::Directory, false);
        // A symlink is a leaf, never followed.
        assert_entry(&entries, "link", FsIndexEntryKind::File, false);
        assert!(find(&entries, "link/er/file.txt").is_none());
        assert!(entries.iter().all(|entry| !entry.ignored));
    }

    #[tokio::test]
    async fn a_subdirectory_of_a_repository_is_walked_not_indexed_by_git() {
        let repo = Dir::repo();
        repo.write(".gitignore", b"*.tmpx\n");
        repo.write("pkg/a.ts", b"a\n");
        repo.write("pkg/b.tmpx", b"b\n");
        let pkg = repo.0.join("pkg");
        let entries = complete(pkg.to_str().expect("utf-8")).await;
        // Walk mode: nothing is ignored, ignore rules are not consulted.
        assert_entry(&entries, "a.ts", FsIndexEntryKind::File, false);
        assert_entry(&entries, "b.tmpx", FsIndexEntryKind::File, false);
    }

    #[tokio::test]
    async fn an_unusable_root_is_an_error() {
        let dir = Dir::new();
        let missing = dir.0.join("missing");
        assert!(index_workspace(missing.to_str().expect("utf-8")).await.is_err());
    }
}
