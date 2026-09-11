import? '.local/justfile'

# npm owns the command graph; just is an optional convenience interface.
check:
    npm run check

test:
    npm test

test-integration:
    npm run test-integration

test-e2e:
    npm run test-e2e

package:
    npm run package

accept rg helper="runtime/helper/target/debug/dsh-remote-helper" fixture="runtime/helper/target/debug/dsh-remote-fixture" platform="macos":
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
