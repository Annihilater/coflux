//! Crash-safe replacement of a small owner-only file: the reader sees either the previous content
//! or the whole new one, never a truncated file, and the new content survives a power loss once
//! this returns.
//!
//! Sequence: a fresh temp file beside the target (`create_new`, mode 0600) → write → fsync → rename
//! over the target → assert 0600 on the target (an existing target keeps its own mode through a
//! rename on some platforms) → fsync the directory so the rename itself is durable. A failure
//! removes the temp file.

use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
use std::path::Path;

use rand_core::{OsRng, RngCore as _};

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("atomic write target has no parent directory"))?;
    fs::create_dir_all(parent)?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let mut suffix = [0u8; 8];
    OsRng.fill_bytes(&mut suffix);
    let temp = parent.join(format!(
        ".{name}.tmp-{}-{}",
        std::process::id(),
        hex::encode(suffix)
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        if let Ok(directory) = OpenOptions::new().read(true).open(parent) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_content_owner_only_and_leaves_no_temp_file() {
        let mut random = [0u8; 8];
        OsRng.fill_bytes(&mut random);
        let dir = std::env::temp_dir().join(format!("coflux-atomic-{}", hex::encode(random)));
        let path = dir.join("state.json");
        write_atomic(&path, b"first").unwrap();
        write_atomic(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
