//! Building the wire-v4 snapshot from what the host observed (ADR-0001/0002/0005). Ordering is
//! **current → other live → resurrectable** (ADR-0001). Redaction (Model A) is applied HERE, before
//! anything leaves the plugin: a hidden name becomes `null`. Built-in attention detectors
//! (session.detached, claude.needs-input, claude.thinking) run over the same data. Array sizes are bounded to the
//! limits the backend enforces, so a huge session tree can't produce a rejected snapshot.
use crate::attentions;
use crate::config::PluginConfig;
use crate::debuglog::PaneObs;
use crate::fingerprint;
use crate::host::HostPort;
use crate::model::{Attention, Pane, Session, SessionState, SnapshotV4, Tab, WIRE_VERSION};
use crate::privacy;

const MAX_SESSIONS: usize = 200;
const MAX_TABS: usize = 200;
const MAX_PANES: usize = 500;

/// A built snapshot plus the debug observations gathered along the way (ADR-0049/0050): EVERY pane
/// seen this tick — raw title, claude verdict, and the freshness verdict the thinking detector used.
/// The observations are local facts (session NAME + title, not sid) and are only ever consumed by
/// `debuglog` — they never hit the wire.
pub struct SnapshotBuild {
    pub snap: SnapshotV4,
    pub panes: Vec<PaneObs>,
}

/// [`build_snapshot_observed`] without the debug observations — the convenience form most tests use.
pub fn build_snapshot(
    host: &impl HostPort,
    config: &PluginConfig,
    machine_id: &str,
    salt: &str,
    tick: u64,
    wall_tick: u64,
    activity: &mut crate::activity::PaneActivity,
) -> SnapshotV4 {
    build_snapshot_observed(host, config, machine_id, salt, tick, wall_tick, activity).snap
}

pub fn build_snapshot_observed(
    host: &impl HostPort,
    config: &PluginConfig,
    machine_id: &str,
    salt: &str,
    tick: u64,
    // Wall-tick (advances every ~1 s Timer) + the cross-tick per-pane fingerprint tracker, so the
    // `claude.thinking` detector can require a pane to be *still producing output* (ADR-0025 fix).
    wall_tick: u64,
    activity: &mut crate::activity::PaneActivity,
) -> SnapshotBuild {
    let p = &config.privacy;

    // Live sessions, current first (stable sort keeps host order among the rest) — ADR-0001.
    let mut live = host.live_sessions();
    live.sort_by_key(|s| !s.is_current);

    let mut sessions: Vec<Session> = Vec::new();
    let mut attentions: Vec<Attention> = Vec::new();
    let mut pane_obs: Vec<PaneObs> = Vec::new();
    // Pane keys observed this tick, to prune the freshness tracker down to what's still live.
    let mut live_keys: std::collections::HashSet<String> = std::collections::HashSet::new();

    for s in live.into_iter().take(MAX_SESSIONS) {
        let sid = fingerprint::sid(salt, &s.name);

        // session.detached — a live session with no attached clients (ADR-0005 §3).
        if s.connected_clients == 0 {
            attentions.push(attentions::detached(&sid));
        }

        let mut tabs: Vec<Tab> = Vec::new();
        for t in s.tabs.into_iter().take(MAX_TABS) {
            let mut panes: Vec<Pane> = Vec::new();
            for pane in t.panes.into_iter().take(MAX_PANES) {
                // Read scrollback ONCE — used for both the activity fingerprint and detectors.
                let scrollback = host.pane_scrollback(pane.id);
                let fp = fingerprint::content_fingerprint(salt, scrollback.as_deref());
                // Track content-change freshness per pane (crate::activity) so `thinking` below can
                // require the pane to be *still producing output*.
                let pane_key = format!("{}:{}:{}", sid, t.tab_id, pane.id);
                let fresh = activity.observe(&pane_key, &fp, wall_tick);
                live_keys.insert(pane_key);

                // claude.needs-input / claude.thinking — best-effort heuristics for a claude pane,
                // recognised by the pane-TITLE marker (✳ idle / Braille spinner), since Zellij reports
                // the pane `command` as null (ADR-0025). needs-input reads the pane's own tail (last
                // line is a prompt) and, as the more specific/actionable state, wins over thinking.
                // thinking additionally requires the pane to be FRESH — a spinner glyph Claude Code
                // leaves frozen on a finished background pane must not read as "still thinking".
                // Identity: title marker first; content-fallback (ADR-0054) for own-session panes —
                // Zellij delivers title changes only on unrelated SessionUpdates (measured minutes
                // late), while the viewport is re-read every tick, so content is the timely signal.
                let is_claude = attentions::is_claude_pane(&pane.title, pane.command.as_deref())
                    || scrollback
                        .as_deref()
                        .is_some_and(attentions::is_claude_content);
                // Record EVERY pane's title + verdicts for the ADR-0049/0050 debug log (local-only),
                // so an unrecognized claude pane's actual title is auditable in the field.
                pane_obs.push(PaneObs {
                    session: s.name.clone(),
                    tab_id: t.tab_id,
                    pane_id: pane.id,
                    title: pane.title.clone(),
                    is_claude,
                    fresh,
                });
                if is_claude {
                    let on_prompt = scrollback
                        .as_deref()
                        .is_some_and(attentions::last_line_is_prompt);
                    // Thinking = still producing output AND a turn-in-flight signal: the title's
                    // spinner frame, or — timely regardless of title delivery (ADR-0054) — the
                    // `esc to interrupt` footer in the live viewport tail.
                    let turn_in_flight = attentions::is_thinking_marker(&pane.title)
                        || scrollback
                            .as_deref()
                            .is_some_and(attentions::tail_shows_turn_in_flight);
                    if on_prompt {
                        attentions.push(attentions::needs_input(&sid, t.tab_id, pane.id));
                    } else if fresh && turn_in_flight {
                        attentions.push(attentions::thinking(&sid, t.tab_id, pane.id));
                    }
                }

                panes.push(Pane {
                    id: pane.id,
                    name: privacy::name_to_wire(p.pane_names, &pane.title),
                    // The pane's command is as sensitive as its name → same visibility (ADR-0002).
                    command: pane
                        .command
                        .as_deref()
                        .and_then(|c| privacy::name_to_wire(p.pane_names, c)),
                    is_focused: pane.is_focused,
                    exited: pane.exited,
                    content_fingerprint: fp,
                    claude: is_claude,
                });
            }
            tabs.push(Tab {
                tab_id: t.tab_id,
                name: privacy::name_to_wire(p.tab_names, &t.name),
                position: t.position,
                active: t.active,
                panes,
            });
        }

        sessions.push(Session {
            sid,
            name: privacy::name_to_wire(p.session_names, &s.name),
            is_current: s.is_current,
            state: SessionState::Live,
            died_seconds_ago: None,
            tabs,
        });
    }

    // Bound the freshness tracker to panes that still exist (closed panes never return).
    activity.retain(&live_keys);

    // Then resurrectable (dead) sessions — name + death age only (Zellij exposes no tab/pane detail).
    let remaining = MAX_SESSIONS.saturating_sub(sessions.len());
    for d in host.dead_sessions().into_iter().take(remaining) {
        sessions.push(Session {
            sid: fingerprint::sid(salt, &d.name),
            name: privacy::name_to_wire(p.session_names, &d.name),
            is_current: false,
            state: SessionState::Resurrectable,
            died_seconds_ago: Some(d.died_seconds_ago),
            tabs: vec![],
        });
    }

    // The real hostname is only ever read when the user opted into it AND the machine is sent as
    // `real` (ADR-0024: opt-in `hostname` flag; ADR-0002 §permissions). Off → machine name is `null`.
    let hostname = if config.wants_hostname() {
        host.hostname()
    } else {
        None
    };
    let machine = privacy::machine_identity(
        p.machine,
        hostname.as_deref(),
        config.machine_alias.as_deref(),
    );

    // Machine claude-activity flag (ADR-0051): ≥1 observed claude pane is producing output. Only
    // own-session panes can ever be fresh (scrollback is unreadable across sessions), so this is
    // honestly this INSTANCE's view; the backend merges instances per machine.
    let claude_active = pane_obs.iter().any(|c| c.is_claude && c.fresh);

    SnapshotBuild {
        snap: SnapshotV4 {
            version: WIRE_VERSION,
            machine_id: machine_id.to_string(),
            captured_at_tick: tick,
            privacy: privacy::privacy_echo(p),
            machine,
            attentions,
            sessions,
            claude_active,
        },
        panes: pane_obs,
    }
}

/// A change-signature of a snapshot for the send-cadence decision (ADR-0026). Two hashes over the
/// snapshot's meaningful content, both EXCLUDING fields that advance every tick without a real change
/// (`capturedAtTick`, a dead session's `diedSecondsAgo`, an attention's `since`):
///
/// - `salient` — the whole tree incl. every pane's `contentFingerprint` + the attention set: changes
///   on ANY meaningful change (structure, output, or attentions).
/// - `structural` — the same but WITHOUT `contentFingerprint`: changes only on an attention
///   onset/clear or a tree change (session/tab/pane added/removed/renamed/re-stated), never on pure
///   pane-output churn.
///
/// The two hashes are only ever compared to the immediately-preceding snapshot's within one plugin
/// run, so a process-local `DefaultHasher` is sufficient (no cross-run/process stability needed).
pub struct ChangeSig {
    pub salient: u64,
    pub structural: u64,
}

pub fn change_signature(snap: &SnapshotV4) -> ChangeSig {
    let mut v = serde_json::to_value(snap).unwrap_or(serde_json::Value::Null);
    strip_volatile(&mut v);
    let salient = hash_json(&v);
    strip_fingerprints(&mut v);
    let structural = hash_json(&v);
    ChangeSig {
        salient,
        structural,
    }
}

fn hash_json(v: &serde_json::Value) -> u64 {
    use std::hash::{Hash, Hasher};
    // `serde_json::Value` serializes with deterministic key order, so the string form is stable for
    // identical input — good enough for an equality check against the previous snapshot.
    let mut h = std::collections::hash_map::DefaultHasher::new();
    v.to_string().hash(&mut h);
    h.finish()
}

/// Remove fields that advance every tick without a meaningful change.
fn strip_volatile(v: &mut serde_json::Value) {
    let Some(obj) = v.as_object_mut() else { return };
    obj.remove("capturedAtTick");
    if let Some(atts) = obj
        .get_mut("attentions")
        .and_then(serde_json::Value::as_array_mut)
    {
        for a in atts.iter_mut() {
            if let Some(o) = a.as_object_mut() {
                o.remove("since");
            }
        }
    }
    if let Some(sessions) = obj
        .get_mut("sessions")
        .and_then(serde_json::Value::as_array_mut)
    {
        for s in sessions.iter_mut() {
            if let Some(o) = s.as_object_mut() {
                o.remove("diedSecondsAgo");
            }
        }
    }
}

/// Additionally remove every pane's `contentFingerprint` — and the `claudeActive` aggregate derived
/// from them (ADR-0051) — leaving only tree structure + attentions. `claudeActive` is content-level:
/// its flips reach the backend via the salient (coalesced) path or the heartbeat, never the
/// floor-bypassing notable path.
fn strip_fingerprints(v: &mut serde_json::Value) {
    if let Some(obj) = v.as_object_mut() {
        obj.remove("claudeActive");
    }
    let Some(sessions) = v
        .get_mut("sessions")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };
    for s in sessions.iter_mut() {
        let Some(tabs) = s.get_mut("tabs").and_then(serde_json::Value::as_array_mut) else {
            continue;
        };
        for t in tabs.iter_mut() {
            let Some(panes) = t.get_mut("panes").and_then(serde_json::Value::as_array_mut) else {
                continue;
            };
            for p in panes.iter_mut() {
                if let Some(o) = p.as_object_mut() {
                    o.remove("contentFingerprint");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{PluginConfig, PrivacyConfig};
    use crate::host::{DeadSession, FakeHost, ObservedPane, ObservedSession, ObservedTab};
    use crate::model::{MachineVisibility, NameVisibility};

    fn base_config() -> PluginConfig {
        PluginConfig {
            token: Some("ztf_x".into()),
            machine_alias: None,
            server_url: "https://x".into(),
            privacy: PrivacyConfig {
                full: true,
                machine: MachineVisibility::Real,
                session_names: NameVisibility::Send,
                tab_names: NameVisibility::Send,
                pane_names: NameVisibility::Send,
            },
            pane_output: false,
            control_long_poll: false,
            hostname_enabled: true, // base case sends the real hostname (see the opt-in gate test)
            debug: false,
            warnings: vec![],
        }
    }

    fn session(name: &str, is_current: bool) -> ObservedSession {
        ObservedSession {
            name: name.into(),
            is_current,
            connected_clients: 1,
            tabs: vec![ObservedTab {
                tab_id: 0,
                name: "editor".into(),
                position: 0,
                active: true,
                panes: vec![ObservedPane {
                    id: 1,
                    title: "nvim".into(),
                    command: Some("nvim".into()),
                    is_focused: true,
                    exited: false,
                }],
            }],
        }
    }

    /// Build with a throwaway freshness tracker (wall_tick = tick). For tests that don't exercise
    /// thinking across ticks — a single call is always a first observation, so it's never "fresh".
    fn build(
        host: &impl HostPort,
        config: &PluginConfig,
        machine_id: &str,
        salt: &str,
        tick: u64,
    ) -> SnapshotV4 {
        let mut act = crate::activity::PaneActivity::default();
        build_snapshot(host, config, machine_id, salt, tick, tick, &mut act)
    }

    /// A single attached session with one pane whose TITLE carries `pane_title` (the marker lives on
    /// the pane, not the tab — the tab stays the real `Tab #1`) and whose command is null, as Zellij
    /// reports it. For the thinking-detector tests.
    fn thinking_host(pane_title: &str) -> FakeHost {
        FakeHost {
            live: vec![ObservedSession {
                name: "work".into(),
                is_current: true,
                connected_clients: 1, // attached → no detached attention
                tabs: vec![ObservedTab {
                    tab_id: 0,
                    name: "Tab #1".into(),
                    position: 0,
                    active: true,
                    panes: vec![ObservedPane {
                        id: 7,
                        title: pane_title.into(),
                        command: None, // Zellij reports null — detection must not depend on it
                        is_focused: true,
                        exited: false,
                    }],
                }],
            }],
            ..Default::default()
        }
    }

    #[test]
    fn orders_current_then_live_then_resurrectable() {
        let mut host = FakeHost {
            live: vec![session("other", false), session("main", true)],
            dead: vec![DeadSession {
                name: "old".into(),
                died_seconds_ago: 300.0,
            }],
            hostname: Some("red-laptop".into()),
            ..Default::default()
        };
        host.scrollback.insert(1, "content".into());

        let snap = build(&host, &base_config(), "m-1", "salt", 7);
        let names: Vec<_> = snap
            .sessions
            .iter()
            .map(|s| s.name.clone().unwrap())
            .collect();
        assert_eq!(names, vec!["main", "other", "old"]);
        assert_eq!(snap.sessions[2].state, SessionState::Resurrectable);
        assert_eq!(snap.sessions[2].died_seconds_ago, Some(300.0));
        assert_eq!(snap.machine.name.as_deref(), Some("red-laptop"));
    }

    #[test]
    fn hostname_is_withheld_when_the_opt_in_flag_is_off() {
        // machine == Real and the host knows its hostname, but the opt-in flag is off (ADR-0024):
        // the real hostname must NOT reach the wire — the machine name is null.
        let mut config = base_config();
        config.hostname_enabled = false;
        assert_eq!(config.privacy.machine, MachineVisibility::Real);

        let host = FakeHost {
            live: vec![session("main", true)],
            hostname: Some("red-laptop".into()),
            ..Default::default()
        };
        let snap = build(&host, &config, "m-1", "salt", 1);
        assert_eq!(snap.machine.source, MachineVisibility::Real);
        assert_eq!(snap.machine.name, None);
    }

    #[test]
    fn redacts_names_when_hidden_but_keeps_a_sid() {
        let mut config = base_config();
        config.privacy.session_names = NameVisibility::Hidden;
        config.privacy.pane_names = NameVisibility::Hidden;
        config.privacy.machine = MachineVisibility::Hidden;

        let host = FakeHost {
            live: vec![session("secret-session", true)],
            ..Default::default()
        };
        let snap = build(&host, &config, "m-1", "salt", 1);
        assert_eq!(snap.sessions[0].name, None);
        assert!(!snap.sessions[0].sid.is_empty());
        let pane = &snap.sessions[0].tabs[0].panes[0];
        assert_eq!(pane.name, None);
        assert_eq!(pane.command, None);
        assert_eq!(snap.machine.name, None);
    }

    #[test]
    fn detects_detached_and_needs_input_attentions() {
        // A detached session (0 clients) with a claude pane sitting on a prompt.
        let mut host = FakeHost {
            live: vec![ObservedSession {
                name: "work".into(),
                is_current: true,
                connected_clients: 0, // detached
                tabs: vec![ObservedTab {
                    tab_id: 0,
                    // Tab name shows a spinner AND the pane's tail ends on a prompt: needs-input wins.
                    name: "⠙ Editing the config".into(),
                    position: 0,
                    active: true,
                    panes: vec![ObservedPane {
                        id: 5,
                        title: "claude".into(),
                        command: Some("claude --resume".into()),
                        is_focused: true,
                        exited: false,
                    }],
                }],
            }],
            ..Default::default()
        };
        host.scrollback
            .insert(5, "thinking…\nWhich file should I edit?".into());

        let snap = build(&host, &base_config(), "m-1", "salt", 1);
        let types: Vec<_> = snap.attentions.iter().map(|a| a.kind.as_str()).collect();
        assert!(types.contains(&"session.detached"));
        assert!(types.contains(&"claude.needs-input"));
        // needs-input targets the right pane.
        let ni = snap
            .attentions
            .iter()
            .find(|a| a.kind == "claude.needs-input")
            .unwrap();
        assert_eq!(ni.target.pane_id, Some(5));
        // The pane sits on a prompt → needs-input; no thinking (pane title carries no spinner marker
        // and, regardless, needs-input wins — ADR-0025 §2).
        assert!(!snap.attentions.iter().any(|a| a.kind == "claude.thinking"));
    }

    #[test]
    fn thinking_fires_for_a_claude_pane_that_spins_and_is_still_producing_output() {
        // The Braille marker lives on the PANE title (Zellij leaves the tab `Tab #1`), and the command
        // is null — detection must key off the title marker (ADR-0025 fix).
        let mut host = thinking_host("⠐ Implement homepage from design file");
        let mut act = crate::activity::PaneActivity::default();
        // Tick 1: first observation — not yet provably producing output, so no thinking.
        host.scrollback.insert(7, "· Swooping…\nline 1".into());
        let s1 = build_snapshot(&host, &base_config(), "m-1", "salt", 1, 1, &mut act);
        assert!(!s1.attentions.iter().any(|a| a.kind == "claude.thinking"));
        // Tick 2: output changed (a live turn) → fresh → thinking fires, targeting the pane.
        host.scrollback
            .insert(7, "· Swooping…\nline 1\nline 2".into());
        let s2 = build_snapshot(&host, &base_config(), "m-1", "salt", 2, 2, &mut act);
        let think = s2
            .attentions
            .iter()
            .find(|a| a.kind == "claude.thinking")
            .expect("thinking attention emitted");
        assert_eq!(think.target.pane_id, Some(7));
        // Mutually exclusive with needs-input for the same pane (no prompt in the tail).
        assert!(!s2.attentions.iter().any(|a| a.kind == "claude.needs-input"));
    }

    #[test]
    fn thinking_does_not_fire_for_a_frozen_spinner_glyph() {
        // THE BUG. Claude finished but left the last spinner frame `⠂` frozen in the background pane's
        // title, and its output no longer changes. A marker-only detector would report "thinking"
        // forever; requiring freshness means it never fires here, no matter how many ticks pass.
        let mut host = thinking_host("⠂ bug-tile-not-updated");
        host.scrollback.insert(7, "final answer — settled".into());
        let mut act = crate::activity::PaneActivity::default();
        for w in 1..12 {
            let s = build_snapshot(&host, &base_config(), "m-1", "salt", w, w, &mut act);
            assert!(
                !s.attentions.iter().any(|a| a.kind == "claude.thinking"),
                "a frozen glyph must not read as thinking (tick {w})"
            );
        }
    }

    #[test]
    fn thinking_clears_once_a_finished_pane_stops_producing_output() {
        let mut host = thinking_host("⠐ working…");
        let mut act = crate::activity::PaneActivity::default();
        host.scrollback.insert(7, "a".into());
        build_snapshot(&host, &base_config(), "m-1", "salt", 1, 1, &mut act);
        host.scrollback.insert(7, "ab".into()); // changed at tick 2 → fresh → thinking
        let live = build_snapshot(&host, &base_config(), "m-1", "salt", 2, 2, &mut act);
        assert!(live.attentions.iter().any(|a| a.kind == "claude.thinking"));
        // Output settles (Claude finished). Past the stale window the attention clears — a structural
        // change the send-gate pushes — even though the frozen spinner glyph never changed.
        let settled = build_snapshot(&host, &base_config(), "m-1", "salt", 20, 20, &mut act);
        assert!(!settled
            .attentions
            .iter()
            .any(|a| a.kind == "claude.thinking"));
    }

    #[test]
    fn needs_input_wins_over_a_live_spinner_on_the_same_pane() {
        // A Braille-marked, still-producing pane whose tail also ends on a prompt: needs-input (the
        // more actionable state) must win, and thinking must not also fire (ADR-0025 §2).
        let mut host = thinking_host("⠙ Deciding");
        let mut act = crate::activity::PaneActivity::default();
        host.scrollback.insert(7, "thinking…\nWhich file?".into());
        build_snapshot(&host, &base_config(), "m-1", "salt", 1, 1, &mut act);
        host.scrollback
            .insert(7, "thinking…\nstill…\nWhich file?".into()); // fresh
        let s = build_snapshot(&host, &base_config(), "m-1", "salt", 2, 2, &mut act);
        assert!(s.attentions.iter().any(|a| a.kind == "claude.needs-input"));
        assert!(!s.attentions.iter().any(|a| a.kind == "claude.thinking"));
    }

    #[test]
    fn stale_title_pane_with_a_live_turn_is_detected_and_thinks_via_content() {
        // THE 2026-07-22 INCIDENT (ADR-0054): Zellij delivers title changes minutes late, so the
        // pane title showed a stale idle "✳" (or even the shell's prompt) while the viewport showed
        // a RUNNING turn. Content must carry both identity and thinking, title be damned.
        let ui =
            "· Bunning… (12s · ↓ 7.0k tokens)\n❯ \n  ⏵⏵ bypass permissions on · esc to interrupt";
        for stale_title in ["nordic@host:/repos/x", "✳ Start using Zustand everywhere"] {
            let mut host = thinking_host(stale_title);
            let mut act = crate::activity::PaneActivity::default();
            host.scrollback.insert(7, ui.to_string());
            let b1 = build_snapshot_observed(&host, &base_config(), "m-1", "salt", 1, 1, &mut act);
            // Identity via content from the very first tick…
            assert!(b1.panes[0].is_claude, "title {stale_title:?}");
            // …thinking waits for freshness (first observation is never fresh, ADR-0034).
            assert!(!b1
                .snap
                .attentions
                .iter()
                .any(|a| a.kind == "claude.thinking"));
            host.scrollback
                .insert(7, format!("{ui}\nstreaming more output"));
            let b2 = build_snapshot_observed(&host, &base_config(), "m-1", "salt", 2, 2, &mut act);
            assert!(
                b2.snap
                    .attentions
                    .iter()
                    .any(|a| a.kind == "claude.thinking"),
                "fresh + esc-to-interrupt must think despite stale title {stale_title:?}"
            );
            assert!(b2.snap.claude_active);
            // The verdict rides the wire per pane (ADR-0055) so the backend's claude.idle scope
            // sees this pane even though its NAME carries no marker.
            assert!(b2.snap.sessions[0].tabs[0].panes[0].claude);
        }
    }

    #[test]
    fn observed_build_reports_claude_panes_with_the_detectors_freshness() {
        // The observations feed the ADR-0049 debug log: local session NAME + tab/pane + the same
        // freshness verdict the thinking detector used this tick.
        let mut host = thinking_host("⠐ working");
        let mut act = crate::activity::PaneActivity::default();
        host.scrollback.insert(7, "line 1".into());
        let b1 = build_snapshot_observed(&host, &base_config(), "m-1", "salt", 1, 1, &mut act);
        assert_eq!(
            b1.panes,
            vec![crate::debuglog::PaneObs {
                session: "work".into(),
                tab_id: 0,
                pane_id: 7,
                title: "⠐ working".into(),
                is_claude: true,
                fresh: false, // first observation is never fresh (ADR-0034)
            }]
        );
        // No pane is provably producing output yet → the wire-level flag is idle (ADR-0051).
        assert!(!b1.snap.claude_active);
        // Output changed → the observation flips to fresh, in step with the detector.
        host.scrollback.insert(7, "line 1\nline 2".into());
        let b2 = build_snapshot_observed(&host, &base_config(), "m-1", "salt", 2, 2, &mut act);
        assert!(b2.panes[0].fresh);
        assert!(b2.snap.claude_active);
        assert!(b2
            .snap
            .attentions
            .iter()
            .any(|a| a.kind == "claude.thinking"));
    }

    #[test]
    fn every_pane_is_observed_with_its_title_and_claude_verdict() {
        // `session()` builds an nvim pane — observed too (ADR-0052 title audit), just not claude,
        // and a busy non-claude pane never drives the machine-level claude flag.
        let mut host = FakeHost {
            live: vec![session("main", true)],
            ..Default::default()
        };
        let mut act = crate::activity::PaneActivity::default();
        host.scrollback.insert(1, "a".into());
        build_snapshot_observed(&host, &base_config(), "m-1", "salt", 1, 1, &mut act);
        host.scrollback.insert(1, "ab".into()); // changing → fresh, but not claude
        let b = build_snapshot_observed(&host, &base_config(), "m-1", "salt", 2, 2, &mut act);
        assert_eq!(b.panes.len(), 1);
        assert_eq!(b.panes[0].title, "nvim");
        assert!(!b.panes[0].is_claude);
        assert!(b.panes[0].fresh);
        assert!(!b.snap.claude_active);
    }

    #[test]
    fn no_needs_input_for_non_claude_or_non_prompt() {
        let mut host = FakeHost {
            live: vec![session("main", true)],
            ..Default::default()
        };
        host.scrollback
            .insert(1, "just some output\nno prompt here".into());
        let snap = build(&host, &base_config(), "m-1", "salt", 1);
        assert!(snap
            .attentions
            .iter()
            .all(|a| a.kind != "claude.needs-input"));
    }

    // --- change_signature (ADR-0026) ---

    #[test]
    fn change_signature_ignores_captured_tick() {
        let mut host = FakeHost {
            live: vec![session("main", true)],
            ..Default::default()
        };
        host.scrollback.insert(1, "content".into());
        let a = change_signature(&build(&host, &base_config(), "m-1", "salt", 1));
        let b = change_signature(&build(&host, &base_config(), "m-1", "salt", 9999));
        assert_eq!(
            a.salient, b.salient,
            "capturedAtTick must not affect the signature"
        );
        assert_eq!(a.structural, b.structural);
    }

    #[test]
    fn content_change_moves_salient_but_not_structural() {
        let mut host = FakeHost {
            live: vec![session("main", true)],
            ..Default::default()
        };
        host.scrollback.insert(1, "before".into());
        let a = change_signature(&build(&host, &base_config(), "m-1", "salt", 1));
        host.scrollback.insert(1, "after".into()); // pane output changed → fingerprint changes
        let b = change_signature(&build(&host, &base_config(), "m-1", "salt", 1));
        assert_ne!(
            a.salient, b.salient,
            "a fingerprint change must move salient"
        );
        assert_eq!(
            a.structural, b.structural,
            "a pure content change must NOT move structural"
        );
    }

    #[test]
    fn attention_onset_moves_both_signatures() {
        let attached = FakeHost {
            live: vec![session("main", true)], // 1 client → no attention
            ..Default::default()
        };
        let mut detached = FakeHost {
            live: vec![session("main", true)],
            ..Default::default()
        };
        detached.live[0].connected_clients = 0; // → session.detached
        let a = change_signature(&build(&attached, &base_config(), "m-1", "salt", 1));
        let b = change_signature(&build(&detached, &base_config(), "m-1", "salt", 1));
        assert_ne!(a.salient, b.salient);
        assert_ne!(
            a.structural, b.structural,
            "an attention onset is a notable (structural) change"
        );
    }

    #[test]
    fn dead_session_age_does_not_move_signatures() {
        let host = |age: f64| FakeHost {
            dead: vec![DeadSession {
                name: "old".into(),
                died_seconds_ago: age,
            }],
            ..Default::default()
        };
        let a = change_signature(&build(&host(10.0), &base_config(), "m-1", "salt", 1));
        let b = change_signature(&build(&host(99.0), &base_config(), "m-1", "salt", 1));
        assert_eq!(
            a.salient, b.salient,
            "diedSecondsAgo ticks up — must be excluded"
        );
        assert_eq!(a.structural, b.structural);
    }
}
