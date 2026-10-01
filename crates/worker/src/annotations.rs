//! Browser annotations (plan 20260929-browser-annotations): the worker's per-workspace store.
//!
//! A desktop annotates elements of a page in its built-in browser tab ("this element, change it like
//! so"); the annotations belong to the **workspace** and live on the device that hosts it, so the
//! workspace's agents read them with `coflux annotations list` whether or not a desktop is open, and
//! every desktop of the account sees the same set.
//!
//! Layout under `$COFLUX_HOME/annotations/` (directories 0700, files 0600):
//!
//! ```text
//! <workspaceId>/index.json                      the workspace's annotations and its revision
//! <workspaceId>/<annotationId>/<imageId>.<ext>   one file per image
//! ```
//!
//! Every write replaces its file atomically ([`crate::atomic_file`]). The store keys by workspace id
//! only: it never needs the worker's workspace table (which is filled from the center and not
//! persisted) to read or list annotations.
//!
//! One annotation points at one or more elements, optionally narrowed to a dragged region (plan
//! 20260929-annotation-polish): `targets[0]` is the anchor, the region is stored relative to it.
//!
//! A code comment (plan 20261001-changes-review-comments) is the same record with a code anchor —
//! lines of one file on one side of the changes view's diff — instead of targets. It shares the
//! numbering, the undo window, the summary counts and the agent commands with page annotations.
//! The anchor is an additive optional field: the index format stays version 2.
//!
//! Deleting is undoable (plan 20260929-annotation-polish): a delete, confirm or clear-resolved moves
//! the records to the index's `deleted` list — gone at once from every listing, count and agent
//! output — and keeps them (image files included) restorable for [`UNDO_WINDOW_MS`]. Expired ones
//! are purged lazily, whenever a workspace's index is loaded or accessed.
//!
//! Index format version 2. An index of any other version (v1 predates targets) is discarded with
//! its images on first access: compatibility with older stores is explicitly not kept.
//!
//! Content never leaves toward the center: what the center receives is the metadata-only
//! [`wire::AnnotationsSummary`] (per workspace a revision and two counts), published as a full
//! idempotent snapshot on every change and unconditionally after authentication, like
//! `SecretRequests`.
//!
//! All methods do blocking file I/O under one lock; async callers run them on the blocking pool.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::os::unix::fs::DirBuilderExt as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use coflux_protocol::logln;
use coflux_protocol::wire::{self, daemon_to_server};
use prost::Message as _;
use rand_core::{OsRng, RngCore as _};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, watch};

use crate::WsOut;

const INDEX_FILE: &str = "index.json";
const INDEX_VERSION: u32 = 2;

/// Annotations kept per workspace; a runaway client cannot fill the disk with records.
pub const MAX_ANNOTATIONS: usize = 500;
/// Images per annotation (the automatic screenshot plus references).
pub const MAX_IMAGES: usize = 10;
/// Bytes of one image. The desktop compresses attachments well below this.
pub const MAX_IMAGE_BYTES: usize = 12 * 1024 * 1024;
const MAX_COMMENT_CHARS: usize = 10_000;
const MAX_NOTE_CHARS: usize = 4_000;
const MAX_URL_CHARS: usize = 4_000;
const MAX_TITLE_CHARS: usize = 500;
const MAX_SELECTOR_CHARS: usize = 2_000;
const MAX_DOM_PATH_CHARS: usize = 4_000;
const MAX_TEXT_CHARS: usize = 500;
const MAX_SHORT_CHARS: usize = 200;
const MAX_VALUE_CHARS: usize = 500;
const MAX_LIST_ITEMS: usize = 24;
const MAX_MAP_ITEMS: usize = 40;
const MAX_FOLLOW_UPS: usize = 50;
/// Elements one annotation points at (a shift-click selection, or a region's inner elements).
const MAX_TARGETS: usize = 24;
/// Characters of a code comment's commented lines kept with it (its excerpt).
const MAX_EXCERPT_CHARS: usize = 8_000;
/// Characters of a code anchor's path.
const MAX_PATH_CHARS: usize = 1_000;
/// Lines one code comment may span.
const MAX_CODE_LINES: u32 = 10_000;
/// How long a deleted annotation stays restorable (「撤销」); comfortably longer than the toast.
pub const UNDO_WINDOW_MS: f64 = 60_000.0;
/// Workspaces listed in one summary; the center applies the same cap.
const MAX_SUMMARY_WORKSPACES: usize = 1024;

pub const STATUS_PENDING: &str = "pending";
pub const STATUS_RESOLVED: &str = "resolved";
/// A code anchor's side: the comparison base, or the working tree.
pub const SIDE_BASE: &str = "base";
pub const SIDE_WORKING_TREE: &str = "working-tree";
const KIND_SCREENSHOT: &str = "screenshot";
const KIND_REFERENCE: &str = "reference";

/// One annotation as stored in `index.json`. Every field defaults, so records written by an older
/// or newer worker load without a migration; unknown fields are kept as they are.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StoredAnnotation {
    pub id: String,
    pub number: u32,
    pub status: String,
    pub page_url: String,
    pub page_title: String,
    pub comment: String,
    /// At least one unless `code` is set; `targets[0]` is the anchor (see the module comment).
    pub targets: Vec<StoredTarget>,
    pub region: Option<StoredRegion>,
    /// Set for a code comment, which has no targets.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<StoredCodeAnchor>,
    pub images: Vec<StoredImage>,
    pub resolution_note: String,
    pub follow_ups: Vec<StoredFollowUp>,
    pub created_at: f64,
    pub updated_at: f64,
    pub resolved_at: f64,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StoredTarget {
    pub element: StoredElement,
    pub source: StoredSource,
}

impl StoredTarget {
    fn source_json(&self) -> serde_json::Value {
        let source = &self.source;
        if source.framework.is_empty() && source.components.is_empty() && source.file.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::to_value(source).unwrap_or_default()
        }
    }
}

/// A dragged region, in CSS pixels relative to `targets[0]`'s top-left corner.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StoredRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Where a code comment sits: lines `start_line..=end_line` (1-based) of `path` on `side`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StoredCodeAnchor {
    pub path: String,
    /// [`SIDE_BASE`] or [`SIDE_WORKING_TREE`].
    pub side: String,
    pub start_line: u32,
    pub end_line: u32,
    /// The commented lines' text when the comment was written.
    pub excerpt: String,
    /// The commit a base-side anchor's lines were read from; empty for the working tree.
    pub base_commit: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StoredElement {
    pub selector: String,
    pub dom_path: String,
    pub tag: String,
    pub text: String,
    pub element_id: String,
    pub classes: Vec<String>,
    pub attributes: BTreeMap<String, String>,
    pub styles: BTreeMap<String, String>,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StoredSource {
    pub framework: String,
    pub components: Vec<String>,
    pub file: String,
    pub line: u32,
    pub column: u32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StoredImage {
    pub id: String,
    pub kind: String,
    pub mime_type: String,
    pub size: u32,
    /// File name inside the annotation's directory.
    pub file: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StoredFollowUp {
    pub comment: String,
    pub previous_note: String,
    pub created_at: f64,
}

/// A deleted annotation kept restorable until `deleted_at + UNDO_WINDOW_MS`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct DeletedAnnotation {
    deleted_at: f64,
    annotation: StoredAnnotation,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct WorkspaceIndex {
    version: u32,
    revision: u32,
    next_number: u32,
    /// The live annotations: the only ones listing, counting, editing and agents ever see.
    annotations: Vec<StoredAnnotation>,
    /// Deleted within the undo window; see [`UNDO_WINDOW_MS`].
    deleted: Vec<DeletedAnnotation>,
    #[serde(flatten)]
    extra: BTreeMap<String, serde_json::Value>,
}

/// Only the header of an index file, read before trusting the rest of it.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct IndexHeader {
    version: u32,
    revision: u32,
}

impl WorkspaceIndex {
    fn counts(&self) -> (u32, u32) {
        let pending = self
            .annotations
            .iter()
            .filter(|annotation| annotation.status == STATUS_PENDING)
            .count() as u32;
        let resolved = self.annotations.len() as u32 - pending;
        (pending, resolved)
    }

    fn position(&self, annotation_id: &str) -> Option<usize> {
        self.annotations
            .iter()
            .position(|annotation| annotation.id == annotation_id)
    }
}

#[derive(Default)]
struct Inner {
    workspaces: HashMap<String, WorkspaceIndex>,
    /// Whether every workspace directory on disk has been loaded (needed for a full summary).
    scanned: bool,
}

pub struct AnnotationStore {
    root: PathBuf,
    inner: Mutex<Inner>,
    to_server: mpsc::Sender<WsOut>,
    /// Bumped on every change of any workspace; `coflux annotations watch` waits on it.
    changes: watch::Sender<u64>,
}

/// A path segment the store builds file names from: workspace ids (UUIDs) and its own ids.
pub fn valid_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.starts_with('.')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |duration| duration.as_secs_f64() * 1000.0)
}

fn fresh_id(prefix: &str) -> String {
    let mut random = [0u8; 8];
    OsRng.fill_bytes(&mut random);
    format!("{prefix}-{}", hex::encode(random))
}

fn clip(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    trimmed.chars().take(max_chars).collect()
}

fn clip_list(values: &[String], max_chars: usize) -> Vec<String> {
    values
        .iter()
        .map(|value| clip(value, max_chars))
        .filter(|value| !value.is_empty())
        .take(MAX_LIST_ITEMS)
        .collect()
}

fn clip_map(values: &HashMap<String, String>) -> BTreeMap<String, String> {
    let mut sorted: Vec<(&String, &String)> = values.iter().collect();
    sorted.sort();
    sorted
        .into_iter()
        .map(|(key, value)| (clip(key, 64), clip(value, MAX_VALUE_CHARS)))
        .filter(|(key, value)| !key.is_empty() && !value.is_empty())
        .take(MAX_MAP_ITEMS)
        .collect()
}

fn finite(value: f64) -> f64 {
    if value.is_finite() && value >= 0.0 {
        value
    } else {
        0.0
    }
}

fn finite_signed(value: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

fn targets_from_wire(targets: &[wire::AnnotationTarget]) -> Vec<StoredTarget> {
    targets
        .iter()
        .take(MAX_TARGETS)
        .map(|target| StoredTarget {
            element: element_from_wire(target.element.as_ref()),
            source: source_from_wire(target.source.as_ref()),
        })
        .collect()
}

fn region_from_wire(region: Option<&wire::AnnotationRegion>) -> Option<StoredRegion> {
    let region = region?;
    let width = finite(region.width);
    let height = finite(region.height);
    if width <= 0.0 || height <= 0.0 {
        return None;
    }
    Some(StoredRegion {
        x: finite_signed(region.x),
        y: finite_signed(region.y),
        width,
        height,
    })
}

/// Truncates to `max_chars` without trimming: a code excerpt's indentation is part of it.
fn clip_raw(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    value.chars().take(max_chars).collect()
}

/// A worktree-relative path as the changes view names it: no absolute path, no `..` step.
fn code_path(value: &str) -> Result<String, String> {
    let path = clip(value, MAX_PATH_CHARS);
    let path = path.trim_start_matches("./").to_string();
    if path.is_empty()
        || path.starts_with('/')
        || path.contains('\0')
        || path.split('/').any(|segment| segment == ".." || segment.is_empty())
    {
        return Err("a code comment needs a relative file path".into());
    }
    Ok(path)
}

/// Validates a code anchor from a put. `None` when the put carries none.
fn code_from_wire(code: Option<&wire::AnnotationCodeAnchor>) -> Result<Option<StoredCodeAnchor>, String> {
    let Some(code) = code else {
        return Ok(None);
    };
    let path = code_path(&code.path)?;
    let side = match wire::AnnotationCodeSide::try_from(code.side) {
        Ok(wire::AnnotationCodeSide::Base) => SIDE_BASE,
        Ok(wire::AnnotationCodeSide::WorkingTree) => SIDE_WORKING_TREE,
        _ => return Err("a code comment needs the side of the diff it is on".into()),
    };
    if code.start_line == 0 || code.end_line < code.start_line || code.end_line - code.start_line >= MAX_CODE_LINES {
        return Err("a code comment needs a valid line range".into());
    }
    let base_commit = if side == SIDE_BASE {
        let commit = clip(&code.base_commit, 64);
        if !commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("invalid base commit".into());
        }
        commit
    } else {
        String::new()
    };
    Ok(Some(StoredCodeAnchor {
        path,
        side: side.into(),
        start_line: code.start_line,
        end_line: code.end_line,
        excerpt: clip_raw(&code.excerpt, MAX_EXCERPT_CHARS),
        base_commit,
    }))
}

fn code_to_wire(code: &StoredCodeAnchor) -> wire::AnnotationCodeAnchor {
    wire::AnnotationCodeAnchor {
        path: code.path.clone(),
        side: if code.side == SIDE_BASE {
            wire::AnnotationCodeSide::Base as i32
        } else {
            wire::AnnotationCodeSide::WorkingTree as i32
        },
        start_line: code.start_line,
        end_line: code.end_line,
        excerpt: code.excerpt.clone(),
        base_commit: code.base_commit.clone(),
    }
}

fn element_to_wire(element: &StoredElement) -> wire::AnnotationElement {
    wire::AnnotationElement {
        selector: element.selector.clone(),
        dom_path: element.dom_path.clone(),
        tag: element.tag.clone(),
        text: element.text.clone(),
        element_id: element.element_id.clone(),
        classes: element.classes.clone(),
        attributes: element.attributes.clone().into_iter().collect(),
        styles: element.styles.clone().into_iter().collect(),
        width: element.width,
        height: element.height,
    }
}

fn source_to_wire(source: &StoredSource) -> wire::AnnotationSource {
    wire::AnnotationSource {
        framework: source.framework.clone(),
        components: source.components.clone(),
        file: source.file.clone(),
        line: source.line,
        column: source.column,
    }
}

fn element_from_wire(element: Option<&wire::AnnotationElement>) -> StoredElement {
    let Some(element) = element else {
        return StoredElement::default();
    };
    StoredElement {
        selector: clip(&element.selector, MAX_SELECTOR_CHARS),
        dom_path: clip(&element.dom_path, MAX_DOM_PATH_CHARS),
        tag: clip(&element.tag, 64).to_ascii_lowercase(),
        text: clip(&element.text, MAX_TEXT_CHARS),
        element_id: clip(&element.element_id, MAX_SHORT_CHARS),
        classes: clip_list(&element.classes, MAX_SHORT_CHARS),
        attributes: clip_map(&element.attributes),
        styles: clip_map(&element.styles),
        width: finite(element.width),
        height: finite(element.height),
    }
}

fn source_from_wire(source: Option<&wire::AnnotationSource>) -> StoredSource {
    let Some(source) = source else {
        return StoredSource::default();
    };
    StoredSource {
        framework: clip(&source.framework, 32).to_ascii_lowercase(),
        components: clip_list(&source.components, MAX_SHORT_CHARS),
        file: clip(&source.file, 1_000),
        line: source.line,
        column: source.column,
    }
}

fn image_kind_name(kind: i32) -> &'static str {
    match wire::AnnotationImageKind::try_from(kind) {
        Ok(wire::AnnotationImageKind::Screenshot) => KIND_SCREENSHOT,
        _ => KIND_REFERENCE,
    }
}

fn image_kind_wire(kind: &str) -> i32 {
    if kind == KIND_SCREENSHOT {
        wire::AnnotationImageKind::Screenshot as i32
    } else {
        wire::AnnotationImageKind::Reference as i32
    }
}

fn extension_for(mime_type: &str) -> Option<&'static str> {
    match mime_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

fn create_private_dir(path: &Path) -> Result<(), String> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .map_err(|error| format!("cannot create {}: {error}", path.display()))
}

impl AnnotationStore {
    pub fn new(home: &str, to_server: mpsc::Sender<WsOut>) -> Self {
        let home = Path::new(home);
        // Image paths are handed to agents as absolute paths; anchor a relative COFLUX_HOME once.
        let home = if home.is_absolute() {
            home.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|cwd| cwd.join(home))
                .unwrap_or_else(|_| home.to_path_buf())
        };
        let (changes, _) = watch::channel(0);
        Self {
            root: home.join("annotations"),
            inner: Mutex::new(Inner::default()),
            to_server,
            changes,
        }
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    fn workspace_dir(&self, workspace_id: &str) -> PathBuf {
        self.root.join(workspace_id)
    }

    fn annotation_dir(&self, workspace_id: &str, annotation_id: &str) -> PathBuf {
        self.workspace_dir(workspace_id).join(annotation_id)
    }

    /// Absolute path of one stored image.
    pub fn image_path(&self, workspace_id: &str, annotation_id: &str, image: &StoredImage) -> PathBuf {
        self.annotation_dir(workspace_id, annotation_id).join(&image.file)
    }

    fn empty_index(revision: u32) -> WorkspaceIndex {
        WorkspaceIndex {
            version: INDEX_VERSION,
            revision,
            next_number: 1,
            ..WorkspaceIndex::default()
        }
    }

    fn read_index(&self, workspace_id: &str) -> Result<WorkspaceIndex, String> {
        let dir = self.workspace_dir(workspace_id);
        let path = dir.join(INDEX_FILE);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Self::empty_index(0)),
            Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
        };
        let header: IndexHeader = serde_json::from_slice(&bytes)
            .map_err(|error| format!("annotation index {} is unreadable: {error}", path.display()))?;
        if header.version != INDEX_VERSION {
            // Another format (v1 predates targets): no conversion, by design. Drop it with its
            // images; the revision carries on so desktops still see a change.
            logln!(
                "[annotations] discarding workspace {workspace_id}'s annotations: index version {} is not {INDEX_VERSION}",
                header.version
            );
            if let Err(error) = fs::remove_dir_all(&dir) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    logln!("[annotations] cannot delete {}: {error}", dir.display());
                }
            }
            return Ok(Self::empty_index(header.revision));
        }
        serde_json::from_slice(&bytes)
            .map_err(|error| format!("annotation index {} is unreadable: {error}", path.display()))
    }

    fn write_index(&self, workspace_id: &str, index: &WorkspaceIndex) -> Result<(), String> {
        let dir = self.workspace_dir(workspace_id);
        create_private_dir(&dir)?;
        let bytes = serde_json::to_vec_pretty(index).map_err(|error| error.to_string())?;
        crate::atomic_file::write_atomic(&dir.join(INDEX_FILE), &bytes)
            .map_err(|error| format!("cannot write the annotation index: {error}"))
    }

    /// The cached index of a workspace, loaded on first use; expired deletions are purged here.
    fn index<'a>(&self, inner: &'a mut Inner, workspace_id: &str) -> Result<&'a mut WorkspaceIndex, String> {
        if !valid_segment(workspace_id) {
            return Err("invalid workspace id".into());
        }
        if !inner.workspaces.contains_key(workspace_id) {
            let index = self.read_index(workspace_id)?;
            inner.workspaces.insert(workspace_id.to_string(), index);
        }
        let index = inner.workspaces.get_mut(workspace_id).unwrap();
        self.purge_expired(workspace_id, index, now_ms());
        Ok(index)
    }

    /// Drops deletions whose undo window has passed, with their image files. Invisible to readers
    /// (they were already gone), so the revision does not change and nothing is published.
    fn purge_expired(&self, workspace_id: &str, index: &mut WorkspaceIndex, now: f64) {
        let expired = |entry: &DeletedAnnotation| now - entry.deleted_at >= UNDO_WINDOW_MS;
        if !index.deleted.iter().any(expired) {
            return;
        }
        let (gone, kept): (Vec<DeletedAnnotation>, Vec<DeletedAnnotation>) =
            std::mem::take(&mut index.deleted).into_iter().partition(expired);
        index.deleted = kept;
        if let Err(error) = self.write_index(workspace_id, index) {
            logln!("[annotations] {error}");
        }
        for entry in gone {
            self.remove_annotation_files(workspace_id, &entry.annotation.id);
        }
    }

    /// Loads every workspace directory once, so a summary covers what is on disk.
    fn scan(&self, inner: &mut Inner) {
        if inner.scanned {
            return;
        }
        inner.scanned = true;
        let Ok(entries) = fs::read_dir(&self.root) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !valid_segment(&name) || inner.workspaces.contains_key(&name) {
                continue;
            }
            if !entry.path().join(INDEX_FILE).is_file() {
                continue;
            }
            match self.read_index(&name) {
                Ok(mut index) => {
                    self.purge_expired(&name, &mut index, now_ms());
                    inner.workspaces.insert(name, index);
                }
                Err(error) => logln!("[annotations] {error}"),
            }
        }
    }

    fn summary_locked(&self, inner: &mut Inner) -> Vec<wire::WorkspaceAnnotationSummary> {
        self.scan(inner);
        let mut workspaces: Vec<wire::WorkspaceAnnotationSummary> = inner
            .workspaces
            .iter()
            .filter(|(_, index)| index.revision > 0)
            .map(|(workspace_id, index)| {
                let (pending, resolved) = index.counts();
                wire::WorkspaceAnnotationSummary {
                    workspace_id: workspace_id.clone(),
                    revision: index.revision,
                    pending,
                    resolved,
                }
            })
            .collect();
        workspaces.sort_by(|a, b| a.workspace_id.cmp(&b.workspace_id));
        workspaces.truncate(MAX_SUMMARY_WORKSPACES);
        workspaces
    }

    /// Queues the full summary for the center with the lock held, so snapshots enter the outbound
    /// queue in the order they were taken; a dropped one (full queue) is healed by the next change
    /// or the unconditional re-send after authentication.
    fn publish_locked(&self, inner: &mut Inner) {
        let envelope = wire::DaemonToServer {
            payload: Some(daemon_to_server::Payload::AnnotationsSummary(
                wire::AnnotationsSummary {
                    workspaces: self.summary_locked(inner),
                },
            )),
        };
        let _ = self.to_server.try_send(envelope.encode_to_vec());
    }

    /// Unconditional re-send (after authentication: the center keeps the summary in memory only).
    pub fn publish(&self) {
        let mut inner = self.inner.lock().unwrap();
        self.publish_locked(&mut inner);
    }

    #[cfg(test)]
    fn summary(&self) -> Vec<wire::WorkspaceAnnotationSummary> {
        let mut inner = self.inner.lock().unwrap();
        self.summary_locked(&mut inner)
    }

    /// Persists a changed index (revision bumped here), then tells the center and the waiters.
    fn commit(&self, inner: &mut Inner, workspace_id: &str, mut index: WorkspaceIndex) -> Result<u32, String> {
        index.version = INDEX_VERSION;
        index.revision = index.revision.wrapping_add(1).max(1);
        self.write_index(workspace_id, &index)?;
        let revision = index.revision;
        inner.workspaces.insert(workspace_id.to_string(), index);
        self.publish_locked(inner);
        self.changes.send_modify(|value| *value = value.wrapping_add(1));
        Ok(revision)
    }

    /// Every annotation of the workspace, in number order.
    pub fn list(&self, workspace_id: &str) -> Result<(u32, Vec<StoredAnnotation>), String> {
        let mut inner = self.inner.lock().unwrap();
        let index = self.index(&mut inner, workspace_id)?;
        Ok((index.revision, index.annotations.clone()))
    }

    /// Create (empty id) or edit an annotation, adding and removing images.
    pub fn put(&self, workspace_id: &str, put: wire::AnnotationPut) -> Result<(u32, StoredAnnotation), String> {
        let incoming = put.annotation.unwrap_or_default();
        let comment = clip(&incoming.comment, MAX_COMMENT_CHARS);
        if comment.is_empty() && put.add_images.is_empty() && incoming.annotation_id.is_empty() {
            return Err("an annotation needs a comment".into());
        }
        let targets = targets_from_wire(&incoming.targets);
        let code = code_from_wire(incoming.code.as_ref())?;
        if !targets.is_empty() && code.is_some() {
            return Err("an annotation points at page elements or at code, not both".into());
        }
        if incoming.annotation_id.is_empty() && targets.is_empty() && code.is_none() {
            return Err("an annotation needs at least one element or a code location".into());
        }
        let mut inner = self.inner.lock().unwrap();
        let mut index = self.index(&mut inner, workspace_id)?.clone();
        let now = now_ms();
        let position = if incoming.annotation_id.is_empty() {
            if index.annotations.len() >= MAX_ANNOTATIONS {
                return Err(format!(
                    "this workspace already has {MAX_ANNOTATIONS} annotations; confirm or delete some first"
                ));
            }
            let number = index.next_number.max(1);
            index.next_number = number + 1;
            index.annotations.push(StoredAnnotation {
                id: fresh_id("ann"),
                number,
                status: STATUS_PENDING.into(),
                created_at: now,
                ..StoredAnnotation::default()
            });
            index.annotations.len() - 1
        } else {
            index
                .position(&incoming.annotation_id)
                .ok_or("the annotation no longer exists (deleted on another desktop?)")?
        };
        let annotation_id = index.annotations[position].id.clone();
        let annotation_dir = self.annotation_dir(workspace_id, &annotation_id);

        // Images: validate everything before writing anything.
        let removed: Vec<String> = put
            .remove_image_ids
            .iter()
            .filter(|id| valid_segment(id))
            .cloned()
            .collect();
        let kept = index.annotations[position]
            .images
            .iter()
            .filter(|image| !removed.contains(&image.id))
            .count();
        if kept + put.add_images.len() > MAX_IMAGES {
            return Err(format!("an annotation holds at most {MAX_IMAGES} images"));
        }
        for upload in &put.add_images {
            if upload.data.is_empty() || upload.data.len() > MAX_IMAGE_BYTES {
                return Err(format!(
                    "an image must be between 1 byte and {} MiB",
                    MAX_IMAGE_BYTES / (1024 * 1024)
                ));
            }
            if extension_for(&upload.mime_type).is_none() {
                return Err(format!("unsupported image type {}", upload.mime_type));
            }
        }
        let mut written: Vec<PathBuf> = Vec::new();
        let mut added: Vec<StoredImage> = Vec::new();
        if !put.add_images.is_empty() {
            create_private_dir(&annotation_dir)?;
        }
        for upload in &put.add_images {
            let id = fresh_id("img");
            let extension = extension_for(&upload.mime_type).unwrap_or("bin");
            let file = format!("{id}.{extension}");
            let path = annotation_dir.join(&file);
            if let Err(error) = crate::atomic_file::write_atomic(&path, &upload.data) {
                for path in &written {
                    let _ = fs::remove_file(path);
                }
                return Err(format!("cannot write an image: {error}"));
            }
            written.push(path);
            added.push(StoredImage {
                id,
                kind: image_kind_name(upload.kind).into(),
                mime_type: upload.mime_type.clone(),
                size: upload.data.len() as u32,
                file,
            });
        }

        let annotation = &mut index.annotations[position];
        let dropped: Vec<StoredImage> = annotation
            .images
            .iter()
            .filter(|image| removed.contains(&image.id))
            .cloned()
            .collect();
        annotation.images.retain(|image| !removed.contains(&image.id));
        annotation.images.extend(added);
        annotation.comment = comment;
        if !incoming.page_url.is_empty() || annotation.page_url.is_empty() {
            annotation.page_url = clip(&incoming.page_url, MAX_URL_CHARS);
            annotation.page_title = clip(&incoming.page_title, MAX_TITLE_CHARS);
        }
        // Targets and region change together; an edit that sends no targets keeps both. Likewise an
        // edit without a code anchor keeps the stored one. Either kind of location replaces the other.
        if !targets.is_empty() {
            annotation.targets = targets;
            annotation.region = region_from_wire(incoming.region.as_ref());
            annotation.code = None;
        } else if let Some(code) = code {
            annotation.code = Some(code);
            annotation.targets.clear();
            annotation.region = None;
        }
        annotation.updated_at = now;
        let stored = annotation.clone();

        match self.commit(&mut inner, workspace_id, index) {
            Ok(revision) => {
                for image in &dropped {
                    let _ = fs::remove_file(annotation_dir.join(&image.file));
                }
                Ok((revision, stored))
            }
            Err(error) => {
                for path in &written {
                    let _ = fs::remove_file(path);
                }
                Err(error)
            }
        }
    }

    /// Deletes the annotations matching `pick` under one lock: they leave the live list at once and
    /// stay restorable for the undo window. Returns the revision and exactly the ids removed.
    fn remove_where(
        &self,
        workspace_id: &str,
        pick: impl Fn(&StoredAnnotation) -> bool,
    ) -> Result<(u32, Vec<String>), String> {
        let mut inner = self.inner.lock().unwrap();
        let mut index = self.index(&mut inner, workspace_id)?.clone();
        let now = now_ms();
        let (gone, kept): (Vec<StoredAnnotation>, Vec<StoredAnnotation>) =
            std::mem::take(&mut index.annotations).into_iter().partition(|annotation| pick(annotation));
        index.annotations = kept;
        if gone.is_empty() {
            return Ok((index.revision, Vec::new()));
        }
        let removed: Vec<String> = gone.iter().map(|annotation| annotation.id.clone()).collect();
        index.deleted.extend(gone.into_iter().map(|annotation| DeletedAnnotation {
            deleted_at: now,
            annotation,
        }));
        let revision = self.commit(&mut inner, workspace_id, index)?;
        Ok((revision, removed))
    }

    /// Deletes (or confirms) annotations. Unknown ids are ignored (already deleted elsewhere).
    pub fn delete(&self, workspace_id: &str, annotation_ids: &[String]) -> Result<(u32, Vec<String>), String> {
        self.remove_where(workspace_id, |annotation| annotation_ids.contains(&annotation.id))
    }

    /// Deletes every resolved annotation (「清除全部已完成」).
    pub fn clear_resolved(&self, workspace_id: &str) -> Result<(u32, Vec<String>), String> {
        self.remove_where(workspace_id, |annotation| annotation.status == STATUS_RESOLVED)
    }

    /// 「撤销」: brings deleted annotations back exactly as they were, within the undo window.
    /// Returns the revision and the ids restored.
    pub fn restore(&self, workspace_id: &str, annotation_ids: &[String]) -> Result<(u32, Vec<String>), String> {
        let mut inner = self.inner.lock().unwrap();
        let mut index = self.index(&mut inner, workspace_id)?.clone();
        let (back, kept): (Vec<DeletedAnnotation>, Vec<DeletedAnnotation>) = std::mem::take(&mut index.deleted)
            .into_iter()
            .partition(|entry| annotation_ids.contains(&entry.annotation.id));
        index.deleted = kept;
        if back.is_empty() {
            let already_live = annotation_ids
                .iter()
                .all(|id| index.annotations.iter().any(|annotation| &annotation.id == id));
            if already_live {
                return Ok((index.revision, Vec::new()));
            }
            return Err("these annotations can no longer be restored (the undo window has passed)".into());
        }
        if index.annotations.len() + back.len() > MAX_ANNOTATIONS {
            return Err(format!(
                "this workspace already has {MAX_ANNOTATIONS} annotations; confirm or delete some first"
            ));
        }
        let restored: Vec<String> = back.iter().map(|entry| entry.annotation.id.clone()).collect();
        index.annotations.extend(back.into_iter().map(|entry| entry.annotation));
        // Numbers are never reused, so number order is creation order.
        index.annotations.sort_by_key(|annotation| annotation.number);
        let revision = self.commit(&mut inner, workspace_id, index)?;
        Ok((revision, restored))
    }

    fn remove_annotation_files(&self, workspace_id: &str, annotation_id: &str) {
        if !valid_segment(annotation_id) {
            return;
        }
        let dir = self.annotation_dir(workspace_id, annotation_id);
        if let Err(error) = fs::remove_dir_all(&dir) {
            if error.kind() != std::io::ErrorKind::NotFound {
                logln!("[annotations] cannot delete {}: {error}", dir.display());
            }
        }
    }

    /// A resolved annotation goes back to pending with the user's added comment.
    pub fn reopen(&self, workspace_id: &str, annotation_id: &str, comment: &str) -> Result<(u32, StoredAnnotation), String> {
        let comment = clip(comment, MAX_COMMENT_CHARS);
        if comment.is_empty() {
            return Err("reopening needs a comment saying what is still wrong".into());
        }
        let mut inner = self.inner.lock().unwrap();
        let mut index = self.index(&mut inner, workspace_id)?.clone();
        let position = index
            .position(annotation_id)
            .ok_or("the annotation no longer exists (confirmed on another desktop?)")?;
        let now = now_ms();
        let annotation = &mut index.annotations[position];
        annotation.follow_ups.push(StoredFollowUp {
            comment,
            previous_note: std::mem::take(&mut annotation.resolution_note),
            created_at: now,
        });
        if annotation.follow_ups.len() > MAX_FOLLOW_UPS {
            annotation.follow_ups.remove(0);
        }
        annotation.status = STATUS_PENDING.into();
        annotation.resolved_at = 0.0;
        annotation.updated_at = now;
        let stored = annotation.clone();
        let revision = self.commit(&mut inner, workspace_id, index)?;
        Ok((revision, stored))
    }

    /// `coflux annotations resolve <id> --note`: `target` is an annotation id or its number
    /// (`3` or `#3`).
    pub fn resolve(&self, workspace_id: &str, target: &str, note: &str) -> Result<StoredAnnotation, String> {
        let note = clip(note, MAX_NOTE_CHARS);
        if note.is_empty() {
            return Err("resolve needs --note saying what changed".into());
        }
        let mut inner = self.inner.lock().unwrap();
        let mut index = self.index(&mut inner, workspace_id)?.clone();
        let target = target.trim();
        let number: Option<u32> = target.trim_start_matches('#').parse().ok();
        let position = index
            .annotations
            .iter()
            .position(|annotation| annotation.id == target || Some(annotation.number) == number)
            .ok_or_else(|| {
                format!("no annotation {target} in this workspace (coflux annotations list shows the pending ones)")
            })?;
        let now = now_ms();
        let annotation = &mut index.annotations[position];
        annotation.status = STATUS_RESOLVED.into();
        annotation.resolution_note = note;
        annotation.resolved_at = now;
        annotation.updated_at = now;
        let stored = annotation.clone();
        self.commit(&mut inner, workspace_id, index)?;
        Ok(stored)
    }

    /// One image file's bytes.
    pub fn read_image(&self, workspace_id: &str, annotation_id: &str, image_id: &str) -> Result<(String, Vec<u8>), String> {
        let image = {
            let mut inner = self.inner.lock().unwrap();
            let index = self.index(&mut inner, workspace_id)?;
            let annotation = index
                .annotations
                .iter()
                .find(|annotation| annotation.id == annotation_id)
                .ok_or("the annotation no longer exists")?;
            annotation
                .images
                .iter()
                .find(|image| image.id == image_id)
                .cloned()
                .ok_or("the image no longer exists")?
        };
        if !valid_segment(annotation_id) || image.file.contains('/') || image.file.starts_with('.') {
            return Err("invalid image reference".into());
        }
        let path = self.image_path(workspace_id, annotation_id, &image);
        let data = fs::read(&path).map_err(|error| format!("cannot read the image: {error}"))?;
        Ok((image.mime_type, data))
    }

    /// The wire form sent to desktops, with the images' absolute paths on this device.
    pub fn to_wire(&self, workspace_id: &str, annotation: &StoredAnnotation) -> wire::Annotation {
        wire::Annotation {
            annotation_id: annotation.id.clone(),
            number: annotation.number,
            status: if annotation.status == STATUS_RESOLVED {
                wire::AnnotationStatus::Resolved as i32
            } else {
                wire::AnnotationStatus::Pending as i32
            },
            page_url: annotation.page_url.clone(),
            page_title: annotation.page_title.clone(),
            comment: annotation.comment.clone(),
            targets: annotation
                .targets
                .iter()
                .map(|target| wire::AnnotationTarget {
                    element: Some(element_to_wire(&target.element)),
                    source: Some(source_to_wire(&target.source)),
                })
                .collect(),
            region: annotation.region.as_ref().map(|region| wire::AnnotationRegion {
                x: region.x,
                y: region.y,
                width: region.width,
                height: region.height,
            }),
            code: annotation.code.as_ref().map(code_to_wire),
            images: annotation
                .images
                .iter()
                .map(|image| wire::AnnotationImage {
                    image_id: image.id.clone(),
                    kind: image_kind_wire(&image.kind),
                    mime_type: image.mime_type.clone(),
                    size: image.size,
                    path: self
                        .image_path(workspace_id, &annotation.id, image)
                        .to_string_lossy()
                        .into_owned(),
                })
                .collect(),
            resolution_note: annotation.resolution_note.clone(),
            follow_ups: annotation
                .follow_ups
                .iter()
                .map(|follow_up| wire::AnnotationFollowUp {
                    comment: follow_up.comment.clone(),
                    previous_note: follow_up.previous_note.clone(),
                    created_at: follow_up.created_at,
                })
                .collect(),
            created_at: annotation.created_at,
            updated_at: annotation.updated_at,
            resolved_at: annotation.resolved_at,
        }
    }

    /// The JSON an agent receives (`coflux annotations list --json`), with absolute image paths.
    pub fn agent_json(&self, workspace_id: &str, annotation: &StoredAnnotation) -> serde_json::Value {
        let images: Vec<serde_json::Value> = annotation
            .images
            .iter()
            .map(|image| {
                serde_json::json!({
                    "id": image.id,
                    "kind": image.kind,
                    "mimeType": image.mime_type,
                    "path": self.image_path(workspace_id, &annotation.id, image).to_string_lossy(),
                })
            })
            .collect();
        // targets[0] is the anchor: the picked element, the first of a selection, or the element
        // containing the region; for a region the others are the elements inside it.
        let targets: Vec<serde_json::Value> = annotation
            .targets
            .iter()
            .map(|target| {
                serde_json::json!({
                    "element": target.element,
                    "source": target.source_json(),
                })
            })
            .collect();
        // A code comment carries its location instead of a page and targets.
        let code = annotation.code.as_ref().map(|code| {
            serde_json::json!({
                "path": code.path,
                "side": code.side,
                "startLine": code.start_line,
                "endLine": code.end_line,
                "lines": code.excerpt,
                "baseCommit": if code.base_commit.is_empty() { serde_json::Value::Null } else { serde_json::Value::from(code.base_commit.clone()) },
            })
        });
        serde_json::json!({
            "id": annotation.id,
            "number": annotation.number,
            "kind": if code.is_some() { "code" } else { "page" },
            "status": annotation.status,
            "comment": annotation.comment,
            "page": { "url": annotation.page_url, "title": annotation.page_title },
            "targets": targets,
            "region": annotation.region,
            "code": code,
            "images": images,
            "followUps": annotation.follow_ups,
            "resolutionNote": annotation.resolution_note,
            "createdAt": annotation.created_at,
            "updatedAt": annotation.updated_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (AnnotationStore, PathBuf, mpsc::Receiver<WsOut>) {
        let mut random = [0u8; 8];
        OsRng.fill_bytes(&mut random);
        let home = std::env::temp_dir().join(format!("coflux-annotations-{}", hex::encode(random)));
        fs::create_dir_all(&home).unwrap();
        let (tx, rx) = mpsc::channel(64);
        (AnnotationStore::new(&home.to_string_lossy(), tx), home, rx)
    }

    fn target(selector: &str, tag: &str, components: &[&str]) -> wire::AnnotationTarget {
        wire::AnnotationTarget {
            element: Some(wire::AnnotationElement {
                selector: selector.into(),
                tag: tag.into(),
                ..Default::default()
            }),
            source: Some(wire::AnnotationSource {
                framework: if components.is_empty() { String::new() } else { "react".into() },
                components: components.iter().map(|name| name.to_string()).collect(),
                ..Default::default()
            }),
        }
    }

    fn put_new(comment: &str, images: usize) -> wire::AnnotationPut {
        wire::AnnotationPut {
            annotation: Some(wire::Annotation {
                comment: comment.into(),
                page_url: "http://localhost:3000/".into(),
                targets: vec![target("#save", "BUTTON", &[])],
                ..Default::default()
            }),
            add_images: (0..images)
                .map(|_| wire::AnnotationImageUpload {
                    kind: wire::AnnotationImageKind::Screenshot as i32,
                    mime_type: "image/png".into(),
                    data: vec![1, 2, 3],
                })
                .collect(),
            remove_image_ids: Vec::new(),
        }
    }

    #[test]
    fn round_trip_survives_a_new_store_and_numbers_are_stable() {
        let (store, home, _rx) = store();
        let (_, first) = store.put("ws-1", put_new("make it blue", 1)).unwrap();
        let (_, second) = store.put("ws-1", put_new("bigger", 0)).unwrap();
        assert_eq!((first.number, second.number), (1, 2));
        assert_eq!(first.targets[0].element.tag, "button");
        let (tx, _rx2) = mpsc::channel(4);
        let reopened = AnnotationStore::new(&home.to_string_lossy(), tx);
        let (revision, list) = reopened.list("ws-1").unwrap();
        assert_eq!(revision, 2);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].comment, "make it blue");
        let path = reopened.image_path("ws-1", &list[0].id, &list[0].images[0]);
        assert_eq!(fs::read(path).unwrap(), vec![1, 2, 3]);
        let _ = fs::remove_dir_all(&home);
    }

    /// Moves every deletion of the workspace `by_ms` into the past, as if that much time passed.
    fn age_deletions(store: &AnnotationStore, workspace_id: &str, by_ms: f64) {
        let mut inner = store.inner.lock().unwrap();
        let index = inner.workspaces.get_mut(workspace_id).unwrap();
        for entry in &mut index.deleted {
            entry.deleted_at -= by_ms;
        }
    }

    #[test]
    fn resolve_reopen_cycle_then_clear_resolved_hides_at_once_and_purges_after_the_window() {
        let (store, home, _rx) = store();
        let (_, annotation) = store.put("ws-1", put_new("fix", 2)).unwrap();
        let dir = store.annotation_dir("ws-1", &annotation.id);
        assert!(dir.is_dir());
        let resolved = store.resolve("ws-1", "#1", "done").unwrap();
        assert_eq!(resolved.status, STATUS_RESOLVED);
        let (_, reopened) = store.reopen("ws-1", &annotation.id, "still red").unwrap();
        assert_eq!(reopened.status, STATUS_PENDING);
        assert_eq!(reopened.follow_ups[0].previous_note, "done");
        store.resolve("ws-1", &annotation.id, "now blue").unwrap();
        let (_, removed) = store.clear_resolved("ws-1").unwrap();
        assert_eq!(removed, vec![annotation.id.clone()]);
        assert!(store.list("ws-1").unwrap().1.is_empty());
        assert_eq!(store.summary()[0].resolved, 0);
        assert!(store.resolve("ws-1", "#1", "again").is_err());
        assert!(store.read_image("ws-1", &annotation.id, &annotation.images[0].id).is_err());
        // Still restorable: the files stay until the window passes.
        assert!(dir.is_dir());
        age_deletions(&store, "ws-1", UNDO_WINDOW_MS + 1.0);
        assert!(store.list("ws-1").unwrap().1.is_empty());
        assert!(!dir.exists());
        assert!(store.restore("ws-1", &removed).is_err());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn delete_then_restore_within_the_window_brings_back_everything() {
        let (store, home, _rx) = store();
        let (_, first) = store.put("ws-1", put_new("first", 1)).unwrap();
        let (_, second) = store.put("ws-1", put_new("second", 0)).unwrap();
        store.resolve("ws-1", "#2", "done").unwrap();
        let (_, removed) = store.delete("ws-1", &[first.id.clone(), second.id.clone(), "ann-gone".into()]).unwrap();
        assert_eq!(removed, vec![first.id.clone(), second.id.clone()]);
        assert!(store.list("ws-1").unwrap().1.is_empty());
        // A new annotation meanwhile takes a fresh number, never a deleted one's.
        let (_, third) = store.put("ws-1", put_new("third", 0)).unwrap();
        assert_eq!(third.number, 3);
        // The deletion survives a worker restart (persisted), and so does the restorable copy.
        let (tx, _rx2) = mpsc::channel(64);
        let reopened = AnnotationStore::new(&home.to_string_lossy(), tx);
        assert_eq!(reopened.list("ws-1").unwrap().1.len(), 1);
        let (_, restored) = reopened.restore("ws-1", &removed).unwrap();
        assert_eq!(restored, removed);
        let (_, list) = reopened.list("ws-1").unwrap();
        let numbers: Vec<u32> = list.iter().map(|annotation| annotation.number).collect();
        assert_eq!(numbers, vec![1, 2, 3]);
        assert_eq!(list[0].id, first.id);
        assert_eq!(list[0].comment, "first");
        assert_eq!(list[1].status, STATUS_RESOLVED);
        assert_eq!(list[1].resolution_note, "done");
        let (_, data) = reopened.read_image("ws-1", &first.id, &first.images[0].id).unwrap();
        assert_eq!(data, vec![1, 2, 3]);
        // Restoring twice is a no-op, not an error.
        assert!(reopened.restore("ws-1", &removed).unwrap().1.is_empty());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn targets_and_region_round_trip() {
        let (store, home, _rx) = store();
        let mut put = put_new("tighten this area", 0);
        let annotation = put.annotation.as_mut().unwrap();
        annotation.targets = vec![
            target("header", "HEADER", &["Header", "App"]),
            target("#logo", "IMG", &["Logo"]),
            target("nav", "NAV", &[]),
        ];
        annotation.region = Some(wire::AnnotationRegion {
            x: 12.0,
            y: -4.0,
            width: 320.0,
            height: 80.0,
        });
        store.put("ws-1", put).unwrap();
        let (tx, _rx2) = mpsc::channel(4);
        let reopened = AnnotationStore::new(&home.to_string_lossy(), tx);
        let (_, list) = reopened.list("ws-1").unwrap();
        let stored = &list[0];
        assert_eq!(stored.targets.len(), 3);
        assert_eq!(stored.targets[0].source.components, vec!["Header", "App"]);
        assert_eq!(stored.targets[1].element.tag, "img");
        assert_eq!(
            stored.region,
            Some(StoredRegion { x: 12.0, y: -4.0, width: 320.0, height: 80.0 })
        );
        let wire = reopened.to_wire("ws-1", stored);
        assert_eq!(wire.targets.len(), 3);
        assert_eq!(wire.region.as_ref().unwrap().width, 320.0);
        let json = reopened.agent_json("ws-1", stored);
        assert_eq!(json["targets"][0]["source"]["components"][1], "App");
        assert!(json["targets"][2]["source"].is_null());
        assert_eq!(json["region"]["height"], 80.0);
        // An edit without targets keeps them; an edit with a plain pick drops the region.
        let mut edit = wire::AnnotationPut {
            annotation: Some(wire::Annotation {
                annotation_id: stored.id.clone(),
                comment: "tighter".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        let (_, edited) = reopened.put("ws-1", edit.clone()).unwrap();
        assert_eq!(edited.targets.len(), 3);
        assert!(edited.region.is_some());
        edit.annotation.as_mut().unwrap().targets = vec![target("#x", "DIV", &[])];
        let (_, edited) = reopened.put("ws-1", edit).unwrap();
        assert_eq!(edited.targets.len(), 1);
        assert!(edited.region.is_none());
        // A new annotation needs an element.
        let mut empty = put_new("no element", 0);
        empty.annotation.as_mut().unwrap().targets.clear();
        assert!(reopened.put("ws-1", empty).is_err());
        let _ = fs::remove_dir_all(&home);
    }

    fn code_anchor(path: &str, side: wire::AnnotationCodeSide, start: u32, end: u32) -> wire::AnnotationCodeAnchor {
        wire::AnnotationCodeAnchor {
            path: path.into(),
            side: side as i32,
            start_line: start,
            end_line: end,
            excerpt: "    let x = 1;\n    let y = 2;".into(),
            base_commit: if side == wire::AnnotationCodeSide::Base { "0a1b2c3d".into() } else { String::new() },
        }
    }

    fn put_code(comment: &str, code: wire::AnnotationCodeAnchor) -> wire::AnnotationPut {
        wire::AnnotationPut {
            annotation: Some(wire::Annotation {
                comment: comment.into(),
                code: Some(code),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn code_comments_round_trip_share_numbering_and_keep_their_anchor_on_edit() {
        let (store, home, _rx) = store();
        let (_, page) = store.put("ws-1", put_new("page one", 0)).unwrap();
        let (_, working) = store
            .put("ws-1", put_code("rename this", code_anchor("src/a.rs", wire::AnnotationCodeSide::WorkingTree, 3, 4)))
            .unwrap();
        let (_, base) = store
            .put("ws-1", put_code("why was this removed?", code_anchor("./src/old.rs", wire::AnnotationCodeSide::Base, 10, 10)))
            .unwrap();
        assert_eq!((page.number, working.number, base.number), (1, 2, 3));
        assert!(working.targets.is_empty());
        let anchor = working.code.as_ref().unwrap();
        assert_eq!((anchor.path.as_str(), anchor.side.as_str(), anchor.start_line, anchor.end_line), ("src/a.rs", SIDE_WORKING_TREE, 3, 4));
        // The excerpt keeps its indentation; a working-tree anchor never keeps a base commit.
        assert_eq!(anchor.excerpt, "    let x = 1;\n    let y = 2;");
        assert!(anchor.base_commit.is_empty());
        let base_anchor = base.code.as_ref().unwrap();
        assert_eq!((base_anchor.path.as_str(), base_anchor.side.as_str(), base_anchor.base_commit.as_str()), ("src/old.rs", SIDE_BASE, "0a1b2c3d"));

        // Survives a new store (persisted in the same version-2 index).
        let (tx, _rx2) = mpsc::channel(4);
        let reopened = AnnotationStore::new(&home.to_string_lossy(), tx);
        let (_, list) = reopened.list("ws-1").unwrap();
        assert_eq!(list[1].code, working.code);
        let wire = reopened.to_wire("ws-1", &list[2]);
        let wire_code = wire.code.as_ref().unwrap();
        assert_eq!(wire_code.side, wire::AnnotationCodeSide::Base as i32);
        assert_eq!((wire_code.start_line, wire_code.end_line), (10, 10));
        assert!(reopened.to_wire("ws-1", &list[0]).code.is_none());

        // Agent JSON: kind, location, lines and base commit.
        let json = reopened.agent_json("ws-1", &list[2]);
        assert_eq!(json["kind"], "code");
        assert_eq!(json["code"]["path"], "src/old.rs");
        assert_eq!(json["code"]["side"], "base");
        assert_eq!(json["code"]["startLine"], 10);
        assert_eq!(json["code"]["baseCommit"], "0a1b2c3d");
        assert_eq!(json["code"]["lines"], "    let x = 1;\n    let y = 2;");
        let json = reopened.agent_json("ws-1", &list[1]);
        assert!(json["code"]["baseCommit"].is_null());
        let json = reopened.agent_json("ws-1", &list[0]);
        assert_eq!(json["kind"], "page");
        assert!(json["code"].is_null());

        // Editing the text without an anchor keeps it.
        let edit = wire::AnnotationPut {
            annotation: Some(wire::Annotation {
                annotation_id: working.id.clone(),
                comment: "rename this to total".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        let (_, edited) = reopened.put("ws-1", edit).unwrap();
        assert_eq!(edited.comment, "rename this to total");
        assert_eq!(edited.code, working.code);
        assert!(edited.targets.is_empty());

        // Resolving and confirming work as for page annotations, undo included.
        reopened.resolve("ws-1", "#2", "renamed").unwrap();
        let (_, removed) = reopened.delete("ws-1", &[working.id.clone()]).unwrap();
        let (_, restored) = reopened.restore("ws-1", &removed).unwrap();
        assert_eq!(restored, removed);
        assert_eq!(reopened.list("ws-1").unwrap().1[1].code, working.code);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn an_annotation_needs_targets_or_a_valid_code_anchor() {
        let (store, home, _rx) = store();
        // Neither: rejected.
        let neither = wire::AnnotationPut {
            annotation: Some(wire::Annotation {
                comment: "where?".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(store.put("ws-1", neither).is_err());
        // Both: rejected.
        let mut both = put_new("both", 0);
        both.annotation.as_mut().unwrap().code = Some(code_anchor("a.rs", wire::AnnotationCodeSide::WorkingTree, 1, 1));
        assert!(store.put("ws-1", both).is_err());
        // Invalid anchors: no side, bad ranges, escaping paths.
        for bad in [
            code_anchor("a.rs", wire::AnnotationCodeSide::Unspecified, 1, 1),
            code_anchor("a.rs", wire::AnnotationCodeSide::WorkingTree, 0, 1),
            code_anchor("a.rs", wire::AnnotationCodeSide::WorkingTree, 5, 4),
            code_anchor("/etc/passwd", wire::AnnotationCodeSide::WorkingTree, 1, 1),
            code_anchor("src/../../x", wire::AnnotationCodeSide::WorkingTree, 1, 1),
            code_anchor("", wire::AnnotationCodeSide::WorkingTree, 1, 1),
            wire::AnnotationCodeAnchor {
                base_commit: "not a commit".into(),
                ..code_anchor("a.rs", wire::AnnotationCodeSide::Base, 1, 1)
            },
        ] {
            assert!(store.put("ws-1", put_code("x", bad)).is_err());
        }
        assert!(!store.workspace_dir("ws-1").join(INDEX_FILE).exists());
        // Either alone is accepted.
        store.put("ws-1", put_new("page", 0)).unwrap();
        store
            .put("ws-1", put_code("code", code_anchor("a.rs", wire::AnnotationCodeSide::WorkingTree, 1, 2)))
            .unwrap();
        assert_eq!(store.list("ws-1").unwrap().1.len(), 2);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn a_version_1_store_is_discarded_with_its_images() {
        let (store, home, _rx) = store();
        let dir = store.workspace_dir("ws-1");
        fs::create_dir_all(dir.join("ann-old")).unwrap();
        fs::write(dir.join("ann-old").join("img-1.png"), [1u8]).unwrap();
        fs::write(
            dir.join(INDEX_FILE),
            r#"{"version":1,"revision":7,"nextNumber":2,"annotations":[{"id":"ann-old","number":1,"status":"pending","comment":"old","element":{"tag":"a"},"source":{}}]}"#,
        )
        .unwrap();
        let (revision, list) = store.list("ws-1").unwrap();
        assert!(list.is_empty());
        assert_eq!(revision, 7);
        assert!(!dir.join("ann-old").exists());
        let (_, fresh) = store.put("ws-1", put_new("new", 0)).unwrap();
        assert_eq!(fresh.number, 1);
        assert_eq!(store.list("ws-1").unwrap().0, 8);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn ids_and_paths_are_validated() {
        let (store, home, _rx) = store();
        assert!(store.list("../etc").is_err());
        assert!(store.list(".hidden").is_err());
        assert!(store.list("a/b").is_err());
        assert!(store.read_image("ws-1", "../x", "img").is_err());
        let mut bad = put_new("x", 0);
        bad.add_images.push(wire::AnnotationImageUpload {
            kind: 1,
            mime_type: "text/html".into(),
            data: vec![1],
        });
        assert!(store.put("ws-1", bad).is_err());
        assert!(!store.workspace_dir("ws-1").join(INDEX_FILE).exists());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn summary_carries_counts_only_and_is_published_on_change() {
        let (store, home, mut rx) = store();
        store.put("ws-1", put_new("a", 0)).unwrap();
        store.put("ws-1", put_new("b", 0)).unwrap();
        store.resolve("ws-1", "1", "ok").unwrap();
        let summary = store.summary();
        assert_eq!(summary.len(), 1);
        assert_eq!((summary[0].pending, summary[0].resolved, summary[0].revision), (1, 1, 3));
        let mut last = None;
        while let Ok(bytes) = rx.try_recv() {
            last = Some(bytes);
        }
        let envelope = wire::DaemonToServer::decode(last.unwrap().as_slice()).unwrap();
        let Some(daemon_to_server::Payload::AnnotationsSummary(snapshot)) = envelope.payload else {
            panic!("expected an AnnotationsSummary");
        };
        assert_eq!(snapshot.workspaces, summary);
        let _ = fs::remove_dir_all(&home);
    }
}
