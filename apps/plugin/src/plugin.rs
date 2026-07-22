//! The WASM FFI adapter: the ONLY module that touches `zellij-tile`. It implements `HostPort` with
//! the real shim functions and drives the `ZellijPlugin` lifecycle. All decision logic lives in the
//! pure modules (config/privacy/snapshot/fingerprint/net) — this file just wires Zellij's events and
//! commands to them. Verified against the pinned zellij-tile 0.44.3 by `cargo build --target wasm32-wasip1`.
use std::collections::BTreeMap;
use std::time::Duration;

use zellij_tile::prelude::*;

use crate::config::{parse_config, PluginConfig};
use crate::fingerprint;
use crate::host::{HostPort, ObservedPane, ObservedSession, ObservedTab};
use crate::model::AttentionState;
use crate::scrub::Scrubber;
use crate::{cadence, control, debuglog, net, output, pairing, snapshot};

const TICK_SECS: f64 = 1.0;
const HOSTNAME_CTX: &str = "zantiflow_hostname";
const CONTROL_CTX: &str = "zantiflow_control"; // the always-on ~5 s control poll (ADR-0026)
const OUTPUT_DELIVER_CTX: &str = "zantiflow_output_deliver";
const PAIR_START_CTX: &str = "zantiflow_pair_start";
const PAIR_POLL_CTX: &str = "zantiflow_pair_poll";
const PAIR_RETRY_TICKS: u64 = 5; // retry a failed /pair/start ~every 5 s

// Wire struct for delivering captured pane output (the backend validates with the full schema). The
// full sessionSid/tabId/paneId identity is echoed from the request so the backend stores it under the
// SAME composite key the owner reads — never colliding with a same-numbered pane elsewhere.
#[derive(serde::Serialize)]
struct OutputDeliveryWire {
    #[serde(rename = "machineId")]
    machine_id: String,
    #[serde(rename = "sessionSid")]
    session_sid: String,
    #[serde(rename = "tabId")]
    tab_id: usize,
    #[serde(rename = "paneId")]
    pane_id: u32,
    lines: Vec<String>,
    #[serde(rename = "capturedAt")]
    captured_at: String,
}

/// The real host: caches the latest observed sessions + hostname; everything else is a live FFI call.
#[derive(Default)]
struct WasmHost {
    live: Vec<ObservedSession>,
    dead: Vec<crate::host::DeadSession>,
    hostname: Option<String>,
}

fn read_file(dir: &str, key: &str) -> Option<String> {
    std::fs::read_to_string(format!("{dir}/{key}")).ok()
}
fn write_file(dir: &str, key: &str, value: &str) {
    let _ = std::fs::write(format!("{dir}/{key}"), value);
}

impl HostPort for WasmHost {
    fn live_sessions(&self) -> Vec<ObservedSession> {
        self.live.clone()
    }
    fn dead_sessions(&self) -> Vec<crate::host::DeadSession> {
        self.dead.clone()
    }
    fn pane_scrollback(&self, pane_id: u32) -> Option<String> {
        // Synchronous on 0.44.3 (FINDINGS §11 confirmed). Only the visible viewport is needed for
        // change-detection, so `get_full_scrollback = false` keeps it cheap.
        match get_pane_scrollback(PaneId::Terminal(pane_id), false) {
            Ok(contents) => Some(contents.viewport.join("\n")),
            Err(_) => None,
        }
    }
    fn hostname(&self) -> Option<String> {
        self.hostname.clone()
    }
    fn read_data(&self, key: &str) -> Option<String> {
        read_file("/data", key)
    }
    fn write_data(&mut self, key: &str, value: &str) {
        write_file("/data", key, value);
    }
    fn read_cache(&self, key: &str) -> Option<String> {
        read_file("/cache", key)
    }
    fn write_cache(&mut self, key: &str, value: &str) {
        write_file("/cache", key, value);
    }
    fn http_post(
        &mut self,
        url: &str,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
        context: Vec<(String, String)>,
    ) {
        web_request(
            url.to_string(),
            HttpVerb::Post,
            headers.into_iter().collect::<BTreeMap<_, _>>(),
            body,
            context.into_iter().collect::<BTreeMap<_, _>>(),
        );
    }
    fn http_get(
        &mut self,
        url: &str,
        headers: Vec<(String, String)>,
        context: Vec<(String, String)>,
    ) {
        web_request(
            url.to_string(),
            HttpVerb::Get,
            headers.into_iter().collect::<BTreeMap<_, _>>(),
            vec![],
            context.into_iter().collect::<BTreeMap<_, _>>(),
        );
    }
    fn set_timeout(&mut self, secs: f64) {
        set_timeout(secs);
    }
    fn random_id(&self) -> String {
        let mut buf = [0u8; 16];
        // WASI CSRNG; if it ever fails, fall back to a fixed marker so we still produce a stable id.
        if getrandom::fill(&mut buf).is_err() {
            return "rng-unavailable".to_string();
        }
        buf.iter().map(|b| format!("{b:02x}")).collect()
    }
    fn log(&self, msg: &str) {
        eprintln!("[zantiflow] {msg}");
    }
}

/// Device-pairing UI/driver state (ADR-0012). Only active when the plugin starts without a token
/// (in config or persisted in `/data`). Holds what `render()` shows and what `pairing_tick()` drives.
#[derive(Default)]
struct PairingUi {
    /// True from load until a token is obtained; false in normal telemetry mode.
    active: bool,
    /// Whether a `/pair/start` is in flight or succeeded (so the tick loop doesn't double-start).
    started: bool,
    /// Terminal: token minted, or gave up (denied/cap/unknown) — stop polling.
    done: bool,
    session_id: Option<String>,
    user_code: Option<String>,
    verification_uri: Option<String>,
    /// Human-readable one-liner shown under the code.
    status: String,
}

#[derive(Default)]
pub struct ZantiflowPlugin {
    host: WasmHost,
    config: Option<PluginConfig>,
    machine_id: String,
    salt: String,
    /// capturedAtTick — a monotonic counter incremented once per SENT snapshot (ADR-0026).
    tick: u64,
    /// Wall-clock tick, incremented every `Timer` regardless of whether we send; paces the control
    /// poll and the send-coalesce floors (ADR-0026).
    wall_tick: u64,
    /// Change-driven, presence-aware send-decision state (ADR-0026).
    send_gate: cadence::SendGate,
    /// Highest control-channel refresh sequence seen; a bump forces one snapshot (manual refresh).
    last_refresh_seq: u64,
    /// Long-poll bookkeeping (ADR-0029). `control_inflight` = a control POST is outstanding;
    /// `control_issued_wall` = the wall-tick it was issued. Only consulted when `control_long_poll` is
    /// on — in fixed-poll mode they are set/cleared but the 5-tick schedule ignores them.
    control_inflight: bool,
    control_issued_wall: u64,
    /// Base telemetry permissions (ReadApplicationState / WebAccess / ReadPaneContents) granted.
    permissions_granted: bool,
    /// The optional `RunCommands` permission (ADR-0024) is requested lazily — only when the opt-in
    /// real-hostname feature is enabled — so alias/hidden users are never prompted for it. These two
    /// flags track that separate request so a RunCommands denial never disables core telemetry.
    run_commands_requested: bool,
    run_commands_granted: bool,
    pairing: PairingUi,
    /// Ticks since pairing began; paces `/pair/poll` (and start retries) off the 1 s timer.
    pair_ticks: u64,
    /// Poll cadence in ticks (≈ the backend-provided interval); ≥1.
    pair_poll_ticks: u64,
    /// Latest ANSI viewport per pane, fed by `PaneRenderReportWithAnsi` (ADR-0016/0017). This is the
    /// ONLY source of colour: `get_pane_scrollback` returns ANSI-stripped text (verified vs 0.44.3).
    output_cache: output::OutputCache,
    /// Whether we're currently subscribed to `PaneRenderReportWithAnsi` — mirrors `pane_output`, kept
    /// in sync by `sync_output_subscription` so idle/off users don't pay for continuous render pushes.
    output_subscribed: bool,
    /// The sid of THIS instance's own (current) Zellij session, refreshed each snapshot. `get_pane_scrollback`
    /// only reads our own session, so we deliver pane output for panes bearing this sid and leave the
    /// rest to the peer plugin instances that own them (ADR-0016). `None` until the first snapshot.
    own_sid: Option<String>,
    /// Cross-tick per-pane content-freshness (ADR-0025 fix): lets `claude.thinking` require a pane to
    /// be still producing output, so a spinner glyph Claude Code freezes on a finished pane clears.
    pane_activity: crate::activity::PaneActivity,
    /// Transition differ for the opt-in `debug` log lines (ADR-0049). Only fed while `debug` is on,
    /// so enabling it mid-run dumps the then-current state as an initial burst (by design).
    debug_state: debuglog::DebugState,
}

fn to_observed(sessions: Vec<SessionInfo>) -> Vec<ObservedSession> {
    sessions
        .into_iter()
        .map(|s| {
            let manifest = s.panes.panes.clone(); // HashMap<tab_position, Vec<PaneInfo>>
            let name = s.name;
            let is_current = s.is_current_session;
            let connected_clients = s.connected_clients;
            let tabs = s
                .tabs
                .into_iter()
                .map(|t| {
                    let panes = manifest
                        .get(&t.position)
                        .cloned()
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|p| !p.is_plugin) // skip plugin panes (incl. our own)
                        .map(|p| ObservedPane {
                            id: p.id,
                            title: p.title,
                            command: p.terminal_command,
                            is_focused: p.is_focused,
                            exited: p.exited,
                        })
                        .collect();
                    ObservedTab {
                        tab_id: t.tab_id,
                        name: t.name,
                        position: t.position,
                        active: t.active,
                        panes,
                    }
                })
                .collect();
            ObservedSession {
                name,
                is_current,
                connected_clients,
                tabs,
            }
        })
        .collect()
}

impl ZantiflowPlugin {
    /// Have we got an effective ingest token yet (from config or a completed pairing)?
    fn has_token(&self) -> bool {
        self.config
            .as_ref()
            .and_then(|c| c.token.as_ref())
            .is_some_and(|t| !t.is_empty())
    }

    /// Kick off `/pair/start` (once WebAccess is granted). Labels the token with the machine alias.
    fn start_pairing(&mut self) {
        let Some(config) = &self.config else { return };
        self.pairing.started = true;
        self.pairing.status = "Requesting a pairing code…".into();
        let req = pairing::build_start_request(&config.server_url, config.machine_alias.as_deref());
        self.host.http_post(
            &req.url,
            req.headers,
            req.body,
            vec![("kind".into(), PAIR_START_CTX.into())],
        );
    }

    /// Poll `/pair/poll` for the current session.
    fn poll_pairing(&mut self) {
        let (Some(config), Some(sid)) = (&self.config, self.pairing.session_id.clone()) else {
            return;
        };
        let req = pairing::build_poll_request(&config.server_url, &sid);
        self.host.http_post(
            &req.url,
            req.headers,
            req.body,
            vec![("kind".into(), PAIR_POLL_CTX.into())],
        );
    }

    /// One pairing timer tick: (re)start `/pair/start`, or poll at the negotiated cadence.
    fn pairing_tick(&mut self) {
        if !self.permissions_granted || self.pairing.done {
            return;
        }
        self.pair_ticks += 1;
        if self.pairing.session_id.is_none() {
            // Not started, or a start failed — (re)try, but not more than ~every 5 s.
            if !self.pairing.started && self.pair_ticks.is_multiple_of(PAIR_RETRY_TICKS) {
                self.start_pairing();
            }
        } else if self.pair_ticks.is_multiple_of(self.pair_poll_ticks.max(1)) {
            self.poll_pairing();
        }
    }

    /// Handle the `/pair/start` response: store the code + cadence, or arm a retry.
    fn on_pair_start(&mut self, status: u16, body: &[u8]) {
        match pairing::parse_start_response(status, body) {
            Some(s) => {
                self.pair_poll_ticks = (s.interval_secs.round() as u64).max(1);
                self.pair_ticks = 0;
                self.pairing.session_id = Some(s.session_id);
                self.pairing.user_code = Some(s.user_code);
                self.pairing.verification_uri = Some(s.verification_uri);
                self.pairing.status = "Waiting for approval on the website…".into();
            }
            None => {
                self.pairing.started = false; // allow pairing_tick to retry
                self.pairing.status =
                    format!("Couldn't start pairing (status {status}); retrying…");
            }
        }
    }

    /// Handle a `/pair/poll` response: finish, keep waiting, refresh an expired code, or fail.
    fn on_pair_poll(&mut self, status: u16, body: &[u8]) {
        match pairing::parse_poll_response(status, body) {
            pairing::PollOutcome::Pending { interval_secs } => {
                self.pair_poll_ticks = (interval_secs.round() as u64).max(1);
                self.pairing.status = "Waiting for approval on the website…".into();
            }
            pairing::PollOutcome::Approved { token } => {
                // Persist for future launches (in /cache, shared across the host's sessions), then
                // switch to telemetry mode immediately.
                self.host.write_cache(pairing::TOKEN_CACHE_KEY, &token);
                if let Some(config) = self.config.as_mut() {
                    config.token = Some(token);
                }
                self.pairing.active = false;
                self.pairing.done = true;
                self.pairing.status = "Paired! Reporting telemetry.".into();
                self.host
                    .log("device paired — ingest token stored in /cache (shared across sessions)");
            }
            pairing::PollOutcome::Expired => {
                // Get a fresh code: clear the session so pairing_tick restarts /pair/start.
                self.pairing.session_id = None;
                self.pairing.user_code = None;
                self.pairing.started = false;
                self.pair_ticks = 0;
                self.pairing.status = "Code expired — requesting a new one…".into();
            }
            pairing::PollOutcome::Denied => self.fail_pairing("Pairing was denied."),
            pairing::PollOutcome::CapReached => self
                .fail_pairing("Token limit reached (max 10). Revoke one, then reload the plugin."),
            pairing::PollOutcome::Done => {
                self.fail_pairing("Pairing ended. Reload the plugin to try again.")
            }
        }
    }

    fn fail_pairing(&mut self, msg: &str) {
        self.pairing.done = true;
        self.pairing.status = msg.to_string();
        self.host.log(msg);
    }

    /// Drive the opt-in real-hostname capability (ADR-0024). Called after a permission grant and on
    /// live config changes. The first time the feature is wanted (with base perms in hand) it
    /// requests `RunCommands`; once that's granted it runs the `hostname` command. A no-op when the
    /// feature is off — so alias/hidden users are never prompted for `RunCommands`.
    fn ensure_hostname_capability(&mut self) {
        let wants = self.config.as_ref().is_some_and(|c| c.wants_hostname());
        if !wants || !self.permissions_granted {
            return;
        }
        if self.run_commands_granted {
            if self.host.hostname.is_none() {
                self.fetch_hostname();
            }
        } else if !self.run_commands_requested {
            request_permission(&[PermissionType::RunCommands]);
            self.run_commands_requested = true;
            self.host
                .log("requesting the RunCommands permission to read the hostname (hostname=on)");
        }
    }

    /// Fire `run_command(["hostname"])`; the result lands asynchronously in `RunCommandResult`.
    fn fetch_hostname(&mut self) {
        let mut ctx = BTreeMap::new();
        ctx.insert("cmd".to_string(), HOSTNAME_CTX.to_string());
        run_command(&["hostname"], ctx);
    }

    /// One telemetry tick (ADR-0026): sample locally every ~1 s, poll the control channel every ~5 s,
    /// and POST a snapshot ONLY when the change-driven / presence-aware gate says so.
    fn telemetry_tick(&mut self) {
        let Some(config) = self.config.clone() else {
            return;
        };
        // Resolve the host-wide machineId once (shared across sessions via /cache, hostname-derived
        // when available). Deferred to here so the async hostname (RunCommandResult) is folded in.
        if self.machine_id.is_empty() {
            self.machine_id = fingerprint::get_or_create_machine_id(&mut self.host, &self.salt);
        }
        // Local sampling stays ~1 s: building the snapshot reads each pane's scrollback (the activity
        // fingerprint) and scans for attentions. Only the SEND below is conditional. The wall-tick +
        // freshness tracker let the thinking detector tell a live turn from a frozen spinner glyph.
        let built = snapshot::build_snapshot_observed(
            &self.host,
            &config,
            &self.machine_id,
            &self.salt,
            self.tick,
            self.wall_tick,
            &mut self.pane_activity,
        );
        let mut snap = built.snap;

        // Opt-in debug logging (ADR-0049): transition-only lines — attention onsets/clears and the
        // claude activity picture across sessions. An unchanged tick emits nothing.
        if config.debug {
            for line in self.debug_state.tick_lines(&snap.attentions, &built.panes) {
                self.host.log(&line);
            }
        }

        // Remember which sid is our own session — the only one whose panes we can capture. Drives the
        // per-instance filter in `deliver_pending` so each session's plugin serves only its own panes.
        self.own_sid = snap
            .sessions
            .iter()
            .find(|s| s.is_current)
            .map(|s| s.sid.clone());

        // Cheap always-on control poll, REGARDLESS of pane_output: liveness touch + presence +
        // pending output + refresh. Its response drives how live we are (watched vs unwatched).
        let live_sids: Vec<String> = snap.sessions.iter().map(|s| s.sid.clone()).collect();
        self.maybe_poll_control(&config, &live_sids);

        // Change-driven, presence-aware send decision (ADR-0026). All emitted attentions are active.
        let sig = snapshot::change_signature(&snap);
        let attention_active = snap
            .attentions
            .iter()
            .any(|a| matches!(a.state, AttentionState::Active));
        let tick = cadence::Tick {
            wall_tick: self.wall_tick,
            salient: sig.salient,
            structural: sig.structural,
            attention_active,
        };
        if let Some(reason) = self.send_gate.decide_reason(&tick) {
            self.tick += 1;
            snap.captured_at_tick = self.tick;
            if let Some(req) = net::build_ingest_request(&config, &snap) {
                // One line per ACTUAL POST: why it fired + what the wire contains (ADR-0049),
                // followed by the per-pane title audit lines (ADR-0052) showing what the claude
                // detector saw this tick.
                if config.debug {
                    self.host.log(&debuglog::ingest_line(
                        self.tick,
                        reason,
                        &snap,
                        req.body.len(),
                    ));
                    for line in debuglog::pane_title_lines(&built.panes) {
                        self.host.log(&line);
                    }
                }
                self.host.http_post(
                    &req.url,
                    req.headers,
                    req.body,
                    vec![("kind".into(), "ingest".into())],
                );
            }
            self.send_gate.record_sent(&tick);
        }
    }

    /// Keep the `PaneRenderReportWithAnsi` subscription in step with the `pane_output` flag. Colour
    /// can ONLY be captured via these change-driven render reports (`get_pane_scrollback` strips ANSI
    /// server-side), so we subscribe when sharing is ON and unsubscribe — dropping the cache — when
    /// it's OFF, so panes are never streamed to us while the feature is disabled. Idempotent.
    fn sync_output_subscription(&mut self) {
        let want = self.config.as_ref().is_some_and(|c| c.pane_output);
        if want && !self.output_subscribed {
            subscribe(&[EventType::PaneRenderReportWithAnsi]);
            self.output_subscribed = true;
            self.host
                .log("pane_output ON — capturing coloured pane renders (ANSI)");
        } else if !want && self.output_subscribed {
            unsubscribe(&[EventType::PaneRenderReportWithAnsi]);
            self.output_subscribed = false;
            self.output_cache.clear();
        }
    }

    /// Issue a control poll if one is due (ADR-0026/0029). In the default fixed-poll mode this fires
    /// every ~5 s exactly as before. In long-poll mode it keeps a single request outstanding, asking
    /// the backend to hold it (`LONG_POLL_WAIT_MS`) so pending output / refresh arrive promptly, and
    /// the [`cadence::control_poll_due`] watchdog re-issues if the host drops a held request.
    fn maybe_poll_control(&mut self, config: &PluginConfig, live_sids: &[String]) {
        let long_poll = config.control_long_poll;
        if !cadence::control_poll_due(
            long_poll,
            self.wall_tick,
            self.control_inflight,
            self.control_issued_wall,
        ) {
            return;
        }
        let wait_ms = if long_poll {
            cadence::LONG_POLL_WAIT_MS
        } else {
            0
        };
        if let Some(req) =
            control::build_control_request(config, &self.machine_id, live_sids, wait_ms)
        {
            self.control_inflight = true;
            self.control_issued_wall = self.wall_tick;
            self.host.http_post(
                &req.url,
                req.headers,
                req.body,
                vec![("kind".into(), CONTROL_CTX.into())],
            );
        }
    }

    /// Handle a control-channel response (ADR-0026): update presence + refresh, then, if sharing is
    /// ON, deliver any panes the website asked to view.
    fn on_control_response(&mut self, body: &[u8]) {
        let Some(resp) = control::parse_control_response(body) else {
            return;
        };
        // Presence drives the send cadence; a rising unwatched→watched edge forces a fresh send.
        self.send_gate.set_watched(resp.watched());
        // Tier-priced heartbeat interval (ADR-0051): 30 s pro / 300 s free, clamped in the gate. An
        // older backend omits it and the conservative 300 s default stands.
        if let Some(secs) = resp.heartbeat_sec {
            self.send_gate.set_heartbeat_secs(secs);
        }
        // A bumped refresh sequence (manual refresh button) forces one snapshot on the next tick.
        if resp.refresh_seq > self.last_refresh_seq {
            self.last_refresh_seq = resp.refresh_seq;
            self.send_gate.force();
        }
        // Pending pane output is acted on ONLY when sharing is enabled (ADR-0016); ignored otherwise.
        if self.config.as_ref().is_some_and(|c| c.pane_output) && !resp.pending_output.is_empty() {
            self.deliver_pending(&resp.pending_output);
        }
    }

    /// Capture + SCRUB each requested pane and deliver it (ADR-0016/0017). Only reached when
    /// `pane_output` is ON.
    fn deliver_pending(&mut self, pending: &[control::PendingRef]) {
        let Some(config) = self.config.clone() else {
            return;
        };
        if !config.pane_output {
            return;
        }
        let Some(token) = config.token.clone() else {
            return;
        };
        let scrubber = Scrubber::new(&[]);
        let base = config.server_url.trim_end_matches('/').to_string();
        let captured_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis().to_string())
            .unwrap_or_default();

        for req in pending {
            // Only serve panes in our OWN session — a raw paneId means a different pane elsewhere, and
            // we can only read our own session's scrollback (the peer instance owning that sid serves
            // the rest). This is what stops the dashboard showing another tab/session's output.
            if !control::should_serve(req, &self.machine_id, self.own_sid.as_deref()) {
                continue;
            }
            // `should_serve` guaranteed a matching sid; tabId is echoed to key the delivery. Skip if
            // (impossibly, given the backend always sends both) either identity part is missing.
            let (Some(session_sid), Some(tab_id)) = (req.session_sid.clone(), req.tab_id) else {
                continue;
            };
            // Prefer the ANSI-coloured frame from the render-report cache; fall back to the plain
            // scrollback for a pane that hasn't rendered since we subscribed (colourless, but better
            // than delivering nothing). Skip only if we have neither.
            let content = match self.output_cache.get(req.pane_id) {
                Some(cached) => cached.to_string(),
                None => match self.host.pane_scrollback(req.pane_id) {
                    Some(plain) => plain,
                    None => continue,
                },
            };
            let lines = output::build_output_lines(&scrubber, &content);
            let delivery = OutputDeliveryWire {
                machine_id: self.machine_id.clone(),
                session_sid,
                tab_id,
                pane_id: req.pane_id,
                lines,
                captured_at: captured_at.clone(),
            };
            if let Ok(json) = serde_json::to_vec(&delivery) {
                let headers = vec![
                    ("Content-Type".to_string(), "application/json".to_string()),
                    ("Authorization".to_string(), format!("Bearer {token}")),
                ];
                self.host.http_post(
                    &format!("{base}/api/v1/output"),
                    headers,
                    json,
                    vec![("kind".into(), OUTPUT_DELIVER_CTX.into())],
                );
            }
        }
    }
}

impl ZellijPlugin for ZantiflowPlugin {
    fn load(&mut self, configuration: BTreeMap<String, String>) {
        // Build identity — the crate version this .wasm was compiled from (ADR-0022). Logged so the
        // Zellij plugin log shows which version is running, matching the backend/web/bot startup logs.
        self.host.log(&format!(
            "zantiflow plugin v{} loading",
            env!("CARGO_PKG_VERSION")
        ));
        // Least-privilege base set: session/pane state, outbound HTTP, scrollback. `RunCommands`
        // (for the hostname lookup) is deliberately NOT here — it's requested lazily only when the
        // opt-in `hostname` feature is on, so alias/hidden users never see that prompt (ADR-0024).
        request_permission(&[
            PermissionType::ReadApplicationState,
            PermissionType::WebAccess,
            PermissionType::ReadPaneContents,
        ]);
        subscribe(&[
            EventType::SessionUpdate,
            EventType::Timer,
            EventType::WebRequestResult,
            EventType::PermissionRequestResult,
            EventType::RunCommandResult,
            EventType::PluginConfigurationChanged,
        ]);

        let mut config = parse_config(&configuration);
        for w in &config.warnings {
            self.host.log(w);
        }
        if config.debug {
            self.host
                .log("debug logging ON (ADR-0049): attention transitions, ingest sends, claude activity — set debug=off to quiet");
        }
        // Effective token: explicit config wins; otherwise reuse a token minted by a previous
        // device pairing (persisted in /cache, shared across sessions). No token → pairing (ADR-0012).
        if config.token.is_none() {
            if let Some(saved) = self.host.read_cache(pairing::TOKEN_CACHE_KEY) {
                let saved = saved.trim();
                if !saved.is_empty() {
                    config.token = Some(saved.to_string());
                }
            }
        }
        if config.token.is_none() {
            self.pairing.active = true;
            self.pair_poll_ticks = (pairing::DEFAULT_POLL_SECS as u64).max(1);
            self.pairing.status = "Waiting for Zellij permissions…".into();
        }
        // The real hostname is fetched later, after the lazily-requested `RunCommands` grant lands
        // (see `ensure_hostname_capability`), and only when the opt-in feature is on (ADR-0024).
        self.config = Some(config);
        // If output sharing is already ON at load, start capturing coloured renders now (ADR-0016).
        self.sync_output_subscription();
        self.salt = fingerprint::get_or_create_salt(&mut self.host);
        // machineId is resolved lazily at first send (see `send_snapshot`): it prefers the hostname,
        // which only arrives asynchronously via `RunCommandResult`, so it isn't known here yet.

        // Start the ~1s telemetry loop; actual sending waits until permissions are granted.
        self.host.set_timeout(TICK_SECS);
    }

    fn update(&mut self, event: Event) -> bool {
        let mut should_render = false;
        match event {
            Event::PermissionRequestResult(status) => {
                if status == PermissionStatus::Granted {
                    // Grants are all-or-nothing for the requested set (FINDINGS §7): if a lazy
                    // RunCommands request was in flight, it's now granted too.
                    if self.run_commands_requested {
                        self.run_commands_granted = true;
                    }
                    self.permissions_granted = true;
                    if self.pairing.active && !self.pairing.started {
                        // WebAccess is now granted — request a pairing code immediately (ADR-0012).
                        self.start_pairing();
                    }
                    // Base perms in hand → lazily request RunCommands / fetch the hostname if the
                    // opt-in hostname feature is on; a no-op otherwise (ADR-0024).
                    self.ensure_hostname_capability();
                } else if self.permissions_granted
                    && self.run_commands_requested
                    && !self.run_commands_granted
                {
                    // Base telemetry was already granted; this denial is the optional RunCommands
                    // delta (ADR-0024). Keep telemetry running — just don't send the real hostname.
                    self.host.log(
                        "RunCommands permission denied — machine reports as hidden (hostname not sent)",
                    );
                } else {
                    self.permissions_granted = false;
                    self.host.log("permissions denied — telemetry disabled");
                }
                should_render = true;
            }
            Event::SessionUpdate(sessions, resurrectable) => {
                self.host.live = to_observed(sessions);
                self.host.dead = resurrectable
                    .into_iter()
                    .map(
                        |(name, since): (String, Duration)| crate::host::DeadSession {
                            name,
                            died_seconds_ago: since.as_secs_f64(),
                        },
                    )
                    .collect();
                // Bound the output cache to panes that still exist (closed panes never rendered again).
                if self.output_subscribed {
                    let live: std::collections::HashSet<u32> = self
                        .host
                        .live
                        .iter()
                        .flat_map(|s| &s.tabs)
                        .flat_map(|t| &t.panes)
                        .map(|p| p.id)
                        .collect();
                    self.output_cache.retain_panes(&live);
                }
            }
            Event::PaneRenderReportWithAnsi(panes) => {
                // The only source of coloured pane content (ADR-0016). Cache the latest ANSI viewport
                // per terminal pane; delivered on demand by `deliver_output`. Plugin panes are skipped.
                if self.output_subscribed {
                    for (id, contents) in panes {
                        if let PaneId::Terminal(pane_id) = id {
                            self.output_cache
                                .record(pane_id, contents.viewport.join("\n"));
                        }
                    }
                }
            }
            Event::RunCommandResult(_exit, stdout, _stderr, ctx) => {
                if ctx.get("cmd").map(String::as_str) == Some(HOSTNAME_CTX) {
                    let name = String::from_utf8_lossy(&stdout).trim().to_string();
                    if !name.is_empty() {
                        self.host.hostname = Some(name);
                    }
                }
            }
            Event::Timer(_) => {
                // Wall-tick advances every timer, independent of whether we send — it paces the
                // control poll and the send-coalesce floors (ADR-0026).
                self.wall_tick = self.wall_tick.wrapping_add(1);
                if self.has_token() {
                    if self.permissions_granted {
                        self.telemetry_tick();
                    }
                } else {
                    // No token yet — drive device pairing off the same 1 s timer (ADR-0012).
                    self.pairing_tick();
                }
                self.host.set_timeout(TICK_SECS); // re-arm (one-shot timer, FINDINGS §4)
            }
            Event::WebRequestResult(status, _headers, body, ctx) => {
                match ctx.get("kind").map(String::as_str) {
                    Some(CONTROL_CTX) => {
                        // Clear the long-poll in-flight flag on ANY terminal result (ADR-0029) so the
                        // next tick re-issues; a non-2xx (e.g. a proxy 504 on a held request) must not
                        // stall the loop. In fixed-poll mode this flag is unused by the schedule.
                        self.control_inflight = false;
                        if (200..300).contains(&status) {
                            self.on_control_response(&body);
                        } else {
                            self.host.log(&format!("control returned status {status}"));
                        }
                    }
                    Some("ingest") if !(200..300).contains(&status) => {
                        self.host.log(&format!("ingest returned status {status}"))
                    }
                    Some(PAIR_START_CTX) => {
                        self.on_pair_start(status, &body);
                        should_render = true;
                    }
                    Some(PAIR_POLL_CTX) => {
                        self.on_pair_poll(status, &body);
                        should_render = true;
                    }
                    _ => {}
                }
            }
            Event::PluginConfigurationChanged(new_config) => {
                // Settings take effect without a restart (FINDINGS §9).
                let was_debug = self.config.as_ref().is_some_and(|c| c.debug);
                let mut config = parse_config(&new_config);
                for w in &config.warnings {
                    self.host.log(w);
                }
                // Log the debug-flag edge itself (ADR-0049) so the log shows when verbosity changed.
                if config.debug && !was_debug {
                    self.host
                        .log("debug logging ON (ADR-0049): attention transitions, ingest sends, claude activity — set debug=off to quiet");
                } else if !config.debug && was_debug {
                    self.host.log("debug logging OFF");
                }
                // Preserve a token minted by pairing (persisted in /cache) across live config changes.
                if config.token.is_none() {
                    if let Some(saved) = self.host.read_cache(pairing::TOKEN_CACHE_KEY) {
                        let saved = saved.trim();
                        if !saved.is_empty() {
                            config.token = Some(saved.to_string());
                        }
                    }
                }
                if config.token.is_some() {
                    self.pairing.active = false; // a token arrived → leave pairing mode
                }
                self.config = Some(config);
                // `pane_output` may have just been toggled — (un)subscribe from ANSI render reports
                // to start/stop colour capture accordingly (ADR-0016).
                self.sync_output_subscription();
                // The real-hostname feature may have just been toggled on — lazily acquire the
                // RunCommands permission and/or fetch the hostname now (ADR-0024). No-op if off.
                self.ensure_hostname_capability();
            }
            _ => {}
        }
        should_render
    }

    fn render(&mut self, _rows: usize, _cols: usize) {
        // Telemetry mode (token from config or a completed pairing): a quiet confirmation.
        if self.has_token() && !self.pairing.active {
            println!();
            println!("  zantiflow ✓ paired — reporting telemetry (change-driven).");
            return;
        }
        // Pairing mode: show the code + where to enter it, plus a live status line.
        println!();
        println!("  zantiflow — pair this device");
        println!();
        if let (Some(code), Some(uri)) = (&self.pairing.user_code, &self.pairing.verification_uri) {
            println!("  1. Open  {uri}  (sign in)");
            println!("  2. Enter this code:");
            println!();
            println!("        {code}");
            println!();
        }
        println!("  {}", self.pairing.status);
    }
}

// NOTE: `register_plugin!` is invoked at the crate root of the plugin BINARY (`src/main.rs`), not here.
// The macro emits `fn main`, and only a binary crate compiles that into the WASI `_start` export that
// Zellij's loader requires — a cdylib/library never does. See src/main.rs.
