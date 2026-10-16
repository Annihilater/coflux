// cargo 不会因 env 变化自动重编译 `option_env!` 读到的值；声明 rerun-if-env-changed
// 让本地增量构建也能在改这个 env 后重编译（CI 全新构建本就不受影响）。见 main.rs SUPERVISOR_VERSION。
fn main() {
    println!("cargo::rustc-check-cfg=cfg(coflux_private_ca)");
    println!("cargo:rerun-if-env-changed=COFLUX_RELEASE_VERSION");
    println!("cargo:rerun-if-env-changed=COFLUX_BUILD_CA_FILE");
    println!("cargo:rerun-if-env-changed=COFLUX_BUILD_PUBLIC_ORIGIN");
    let path = std::env::var("COFLUX_BUILD_CA_FILE").unwrap_or_default();
    if path.is_empty() {
        return;
    }
    let dest = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("private-ca.pem");
    std::fs::copy(&path, &dest).unwrap_or_else(|error| panic!("copy {path} into the build: {error}"));
    println!("cargo:rerun-if-changed={path}");
    println!("cargo:rustc-cfg=coflux_private_ca");
}
