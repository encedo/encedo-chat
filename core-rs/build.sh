#!/usr/bin/env bash
# Build the WASM core deterministically and copy it where the engine loads it
# from. The toolchain is pinned by rust-toolchain.toml; the same commit on the
# same toolchain gives the same bytes (CI rebuilds and compares, desktop.yml).
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release --target wasm32-unknown-unknown --quiet
mkdir -p ../impl/core-wasm
cp target/wasm32-unknown-unknown/release/encedo_core.wasm ../impl/core-wasm/core.wasm
ls -l ../impl/core-wasm/core.wasm | awk '{print "core.wasm", $5, "bytes"}'
sha256sum ../impl/core-wasm/core.wasm
