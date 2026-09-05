#!/bin/sh
# Run on the Linux build machine. Rust std for the requested target must be installed.
set -eu
build_target=${1:-x86_64-unknown-linux-gnu}
case "$build_target" in
    aarch64-unknown-linux-musl)
        build_host=$(rustc -vV | sed -n 's/^host: //p')
        CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER="$(rustc --print sysroot)/lib/rustlib/$build_host/bin/rust-lld"
        export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER
        ;;
    x86_64-unknown-linux-gnu) ;;
    *) echo 'Unsupported acceptance target' >&2; exit 2 ;;
esac
cargo build --locked --release --target "$build_target"
