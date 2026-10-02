//! Release identity shared by the launcher (version pointer, remote release floor) and the
//! runtime (download and verification): strict `v`-prefixed SemVer, the version-as-path rule for
//! the version store, and the four release targets.

use semver::Version;

pub const MAX_VERSION_BYTES: usize = 128;

/// A release version must be canonical strict SemVer with a `v` prefix. Build metadata does
/// not take part in precedence; a different string of equal precedence is still a replay.
#[derive(Clone, Debug)]
pub struct ReleaseVersion {
    raw: String,
    parsed: Version,
}

impl ReleaseVersion {
    pub fn parse(raw: &str) -> Result<Self, String> {
        if raw.len() > MAX_VERSION_BYTES {
            return Err(format!("release version exceeds {MAX_VERSION_BYTES} bytes"));
        }
        let semver = raw
            .strip_prefix('v')
            .ok_or_else(|| "release version must be strict SemVer with a v prefix".to_string())?;
        let parsed = Version::parse(semver)
            .map_err(|error| format!("release version is not strict SemVer: {error}"))?;
        if format!("v{parsed}") != raw {
            return Err("release version is not in canonical SemVer form".to_string());
        }
        Ok(Self {
            raw: raw.to_string(),
            parsed,
        })
    }

    pub fn as_str(&self) -> &str {
        &self.raw
    }

    pub fn is_newer_than(&self, other: &Self) -> bool {
        self.parsed.cmp_precedence(&other.parsed).is_gt()
    }

    pub fn max(self, other: Self) -> Self {
        if other.is_newer_than(&self) {
            other
        } else {
            self
        }
    }
}

/// The release matrix produces exactly these four targets. Linux verifies the musl triple of the
/// real release artifact even when the local debug build is gnu.
pub fn current_release_target() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("linux", "aarch64") => "aarch64-unknown-linux-musl",
        ("linux", "x86_64") => "x86_64-unknown-linux-musl",
        _ => "unsupported",
    }
}

/// A version is used as one path component of the version store: refuse traversal, the reserved
/// builtin name and anything outside `A-Za-z0-9._-+`.
pub fn validate_version(version: &str) -> Result<(), String> {
    if version.is_empty() {
        return Err("version is empty".into());
    }
    if version == "builtin" {
        return Err("version 'builtin' is reserved".into());
    }
    if version == "." {
        return Err("version '.' would collapse into the store root".into());
    }
    if version.len() > MAX_VERSION_BYTES {
        return Err(format!("version exceeds {MAX_VERSION_BYTES} bytes"));
    }
    if version.contains("..") {
        return Err(format!("version contains '..': {version}"));
    }
    if !version
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '+'))
    {
        return Err(format!(
            "version contains characters outside A-Za-z0-9._-+: {version}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_semver_precedence_is_strict() {
        let rc = ReleaseVersion::parse("v2.0.0-rc.2").unwrap();
        let stable = ReleaseVersion::parse("v2.0.0").unwrap();
        let next = ReleaseVersion::parse("v2.0.1").unwrap();
        let build_one = ReleaseVersion::parse("v2.0.0+build.1").unwrap();
        let build_two = ReleaseVersion::parse("v2.0.0+build.2").unwrap();
        assert!(stable.is_newer_than(&rc));
        assert!(next.is_newer_than(&stable));
        assert!(!rc.is_newer_than(&stable));
        assert!(!build_two.is_newer_than(&build_one));
        assert!(!build_one.is_newer_than(&build_two));
        assert!(ReleaseVersion::parse("2.0.0").is_err());
        assert!(ReleaseVersion::parse("v02.0.0").is_err());
        assert!(ReleaseVersion::parse("v2.0.0-01").is_err());
    }

    #[test]
    fn invalid_versions_never_escape_the_store() {
        for version in ["", ".", "builtin", "../evil", "a/b", "a b"] {
            assert!(validate_version(version).is_err(), "should reject {version:?}");
        }
        assert!(validate_version(&"v".repeat(MAX_VERSION_BYTES + 1)).is_err());
        assert!(validate_version("v1.2.3-rc_1").is_ok());
        assert!(validate_version("v1.2.3+build.1").is_ok());
    }
}
