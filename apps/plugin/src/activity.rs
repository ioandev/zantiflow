//! Per-pane content-freshness tracking for the `claude.thinking` detector (ADR-0025 fix). Zellij emits
//! no "new stdout" event, and Claude Code leaves a background pane's spinner glyph FROZEN when a turn
//! ends — so the pane-title marker alone can't tell "still thinking" from "finished" (a frozen `⠂`
//! looks identical to a live frame). We disambiguate with OBSERVED activity: a pane counts as thinking
//! only while its content is still changing. Each tick we already fingerprint every pane (the activity
//! signal, `fingerprint::content_fingerprint`); here we remember the wall-tick of each pane's last
//! change and report whether it is FRESH. When Claude finishes and the output settles, freshness lapses
//! within a few seconds → the `claude.thinking` attention clears (a structural change the send-gate
//! pushes promptly), even though the frozen glyph itself never changed.
use std::collections::{HashMap, HashSet};

/// A pane counts as "actively producing output" for this many wall-ticks (~seconds) after its last
/// observed content change. Wide enough to bridge the ~1 s sampling and any brief pause between
/// Claude's streamed chunks (its spinner's elapsed-time counter re-renders every second while a turn
/// is in flight, so a truly-thinking pane changes every tick), tight enough that "thinking" clears
/// within a few seconds of the turn ending.
const THINKING_STALE_TICKS: u64 = 8;

/// One pane's last-seen fingerprint and the wall-tick at which it last *changed*. `changed_at` is
/// `None` until we've observed an actual change — a first-ever sample is never "fresh", so an idle pane
/// whose title happens to carry a frozen spinner frame doesn't false-fire on plugin startup.
struct Entry {
    fp: String,
    changed_at: Option<u64>,
}

/// Remembers each pane's fingerprint across ticks so [`observe`] can report freshness. Owned by the
/// plugin across ticks; bounded to live panes via [`retain`].
///
/// [`observe`]: PaneActivity::observe
/// [`retain`]: PaneActivity::retain
#[derive(Default)]
pub struct PaneActivity {
    seen: HashMap<String, Entry>,
}

impl PaneActivity {
    /// Record `fp` for `key` at `wall_tick`, then report whether the pane is FRESH — i.e. its content
    /// changed within the last [`THINKING_STALE_TICKS`]. A first-ever observation returns `false`
    /// (we require at least one observed change before claiming activity).
    pub fn observe(&mut self, key: &str, fp: &str, wall_tick: u64) -> bool {
        match self.seen.get_mut(key) {
            None => {
                self.seen.insert(
                    key.to_string(),
                    Entry {
                        fp: fp.to_string(),
                        changed_at: None,
                    },
                );
                false
            }
            Some(entry) => {
                if entry.fp != fp {
                    entry.fp = fp.to_string();
                    entry.changed_at = Some(wall_tick);
                    true
                } else {
                    entry
                        .changed_at
                        .is_some_and(|c| wall_tick.saturating_sub(c) < THINKING_STALE_TICKS)
                }
            }
        }
    }

    /// Drop panes no longer present so the map stays bounded to what's live (closed panes never return).
    pub fn retain(&mut self, live_keys: &HashSet<String>) {
        self.seen.retain(|k, _| live_keys.contains(k));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_observation_is_never_fresh() {
        let mut a = PaneActivity::default();
        // A pane we've never seen — even one whose glyph is a frozen spinner frame — is not "fresh":
        // we have no evidence its content is changing yet.
        assert!(!a.observe("p", "fp1", 1));
    }

    #[test]
    fn a_change_is_fresh_then_decays_after_the_stale_window() {
        let mut a = PaneActivity::default();
        assert!(!a.observe("p", "fp1", 1)); // first sample: not fresh
        assert!(a.observe("p", "fp2", 2)); // changed at tick 2 → fresh
                                           // Unchanged, still within the window → stays fresh.
        assert!(a.observe("p", "fp2", 2 + THINKING_STALE_TICKS - 1));
        // Unchanged past the window → no longer fresh (Claude finished; output settled).
        assert!(!a.observe("p", "fp2", 2 + THINKING_STALE_TICKS));
        // A later change re-arms freshness from that tick.
        assert!(a.observe("p", "fp3", 100));
        assert!(!a.observe("p", "fp3", 100 + THINKING_STALE_TICKS));
    }

    #[test]
    fn a_frozen_fingerprint_never_becomes_fresh_on_its_own() {
        let mut a = PaneActivity::default();
        a.observe("p", "frozen", 1);
        // No matter how many ticks pass, an unchanging fingerprint that never changed is never fresh.
        for w in 2..50 {
            assert!(!a.observe("p", "frozen", w), "tick {w} must stay stale");
        }
    }

    #[test]
    fn retain_drops_panes_that_closed() {
        let mut a = PaneActivity::default();
        a.observe("keep", "x", 1);
        a.observe("drop", "y", 1);
        let live: HashSet<String> = ["keep".to_string()].into_iter().collect();
        a.retain(&live);
        assert!(a.seen.contains_key("keep"));
        assert!(!a.seen.contains_key("drop"));
    }
}
