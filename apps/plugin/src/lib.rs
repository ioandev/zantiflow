//! zantiflow Zellij plugin.
//!
//! Architecture (ADR-0014): all pure logic — config parsing, privacy (Model A), the wire-v4 snapshot
//! model, fingerprinting — is target-agnostic and unit-tested natively behind the [`host::HostPort`]
//! trait. The `zellij-tile` FFI lives ONLY in the wasm-gated `plugin` module, so the bulk of the code
//! compiles and tests on the host without WASM or a running Zellij.

pub mod activity;
pub mod attentions;
pub mod cadence;
pub mod config;
pub mod control;
pub mod fingerprint;
pub mod host;
pub mod model;
pub mod net;
pub mod output;
pub mod pairing;
pub mod privacy;
pub mod scrub;
pub mod snapshot;

// The zellij-tile FFI adapter + ZellijPlugin impl — compiled only for the wasm plugin target.
// `pub` so the plugin binary (src/main.rs) can name `plugin::ZantiflowPlugin` in `register_plugin!`.
#[cfg(target_arch = "wasm32")]
pub mod plugin;
