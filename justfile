import? '.local/justfile'

check:
    cargo fmt --all --check
    cargo clippy --locked --workspace --all-targets -- -D warnings
    cargo build --locked

accept rg helper="target/debug/dsh-remote" fixture="target/debug/dsh-remote-fixture" platform="macos":
    python3 runtime/helper/tests/acceptance.py --helper {{helper}} --fixture {{fixture}} --platform {{platform}} --rg {{rg}}
