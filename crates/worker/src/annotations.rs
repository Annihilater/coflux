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
//! Every write replaces its file atomically ([`crate::atomic_file`]); deleting an annotation deletes
//! its image directory. The store keys by workspace id only: it never needs the worker's workspace
//! table (which is filled from the center and not persisted) to read or list annotations.
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
const INDEX_VERSION: u32 = 1;

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
/// Workspaces listed in one summary; the center applies the same cap.
const MAX_SUMMARY_WORKSPACES: usize = 1024;

pub const STATUS_PENDING: &str = "pending";
pub const STATUS_RESOLVED: &str = "resolved";
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
    pub element: StoredElement,
    pub source: StoredSource,
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

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct WorkspaceIndex {
    version: u32,
    revision: u32,
    next_number: u32,
    annotations: Vec<StoredAnnotation>,
    #[serde(flatten)]
    extra: BTreeMap<String, serde_json::Value>,
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

    fn read_index(&self, workspace_id: &str) -> Result<WorkspaceIndex, String> {
        let path = self.workspace_dir(workspace_id).join(INDEX_FILE);
        match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|error| format!("annotation index {} is unreadable: {error}", path.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(WorkspaceIndex {
                version: INDEX_VERSION,
                next_number: 1,
                ..WorkspaceIndex::default()
            }),
            Err(error) => Err(format!("cannot read {}: {error}", path.display())),
        }
    }

    fn write_index(&self, workspace_id: &str, index: &WorkspaceIndex) -> Result<(), String> {
        let dir = self.workspace_dir(workspace_id);
        create_private_dir(&dir)?;
        let bytes = serde_json::to_vec_pretty(index).map_err(|error| error.to_string())?;
        crate::atomic_file::write_atomic(&dir.join(INDEX_FILE), &bytes)
            .map_err(|error| format!("cannot write the annotation index: {error}"))
    }

    /// The cached index of a workspace, loaded on first use.
    fn index<'a>(&self, inner: &'a mut Inner, workspace_id: &str) -> Result<&'a mut WorkspaceIndex, String> {
        if !valid_segment(workspace_id) {
            return Err("invalid workspace id".into());
        }
        if !inner.workspaces.contains_key(workspace_id) {
            let index = self.read_index(workspace_id)?;
            inner.workspaces.insert(workspace_id.to_string(), index);
        }
        Ok(inner.workspaces.get_mut(workspace_id).unwrap())
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
                Ok(index) => {
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
        if incoming.element.is_some() {
            annotation.element = element_from_wire(incoming.element.as_ref());
        }
        if incoming.source.is_some() {
            annotation.source = source_from_wire(incoming.source.as_ref());
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

    /// Deletes annotations and their image files. Unknown ids are ignored (already deleted elsewhere).
    pub fn delete(&self, workspace_id: &str, annotation_ids: &[String]) -> Result<u32, String> {
        let mut inner = self.inner.lock().unwrap();
        let mut index = self.index(&mut inner, workspace_id)?.clone();
        let before = index.annotations.len();
        let mut gone = Vec::new();
        index.annotations.retain(|annotation| {
            let remove = annotation_ids.contains(&annotation.id);
            if remove {
                gone.push(annotation.id.clone());
            }
            !remove
        });
        if index.annotations.len() == before {
            return Ok(index.revision);
        }
        let revision = self.commit(&mut inner, workspace_id, index)?;
        for annotation_id in gone {
            self.remove_annotation_files(workspace_id, &annotation_id);
        }
        Ok(revision)
    }

    /// Deletes every resolved annotation (「清除全部已完成」).
    pub fn clear_resolved(&self, workspace_id: &str) -> Result<u32, String> {
        let resolved: Vec<String> = {
            let mut inner = self.inner.lock().unwrap();
            let index = self.index(&mut inner, workspace_id)?;
            index
                .annotations
                .iter()
                .filter(|annotation| annotation.status == STATUS_RESOLVED)
                .map(|annotation| annotation.id.clone())
                .collect()
        };
        self.delete(workspace_id, &resolved)
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
            element: Some(wire::AnnotationElement {
                selector: annotation.element.selector.clone(),
                dom_path: annotation.element.dom_path.clone(),
                tag: annotation.element.tag.clone(),
                text: annotation.element.text.clone(),
                element_id: annotation.element.element_id.clone(),
                classes: annotation.element.classes.clone(),
                attributes: annotation.element.attributes.clone().into_iter().collect(),
                styles: annotation.element.styles.clone().into_iter().collect(),
                width: annotation.element.width,
                height: annotation.element.height,
            }),
            source: Some(wire::AnnotationSource {
                framework: annotation.source.framework.clone(),
                components: annotation.source.components.clone(),
                file: annotation.source.file.clone(),
                line: annotation.source.line,
                column: annotation.source.column,
            }),
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
        let source = &annotation.source;
        let has_source = !source.framework.is_empty() || !source.components.is_empty() || !source.file.is_empty();
        let source = if has_source {
            serde_json::to_value(source).unwrap_or_default()
        } else {
            serde_json::Value::Null
        };
        serde_json::json!({
            "id": annotation.id,
            "number": annotation.number,
            "status": annotation.status,
            "comment": annotation.comment,
            "page": { "url": annotation.page_url, "title": annotation.page_title },
            "element": annotation.element,
            "source": source,
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

    fn put_new(comment: &str, images: usize) -> wire::AnnotationPut {
        wire::AnnotationPut {
            annotation: Some(wire::Annotation {
                comment: comment.into(),
                page_url: "http://localhost:3000/".into(),
                element: Some(wire::AnnotationElement {
                    selector: "#save".into(),
                    tag: "BUTTON".into(),
                    ..Default::default()
                }),
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
        assert_eq!(first.element.tag, "button");
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

    #[test]
    fn delete_removes_image_files_and_resolve_reopen_cycle() {
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
        store.clear_resolved("ws-1").unwrap();
        assert!(!dir.exists());
        assert!(store.list("ws-1").unwrap().1.is_empty());
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
