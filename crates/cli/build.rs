use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    println!("cargo::rustc-check-cfg=cfg(coflux_private_ca)");
    println!("cargo:rerun-if-env-changed=COFLUX_BUILD_CA_FILE");
    println!("cargo:rerun-if-env-changed=COFLUX_BUILD_PUBLIC_ORIGIN");
    let path = env::var("COFLUX_BUILD_CA_FILE").unwrap_or_default();
    if path.is_empty() {
        return;
    }
    let dest = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR")).join("private-ca.pem");
    fs::copy(&path, &dest).unwrap_or_else(|error| panic!("copy {path} into the build: {error}"));
    println!("cargo:rerun-if-changed={path}");
    println!("cargo:rustc-cfg=coflux_private_ca");
}
