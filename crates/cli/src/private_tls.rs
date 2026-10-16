//! Extra trust and the default account origin for a privately compiled centre.
use std::sync::Arc;
#[cfg(coflux_private_ca)]
use std::sync::OnceLock;

use rustls::ClientConfig;
#[cfg(coflux_private_ca)]
use rustls::RootCertStore;

#[cfg(coflux_private_ca)]
const PRIVATE_CA_PEM: &str = include_str!(concat!(env!("OUT_DIR"), "/private-ca.pem"));

pub fn default_account_server() -> &'static str {
    option_env!("COFLUX_BUILD_PUBLIC_ORIGIN")
        .map(str::trim)
        .filter(|origin| !origin.is_empty())
        .unwrap_or("https://api.coflux.yourantiandi.com")
}

pub fn client_config() -> Option<Arc<ClientConfig>> {
    #[cfg(not(coflux_private_ca))]
    {
        None
    }
    #[cfg(coflux_private_ca)]
    {
        Some(CONFIG.get_or_init(build_config).clone())
    }
}

#[cfg(coflux_private_ca)]
static CONFIG: OnceLock<Arc<ClientConfig>> = OnceLock::new();

#[cfg(coflux_private_ca)]
fn build_config() -> Arc<ClientConfig> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let mut reader = std::io::Cursor::new(PRIVATE_CA_PEM.as_bytes());
    let mut added = 0;
    for cert in rustls_pemfile::certs(&mut reader) {
        let cert = cert.expect("COFLUX_BUILD_CA_FILE is not a PEM certificate");
        roots
            .add(cert)
            .expect("private CA could not be added to the trust store");
        added += 1;
    }
    assert!(
        added > 0,
        "COFLUX_BUILD_CA_FILE did not contain a certificate"
    );
    Arc::new(
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
            .expect("ring supports TLS 1.2 and 1.3")
            .with_root_certificates(roots)
            .with_no_client_auth(),
    )
}
