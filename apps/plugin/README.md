# zantiflow-plugin

The Zellij plugin (Rust → `wasm32-wasip1`). Once per second it builds a **wire-v4** snapshot of
sessions → tabs → panes (with derived per-pane activity fingerprints) and POSTs it to the backend's
`/api/v1/ingest`, applying privacy redaction (ADR-0002 Model A) **before anything leaves the machine**.

## Architecture (ADR-0014)

All decision logic is target-agnostic and unit-tested on the host behind the `HostPort` trait; the
`zellij-tile` FFI is isolated to the wasm-only `plugin` module (`zellij-tile` is a
`[target.'cfg(target_arch = "wasm32")'.dependencies]`).

| Module | Role | Native-tested |
| --- | --- | --- |
| `model` | wire-v4 serde structs (mirror `packages/protocol`) | ✅ |
| `config` | parse KDL config; privacy Model A **fail-closed**; `server_url` https-only | ✅ |
| `privacy` | apply visibility → redact names to `null` | ✅ |
| `fingerprint` | stable `sid`, salted content fingerprint, machineId/salt in `/data`·`/cache` | ✅ |
| `snapshot` | build v4 tree (order current→live→resurrectable), bounded | ✅ |
| `net` | build the Bearer + JSON ingest POST | ✅ |
| `pairing` | build `/pair/start`+`/pair/poll` requests; parse the RFC-8628 states (ADR-0012) | ✅ |
| `host` | `HostPort` trait + in-memory `FakeHost` | — |
| `plugin` | **wasm-only** FFI adapter + `ZellijPlugin` loop (telemetry · pairing · `render`) | build-verified |

## Build & test

```bash
cargo test  -p zantiflow-plugin                              # native unit tests
cargo build -p zantiflow-plugin --target wasm32-wasip1 --release   # the .wasm artifact
cargo clippy -p zantiflow-plugin --all-targets -- -D warnings
cargo clippy -p zantiflow-plugin --target wasm32-wasip1 -- -D warnings
```

Pinned to `zellij-tile 0.44.3` (matches the reference Zellij; its `Event`/`Permission` enums are
`#[non_exhaustive]` — re-verify against the exact tag on upgrade). The release build verifies every
FFI name/type against that tag.

## Configuration note — `server_url`

`server_url` is **optional**: unset, it defaults to the hosted service (`https://zantiflow.com`), so
a normal user only sets it when self-hosting. For the local smoke check below, point it at your own
backend (`http://localhost:4000` — plain http is allowed for localhost only). See
`docs/.../plugin/getting-started.mdx` for the full user-facing config.

## Configuration note — `hostname` (opt-in, ADR-0024)

Sending the **real hostname** is **off by default**. It requires the Zellij `RunCommands` permission,
which the plugin requests **lazily** — only when you set `hostname "on"` *and* `machine_name "real"`.
So `alias`/`hidden`/default users are never prompted for `RunCommands`, and the real hostname never
leaves the machine unless explicitly enabled. With it off (or the machine aliased/hidden), the machine
name is sent as `null` and the dashboard shows `<hidden>`. Toggling `hostname "on"` at runtime acquires
the permission without a reload; denying the prompt keeps telemetry running (just no hostname). The
single gate is `config::wants_hostname()`.

## Real-Zellij smoke check (ADR-0014 §6) — throwaway session ONLY

> **Never** load the plugin into a running session and **never** restart the user's Zellij. Use a
> fresh named session and delete it afterward.

1. Start a local backend (Phase 1/2) on `:4000`. Then either **pair the device** — leave `token` out
   of `dev/zantiflow-dev.kdl`; the plugin pane shows a code, you approve it at the website `/pair`
   (signed in), and the plugin stores the minted token in `/data` — **or** paste a manually-minted
   ingest token into the layout.
2. `cargo build -p zantiflow-plugin --target wasm32-wasip1 --release`
3. `zellij --session zantiflow-smoke --layout apps/plugin/dev/zantiflow-dev.kdl`
4. **Grant** the base permission prompt in the plugin pane (ReadApplicationState, WebAccess,
   ReadPaneContents). `RunCommands` is prompted **separately** and only if you enable `hostname "on"`
   with `machine_name "real"` (ADR-0024) — exercise that path by toggling the flag and granting/denying.
5. Confirm the backend receives a v4 snapshot ~once/second; the machine appears via the read API.
6. **Colour capture (ADR-0016/0017).** Enable `pane_output "on"` in the layout, run something colourful
   in one of the non-plugin panes (e.g. `ls --color=always`, `cargo build`, a `claude` session), then
   open that pane's output drawer in the dashboard. Confirm the "last 50 lines" render **in colour**.
   Note: colour comes from `PaneRenderReportWithAnsi` change events (the plugin subscribes only while
   `pane_output` is ON) — `get_pane_scrollback` is ANSI-stripped server-side, so a pane that hasn't
   repainted since you enabled sharing falls back to plain text until it next renders.
7. `zellij delete-session zantiflow-smoke --force`
