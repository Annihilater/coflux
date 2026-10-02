//! Remote release download + verification (plan 20261002-runtime-launcher-merge: this lives in
//! the runtime, the component that changes with the manifest and statement formats; the launcher
//! only owns the version pointer and the remote release floor).
//!
//! Bounded download of a `coflux-runtime` artifact (and its paired `coflux-transport`) into a
//! temporary file under `<COFLUX_HOME>/runtimes/<version>/`, then size / SHA-256 / domain-separated
//! release-statement checks. The runtime artifact carries **no** legacy raw-binary signature: a
//! pre-plan supervisor must never be able to verify or run one. Only after atomic installation
//! does the runtime ask the launcher, over the private channel, to switch.
//!
//! Security: the ed25519 statement separates "may publish runtime binaries" from control of the
//! centre or of the download source. The public key is baked in or overridden through
//! `COFLUX_WORKER_PUBKEY` (tests, self-keyed deployments); a remote party cannot set the local
//! environment. Without a valid key every download is refused.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use coflux_protocol::logln;
use coflux_protocol::release::{current_release_target, validate_version, ReleaseVersion};
use coflux_protocol::wire;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::launcher_link::LauncherLink;

/// Signed helper metadata inherits version and target from its runtime release.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportArtifact {
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub release_signature: String,
}

impl From<wire::TransportArtifact> for TransportArtifact {
    fn from(value: wire::TransportArtifact) -> Self {
        Self { url: value.url, sha256: value.sha256, size: value.size, release_signature: value.release_signature }
    }
}

/// Where the runtime lands after `install()`: what the launcher needs to run it.
#[derive(Clone, Debug)]
pub struct InstalledRuntime {
    pub version: String,
    pub cmd: String,
}

/// Hard upper bound of one runtime artifact: checked against Content-Length and enforced on the
/// decoded body, so chunked or lying responses cannot bypass it.
const MAX_RUNTIME_BYTES: u64 = 128 * 1024 * 1024;
const DOWNLOAD_INITIAL_CAPACITY: u64 = 1024 * 1024;
const MAX_TARGET_BYTES: usize = 128;
const MAX_UPGRADE_URL_BYTES: usize = 8192;
/// The runtime's own statement domain, distinct from `coflux-worker-release-v1` and every other
/// component: a worker-domain signature over identical metadata never verifies here, and a
/// pre-plan supervisor never accepts a runtime artifact as a worker.
const RELEASE_STATEMENT_DOMAIN: &[u8] = b"coflux-runtime-release-v1\0";
/// Version store root under `COFLUX_HOME`; the launcher resolves `<store>/<version>/coflux-runtime`.
pub const RUNTIME_STORE_DIR: &str = "runtimes";
pub const RUNTIME_BINARY: &str = "coflux-runtime";

/// 编译期内置的发布公钥（来自提交的 `release-pubkey.hex`，公钥非密可提交）。
/// 占位为全 0（无效点）→ 默认下载升级被拒；发布者用 `scripts/gen-keypair.mjs` 生成后换入并提交。
const BAKED_IN_PUBKEY_HEX: &str = include_str!("../release-pubkey.hex");

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn append_len_prefixed(out: &mut Vec<u8>, value: &[u8]) {
    out.extend_from_slice(&(value.len() as u32).to_be_bytes());
    out.extend_from_slice(value);
}

/// 跨语言签名 transcript：`domain || len(version) || version || len(target) || target ||
/// sha256(raw 32B) || artifact_size(BE64)`。所有可变长字段均有 BE32 长度前缀。
pub(crate) fn release_statement(
    version: &str,
    target: &str,
    sha256: &[u8; 32],
    artifact_size: u64,
) -> Vec<u8> {
    let mut statement = Vec::with_capacity(
        RELEASE_STATEMENT_DOMAIN.len() + 4 + version.len() + 4 + target.len() + 32 + 8,
    );
    statement.extend_from_slice(RELEASE_STATEMENT_DOMAIN);
    append_len_prefixed(&mut statement, version.as_bytes());
    append_len_prefixed(&mut statement, target.as_bytes());
    statement.extend_from_slice(sha256);
    statement.extend_from_slice(&artifact_size.to_be_bytes());
    statement
}

fn verifying_key() -> Option<VerifyingKey> {
    let hexkey =
        std::env::var("COFLUX_WORKER_PUBKEY").unwrap_or_else(|_| BAKED_IN_PUBKEY_HEX.to_string());
    let bytes = hex::decode(hexkey.trim()).ok()?;
    let arr: [u8; 32] = bytes.try_into().ok()?;
    VerifyingKey::from_bytes(&arr).ok()
}

/// 在启动下载线程、发起网络请求前完成所有固定形状校验，避免畸形控制消息占用线程/带宽。
pub fn validate_upgrade_request(
    version: &str,
    url: &str,
    expected_sha256: &str,
    target: &str,
    artifact_size: u64,
    release_signature_hex: &str,
) -> Result<ReleaseVersion, String> {
    let release_version = ReleaseVersion::parse(version)?;
    validate_version(version)?;
    if url.is_empty() || url.len() > MAX_UPGRADE_URL_BYTES {
        return Err(format!("升级 URL 为空或超过 {MAX_UPGRADE_URL_BYTES} 字节"));
    }
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("升级 URL 仅允许 http/https".to_string());
    }
    let sha = hex::decode(expected_sha256.trim()).map_err(|_| "sha256 非法 hex".to_string())?;
    if sha.len() != 32 {
        return Err("sha256 长度非法".to_string());
    }
    if target.is_empty() || target.len() > MAX_TARGET_BYTES {
        return Err(format!("release target 为空或超过 {MAX_TARGET_BYTES} 字节"));
    }
    if target != current_release_target() {
        return Err(format!(
            "release target 不匹配: 期望 {}, 收到 {target}",
            current_release_target()
        ));
    }
    if artifact_size == 0 || artifact_size > MAX_RUNTIME_BYTES {
        return Err(format!(
            "artifact size 必须在 1..={MAX_RUNTIME_BYTES} 字节内"
        ));
    }
    let release_signature = hex::decode(release_signature_hex.trim())
        .map_err(|_| "release 签名非法 hex".to_string())?;
    if release_signature.len() != 64 {
        return Err("release 签名长度非法".to_string());
    }
    Ok(release_version)
}

fn sync_dir(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|dir| dir.sync_all())
        .map_err(|error| format!("同步目录 {} 失败: {error}", path.display()))
}

/// 确保目录真实存在且不是符号链接；server 可控的 version 不能借已有链接把产物引出 workers/。
/// 返回本次是否新建，调用方据此同步父目录的目录项。
fn ensure_real_dir(path: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() => {
            Ok(false)
        }
        Ok(_) => Err(format!("{} 不是安全的真实目录", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::create_dir(path) {
                Ok(()) => Ok(true),
                // 并发 staging 都可能先观察到 NotFound。输掉 create_dir 的一方必须
                // 重新验证赢家创建的是安全真实目录，不能把正常竞态当安装失败。
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let metadata = std::fs::symlink_metadata(path)
                        .map_err(|error| format!("复查目录 {} 失败: {error}", path.display()))?;
                    if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
                        Ok(true)
                    } else {
                        Err(format!("{} 并发创建后不是安全的真实目录", path.display()))
                    }
                }
                Err(error) => Err(format!("创建目录 {} 失败: {error}", path.display())),
            }
        }
        Err(error) => Err(format!("检查目录 {} 失败: {error}", path.display())),
    }
}

fn create_temp_file(dir: &Path, prefix: &str) -> Result<(File, PathBuf), String> {
    for _ in 0..32 {
        let id = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(format!(".{prefix}.{}.{}.tmp", std::process::id(), id));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((file, path)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("创建临时文件 {} 失败: {error}", path.display())),
        }
    }
    Err(format!("在 {} 创建唯一临时文件失败", dir.display()))
}

fn read_bounded_with_limit(
    mut reader: impl Read,
    announced_length: Option<u64>,
    limit: u64,
) -> Result<Vec<u8>, String> {
    if announced_length.is_some_and(|length| length > limit) {
        return Err(format!("runtime 产物过大（上限 {limit} 字节）"));
    }
    // Content-Length 来自远端；不能仅凭一个 128 MiB 声明就立刻预留 128 MiB。
    let capacity = announced_length
        .unwrap_or(0)
        .min(limit)
        .min(DOWNLOAD_INITIAL_CAPACITY) as usize;
    let mut body = Vec::with_capacity(capacity);
    reader
        .by_ref()
        .take(limit + 1)
        .read_to_end(&mut body)
        .map_err(|error| format!("读取下载响应失败: {error}"))?;
    if body.len() as u64 > limit {
        return Err(format!("runtime 产物过大（上限 {limit} 字节）"));
    }
    if body.is_empty() {
        return Err("runtime 产物为空".to_string());
    }
    Ok(body)
}

fn read_bounded(reader: impl Read, announced_length: Option<u64>) -> Result<Vec<u8>, String> {
    read_bounded_with_limit(reader, announced_length, MAX_RUNTIME_BYTES)
}

fn prepare_version_dir(home: &Path, version: &str) -> Result<(PathBuf, PathBuf), String> {
    let workers = home.join(RUNTIME_STORE_DIR);
    if ensure_real_dir(&workers)? {
        sync_dir(home)?;
    }
    let version_dir = workers.join(version);
    if ensure_real_dir(&version_dir)? {
        sync_dir(&workers)?;
    }
    Ok((workers, version_dir))
}

/// A verified, fsynced candidate. Drop removes whatever was not promoted, so a stale generation,
/// a refused switch or an installation failure never leaves a partial `coflux-runtime` behind.
struct StagedTransport {
    temp: Option<PathBuf>,
    metadata: TransportArtifact,
}
impl Drop for StagedTransport {
    fn drop(&mut self) {
        if let Some(path) = self.temp.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}
pub struct StagedRuntime {
    transport: Option<StagedTransport>,
    pair_staging: Option<PathBuf>,
    version: String,
    digest: [u8; 32],
    temp_path: Option<PathBuf>,
    final_path: PathBuf,
    workers_dir: PathBuf,
    version_dir: PathBuf,
}

impl StagedRuntime {
    /// 在 manager 的 generation 临界区内调用。rename 与目标位于同一目录，晋升原子；
    /// 文件本体、版本目录和 workers 目录都同步后才返回可执行 spec。
    pub fn install(mut self) -> Result<InstalledRuntime, String> {
        if let Some(mut companion) = self.transport.take() {
            let staging = self
                .pair_staging
                .as_ref()
                .ok_or("paired release lacks private staging directory")?
                .clone();
            std::fs::rename(
                self.temp_path.as_ref().ok_or("missing staged worker")?,
                staging.join(RUNTIME_BINARY),
            )
            .map_err(|_| "stage worker failed")?;
            self.temp_path = None;
            std::fs::rename(
                companion.temp.as_ref().ok_or("missing staged companion")?,
                staging.join("coflux-transport"),
            )
            .map_err(|_| "stage companion failed")?;
            companion.temp = None;
            let marker = serde_json::json!({"runtimeSha256":hex::encode(self.digest),"transport":companion.metadata});
            persist_marker(
                staging.to_str().ok_or("invalid staging directory")?,
                "transport-pair.json",
                &marker.to_string(),
            )?;
            sync_dir(&staging)?;
            if self.version_dir.exists() {
                // Existing versions are immutable, including legacy worker-only
                // directories. Never add a companion or marker in place.
                let existing = installed_runtime(
                    self.workers_dir
                        .parent()
                        .and_then(Path::to_str)
                        .ok_or("invalid home")?,
                    &self.version,
                )?;
                if !self.version_dir.join("transport-pair.json").is_file() {
                    return Err("existing version is not a complete native pair".into());
                }
                let bytes = read_bounded(
                    File::open(&existing.cmd).map_err(|_| "installed worker unreadable")?,
                    None,
                )?;
                if <[u8; 32]>::from(Sha256::digest(&bytes)) != self.digest {
                    return Err("immutable worker digest differs".into());
                }
                verify_companion_file(
                    &self.version_dir.join("coflux-transport"),
                    &companion.metadata,
                )?;
            } else {
                std::fs::rename(&staging, &self.version_dir)
                    .map_err(|_| "atomic native pair publication failed")?;
                self.pair_staging = None;
            }
            sync_dir(&self.workers_dir)?;
            return Ok(InstalledRuntime {
                version: self.version.clone(),
                cmd: self.final_path.to_string_lossy().into_owned(),
            });
        } else if self.pair_staging.is_some()
            || self.version_dir.join("transport-pair.json").exists()
        {
            return Err("paired release cannot be installed without its companion".into());
        }

        if self.final_path.exists() {
            let metadata = std::fs::symlink_metadata(&self.final_path).map_err(|error| {
                format!(
                    "检查已安装 worker {} 失败: {error}",
                    self.final_path.display()
                )
            })?;
            if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
                return Err(format!(
                    "已安装 worker {} 不是安全的普通文件",
                    self.final_path.display()
                ));
            }
            // 只需读 fd：owner 可用 fchmod 修复连写位也丢失（如 0444）的文件，fsync
            // 同样允许只读 fd。若要求 write 打开，恰会在最需要自愈时先被权限拒绝。
            let mut existing_file = File::open(&self.final_path)
                .map_err(|error| format!("打开已安装 worker 失败: {error}"))?;
            let existing = read_bounded(&mut existing_file, Some(metadata.len()))?;
            let existing_digest: [u8; 32] = Sha256::digest(&existing).into();
            if existing_digest != self.digest {
                return Err(format!(
                    "版本 {} 已安装但内容不同，拒绝复用版本号覆盖",
                    self.version
                ));
            }
            // 同版本同内容是幂等请求，但上一次可能在 rename 后、目录 fsync 前失败，或
            // 正式文件的执行位后来丢失。重新修复权限并同步文件/两级目录后才能宣告成功。
            existing_file
                .set_permissions(std::fs::Permissions::from_mode(0o755))
                .map_err(|error| format!("修复已安装 worker 执行权限失败: {error}"))?;
            existing_file
                .sync_all()
                .map_err(|error| format!("同步已安装 worker 失败: {error}"))?;
            sync_dir(&self.version_dir)?;
            sync_dir(&self.workers_dir)?;
            return Ok(InstalledRuntime {
                version: self.version.clone(),
                cmd: self.final_path.to_string_lossy().into_owned(),
            });
        }

        let temp_path = self.temp_path.take().ok_or("候选 worker 临时文件已失效")?;
        if let Err(error) = std::fs::rename(&temp_path, &self.final_path) {
            self.temp_path = Some(temp_path);
            return Err(format!("原子安装 worker 失败: {error}"));
        }
        sync_dir(&self.version_dir)?;
        sync_dir(&self.workers_dir)?;

        Ok(InstalledRuntime {
            version: self.version.clone(),
            cmd: self.final_path.to_string_lossy().into_owned(),
        })
    }
}

impl Drop for StagedRuntime {
    fn drop(&mut self) {
        if let Some(path) = self.pair_staging.take() {
            let _ = std::fs::remove_dir_all(path);
        }
        if let Some(path) = self.temp_path.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

pub(crate) fn stage_verified_bytes(
    home: &Path,
    version: &str,
    body: &[u8],
    digest: [u8; 32],
) -> Result<StagedRuntime, String> {
    let (workers_dir, version_dir) = prepare_version_dir(home, version)?;
    let (mut file, temp_path) = create_temp_file(&version_dir, RUNTIME_BINARY)?;
    let staged = StagedRuntime {
        transport: None,
        pair_staging: None,
        version: version.to_string(),
        digest,
        final_path: version_dir.join(RUNTIME_BINARY),
        temp_path: Some(temp_path),
        workers_dir,
        version_dir,
    };
    file.write_all(body)
        .map_err(|error| format!("写 worker 临时文件失败: {error}"))?;
    file.set_permissions(std::fs::Permissions::from_mode(0o755))
        .map_err(|error| format!("设置 worker 执行权限失败: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("同步 worker 临时文件失败: {error}"))?;
    drop(file);
    Ok(staged)
}

fn stage_pair_worker(
    home: &Path,
    version: &str,
    body: &[u8],
    digest: [u8; 32],
) -> Result<StagedRuntime, String> {
    validate_version(version)?;
    let workers_dir = home.join(RUNTIME_STORE_DIR);
    if ensure_real_dir(&workers_dir)? {
        sync_dir(home)?;
    }
    let staging = workers_dir.join(format!(
        ".pair-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir(&staging).map_err(|_| "native pair staging unavailable")?;
    let version_dir = workers_dir.join(version);
    let mut staged = StagedRuntime {
        transport: None,
        pair_staging: Some(staging.clone()),
        version: version.into(),
        digest,
        temp_path: None,
        final_path: version_dir.join(RUNTIME_BINARY),
        workers_dir,
        version_dir,
    };
    let (mut file, temp) = create_temp_file(&staging, RUNTIME_BINARY)?;
    staged.temp_path = Some(temp);
    file.write_all(body)
        .map_err(|_| "paired worker write failed")?;
    file.set_permissions(std::fs::Permissions::from_mode(0o755))
        .map_err(|_| "paired worker chmod failed")?;
    file.sync_all().map_err(|_| "paired worker sync failed")?;
    Ok(staged)
}

/// 下载、校验并写入 fsync 过的临时文件；不会改动正式产物路径。
pub fn download_verify_stage(
    url: &str,
    expected_sha256: &str,
    home: &str,
    version: &str,
    target: &str,
    artifact_size: u64,
    release_signature_hex: &str,
    transport: Option<&TransportArtifact>,
) -> Result<StagedRuntime, String> {
    validate_upgrade_request(
        version,
        url,
        expected_sha256,
        target,
        artifact_size,
        release_signature_hex,
    )?;
    let vk = verifying_key().ok_or("未配置有效的 worker 公钥，拒绝下载升级")?;

    let resp = ureq::get(url)
        .timeout(Duration::from_secs(60))
        .call()
        .map_err(|error| format!("下载失败: {error}"))?;
    let announced_length = resp
        .header("Content-Length")
        .and_then(|value| value.parse::<u64>().ok());
    if announced_length.is_some_and(|length| length != artifact_size) {
        return Err(format!(
            "Content-Length 与已签名 artifact size 不符: 声明 {artifact_size}, 响应 {}",
            announced_length.unwrap_or_default()
        ));
    }
    let body = read_bounded_with_limit(resp.into_reader(), announced_length, artifact_size)?;
    if body.len() as u64 != artifact_size {
        return Err(format!(
            "worker 产物实际长度与已签名 artifact size 不符: 声明 {artifact_size}, 实得 {}",
            body.len()
        ));
    }

    // sha256（完整性，服务器声明的期望值）：强制提供，空值不再放行（防御纵深，不留跳过口）。
    let digest: [u8; 32] = Sha256::digest(&body).into();
    let got = hex::encode(digest);
    if expected_sha256.trim().is_empty() {
        return Err("缺少 sha256，拒绝升级".to_string());
    }
    if got != expected_sha256.trim().to_lowercase() {
        return Err(format!("sha256 不符: 期望 {expected_sha256}, 实得 {got}"));
    }

    // The release statement is the only signature over a runtime artifact: it binds
    // version / target / sha256 / size under the runtime domain.
    let expected_digest: [u8; 32] = hex::decode(expected_sha256.trim())
        .map_err(|_| "sha256 非法 hex".to_string())?
        .try_into()
        .map_err(|_| "sha256 长度非法".to_string())?;
    let release_sig_bytes = hex::decode(release_signature_hex.trim())
        .map_err(|_| "release 签名非法 hex".to_string())?;
    let release_sig = Signature::from_slice(&release_sig_bytes)
        .map_err(|_| "release 签名长度非法".to_string())?;
    let statement = release_statement(version, target, &expected_digest, artifact_size);
    vk.verify(&statement, &release_sig)
        .map_err(|_| "release statement 签名校验失败（发布元数据被篡改）".to_string())?;

    let mut staged = if transport.is_some() {
        stage_pair_worker(Path::new(home), version, &body, digest)?
    } else {
        stage_verified_bytes(Path::new(home), version, &body, digest)?
    };
    if let Some(metadata) = transport {
        validate_upgrade_request(
            version,
            &metadata.url,
            &metadata.sha256,
            target,
            metadata.size,
            &metadata.release_signature,
        )?;
        let response = ureq::get(&metadata.url)
            .timeout(Duration::from_secs(60))
            .call()
            .map_err(|_| "transport download failed")?;
        let announced = response
            .header("Content-Length")
            .and_then(|value| value.parse::<u64>().ok());
        if announced.is_some_and(|size| size != metadata.size) {
            return Err("transport Content-Length mismatch".into());
        }
        let data = read_bounded_with_limit(response.into_reader(), announced, metadata.size)?;
        if data.len() as u64 != metadata.size
            || hex::encode(Sha256::digest(&data)) != metadata.sha256.to_lowercase()
        {
            return Err("transport size/digest mismatch".into());
        }
        let digest: [u8; 32] = Sha256::digest(&data).into();
        let signature = Signature::from_slice(
            &hex::decode(&metadata.release_signature).map_err(|_| "invalid transport signature")?,
        )
        .map_err(|_| "invalid transport signature")?;
        let mut statement = b"coflux-transport-release-v1\0".to_vec();
        append_len_prefixed(&mut statement, version.as_bytes());
        append_len_prefixed(&mut statement, target.as_bytes());
        statement.extend_from_slice(&digest);
        statement.extend_from_slice(&metadata.size.to_be_bytes());
        vk.verify(&statement, &signature)
            .map_err(|_| "transport release signature rejected")?;
        let (mut file, temp) = create_temp_file(
            staged
                .pair_staging
                .as_ref()
                .ok_or("missing pair staging directory")?,
            "coflux-transport",
        )?;
        let companion = StagedTransport {
            temp: Some(temp),
            metadata: metadata.clone(),
        };
        file.write_all(&data)
            .map_err(|_| "transport write failed")?;
        file.set_permissions(std::fs::Permissions::from_mode(0o755))
            .map_err(|_| "transport chmod failed")?;
        file.sync_all().map_err(|_| "transport sync failed")?;
        staged.transport = Some(companion);
    }
    Ok(staged)
}

fn verify_companion_file(path: &Path, metadata: &TransportArtifact) -> Result<(), String> {
    let stat = std::fs::symlink_metadata(path).map_err(|_| "transport file missing")?;
    if !stat.is_file()
        || stat.file_type().is_symlink()
        || stat.len() != metadata.size
        || stat.permissions().mode() & 0o111 == 0
    {
        return Err("invalid transport file".into());
    }
    let data = read_bounded(
        File::open(path).map_err(|_| "transport file unreadable")?,
        Some(stat.len()),
    )?;
    if hex::encode(Sha256::digest(&data)) != metadata.sha256.to_lowercase() {
        return Err("transport file digest mismatch".into());
    }
    Ok(())
}

/// marker 统一用同目录临时文件 + fsync + rename，避免断电/进程退出留下空文件。
fn persist_marker(home: &str, name: &str, value: &str) -> Result<(), String> {
    let home = Path::new(home);
    let (mut file, temp_path) = create_temp_file(home, name)?;
    let final_path = home.join(name);
    let result = (|| {
        file.write_all(value.as_bytes())
            .map_err(|error| format!("写 {name} 临时文件失败: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("同步 {name} 临时文件失败: {error}"))?;
        drop(file);
        std::fs::rename(&temp_path, &final_path)
            .map_err(|error| format!("原子更新 {name} 失败: {error}"))?;
        sync_dir(home)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp_path);
    }
    result
}

/// A version in the store is usable only as a real, non-symlink, non-empty, executable file whose
/// paired companion (when present) still matches its marker. The launcher runs the same check
/// before it switches.
pub fn installed_runtime(home: &str, version: &str) -> Result<InstalledRuntime, String> {
    validate_version(version)?;
    let home = Path::new(home);
    let workers = home.join(RUNTIME_STORE_DIR);
    let version_dir = workers.join(version);
    for dir in [&workers, &version_dir] {
        let metadata = std::fs::symlink_metadata(dir)
            .map_err(|error| format!("检查 {} 失败: {error}", dir.display()))?;
        if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
            return Err(format!("{} 不是安全的真实目录", dir.display()));
        }
    }
    let path = version_dir.join(RUNTIME_BINARY);
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|error| format!("检查 {} 失败: {error}", path.display()))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() || metadata.len() == 0 {
        return Err(format!("{} 不是可恢复的普通 runtime 文件", path.display()));
    }
    if metadata.permissions().mode() & 0o111 == 0 {
        return Err(format!("{} 没有执行权限", path.display()));
    }
    let pair = version_dir.join("transport-pair.json");
    if pair.exists() {
        let stat = std::fs::symlink_metadata(&pair).map_err(|_| "pair metadata missing")?;
        if !stat.is_file() || stat.file_type().is_symlink() || stat.len() > 32768 {
            return Err("invalid pair metadata".into());
        }
        let marker: serde_json::Value =
            serde_json::from_reader(File::open(pair).map_err(|_| "pair metadata unreadable")?)
                .map_err(|_| "invalid pair metadata")?;
        let companion: TransportArtifact = serde_json::from_value(marker["transport"].clone())
            .map_err(|_| "invalid companion metadata")?;
        verify_companion_file(&version_dir.join("coflux-transport"), &companion)?;
        let bytes = read_bounded(
            File::open(&path).map_err(|_| "worker unreadable")?,
            Some(metadata.len()),
        )?;
        if marker["runtimeSha256"].as_str() != Some(hex::encode(Sha256::digest(&bytes)).as_str()) {
            return Err("paired worker digest mismatch".into());
        }
    }
    Ok(InstalledRuntime {
        version: version.to_string(),
        cmd: path.to_string_lossy().into_owned(),
    })
}


/// One remote upgrade request after shape validation.
#[derive(Clone, Debug)]
struct RemoteUpgradeRequest {
    generation: u64,
    release_version: ReleaseVersion,
    version: String,
    url: String,
    sha256: String,
    target: String,
    artifact_size: u64,
    release_signature: String,
    transport: Option<TransportArtifact>,
}

#[derive(Default)]
struct RemoteUpgradeState {
    /// Bumped by every accepted request; a download that finishes after a newer request arrived
    /// is discarded (its temporary files are dropped) instead of overtaking it.
    generation: u64,
    /// At most one download executor at a time; later requests only replace `latest`.
    executor_running: bool,
    latest: Option<RemoteUpgradeRequest>,
}

/// Downloads, verifies and installs releases the centre pushes, then asks the launcher to switch.
/// Single executor with a latest-only mailbox: a download buffers up to 128 MiB, so every
/// `worker.upgrade` must not spawn its own; while A downloads, B then C leave only C queued.
pub struct RemoteUpgrader {
    home: String,
    launcher: Option<Arc<LauncherLink>>,
    state: Mutex<RemoteUpgradeState>,
}

impl RemoteUpgrader {
    pub fn new(home: String, launcher: Option<Arc<LauncherLink>>) -> Arc<Self> {
        Arc::new(Self { home, launcher, state: Mutex::new(RemoteUpgradeState::default()) })
    }

    /// The launcher's committed remote release floor (learned at `ready`); a candidate at or
    /// below it is refused before any download. The launcher re-checks on `switch`.
    fn ensure_release_is_newer(&self, candidate: &ReleaseVersion) -> Result<(), String> {
        let Some(launcher) = &self.launcher else {
            return Err("no launcher: a bare runtime never switches versions".into());
        };
        if let Some(floor) = launcher.release_floor() {
            if !candidate.is_newer_than(&floor) {
                return Err(format!(
                    "refusing downgrade/replay of release {}: committed floor is {}",
                    candidate.as_str(),
                    floor.as_str()
                ));
            }
        }
        Ok(())
    }

    fn enqueue(&self, request: RemoteUpgradeRequest) -> Option<RemoteUpgradeRequest> {
        let mut state = self.state.lock().unwrap();
        state.generation = state.generation.wrapping_add(1);
        let request = RemoteUpgradeRequest { generation: state.generation, ..request };
        if state.executor_running {
            if let Some(replaced) = state.latest.replace(request) {
                logln!(
                    "[upgrade] newer request replaces the queued one old={} new={}",
                    replaced.version,
                    state.latest.as_ref().unwrap().version
                );
            }
            None
        } else {
            state.executor_running = true;
            Some(request)
        }
    }

    fn take_next(state: &mut RemoteUpgradeState) -> Option<RemoteUpgradeRequest> {
        match state.latest.take() {
            Some(next) => Some(next),
            None => {
                state.executor_running = false;
                None
            }
        }
    }

    /// Finish one download inside the linearisation gate: only the request that is still the
    /// newest installs and asks for the switch; the lock is held across install on purpose.
    fn finish(
        &self,
        request: RemoteUpgradeRequest,
        result: Result<StagedRuntime, String>,
    ) -> Option<RemoteUpgradeRequest> {
        let mut state = self.state.lock().unwrap();
        let is_latest = state.generation == request.generation;
        match result {
            Ok(staged) if is_latest => {
                if let Err(error) = self.ensure_release_is_newer(&request.release_version) {
                    logln!("[upgrade] verified release is stale, keeping current version: {error}");
                    return Self::take_next(&mut state);
                }
                match staged.install() {
                    Ok(installed) => {
                        logln!(
                            "[upgrade] release statement and artifact verified, installed {} at {}",
                            installed.version,
                            installed.cmd
                        );
                        match self.launcher.as_ref().map(|link| link.switch(&installed.version)) {
                            Some(Ok(())) => logln!("[upgrade] launcher accepted switch to {}", installed.version),
                            Some(Err(error)) => logln!("[upgrade] launcher refused switch to {}: {error}", installed.version),
                            None => logln!("[upgrade] no launcher to switch to {}", installed.version),
                        }
                    }
                    Err(error) => logln!("[upgrade] installation refused, keeping current version: {error}"),
                }
            }
            Ok(_staged) => logln!(
                "[upgrade] discarding stale download version={} generation={}",
                request.version,
                request.generation
            ),
            Err(error) if is_latest => logln!("[upgrade] release refused, keeping current version: {error}"),
            Err(error) => logln!(
                "[upgrade] stale download failed version={} generation={}: {error}",
                request.version,
                request.generation
            ),
        }
        Self::take_next(&mut state)
    }

    fn run_executor(self: Arc<Self>, mut request: RemoteUpgradeRequest) {
        loop {
            let result = download_verify_stage(
                &request.url,
                &request.sha256,
                &self.home,
                &request.version,
                &request.target,
                request.artifact_size,
                &request.release_signature,
                request.transport.as_ref(),
            );
            match self.finish(request, result) {
                Some(next) => request = next,
                None => break,
            }
        }
    }

    /// A `worker.upgrade` from the centre. Fixed-shape validation and the floor check happen
    /// synchronously, before any network access; the download runs on the single executor thread.
    pub fn install_from_url(
        self: &Arc<Self>,
        version: String,
        url: String,
        sha256: String,
        target: String,
        artifact_size: u64,
        release_signature: String,
        transport: Option<TransportArtifact>,
    ) {
        let release_version = match validate_upgrade_request(
            &version,
            &url,
            &sha256,
            &target,
            artifact_size,
            &release_signature,
        ) {
            Ok(release_version) => release_version,
            Err(error) => {
                logln!("[upgrade] malformed upgrade request (no download): {error}");
                return;
            }
        };
        if let Some(companion) = transport.as_ref() {
            if validate_upgrade_request(
                &version,
                &companion.url,
                &companion.sha256,
                &target,
                companion.size,
                &companion.release_signature,
            )
            .is_err()
            {
                logln!("[upgrade] invalid native companion metadata; download refused");
                return;
            }
        }
        if let Err(error) = self.ensure_release_is_newer(&release_version) {
            logln!("[upgrade] {error}");
            return;
        }
        let Some(request) = self.enqueue(RemoteUpgradeRequest {
            generation: 0,
            release_version,
            version,
            url,
            sha256,
            target,
            artifact_size,
            release_signature,
            transport,
        }) else {
            return;
        };
        let this = Arc::clone(self);
        std::thread::spawn(move || this.run_executor(request));
    }

    /// Switch to a version already registered with the launcher (a test registry entry): the
    /// centre's `workerUpgrade` without a download URL.
    pub fn switch_known(&self, version: String) {
        match self.launcher.as_ref().map(|link| link.switch(&version)) {
            Some(Ok(())) => logln!("[upgrade] launcher accepted switch to {version}"),
            Some(Err(error)) => logln!("[upgrade] launcher refused switch to {version}: {error}"),
            None => logln!("[upgrade] no launcher to switch to {version}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_home(name: &str) -> PathBuf {
        let id = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "coflux-runtime-{name}-{}-{id}",
            std::process::id()
        ));
        std::fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn bounded_reader_rejects_declared_and_actual_oversize() {
        let error = read_bounded_with_limit(&b"ok"[..], Some(9), 8).unwrap_err();
        assert!(error.contains("过大"));

        let reader = std::io::repeat(7).take(9);
        let error = read_bounded_with_limit(reader, None, 8).unwrap_err();
        assert!(error.contains("过大"));
    }

    #[test]
    fn installed_runtime_recovery_is_strict() {
        let home = test_home("recovery");
        let version_dir = home.join("runtimes/v1.2.3");
        std::fs::create_dir_all(&version_dir).unwrap();
        let worker = version_dir.join(RUNTIME_BINARY);
        std::fs::write(&worker, b"worker").unwrap();
        std::fs::set_permissions(&worker, std::fs::Permissions::from_mode(0o755)).unwrap();
        let spec = installed_runtime(home.to_str().unwrap(), "v1.2.3").unwrap();
        assert_eq!(spec.cmd, worker.to_string_lossy());

        std::fs::set_permissions(&worker, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(installed_runtime(home.to_str().unwrap(), "v1.2.3")
            .unwrap_err()
            .contains("执行权限"));
        std::fs::remove_dir_all(home).unwrap();
    }

    fn pair_fixture(home: &Path, version: &str, worker: &[u8], helper: &[u8]) -> StagedRuntime {
        let mut staged =
            stage_pair_worker(home, version, worker, Sha256::digest(worker).into()).unwrap();
        let (mut file, path) =
            create_temp_file(staged.pair_staging.as_ref().unwrap(), "coflux-transport").unwrap();
        file.write_all(helper).unwrap();
        file.set_permissions(std::fs::Permissions::from_mode(0o755))
            .unwrap();
        file.sync_all().unwrap();
        staged.transport = Some(StagedTransport {
            temp: Some(path),
            metadata: TransportArtifact {
                url: "https://example.invalid/helper".into(),
                sha256: hex::encode(Sha256::digest(helper)),
                size: helper.len() as u64,
                release_signature: "00".repeat(64),
            },
        });
        staged
    }
    #[test]
    fn pair_publication_is_one_directory_and_drop_never_exposes_partial_version() {
        let home = test_home("atomic-pair");
        let staged = pair_fixture(&home, "v2.0.0", b"worker", b"helper");
        let staging = staged.pair_staging.clone().unwrap();
        assert!(!home.join("runtimes/v2.0.0").exists());
        drop(staged);
        assert!(!staging.exists());
        assert!(!home.join("runtimes/v2.0.0").exists());
        pair_fixture(&home, "v2.0.0", b"worker", b"helper")
            .install()
            .unwrap();
        assert!(installed_runtime(home.to_str().unwrap(), "v2.0.0").is_ok());
        pair_fixture(&home, "v2.0.0", b"worker", b"helper")
            .install()
            .unwrap();
        assert!(pair_fixture(&home, "v2.0.0", b"worker", b"different")
            .install()
            .is_err());
        assert_eq!(
            std::fs::read(home.join("runtimes/v2.0.0/coflux-transport")).unwrap(),
            b"helper"
        );
        std::fs::remove_file(home.join("runtimes/v2.0.0/coflux-transport")).unwrap();
        assert!(installed_runtime(home.to_str().unwrap(), "v2.0.0").is_err());
        std::fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn pair_install_cannot_mutate_an_existing_worker_only_version() {
        let home = test_home("legacy-pair");
        let worker = b"worker";
        stage_verified_bytes(&home, "v2.0.0", worker, Sha256::digest(worker).into())
            .unwrap()
            .install()
            .unwrap();
        assert!(pair_fixture(&home, "v2.0.0", worker, b"helper")
            .install()
            .is_err());
        assert!(!home.join("runtimes/v2.0.0/coflux-transport").exists());
        assert!(!home.join("runtimes/v2.0.0/transport-pair.json").exists());
        assert_eq!(
            std::fs::read(home.join("runtimes/v2.0.0/coflux-worker")).unwrap(),
            worker
        );
        std::fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn staged_worker_only_appears_at_final_path_after_atomic_install() {
        let home = test_home("atomic-install");
        let body = b"signed worker bytes";
        let digest: [u8; 32] = Sha256::digest(body).into();
        let staged = stage_verified_bytes(&home, "v2", body, digest).unwrap();
        let final_path = home.join("runtimes/v2/coflux-worker");
        assert!(!final_path.exists(), "晋升前正式路径不可见");
        assert!(
            staged.temp_path.as_ref().unwrap().exists(),
            "验签内容已在同目录临时文件持久化"
        );

        let spec = staged.install().unwrap();
        assert_eq!(spec.cmd, final_path.to_string_lossy());
        assert_eq!(std::fs::read(&final_path).unwrap(), body);
        assert_ne!(
            std::fs::metadata(&final_path).unwrap().permissions().mode() & 0o111,
            0
        );

        // 同版本同内容幂等，并修复上次安装后丢失的执行位；同版本不同内容拒绝覆盖。
        std::fs::set_permissions(&final_path, std::fs::Permissions::from_mode(0o444)).unwrap();
        stage_verified_bytes(&home, "v2", body, digest)
            .unwrap()
            .install()
            .unwrap();
        assert_ne!(
            std::fs::metadata(&final_path).unwrap().permissions().mode() & 0o111,
            0,
            "同 digest 重试也必须恢复执行位后才成功"
        );
        let other = b"different signed bytes";
        let other_digest: [u8; 32] = Sha256::digest(other).into();
        let error = stage_verified_bytes(&home, "v2", other, other_digest)
            .unwrap()
            .install()
            .unwrap_err();
        assert!(error.contains("内容不同"));
        assert_eq!(std::fs::read(&final_path).unwrap(), body);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn malformed_upgrade_fields_are_rejected_before_network_access() {
        let sha = "00".repeat(32);
        let release_signature = "22".repeat(64);
        let target = current_release_target();
        assert!(validate_upgrade_request(
            "v1.2.3",
            "https://example.invalid/worker",
            &sha,
            target,
            1,
            &release_signature,
        )
        .is_ok());
        assert!(validate_upgrade_request(
            "v1.2.3",
            "file:///etc/passwd",
            &sha,
            target,
            1,
            &release_signature,
        )
        .is_err());
        assert!(validate_upgrade_request(
            "v1.2.3",
            "https://example.invalid/worker",
            "00",
            target,
            1,
            &release_signature,
        )
        .is_err());
        assert!(validate_upgrade_request(
            "v1.2.3",
            &format!(
                "https://example.invalid/{}",
                "a".repeat(MAX_UPGRADE_URL_BYTES)
            ),
            &sha,
            target,
            1,
            &release_signature,
        )
        .is_err());
        assert!(validate_upgrade_request(
            "not-semver",
            "https://example.invalid/worker",
            &sha,
            target,
            1,
            &release_signature,
        )
        .is_err());
        assert!(validate_upgrade_request(
            "v1.2.3",
            "https://example.invalid/worker",
            &sha,
            "aarch64-unknown-cross-target",
            1,
            &release_signature,
        )
        .is_err());
        assert!(validate_upgrade_request(
            "v1.2.3",
            "https://example.invalid/worker",
            &sha,
            target,
            0,
            &release_signature,
        )
        .is_err());
        assert!(validate_upgrade_request(
            "v1.2.3",
            "https://example.invalid/worker",
            &sha,
            target,
            1,
            "22",
        )
        .is_err());
    }

    #[test]
    fn release_statement_matches_node_signer_vector() {
        let mut digest = [0u8; 32];
        digest[31] = 0xff;
        let statement = release_statement(
            "v1.2.3-rc.1",
            "aarch64-unknown-linux-musl",
            &digest,
            123_456_789,
        );
        // Domain prefix, then the BE32-length-prefixed version and target, the raw digest and the
        // BE64 size: the same transcript scripts/release-statement.mjs produces under the runtime domain.
        let mut expected = hex::encode(b"coflux-runtime-release-v1\0");
        expected.push_str("0000000b76312e322e332d72632e310000001a616172636836342d756e6b6e6f776e2d6c696e75782d6d75736c");
        expected.push_str("00000000000000000000000000000000000000000000000000000000000000ff");
        expected.push_str("00000000075bcd15");
        assert_eq!(hex::encode(statement), expected);
    }

    #[test]
    fn runtime_statement_never_matches_the_worker_domain_for_identical_metadata() {
        let digest = [7u8; 32];
        let runtime = release_statement("v1.2.3", "aarch64-apple-darwin", &digest, 42);
        let mut worker = b"coflux-worker-release-v1\0".to_vec();
        append_len_prefixed(&mut worker, b"v1.2.3");
        append_len_prefixed(&mut worker, b"aarch64-apple-darwin");
        worker.extend_from_slice(&digest);
        worker.extend_from_slice(&42u64.to_be_bytes());
        assert_ne!(runtime, worker);
    }

    #[test]
    fn concurrent_first_staging_reuses_safely_created_directories() {
        let home = std::sync::Arc::new(test_home("concurrent-stage"));
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(16));
        let body = b"same signed worker bytes";
        let digest: [u8; 32] = Sha256::digest(body).into();
        let mut threads = Vec::new();
        for _ in 0..16 {
            let home = std::sync::Arc::clone(&home);
            let barrier = std::sync::Arc::clone(&barrier);
            threads.push(std::thread::spawn(move || {
                barrier.wait();
                let staged = stage_verified_bytes(&home, "v-race", body, digest).unwrap();
                assert!(staged.temp_path.as_ref().unwrap().exists());
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }
        assert!(home.join("runtimes/v-race").is_dir());
        std::fs::remove_dir_all(home.as_ref()).unwrap();
    }

    #[test]
    fn remote_upgrade_uses_one_executor_and_only_runs_latest_mailbox_item() {
        let home = test_home("latest-only");
        let upgrader = RemoteUpgrader::new(home.to_string_lossy().into_owned(), None);
        let request = |version: &str, url: &str| RemoteUpgradeRequest {
            generation: 0,
            release_version: ReleaseVersion::parse(version).unwrap(),
            version: version.into(),
            url: url.into(),
            sha256: "00".repeat(32),
            target: current_release_target().into(),
            artifact_size: 1,
            release_signature: "22".repeat(64),
            transport: None,
        };
        let first = upgrader
            .enqueue(request("v1.0.0", "https://example.invalid/a"))
            .expect("the idle executor takes A");
        assert!(upgrader.enqueue(request("v1.1.0", "https://example.invalid/b")).is_none());
        assert!(upgrader.enqueue(request("v1.2.0", "https://example.invalid/c")).is_none());
        assert_eq!(
            upgrader.state.lock().unwrap().latest.as_ref().map(|r| r.version.as_str()),
            Some("v1.2.0"),
            "C replaces B in the mailbox"
        );
        let body_a = b"signed runtime a";
        let staged_a = stage_verified_bytes(&home, "v1.0.0", body_a, Sha256::digest(body_a).into()).unwrap();
        let latest = upgrader.finish(first, Ok(staged_a)).expect("A's completion hands over C");
        assert_eq!(latest.version, "v1.2.0");
        assert!(!home.join("runtimes/v1.0.0/coflux-runtime").exists(), "a stale A is never promoted");
        assert!(!home.join("runtimes/v1.1.0/coflux-runtime").exists(), "B never ran");
        let body_c = b"signed runtime c";
        let staged_c = stage_verified_bytes(&home, "v1.2.0", body_c, Sha256::digest(body_c).into()).unwrap();
        assert!(upgrader.finish(latest, Ok(staged_c)).is_none());
        // Without a launcher the install happens but no switch can be requested; the artifact
        // is in the store for the launcher to find.
        assert_eq!(std::fs::read(home.join("runtimes/v1.2.0/coflux-runtime")).unwrap(), body_c);
        assert!(!upgrader.state.lock().unwrap().executor_running);
        std::fs::remove_dir_all(home).unwrap();
    }
}
