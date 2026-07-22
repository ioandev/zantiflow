//! Transition-only debug logging (ADR-0049), behind the `debug` config flag. Pure differ: fed once
//! per telemetry tick with the detected attentions and the per-claude-pane freshness observations, it
//! returns the lines to emit through `HostPort::log` (plugin stderr → Zellij's own `zellij.log`).
//! Edges only — an unchanged tick returns nothing, so an idle machine stays silent even with debug on.
//!
//! Privacy: lines may include LOCAL session names, tab/pane ids, truncated sids, attention types and
//! counts — never the ingest token and never pane content/scrollback (ADR-0018 §4).
use std::collections::{BTreeMap, BTreeSet};

use crate::cadence::SendReason;
use crate::model::{Attention, AttentionTarget, SnapshotV4};

/// One pane's identity, title, and content-freshness, observed while building a snapshot — EVERY
/// pane, not just recognized claude ones, so the title-audit lines (ADR-0052) can show what the
/// claude detector saw and rejected. `session`/`title` are LOCAL observations (this log never
/// leaves the machine; the wire may redact names). `is_claude` is the ADR-0034 marker verdict;
/// `fresh` is the same freshness verdict the thinking detector uses (content changed within the
/// window, i.e. currently producing output).
#[derive(Debug, Clone, PartialEq)]
pub struct PaneObs {
    pub session: String,
    pub tab_id: usize,
    pub pane_id: u32,
    pub title: String,
    pub is_claude: bool,
    pub fresh: bool,
}

/// `<sid-prefix>:<tab>:<pane>` — the wire-side identity of an attention target, sid truncated to
/// "s" + 8 hex (plenty to disambiguate locally), missing parts as `-`.
fn fmt_target(t: &AttentionTarget) -> String {
    let sid: String = t
        .session_sid
        .as_deref()
        .unwrap_or("-")
        .chars()
        .take(9)
        .collect();
    let tab = t.tab_id.map_or_else(|| "-".into(), |v| v.to_string());
    let pane = t.pane_id.map_or_else(|| "-".into(), |v| v.to_string());
    format!("{sid}:{tab}:{pane}")
}

/// Stable identity of one attention for diffing and display: `type @ target`.
fn attn_key(a: &Attention) -> String {
    format!("{} @ {}", a.kind, fmt_target(&a.target))
}

fn fresh_word(fresh: bool) -> &'static str {
    if fresh {
        "active — producing output"
    } else {
        "idle — output settled"
    }
}

/// Remembers the previous tick's detector/activity picture so [`tick_lines`] can emit edges only.
/// Owned by the plugin across ticks; starts empty, so enabling debug mid-run dumps the current state
/// as an initial burst of "transitions" (accepted in ADR-0049 — it doubles as a state dump).
///
/// [`tick_lines`]: DebugState::tick_lines
#[derive(Default)]
pub struct DebugState {
    /// Attention keys (`type @ target`) active on the previous tick.
    attn: BTreeSet<String>,
    /// Per claude pane (local session name, tab, pane) → last seen freshness.
    claude: BTreeMap<(String, usize, u32), bool>,
    /// Machine-level "any claude pane producing output" as of the previous tick; `None` until the
    /// first tick that sees a claude pane (and again after they all disappear).
    any_active: Option<bool>,
}

impl DebugState {
    /// Diff this tick's attentions + pane observations against the previous tick and return the
    /// debug lines to log (empty when nothing changed). Claude-transition lines consider only the
    /// panes whose `is_claude` verdict is set (ADR-0052 generalized the observations to all panes).
    pub fn tick_lines(&mut self, attentions: &[Attention], panes: &[PaneObs]) -> Vec<String> {
        let claude: Vec<&PaneObs> = panes.iter().filter(|p| p.is_claude).collect();
        let mut lines = Vec::new();

        // 1. Attention transitions — the detector's output edges, independent of whether the
        //    send-gate has POSTed them yet.
        let now: BTreeSet<String> = attentions.iter().map(attn_key).collect();
        for k in now.difference(&self.attn) {
            lines.push(format!("debug: attention onset: {k}"));
        }
        for k in self.attn.difference(&now) {
            lines.push(format!("debug: attention cleared: {k}"));
        }
        self.attn = now;

        // 2. Per-pane claude activity transitions (first sighting, active ↔ idle, gone).
        let mut next: BTreeMap<(String, usize, u32), bool> = BTreeMap::new();
        for obs in &claude {
            let key = (obs.session.clone(), obs.tab_id, obs.pane_id);
            match self.claude.get(&key) {
                None => lines.push(format!(
                    "debug: claude pane seen: session \"{}\" tab {} pane {} ({})",
                    obs.session,
                    obs.tab_id,
                    obs.pane_id,
                    fresh_word(obs.fresh)
                )),
                Some(prev) if *prev != obs.fresh => lines.push(format!(
                    "debug: claude pane {}: session \"{}\" tab {} pane {}",
                    fresh_word(obs.fresh),
                    obs.session,
                    obs.tab_id,
                    obs.pane_id
                )),
                Some(_) => {}
            }
            next.insert(key, obs.fresh);
        }
        for (session, tab_id, pane_id) in self.claude.keys() {
            if !next.contains_key(&(session.clone(), *tab_id, *pane_id)) {
                lines.push(format!(
                    "debug: claude pane gone: session \"{session}\" tab {tab_id} pane {pane_id}"
                ));
            }
        }
        self.claude = next;

        // 3. The machine-level edge — the plugin-local leading indicator of the backend's
        //    `claude.idle` (ADR-0027 fires after ALL claude panes idle past the tier threshold).
        if claude.is_empty() {
            if self.any_active.take().is_some() {
                lines.push("debug: no claude panes visible on this machine".to_string());
            }
        } else {
            let active = claude.iter().filter(|o| o.fresh).count();
            let total = claude.len();
            let any = active > 0;
            if self.any_active != Some(any) {
                lines.push(if any {
                    format!("debug: claude ACTIVE — {active}/{total} claude pane(s) producing output")
                } else {
                    format!(
                        "debug: claude IDLE across all sessions — 0/{total} claude pane(s) producing \
                         output (the backend's claude.idle threshold counts from here)"
                    )
                });
                self.any_active = Some(any);
            }
        }

        lines
    }
}

/// Title-audit lines (ADR-0052): one per observed pane, showing EXACTLY what the claude detector
/// saw — the raw pane title (quote-escaped, truncated) plus its verdict and freshness. Emitted only
/// after an ingest-send line, so a cycling spinner glyph never causes per-tick spam.
pub fn pane_title_lines(panes: &[PaneObs]) -> Vec<String> {
    panes
        .iter()
        .map(|p| {
            let title: String = p.title.chars().take(80).collect();
            format!(
                "debug:   pane: session \"{}\" tab {} pane {} claude={} fresh={} title={:?}",
                p.session,
                p.tab_id,
                p.pane_id,
                if p.is_claude { "yes" } else { "no" },
                if p.fresh { "yes" } else { "no" },
                title
            )
        })
        .collect()
}

/// One line per actual ingest POST: the send reason (which ADR-0026 gate branch fired), what the
/// snapshot contains, and its size. Only wire-side facts — counts, attention types/targets, bytes.
pub fn ingest_line(tick: u64, reason: SendReason, snap: &SnapshotV4, body_bytes: usize) -> String {
    let panes: usize = snap
        .sessions
        .iter()
        .flat_map(|s| &s.tabs)
        .map(|t| t.panes.len())
        .sum();
    let attn = snap
        .attentions
        .iter()
        .map(attn_key)
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "debug: ingest send #{tick} ({}): {} session(s), {panes} pane(s), claude={}, attentions=[{attn}], {body_bytes} bytes",
        reason.as_str(),
        snap.sessions.len(),
        if snap.claude_active { "active" } else { "idle" }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AttentionState, MachineIdentity, MachineVisibility, PrivacyEcho};
    use crate::model::{NameVisibility, Session, SessionState, WIRE_VERSION};

    fn attn(kind: &str, sid: &str, tab: usize, pane: u32) -> Attention {
        Attention {
            kind: kind.to_string(),
            target: AttentionTarget {
                machine_id: None,
                session_sid: Some(sid.to_string()),
                tab_id: Some(tab),
                pane_id: Some(pane),
            },
            state: AttentionState::Active,
            since: 0.0,
            detail: None,
        }
    }

    fn pane(session: &str, tab_id: usize, pane_id: u32, fresh: bool) -> PaneObs {
        PaneObs {
            session: session.to_string(),
            tab_id,
            pane_id,
            title: "✳ Claude Code".to_string(),
            is_claude: true,
            fresh,
        }
    }

    #[test]
    fn non_claude_panes_produce_no_claude_transition_lines() {
        let mut d = DebugState::default();
        let shell = PaneObs {
            session: "work".into(),
            tab_id: 0,
            pane_id: 3,
            title: "nvim".into(),
            is_claude: false,
            fresh: true, // busy, but not claude — must not count anywhere
        };
        assert!(d.tick_lines(&[], &[shell]).is_empty());
    }

    #[test]
    fn pane_title_lines_show_the_raw_title_verdict_and_freshness() {
        let obs = [
            pane("work", 2, 2, true),
            PaneObs {
                session: "work".into(),
                tab_id: 0,
                pane_id: 3,
                // The ADR-0052 motivating case: a sparkle VARIANT the detector rejects must be
                // visible verbatim in the log so the mismatch can be proven from the field.
                title: "✻ Claude Code".into(),
                is_claude: false,
                fresh: true,
            },
        ];
        assert_eq!(
            pane_title_lines(&obs),
            vec![
                "debug:   pane: session \"work\" tab 2 pane 2 claude=yes fresh=yes title=\"✳ Claude Code\"",
                "debug:   pane: session \"work\" tab 0 pane 3 claude=no fresh=yes title=\"✻ Claude Code\"",
            ]
        );
    }

    #[test]
    fn attention_onset_and_clear_are_logged_once_each() {
        let mut d = DebugState::default();
        let a = attn("claude.thinking", "sdeadbeef99", 0, 7);
        let onset = d.tick_lines(std::slice::from_ref(&a), &[]);
        assert_eq!(
            onset,
            // The sid is truncated to "s" + 8 hex in the target.
            vec!["debug: attention onset: claude.thinking @ sdeadbeef:0:7"]
        );
        // Still active → no repeat line (edges only).
        assert!(d.tick_lines(&[a], &[]).is_empty());
        // Cleared (absent from this tick's set) → one clear line.
        assert_eq!(
            d.tick_lines(&[], &[]),
            vec!["debug: attention cleared: claude.thinking @ sdeadbeef:0:7"]
        );
        assert!(d.tick_lines(&[], &[]).is_empty());
    }

    #[test]
    fn claude_pane_transitions_are_edges_only() {
        let mut d = DebugState::default();
        // First sighting (never fresh on a first observation, ADR-0034) → seen + machine-level IDLE.
        let l1 = d.tick_lines(&[], &[pane("work", 0, 7, false)]);
        assert_eq!(
            l1,
            vec![
                "debug: claude pane seen: session \"work\" tab 0 pane 7 (idle — output settled)",
                "debug: claude IDLE across all sessions — 0/1 claude pane(s) producing output (the \
                 backend's claude.idle threshold counts from here)",
            ]
        );
        // Output starts changing → pane goes active AND the machine-level edge flips.
        let l2 = d.tick_lines(&[], &[pane("work", 0, 7, true)]);
        assert_eq!(
            l2,
            vec![
                "debug: claude pane active — producing output: session \"work\" tab 0 pane 7",
                "debug: claude ACTIVE — 1/1 claude pane(s) producing output",
            ]
        );
        // Unchanged → silence.
        assert!(d.tick_lines(&[], &[pane("work", 0, 7, true)]).is_empty());
        // Settles again → both edges flip back.
        let l4 = d.tick_lines(&[], &[pane("work", 0, 7, false)]);
        assert_eq!(l4.len(), 2);
        assert!(l4[0].contains("idle — output settled"));
        assert!(l4[1].contains("claude IDLE across all sessions"));
    }

    #[test]
    fn machine_edge_tracks_any_pane_across_sessions() {
        let mut d = DebugState::default();
        // Two sessions, one pane each; only one is producing output → ACTIVE 1/2.
        let first = d.tick_lines(
            &[],
            &[pane("work", 0, 7, true), pane("side", 1, 9, false)],
        );
        assert!(first
            .iter()
            .any(|l| l == "debug: claude ACTIVE — 1/2 claude pane(s) producing output"));
        // The busy one settles → ALL sessions idle, exactly one machine-level line.
        let idle = d.tick_lines(
            &[],
            &[pane("work", 0, 7, false), pane("side", 1, 9, false)],
        );
        assert_eq!(
            idle.iter()
                .filter(|l| l.contains("claude IDLE across all sessions"))
                .count(),
            1
        );
        assert!(idle.iter().any(|l| l.contains("0/2")));
    }

    #[test]
    fn a_disappearing_claude_pane_is_logged_and_resets_the_machine_edge() {
        let mut d = DebugState::default();
        d.tick_lines(&[], &[pane("work", 0, 7, true)]);
        let gone = d.tick_lines(&[], &[]);
        assert_eq!(
            gone,
            vec![
                "debug: claude pane gone: session \"work\" tab 0 pane 7",
                "debug: no claude panes visible on this machine",
            ]
        );
        // A later pane starts a fresh machine-level picture (state was reset, so it logs again).
        let back = d.tick_lines(&[], &[pane("work", 0, 7, false)]);
        assert!(back.iter().any(|l| l.contains("claude IDLE across all sessions")));
    }

    #[test]
    fn ingest_line_summarises_the_wire_contents() {
        let snap = SnapshotV4 {
            version: WIRE_VERSION,
            machine_id: "m-1".into(),
            captured_at_tick: 12,
            privacy: PrivacyEcho {
                full: true,
                machine: MachineVisibility::Real,
                session_names: NameVisibility::Send,
                tab_names: NameVisibility::Send,
                pane_names: NameVisibility::Send,
            },
            machine: MachineIdentity {
                name: None,
                source: MachineVisibility::Real,
            },
            attentions: vec![attn("claude.thinking", "sdeadbeef99", 0, 7)],
            sessions: vec![Session {
                sid: "sdeadbeef99".into(),
                name: Some("work".into()),
                is_current: true,
                state: SessionState::Live,
                died_seconds_ago: None,
                tabs: vec![],
            }],
            claude_active: true,
        };
        assert_eq!(
            ingest_line(12, SendReason::Notable, &snap, 1682),
            "debug: ingest send #12 (notable): 1 session(s), 0 pane(s), claude=active, \
             attentions=[claude.thinking @ sdeadbeef:0:7], 1682 bytes"
        );
    }
}
