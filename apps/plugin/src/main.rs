//! WASI-command entry point for the zantiflow Zellij plugin.
//!
//! Zellij's plugin loader (`plugin_loader.rs`) fatally requires the wasm to export `_start` — the WASI
//! command entry point. That export is only produced when `register_plugin!`'s generated `fn main` is
//! the crate root of a **binary** target; a `cdylib`/library never compiles `main` into `_start`, no
//! matter where the macro is invoked. So the macro lives here, at the root of the plugin binary. All
//! real logic stays in the library (`plugin::ZantiflowPlugin` and the pure, natively-tested modules).

#[cfg(target_arch = "wasm32")]
use zellij_tile::prelude::*;

// Expands to `fn main` (→ `_start`) plus the `#[no_mangle]` load/update/render/pipe/plugin_version
// exports Zellij calls. Must stay at crate root, uncnested, for `_start` to be emitted.
#[cfg(target_arch = "wasm32")]
register_plugin!(zantiflow_plugin::plugin::ZantiflowPlugin);

// Native builds (unit tests / tooling) don't produce the wasm plugin — the entry point is wasm-only.
#[cfg(not(target_arch = "wasm32"))]
fn main() {}
