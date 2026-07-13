# Zellij Plugin API — Research Findings

Reference notes gathered while writing [ADR-0001](adrs/0001-zellij-session-telemetry-architecture.md)
and [ADR-0002](adrs/0002-configurable-telemetry-privacy-controls.md). Everything here was verified
against live sources — docs.rs `zellij-tile`, zellij.dev/documentation, and raw GitHub source
(`zellij-tile/src/{lib,shim}.rs`, `zellij-utils/src/data.rs`) — not from memory. Items that could not
be fully confirmed are marked **⚠ FLAG**.

> **Version note.** docs.rs "latest" resolved to **zellij-tile 0.44.3** (published 2026-05-13).
> Struct/enum facts are from that published version; function signatures were cross-checked against
> `main` (which may lead 0.44.3). The `Event`/`EventType`/`PermissionType` enums are
> `#[non_exhaustive]` and still evolving — **pin an exact `zellij-tile` version and re-verify field
> and enum names against that tag** before relying on them.

---

## 1. Plugin model basics

- Zellij plugins are **WASM modules**. The first-class, best-supported authoring path is **Rust +
  the `zellij-tile` crate**.
- A plugin implements the `ZellijPlugin` trait. The `register_plugin!` macro generates the
  `#[no_mangle] load()` FFI entry point that deserializes the protobuf config and calls your `load`.
- Lifecycle: `load(configuration)` → `update(event)` (returns whether to re-render) → `render(rows, cols)`.
- A plugin only receives events it has **subscribed** to via `subscribe(&[EventType])`.

Sources: [ZellijPlugin trait (docs.rs)](https://docs.rs/zellij-tile/latest/zellij_tile/trait.ZellijPlugin.html),
[lib.rs](https://raw.githubusercontent.com/zellij-org/zellij/main/zellij-tile/src/lib.rs)

---

## 2. Events that expose session/tab/pane structure

Subscribe with `subscribe(&[EventType])`; matching events arrive in `update`.

| Event | Payload | Scope |
| --- | --- | --- |
| `SessionUpdate` | `(Vec<SessionInfo>, Vec<(String, Duration)>)` | **All** sessions. First vec = live sessions; second vec = resurrectable (dead) session names + time since death. |
| `TabUpdate` | `Vec<TabInfo>` | Current session's tabs. |
| `PaneUpdate` | `PaneManifest` | Current session's panes. |
| `ModeUpdate` | `ModeInfo` | Current input mode, keybinds, theme, session name. |

**Key insight:** `SessionUpdate` is the richest single source — each `SessionInfo` already nests
`.tabs: Vec<TabInfo>` and `.panes: PaneManifest` and carries `is_current_session`, so the full
tab/pane tree for every live session comes from `SessionUpdate` alone. `TabUpdate`/`PaneUpdate` are
narrower (current session only) but fire on their respective changes.

Sources: [Event enum (docs.rs)](https://docs.rs/zellij-tile/latest/zellij_tile/prelude/enum.Event.html),
[Events (zellij.dev)](https://zellij.dev/documentation/plugin-api-events.html),
[data.rs](https://raw.githubusercontent.com/zellij-org/zellij/main/zellij-utils/src/data.rs)

---

## 3. Struct fields (data-model critical)

### `SessionInfo` — 12 fields

`name: String`, `tabs: Vec<TabInfo>`, `panes: PaneManifest`, `connected_clients: usize`,
`is_current_session: bool`, `available_layouts: Vec<LayoutInfo>`, `plugins: BTreeMap<u32, PluginInfo>`,
`web_clients_allowed: bool`, `web_client_count: usize`, `tab_history: BTreeMap<u16, Vec<usize>>`,
`pane_history: BTreeMap<u16, Vec<PaneId>>`, `creation_time: Duration`.

> No session **id** field — sessions are identified only by `name`. (This is why ADR-0002 introduces
> a synthetic stable `sid`.)

### `TabInfo` — 19 fields

`position: usize`, `name: String`, `active: bool`, `panes_to_hide: usize`,
`is_fullscreen_active: bool`, `is_sync_panes_active: bool`, `are_floating_panes_visible: bool`,
`other_focused_clients: Vec<u16>`, `active_swap_layout_name: Option<String>`,
`is_swap_layout_dirty: bool`, `viewport_rows: usize`, `viewport_columns: usize`,
`display_area_rows: usize`, `display_area_columns: usize`, `selectable_tiled_panes_count: usize`,
`selectable_floating_panes_count: usize`, `tab_id: usize`, **`has_bell_notification: bool`**,
**`is_flashing_bell: bool`**.

> The two bell fields are the *only* built-in activity-ish signal in the structural events (per-tab,
> fires on a `\a` BEL — see §6).

### `PaneManifest` — 1 field

`panes: HashMap<usize, Vec<PaneInfo>>` — maps **tab position → panes** in that tab (tiled, floating,
suppressed).

### `PaneInfo` — 25 fields

`id: u32`, `is_plugin: bool`, `is_focused: bool`, `is_fullscreen: bool`, `is_floating: bool`,
`is_suppressed: bool`, `title: String`, `exited: bool`, `exit_status: Option<i32>`, `is_held: bool`,
`pane_x: usize`, `pane_content_x: usize`, `pane_y: usize`, `pane_content_y: usize`,
`pane_rows: usize`, `pane_content_rows: usize`, `pane_columns: usize`, `pane_content_columns: usize`,
`cursor_coordinates_in_pane: Option<(usize, usize)>`, `terminal_command: Option<String>`,
`plugin_url: Option<String>`, `is_selectable: bool`, `index_in_pane_group: BTreeMap<u16, usize>`,
`default_fg: Option<String>`, `default_bg: Option<String>`.

### ⚠ Critical: `PaneInfo` has NO output-activity signal

Confirmed absence of any of the following:

- **No** "last updated" / output timestamp.
- **No** byte counts or lines-written counter.
- **No** dirty flag / "new stdout arrived" flag.
- **No** `is_active` field — only `is_focused`, which is selection/focus, **not** output activity.
- `title` can change (OSC title / `terminal_command`) and `cursor_coordinates_in_pane` moves as
  output arrives, but neither is a reliable "new output" signal.

The structs describe **layout and state**, never **output recency**. Any "when did this pane last
produce output" feature must be **derived** (see §6).

Sources: [SessionInfo](https://docs.rs/zellij-tile/latest/zellij_tile/prelude/struct.SessionInfo.html),
[TabInfo](https://docs.rs/zellij-tile/latest/zellij_tile/prelude/struct.TabInfo.html),
[PaneManifest](https://docs.rs/zellij-tile/latest/zellij_tile/prelude/struct.PaneManifest.html),
[PaneInfo](https://docs.rs/zellij-tile/latest/zellij_tile/prelude/struct.PaneInfo.html)

---

## 4. Cadence — `set_timeout` → `Timer`

- Signature: `pub fn set_timeout(secs: f64)`. After the delay, `update` is called with the `Timer(f64)`
  event, carrying the elapsed duration.
- **One-shot** — it does **not** repeat. Idiomatic once-per-second loop:
  1. `subscribe(&[EventType::Timer])` in `load`.
  2. Call `set_timeout(1.0)` once.
  3. On `Event::Timer(_)` in `update`, do the work, then call `set_timeout(1.0)` again to re-arm.

**Caveats:**
- Not a real-time clock — the delay is a *minimum*; it's serviced when the host next runs the plugin,
  so intervals can drift/coalesce under load. Don't assume exactly 1000 ms.
- Re-arming from the handler means handler time adds to the interval (period ≈ 1s + handler time).
- You **must** subscribe to `EventType::Timer` or the event is dropped.

Sources: [set_timeout (shim)](https://raw.githubusercontent.com/zellij-org/zellij/main/zellij-tile/src/shim.rs),
[Commands (zellij.dev)](https://zellij.dev/documentation/plugin-api-commands.html)

---

## 5. Web requests (outbound HTTP from a plugin)

```rust
pub fn web_request<S: AsRef<str>>(
    url: S,
    verb: HttpVerb,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
    context: BTreeMap<String, String>,
)
```

- **Returns `()`** — fire-and-forget / asynchronous. No inline response.
- `HttpVerb` variants: **`Get`, `Post`, `Put`, `Delete`** (four only — no Patch/Head/Options).
- **Response path:** subscribe to `EventType::WebRequestResult`, which delivers
  `WebRequestResult(u16, BTreeMap<String, String>, Vec<u8>, BTreeMap<String, String>)`
  = `(status_code, response_headers, response_body_bytes, context)`.
- **Correlation:** the `context` map you pass in is returned **verbatim** as the 4th element — tag
  requests with it since async responses can interleave.
- Requires the **`WebAccess`** permission. ⚠ Also depends on Zellij being built/allowed with web
  access in the target environment — verify and define a fallback if denied.

Sources: [web_request (shim)](https://raw.githubusercontent.com/zellij-org/zellij/main/zellij-tile/src/shim.rs),
[HttpVerb](https://docs.rs/zellij-tile/latest/zellij_tile/prelude/enum.HttpVerb.html),
[Commands](https://zellij.dev/documentation/plugin-api-commands.html)

---

## 6. Detecting new stdout in a pane (the hard problem)

**There is NO push event for "a pane produced new stdout"** — no byte-count/lines-written event, no
per-pane dirty/activity event. `dump_screen` is a Zellij *keybinding action*, **not** a plugin API
function (not in the shim), so a plugin cannot call it. Realistic options, roughly by practicality:

- **Option A — poll scrollback and diff (most viable).**
  `get_pane_scrollback(pane_id: PaneId, get_full_scrollback: bool) -> Result<PaneContents, String>`
  exists in the shim. Each tick, pull each pane's content, hash/diff vs the previous snapshot, treat
  "changed" as activity. Requires **`ReadPaneContents`**.
  *Limits:* O(panes) reads per tick; detects *change*, not exact new bytes; content that scrolls past
  within a tick can be missed; a repainting TUI (e.g. `htop`) looks perpetually "active"; ANSI/cursor
  repaints inflate change. Cost scales with pane count × scrollback at a 1s cadence.

- **Option B — `PaneRenderReport` / `PaneRenderReportWithAnsi` events.**
  Present in the 0.44.3 `EventType` enum, carrying `HashMap<PaneId, PaneContents>` (ANSI stripped vs
  preserved) — closer to live monitoring. **RESOLVED (see §15):** the opt-in mechanism is just plain
  `subscribe(&[EventType::PaneRenderReportWithAnsi])` — no per-pane selection, no separate permission
  beyond `ReadPaneContents`; the server pushes **changed** panes only. This is the sole way for a plugin
  to obtain **coloured** pane content (Option A's `get_pane_scrollback` is ANSI-stripped), and it's what
  the pane-output channel uses. Interpretation caveat still holds (rendered-frame change ≠ new logical
  output), which is why the general activity signal stays on Option A's fingerprint.

- **Option C — command panes only.** If the plugin *launches* the panes as command panes, it gets
  lifecycle events: `CommandPaneOpened`, `CommandPaneExited`, `CommandPaneReRun`, plus
  `RunCommandResult(exit_code, stdout, stderr, context)`. Gives real stdout, but only for
  whole-command completion of commands *you* ran — not arbitrary interactive panes, not incremental.
  Requires `RunCommands`.

- **Option D — bell as a coarse proxy.** `TabInfo.has_bell_notification` / `is_flashing_bell` flag a
  BEL (`\a`) from a program in that tab. Per-*tab*, only on BEL — a weak supplementary signal.

**Bottom line:** Zellij's plugin API is built around **structure/state**, not **output telemetry**.
Any per-second "did this pane get new output" must be built on **polling + diffing** (Option A), which
is approximate, can't report true byte counts, and gets expensive with many panes.

Sources: [shim.rs](https://raw.githubusercontent.com/zellij-org/zellij/main/zellij-tile/src/shim.rs),
[EventType (docs.rs)](https://docs.rs/zellij-tile/latest/zellij_tile/prelude/enum.EventType.html)

---

## 7. Permissions

`request_permission(permissions: &[PermissionType])` — call in `load()`. It prompts the user once
(persisted per plugin). The outcome arrives asynchronously as
`Event::PermissionRequestResult(PermissionStatus)` (subscribe to
`EventType::PermissionRequestResult`). Gate real logic behind the granted result; request everything
needed in a single call.

**Full `PermissionType` enum (17 variants):** `ReadApplicationState`, `ChangeApplicationState`,
`OpenFiles`, `RunCommands`, `OpenTerminalsOrPlugins`, `WriteToStdin`, `WebAccess`, `ReadCliPipes`,
`MessageAndLaunchOtherPlugins`, `Reconfigure`, `FullHdAccess`, `StartWebServer`, `InterceptInput`,
`ReadPaneContents`, `RunActionsAsUser`, `WriteToClipboard`, `ReadSessionEnvironmentVariables`.

Relevant here:

| Need | Permission |
| --- | --- |
| Session/Tab/Pane/Mode updates (read app state) | `ReadApplicationState` |
| Outbound HTTP (`web_request`) | `WebAccess` |
| Read pane scrollback / render reports | `ReadPaneContents` |
| Run host commands (`run_command`, e.g. `hostname`) | `RunCommands` |
| Read session env vars | `ReadSessionEnvironmentVariables` |
| Remap `/host` mount to elsewhere on disk | `FullHdAccess` |

> ⚠ Naming gotcha: the permissions **doc page** labels it "RunCommand" (singular) but the actual enum
> variant is **`RunCommands`** (plural). Use the enum name in code.
>
> `Reconfigure` is **not** about receiving your own plugin config — it gates the `reconfigure(new_config, save)`
> call that changes the **entire Zellij configuration** (running + optionally the on-disk file). Not
> needed to consume plugin config (see §9).
>
> Receiving `PluginConfigurationChanged` needs **no** permission.

Sources: [PermissionType](https://docs.rs/zellij-tile/latest/zellij_tile/prelude/enum.PermissionType.html),
[Permissions (zellij.dev)](https://zellij.dev/documentation/plugin-api-permissions.html)

---

## 8. Plugin configuration delivery

- **`load` signature (confirmed):**
  ```rust
  fn load(&mut self, configuration: BTreeMap<String, String>) {}
  ```
  Provided (default no-op) trait method; the parameter is named `configuration`; type is exactly
  `BTreeMap<String, String>`.
- **Layout (KDL):** custom key/value config goes in the `plugin` node's child braces. Keys are
  arbitrary bare identifiers; values are arbitrary strings (KDL literals like `1` are coerced to
  strings, since the map is `<String, String>`):
  ```kdl
  pane {
      plugin location="file:/path/to/plugin.wasm" {
          some_key   "some_value"
          another_key 1
      }
  }
  ```
- **CLI / action:** `--configuration` (`-c`) with comma-separated `key=value` pairs:
  ```bash
  zellij action launch-or-focus-plugin --configuration "some_key=some_value,another_key=1"
  ```
  Also settable from a keybinding's `LaunchOrFocusPlugin`/`LaunchPlugin` action, and the top-level
  `zellij plugin` subcommand accepts configuration.
- ⚠ **FLAG:** a pipe-specific runtime config flag on `zellij pipe` was **not** confirmed; treat
  "config via pipe" as launch-time only. Confirmed channels: layout, `zellij action … --configuration`,
  keybindings, `zellij plugin`.

Prior art: **zjstatus** configures a whole status bar through arbitrary string `load` keys — the
canonical example.

Sources: [Plugin configuration](https://zellij.dev/documentation/plugin-api-configuration.html),
[Creating a layout](https://zellij.dev/documentation/creating-a-layout.html),
[CLI actions](https://zellij.dev/documentation/cli-actions),
[lib.rs](https://raw.githubusercontent.com/zellij-org/zellij/main/zellij-tile/src/lib.rs),
[zjstatus](https://github.com/dj95/zjstatus)

---

## 9. Runtime reconfiguration

- **Config-updated event (confirmed):** `Event::PluginConfigurationChanged(BTreeMap<String, String>)`
  is delivered to a running plugin's `update`. Subscribe and re-apply on receipt — this is the
  mechanism for settings that take effect **without a restart**. **No permission required.**
- ⚠ **FLAG:** the precise trigger conditions (re-launch/focus with a new config map vs a global config
  reload) are only partially documented. Payload type confirmed; verify the actual trigger on your
  pinned version. Fallback: restart the plugin.
- `Reconfigure` permission gates `reconfigure(new_config: String, save_configuration_file: bool)` —
  changes the **whole Zellij config**, not your plugin settings. Keep the two concepts separate.

Sources: [data.rs (Event enum)](https://raw.githubusercontent.com/zellij-org/zellij/main/zellij-utils/src/data.rs),
[Events](https://zellij.dev/documentation/plugin-api-events.html),
[Permissions](https://zellij.dev/documentation/plugin-api-permissions.html)

---

## 10. Getting the host machine name (hostname)

Zellij exposes the machine hostname **nowhere** — not in `SessionInfo`, not in `ModeInfo` (closest
fields: `ModeInfo.session_name` = the Zellij session, and `web_server_ip` = an IP, neither is the
host name). Options investigated:

| Path | Verdict |
| --- | --- |
| (a) Env vars — `std::env::var("HOSTNAME")`, or `get_session_environment_variables()` (needs `ReadSessionEnvironmentVariables`) | **Unreliable.** `get_session_environment_variables()` returns the *session's* env, not an arbitrary host lookup. `HOSTNAME` is often a non-exported shell var and frequently absent. WASI sandbox env is not populated with the host env by default. ⚠ environment-dependent. |
| (b) Read `/etc/hostname` via WASI filesystem | **Gated/heavy.** Default sandbox mounts only `/host`, `/data`, `/cache`, `/tmp`; `/etc/hostname` is outside them. `FullHdAccess` can remap `/host` to `/` (then read `/host/etc/hostname`) — extra permission + runtime remap, Linux-centric. |
| (c) `run_command(&["hostname"], ctx)` + `Event::RunCommandResult`, needs `RunCommands` | **Recommended.** A few lines + one permission prompt, cross-platform, returns the true host name regardless of shell env. |
| (d) Any built-in Event/struct | **None.** |

**Verdict:** the simplest reliable way is **option (c)** — `run_command(&["hostname"], context)`,
subscribe to `Event::RunCommandResult(Option<i32>, Vec<u8> /*stdout*/, Vec<u8> /*stderr*/, BTreeMap<String,String> /*context*/)`,
match your `context` marker, parse stdout. Gated by **`RunCommands`**. (Alternatives: `["uname","-n"]`,
`["cat","/etc/hostname"]`.)

Sources: [shim (run_command)](https://docs.rs/zellij-tile/latest/zellij_tile/shim/index.html),
[data.rs](https://raw.githubusercontent.com/zellij-org/zellij/main/zellij-utils/src/data.rs),
[get_session_environment_variables](https://docs.rs/zellij-tile/latest/zellij_tile/shim/fn.get_session_environment_variables.html),
[Filesystem](https://zellij.dev/documentation/plugin-api-file-system.html),
[Permissions](https://zellij.dev/documentation/plugin-api-permissions.html),
[FullHdAccess (0.42 news)](https://zellij.dev/news/stacked-resize-pinned-panes/)

---

## 11. Useful synchronous getters (no event round-trip)

`get_pane_info`, `get_focused_pane_info`, `get_tab_info`, `get_session_list`,
`get_pane_running_command`, `get_pane_cwd`, `get_pane_pid`, `get_session_environment_variables`
(permissioned), `get_pane_scrollback` (permissioned).

⚠ **FLAG:** `get_pane_scrollback` shows `-> Result<PaneContents, String>` (synchronous) on `main`;
confirm it exists and is synchronous on your pinned 0.44.x tag (some content APIs historically
returned via events). Confirm its exact permission (almost certainly `ReadPaneContents`).

Source: [shim module index](https://docs.rs/zellij-tile/latest/zellij_tile/shim/index.html)

---

## 12. Plugin filesystem sandbox

By default a plugin's WASI sandbox mounts only:

- `/host` — the last-focused pane's cwd / Zellij's start dir
- `/data` — plugin's own persistent data dir
- `/cache` — plugin's cache dir
- `/tmp`

Reaching outside these (e.g. `/etc/hostname`) requires `FullHdAccess` + a runtime `/host` remap
(introduced with the wasmtime migration, Zellij 0.42). `/data` and `/cache` are the places to persist
plugin state (e.g. a salt for a stable pseudonymous id).

Source: [Filesystem](https://zellij.dev/documentation/plugin-api-file-system.html),
[0.42 news](https://zellij.dev/news/stacked-resize-pinned-panes/)

---

## 13. Prior art (config-driven plugins)

- **zjstatus** (dj95) — status bar configured almost entirely through `load` KDL key/values; the
  canonical arbitrary-string-config example. https://github.com/dj95/zjstatus
- **zellij-forgot** (karimould) — keybind cheatsheet plugin that reads plugin config for behaviour.
  https://github.com/karimould/zellij-forgot

---

## 14. Open / unverified items to re-check against a pinned version

1. `PaneRenderReport` / `PaneRenderReportWithAnsi` opt-in mechanism, delivery frequency, and
   permission — variants exist, subscription model not found in the shim.
2. `get_pane_scrollback` existence/return-semantics (sync vs event) and exact permission on the pinned
   0.44.x tag.
3. Exact trigger conditions for `Event::PluginConfigurationChanged` (payload confirmed; triggers not).
4. Whether `HOSTNAME` specifically appears in `get_session_environment_variables()` or the plugin's
   WASI env — environment-dependent; do not depend on it.
5. A dedicated pipe-time `--configuration` flag on `zellij pipe` — not confirmed.
6. Function signatures read from `main` may lead 0.44.3 — cross-check the exact tag you depend on.

---

## 15. Verified against the pinned `zellij-tile 0.44.3` (Phase 3b)

The plugin (`apps/plugin`) compiles against the exact pinned tag `zellij-tile = "0.44.3"` for
`wasm32-wasip1`, which statically confirms every FFI name/type used. Resolutions of earlier ⚠ FLAGs:

- **`get_pane_scrollback` (§11/§14.2) — CONFIRMED synchronous:**
  `pub fn get_pane_scrollback(pane_id: PaneId, get_full_scrollback: bool) -> Result<PaneContents, String>`.
  `PaneContents { lines_above_viewport: Vec<String>, lines_below_viewport: Vec<String>, viewport:
  Vec<String>, selected_text: Option<SelectedText> }`. The plugin fingerprints `viewport.join("\n")`
  with `get_full_scrollback = false`. `PaneId::Terminal(u32) | Plugin(u32)`.
- **`get_pane_scrollback` STRIPS ANSI — colour only via `PaneRenderReportWithAnsi` (§6 Option B, now
  RESOLVED).** Server-side (`zellij-server` v0.44.3), `GetPaneScrollback` → `pane.pane_contents()` →
  `grid.pane_contents()`, which builds each line as `row.columns.map(|c| c.character).collect()` —
  **character only, no styles**. Its sibling `grid.pane_contents_with_ansi()` (writes `tc.styles` +
  `\u{1b}[m`) is never called by `get_pane_scrollback`, so scrollback is always plain text. The **only**
  plugin-reachable ANSI is the `Event::PaneRenderReportWithAnsi(HashMap<PaneId, PaneContents>)` event
  (`EventType` is `strum_discriminants` of `Event`, so `EventType::PaneRenderReportWithAnsi` is
  subscribable via plain `subscribe`). Subscribing flips the server's `PluginSubscribedToAnsiPaneContents`
  on; it then pushes an ANSI-preserving `viewport` for each pane **as it renders** (changed panes only —
  idle panes aren't re-sent). There is **no** `SubscribeToPaneRenders` plugin command / shim in 0.44.3;
  plain `subscribe`/`unsubscribe` is the whole API. The pane-output channel (ADR-0016) caches these
  frames per pane (`output::OutputCache`) and falls back to plain `get_pane_scrollback` for
  not-yet-rendered panes.
- **Event shapes (compiled) —** `SessionUpdate(Vec<SessionInfo>, Vec<(String, Duration)>)`,
  `Timer(f64)`, `PermissionRequestResult(PermissionStatus{Granted|Denied})`,
  `RunCommandResult(Option<i32>, Vec<u8>, Vec<u8>, BTreeMap<String,String>)`,
  `WebRequestResult(u16, …, Vec<u8>, BTreeMap<String,String>)`,
  `PluginConfigurationChanged(BTreeMap<String,String>)`.
- **`web_request(url, HttpVerb, BTreeMap headers, Vec<u8> body, BTreeMap context)`**; `HttpVerb::Post`.
- **`register_plugin!`** + `ZellijPlugin: Default` (`load`/`update`/`pipe`/`render`); `request_permission`,
  `subscribe`, `run_command(&["hostname"], ctx)`, `set_timeout(f64)` — all as documented above.
- **Runtime** behaviors (actual permission-grant flow, `web_request` egress, `PluginConfigurationChanged`
  trigger, `/data`·`/cache` writability) require the real-Zellij smoke check — a **throwaway session
  only** — per `apps/plugin/README.md`.

## Primary sources

- Events — https://zellij.dev/documentation/plugin-api-events.html
- Commands — https://zellij.dev/documentation/plugin-api-commands.html
- Permissions — https://zellij.dev/documentation/plugin-api-permissions.html
- Configuration — https://zellij.dev/documentation/plugin-api-configuration.html
- Filesystem — https://zellij.dev/documentation/plugin-api-file-system.html
- Type reference — https://zellij.dev/documentation/plugin-api-types.html
- `Event` enum — https://docs.rs/zellij-tile/latest/zellij_tile/prelude/enum.Event.html
- `EventType` enum — https://docs.rs/zellij-tile/latest/zellij_tile/prelude/enum.EventType.html
- `PermissionType` — https://docs.rs/zellij-tile/latest/zellij_tile/prelude/enum.PermissionType.html
- `HttpVerb` — https://docs.rs/zellij-tile/latest/zellij_tile/prelude/enum.HttpVerb.html
- `ZellijPlugin` trait — https://docs.rs/zellij-tile/latest/zellij_tile/trait.ZellijPlugin.html
- Struct pages — https://docs.rs/zellij-tile/latest/zellij_tile/prelude/
- shim module index — https://docs.rs/zellij-tile/latest/zellij_tile/shim/index.html
- `zellij-tile` lib.rs — https://raw.githubusercontent.com/zellij-org/zellij/main/zellij-tile/src/lib.rs
- `zellij-tile` shim.rs — https://raw.githubusercontent.com/zellij-org/zellij/main/zellij-tile/src/shim.rs
- `zellij-utils` data.rs — https://raw.githubusercontent.com/zellij-org/zellij/main/zellij-utils/src/data.rs
