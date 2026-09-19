//! The executor model-configuration cache (`$COFLUX_HOME/executor-settings.json`, chmod 600).
//!
//! The centre owns this configuration; the daemon's only job on this path is to write what it is
//! handed to a local file. The reader is the desktop main process on the same machine, which opens
//! the file directly — there is deliberately **no** read/write interface on the daemon side. That
//! keeps the read path entirely local: the executor can still take work while the machine is
//! offline, and only *changing* the configuration needs the network.
//!
//! The file holds API keys in the clear, so it follows `creds.rs` (the `credentials.json` that
//! already stores the device token, a bearer secret) and **not** `conn_state.rs`, whose own header
//! states it is a key-free snapshot that needs no 0600. Same threat model as `credentials.json`:
//! anything that can read this file can already read the device token next to it.
//!
//! Writes go through a temporary file and a rename so a reader never sees half a document — the
//! desktop side polls/watches this path and would otherwise parse a truncated JSON as "nothing
//! configured", which reads to the user as "my configuration vanished".

use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use serde::Serialize;

use coflux_protocol::wire;

#[derive(Serialize)]
struct CachedModel {
    id: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedCustomProvider {
    id: String,
    name: String,
    base_url: String,
    api: String,
    models: Vec<CachedModel>,
    auth_header: bool,
    keyless: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedCredential {
    provider_id: String,
    #[serde(rename = "type")]
    kind: String,
    api_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedSettings {
    revision: f64,
    provider: String,
    model_id: String,
    custom_providers: Vec<CachedCustomProvider>,
    credentials: Vec<CachedCredential>,
    credential_error: String,
    updated_at: f64,
}

pub struct ExecutorSettingsStore {
    path: String,
    home: String,
}

impl ExecutorSettingsStore {
    pub fn new(home: &str) -> Self {
        Self {
            path: format!("{home}/executor-settings.json"),
            home: home.to_string(),
        }
    }

    /// Persist one delivery. Failures are logged by the caller, not retried: the centre re-sends the
    /// whole configuration on every reconnect, so a transient write failure heals by itself.
    pub fn save(&self, update: &wire::ExecutorSettingsUpdate, now_ms: f64) -> Result<(), String> {
        let cached = CachedSettings {
            revision: update.revision,
            provider: update.provider.clone(),
            model_id: update.model_id.clone(),
            custom_providers: update
                .custom_providers
                .iter()
                .map(|provider| CachedCustomProvider {
                    id: provider.provider_id.clone(),
                    name: provider.name.clone(),
                    base_url: provider.base_url.clone(),
                    api: provider.api.clone(),
                    models: provider
                        .models
                        .iter()
                        .map(|model| CachedModel {
                            id: model.id.clone(),
                            name: model.name.clone(),
                        })
                        .collect(),
                    auth_header: provider.auth_header,
                    keyless: provider.keyless,
                })
                .collect(),
            credentials: update
                .credentials
                .iter()
                .map(|credential| CachedCredential {
                    provider_id: credential.provider_id.clone(),
                    kind: credential.r#type.clone(),
                    api_key: credential.api_key.clone(),
                })
                .collect(),
            credential_error: update.credential_error.clone(),
            updated_at: now_ms,
        };
        let json = serde_json::to_string_pretty(&cached).map_err(|error| error.to_string())?;
        self.write_atomic(&json)
    }

    fn write_atomic(&self, json: &str) -> Result<(), String> {
        fs::create_dir_all(&self.home).map_err(|error| error.to_string())?;
        let _ = fs::set_permissions(&self.home, fs::Permissions::from_mode(0o700));
        let temp = format!("{}.{}.tmp", self.path, std::process::id());
        {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&temp)
                .map_err(|error| error.to_string())?;
            file.write_all(json.as_bytes())
                .map_err(|error| error.to_string())?;
            file.write_all(b"\n").map_err(|error| error.to_string())?;
        }
        // rename is atomic within one filesystem: the reader sees either the previous document or
        // the whole new one, never a truncated file.
        if let Err(error) = fs::rename(&temp, &self.path) {
            let _ = fs::remove_file(&temp);
            return Err(error.to_string());
        }
        // The temp file already carries 0600, but an existing target keeps its own mode through a
        // rename on some platforms; assert it rather than assume.
        let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600));
        Ok(())
    }

    #[cfg(test)]
    pub fn path(&self) -> &str {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand_core::{OsRng, RngCore};

    /// Own temporary HOME per test, following the house pattern in local_auth.rs: the real
    /// `~/.coflux` is never touched.
    fn temp_home(name: &str) -> String {
        let mut random = [0u8; 8];
        OsRng.fill_bytes(&mut random);
        let directory = std::env::temp_dir().join(format!(
            "coflux-{name}-{}-{}",
            std::process::id(),
            hex::encode(random)
        ));
        fs::create_dir_all(&directory).unwrap();
        directory.to_string_lossy().into_owned()
    }

    fn sample() -> wire::ExecutorSettingsUpdate {
        wire::ExecutorSettingsUpdate {
            revision: 7.0,
            provider: "anthropic".into(),
            model_id: "claude-sonnet-5".into(),
            custom_providers: vec![wire::ExecutorCustomProvider {
                provider_id: "my-relay".into(),
                name: "My relay".into(),
                base_url: "https://relay.example/v1".into(),
                api: "openai-completions".into(),
                models: vec![wire::ExecutorCustomProviderModel {
                    id: "gpt-x".into(),
                    name: "GPT X".into(),
                }],
                auth_header: true,
                keyless: false,
            }],
            credentials: vec![wire::ExecutorCredential {
                provider_id: "anthropic".into(),
                r#type: "api_key".into(),
                api_key: "sk-secret".into(),
            }],
            credential_error: String::new(),
        }
    }

    #[test]
    fn writes_camel_case_json_the_desktop_can_read() {
        let home = temp_home("execset-json");
        let store = ExecutorSettingsStore::new(&home);
        store.save(&sample(), 1_700_000_000_000.0).unwrap();
        let raw = fs::read_to_string(store.path()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["revision"], 7.0);
        assert_eq!(parsed["modelId"], "claude-sonnet-5");
        assert_eq!(parsed["customProviders"][0]["id"], "my-relay");
        assert_eq!(parsed["customProviders"][0]["baseUrl"], "https://relay.example/v1");
        assert_eq!(parsed["customProviders"][0]["authHeader"], true);
        assert_eq!(parsed["credentials"][0]["providerId"], "anthropic");
        assert_eq!(parsed["credentials"][0]["type"], "api_key");
        assert_eq!(parsed["credentials"][0]["apiKey"], "sk-secret");
    }

    /// The file holds API keys, so it must land 0600 like credentials.json — not the 0644 that
    /// conn-state.json is allowed.
    #[test]
    fn cache_file_is_owner_only() {
        let home = temp_home("execset-mode");
        let store = ExecutorSettingsStore::new(&home);
        store.save(&sample(), 0.0).unwrap();
        let mode = fs::metadata(store.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    /// A second delivery replaces the first outright; no temporary file is left behind for the
    /// desktop side to trip over.
    #[test]
    fn rewrite_replaces_and_leaves_no_temp_file() {
        let home = temp_home("execset-rewrite");
        let store = ExecutorSettingsStore::new(&home);
        store.save(&sample(), 0.0).unwrap();
        let mut next = sample();
        next.revision = 8.0;
        next.credentials.clear();
        store.save(&next, 0.0).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(store.path()).unwrap()).unwrap();
        assert_eq!(parsed["revision"], 8.0);
        assert_eq!(parsed["credentials"].as_array().unwrap().len(), 0);
        let leftovers: Vec<_> = fs::read_dir(&home)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    /// An undecryptable credential arrives as a readable error, and it must survive into the file:
    /// showing "not configured" instead would make the user think they never filled anything in.
    #[test]
    fn credential_error_reaches_the_cache_file() {
        let home = temp_home("execset-error");
        let store = ExecutorSettingsStore::new(&home);
        let mut update = sample();
        update.credentials.clear();
        update.credential_error = "服务端密钥已变更，请重新填写 API key".into();
        store.save(&update, 0.0).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(store.path()).unwrap()).unwrap();
        assert_eq!(parsed["credentialError"], "服务端密钥已变更，请重新填写 API key");
    }
}
