import? '.local/justfile'

check:
    cd runtime/helper && cargo fmt --all --check
    cd runtime/helper && cargo clippy --locked --all-targets -- -D warnings
    cd runtime/helper && cargo build --locked

accept rg helper="runtime/helper/target/debug/dsh-remote" fixture="runtime/helper/target/debug/dsh-remote-fixture" platform="macos":
    python3 runtime/helper/tests/acceptance.py --helper {{helper}} --fixture {{fixture}} --platform {{platform}} --rg {{rg}}

# Rebuildable integration inputs, staging and private test state only.
clean:
    rm -rf .build

clean-reports:
    rm -rf artifacts

clean-dist:
    rm -rf dist

clean-rust:
    cd runtime/helper && cargo clean
