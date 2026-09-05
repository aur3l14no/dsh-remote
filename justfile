import? 'justfile.local'

check:
    cargo fmt --check
    cargo clippy --all-targets -- -D warnings
    cargo build --locked

accept rg helper="target/debug/dsh-remote" fixture="target/debug/dsh-remote-fixture" platform="macos":
    python3 tests/acceptance.py --helper {{helper}} --fixture {{fixture}} --platform {{platform}} --rg {{rg}}
