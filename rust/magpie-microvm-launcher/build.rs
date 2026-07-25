//! Build script: tells the linker where to find `libkrun.so` and to link it
//! dynamically.
//!
//! `libkrun`'s own build (see `spike/m8-a1/provision.sh` step 5 + correction
//! (c)) installs `libkrun.so.1.19.4` (symlinked as `libkrun.so.1` and
//! `libkrun.so`) into `/usr/local/lib64`. That path is registered with
//! `ldconfig` via `/etc/ld.so.conf.d/libkrun.conf`, so the RUNTIME dynamic
//! loader (`ld.so`) finds it fine once installed — but the LINK-TIME
//! link-editor (`ld`, invoked by `rustc`/`cc`) does not consult
//! `/etc/ld.so.conf` at all; it only searches its own compiled-in default
//! directories (e.g. `/usr/lib`, `/lib`) plus whatever `-L` flags are passed
//! explicitly. Without the `-L` below, the build fails at link time with
//! "cannot find -lkrun" even on a host where the library is correctly
//! installed and would resolve fine at runtime.
//!
//! `MAGPIE_LIBKRUN_LIB_DIR` lets a differently-configured host (e.g. a distro
//! that packages libkrun somewhere other than `/usr/local/lib64`) override
//! the search path without patching this file.

fn main() {
    let lib_dir =
        std::env::var("MAGPIE_LIBKRUN_LIB_DIR").unwrap_or_else(|_| "/usr/local/lib64".to_string());
    println!("cargo:rustc-link-search=native={lib_dir}");
    // Dynamic link against libkrun.so.1 (ABI 1, pinned to v1.19.4 — see
    // src/krun.rs's `LIBKRUN_ABI_PIN`). `dylib` is the default for `-lkrun`
    // but spelled out here so the "this is NOT the static-musl lane" fact is
    // impossible to miss on a skim.
    println!("cargo:rustc-link-lib=dylib=krun");
    println!("cargo:rerun-if-env-changed=MAGPIE_LIBKRUN_LIB_DIR");
}
