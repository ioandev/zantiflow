//! Change-driven, presence-aware send cadence (ADR-0026). This is the decision core that replaces the
//! old "POST every tick": given the current snapshot's change-signature, whether an attention is
//! active, and whether a dashboard is watching, decide whether to POST a snapshot *this* tick.
//!
//! It lives in a pure, native module (no `zellij-tile`, no FFI) so the whole policy is unit-tested off
//! the wasm target — `plugin.rs` only feeds it inputs and acts on the boolean.
//!
//! All intervals are counted in **wall-ticks** (the ~1 s timer, incremented every `Timer` regardless
//! of whether we send), so they are independent of how often we actually POST.

/// The cheap always-on control poll runs every ~5 s (reuses the ADR-0016 output cadence).
pub const CONTROL_POLL_EVERY_TICKS: u64 = 5;
/// Long-poll (ADR-0029, opt-in): how long the plugin asks the backend to hold the control response.
/// Must stay below the backend clamp and the 60 s read-filter. On a response the plugin re-issues on
/// the next tick, so a pending pane-output request reaches it in ≈1 tick instead of up to ~5 s.
pub const LONG_POLL_WAIT_MS: u64 = 25_000;
/// Long-poll watchdog: if no `WebRequestResult` returns within this many wall-ticks of issuing a held
/// request, assume the host silently dropped it and re-issue. Must exceed the hold (25 s ≈ 25 ticks)
/// plus slack, so a normally-returning long-poll is never re-issued early.
pub const CONTROL_WATCHDOG_TICKS: u64 = 35;
// Compile-time invariant: the hold (in ~1 s ticks) sits safely inside the watchdog window, so a
// normally-returning long-poll is never mistaken for a dropped one.
const _: () = assert!(LONG_POLL_WAIT_MS / 1000 < CONTROL_WATCHDOG_TICKS);
/// An attention onset / structural change sends after this short debounce (absorbs flapping) — it
/// bypasses the coalesce floors so a `claude.needs-input` onset reaches the backend promptly and the
/// notification fires on time.
pub const ONSET_DEBOUNCE_TICKS: u64 = 2;
/// While a dashboard is watching, a content change coalesces to at most one send per ~15 s.
pub const WATCHED_FLOOR_TICKS: u64 = 15;
/// While nobody is watching, a content change coalesces to at most one send per ~30 s.
pub const IDLE_FLOOR_TICKS: u64 = 30;
/// While any attention is active, re-send at least this often so the backend keeps the episode alive
/// and fires (and re-fires after cooldown) within the ~2 min budget.
pub const KEEPALIVE_TICKS: u64 = 30;
/// Heartbeat floor (ADR-0051): re-send a full snapshot after this much send-silence even with NO
/// change, bounding backend staleness and self-healing a lost fire-and-forget ingest. The backend
/// prices the real interval by tier via the control response (30 pro / 300 free); this default IS
/// the free interval, so a plugin that never hears back is never more generous than the account earns.
pub const HEARTBEAT_DEFAULT_TICKS: u64 = 300;
/// Clamp bounds on a backend-supplied heartbeat interval: a buggy/hostile backend can neither induce
/// near-1 s spam nor stretch the bound past an hour.
pub const HEARTBEAT_MIN_TICKS: u64 = 10;
pub const HEARTBEAT_MAX_TICKS: u64 = 3600;

/// Whether to issue a control poll this wall-tick (ADR-0026/0029). Pure so it is unit-tested off the
/// wasm target; `plugin.rs` only feeds it state and acts on the boolean.
///
/// - **Fixed poll** (`long_poll = false`, the ADR-0026 default — unchanged): fire every
///   [`CONTROL_POLL_EVERY_TICKS`], regardless of any in-flight request.
/// - **Long-poll** (`long_poll = true`, ADR-0029): keep exactly one request outstanding — fire when
///   none is in flight, or when the [`CONTROL_WATCHDOG_TICKS`] watchdog has expired since it was
///   issued (the host dropped the held request without delivering a result).
pub fn control_poll_due(long_poll: bool, wall_tick: u64, inflight: bool, issued_wall: u64) -> bool {
    if long_poll {
        !inflight || wall_tick.saturating_sub(issued_wall) >= CONTROL_WATCHDOG_TICKS
    } else {
        wall_tick.is_multiple_of(CONTROL_POLL_EVERY_TICKS)
    }
}

/// One tick's change inputs. `salient` covers *any* change (tree structure + pane fingerprints +
/// attentions); `structural` covers only the "notable" subset (structure + attentions, NOT
/// fingerprints), so a change in `structural` means an attention onset/clear or a tree change.
pub struct Tick {
    pub wall_tick: u64,
    pub salient: u64,
    pub structural: u64,
    pub attention_active: bool,
}

/// WHY the send-gate decided to POST this tick — one variant per [`SendGate::decide_reason`] branch.
/// Only consumed by the ADR-0049 debug log line; the send behavior itself is unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendReason {
    /// First-ever send after load.
    First,
    /// Explicit one-shot force: cold-start re-arm, unwatched→watched edge, or a manual refresh.
    Forced,
    /// Structural/attention change past the onset debounce.
    Notable,
    /// Pane-content change past the presence-dependent coalesce floor.
    Content,
    /// Attention-active keepalive.
    Keepalive,
    /// Tier-paced no-change heartbeat (ADR-0051) — the weakest reason, only when nothing else fired.
    Heartbeat,
}

impl SendReason {
    pub fn as_str(self) -> &'static str {
        match self {
            SendReason::First => "first",
            SendReason::Forced => "forced",
            SendReason::Notable => "notable",
            SendReason::Content => "content",
            SendReason::Keepalive => "keepalive",
            SendReason::Heartbeat => "heartbeat",
        }
    }
}

/// Remembers what was last sent so each tick's decision is O(1). Owned by the plugin across ticks.
pub struct SendGate {
    last_salient: Option<u64>,
    last_structural: Option<u64>,
    last_send_wall: u64,
    watched: bool,
    /// One-shot: forces the next decision to send (cold-start / unwatched→watched / manual refresh).
    force: bool,
    /// Max send-silence before a no-change heartbeat fires (ADR-0051), in wall-ticks (~seconds).
    /// Starts at the free-tier default; re-priced by each control response via [`set_heartbeat_secs`].
    ///
    /// [`set_heartbeat_secs`]: SendGate::set_heartbeat_secs
    heartbeat_ticks: u64,
}

impl Default for SendGate {
    fn default() -> Self {
        SendGate {
            last_salient: None,
            last_structural: None,
            last_send_wall: 0,
            watched: false,
            force: false,
            heartbeat_ticks: HEARTBEAT_DEFAULT_TICKS,
        }
    }
}

impl SendGate {
    /// Apply the backend's tier-priced heartbeat interval (seconds ≈ wall-ticks), clamped so a
    /// misbehaving backend can't turn the heartbeat into ~1 s spam or push it past an hour.
    pub fn set_heartbeat_secs(&mut self, secs: u64) {
        self.heartbeat_ticks = secs.clamp(HEARTBEAT_MIN_TICKS, HEARTBEAT_MAX_TICKS);
    }

    /// Force a send at the next tick (manual refresh, or any explicit reason).
    pub fn force(&mut self) {
        self.force = true;
    }

    /// Update the watched flag from the control response; a rising edge (unwatched→watched) forces a
    /// fresh send so a viewer who just opened the dashboard sees current data quickly.
    pub fn set_watched(&mut self, now_watched: bool) {
        if now_watched && !self.watched {
            self.force = true;
        }
        self.watched = now_watched;
    }

    pub fn watched(&self) -> bool {
        self.watched
    }

    /// Decide whether to POST a snapshot this tick. Pure (does not mutate) — call [`record_sent`] iff
    /// you actually send.
    ///
    /// [`record_sent`]: SendGate::record_sent
    pub fn decide(&self, t: &Tick) -> bool {
        self.decide_reason(t).is_some()
    }

    /// [`decide`], but naming WHICH branch fired (`None` = don't send) so the ADR-0049 debug log can
    /// report why a snapshot went out. Same logic, same order — `decide` delegates here.
    ///
    /// [`decide`]: SendGate::decide
    pub fn decide_reason(&self, t: &Tick) -> Option<SendReason> {
        // First-ever send, or an explicit force (cold-start / unwatched→watched / refresh).
        if self.last_salient.is_none() {
            return Some(SendReason::First);
        }
        if self.force {
            return Some(SendReason::Forced);
        }
        let elapsed = t.wall_tick.saturating_sub(self.last_send_wall);
        let notable = self.last_structural != Some(t.structural); // attention onset/clear or tree change
        let content_dirty = self.last_salient != Some(t.salient); // any change, incl. pane content

        // A notable change is latency-sensitive (it may start/stop a notification) → send promptly,
        // bypassing the coalesce floor after only a short debounce.
        if notable && elapsed >= ONSET_DEBOUNCE_TICKS {
            return Some(SendReason::Notable);
        }
        // A pure content change coalesces to the presence-dependent floor. Nobody watching + no change
        // ⇒ neither branch fires ⇒ we send nothing (the core win).
        if content_dirty {
            let floor = if self.watched {
                WATCHED_FLOOR_TICKS
            } else {
                IDLE_FLOOR_TICKS
            };
            if elapsed >= floor {
                return Some(SendReason::Content);
            }
        }
        // Keepalive while an attention is active so the backend's ingest-driven engine keeps firing.
        if t.attention_active && elapsed >= KEEPALIVE_TICKS {
            return Some(SendReason::Keepalive);
        }
        // Tier-paced heartbeat (ADR-0051), the weakest reason: bound send-silence even with no change
        // at all, so backend staleness is capped and a lost fire-and-forget ingest self-heals.
        if elapsed >= self.heartbeat_ticks {
            return Some(SendReason::Heartbeat);
        }
        None
    }

    /// Record that a snapshot with this tick's signatures was sent; clears the one-shot force.
    pub fn record_sent(&mut self, t: &Tick) {
        self.last_salient = Some(t.salient);
        self.last_structural = Some(t.structural);
        self.last_send_wall = t.wall_tick;
        self.force = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tick with no notable/content change relative to `(salient, structural)`.
    fn tick(wall: u64, salient: u64, structural: u64, attention: bool) -> Tick {
        Tick {
            wall_tick: wall,
            salient,
            structural,
            attention_active: attention,
        }
    }

    #[test]
    fn cold_start_always_sends_then_records() {
        let mut g = SendGate::default();
        let t = tick(1, 100, 10, false);
        assert!(g.decide(&t), "first-ever tick must send");
        g.record_sent(&t);
        // Same signature, nothing watching, no attention → nothing to send.
        assert!(!g.decide(&tick(2, 100, 10, false)));
    }

    #[test]
    fn idle_unwatched_no_change_sends_nothing() {
        let mut g = SendGate::default();
        let t = tick(1, 100, 10, false);
        g.decide(&t);
        g.record_sent(&t);
        for w in 2..=200 {
            assert!(
                !g.decide(&tick(w, 100, 10, false)),
                "idle tick {w} must be silent"
            );
        }
    }

    #[test]
    fn content_change_coalesces_to_idle_floor_when_unwatched() {
        let mut g = SendGate::default();
        let first = tick(1, 100, 10, false);
        g.decide(&first);
        g.record_sent(&first);
        // Fingerprint churns (salient changes, structural stable). Below the 30-tick floor → silent.
        assert!(!g.decide(&tick(1 + IDLE_FLOOR_TICKS - 1, 101, 10, false)));
        // At the floor → send.
        assert!(g.decide(&tick(1 + IDLE_FLOOR_TICKS, 101, 10, false)));
    }

    #[test]
    fn content_change_uses_the_tighter_watched_floor() {
        let mut g = SendGate::default();
        let first = tick(1, 100, 10, false);
        g.decide(&first);
        g.record_sent(&first);
        g.set_watched(true); // forces a send on the rising edge
        let edge = tick(2, 100, 10, false);
        assert!(g.decide(&edge));
        g.record_sent(&edge); // clears the force; last send at wall 2
        assert!(!g.decide(&tick(2 + WATCHED_FLOOR_TICKS - 1, 200, 10, false)));
        assert!(g.decide(&tick(2 + WATCHED_FLOOR_TICKS, 200, 10, false)));
    }

    #[test]
    fn notable_change_bypasses_the_floor_after_a_short_debounce() {
        let mut g = SendGate::default();
        let first = tick(1, 100, 10, false);
        g.decide(&first);
        g.record_sent(&first);
        // An attention onset changes BOTH signatures. Within the debounce → wait.
        assert!(!g.decide(&tick(1 + ONSET_DEBOUNCE_TICKS - 1, 105, 11, true)));
        // At the debounce → send, far below the 30-tick idle floor.
        assert!(g.decide(&tick(1 + ONSET_DEBOUNCE_TICKS, 105, 11, true)));
    }

    #[test]
    fn keepalive_resends_while_an_attention_is_active_even_with_no_change() {
        let mut g = SendGate::default();
        let first = tick(1, 100, 10, true);
        g.decide(&first);
        g.record_sent(&first);
        // Nothing changes, but the attention stays active → re-send at the keepalive interval.
        assert!(!g.decide(&tick(1 + KEEPALIVE_TICKS - 1, 100, 10, true)));
        assert!(g.decide(&tick(1 + KEEPALIVE_TICKS, 100, 10, true)));
    }

    #[test]
    fn decide_reason_names_the_branch_that_fired() {
        let mut g = SendGate::default();
        let first = tick(1, 100, 10, false);
        assert_eq!(g.decide_reason(&first), Some(SendReason::First));
        g.record_sent(&first);
        // No change → no reason (and decide agrees).
        assert_eq!(g.decide_reason(&tick(2, 100, 10, false)), None);
        assert!(!g.decide(&tick(2, 100, 10, false)));
        // Structural change past the debounce → Notable.
        assert_eq!(
            g.decide_reason(&tick(1 + ONSET_DEBOUNCE_TICKS, 105, 11, false)),
            Some(SendReason::Notable)
        );
        // Pure content change at the idle floor → Content.
        assert_eq!(
            g.decide_reason(&tick(1 + IDLE_FLOOR_TICKS, 101, 10, false)),
            Some(SendReason::Content)
        );
        // Unchanged but attention-active at the keepalive interval → Keepalive.
        assert_eq!(
            g.decide_reason(&tick(1 + KEEPALIVE_TICKS, 100, 10, true)),
            Some(SendReason::Keepalive)
        );
        // A one-shot force wins over "no change".
        g.force();
        assert_eq!(
            g.decide_reason(&tick(3, 100, 10, false)),
            Some(SendReason::Forced)
        );
    }

    #[test]
    fn heartbeat_bounds_send_silence_at_the_free_default() {
        let mut g = SendGate::default();
        let first = tick(1, 100, 10, false);
        g.decide(&first);
        g.record_sent(&first);
        // Idle, unwatched, unchanged: silent right up to the 300-tick floor…
        assert!(!g.decide(&tick(1 + HEARTBEAT_DEFAULT_TICKS - 1, 100, 10, false)));
        // …then the heartbeat fires, with its own (weakest) reason.
        assert_eq!(
            g.decide_reason(&tick(1 + HEARTBEAT_DEFAULT_TICKS, 100, 10, false)),
            Some(SendReason::Heartbeat)
        );
    }

    #[test]
    fn backend_priced_heartbeat_applies_and_the_clock_resets_on_every_send() {
        let mut g = SendGate::default();
        g.set_heartbeat_secs(30); // the pro interval, as the control response prices it
        let first = tick(1, 100, 10, false);
        g.decide(&first);
        g.record_sent(&first);
        assert!(!g.decide(&tick(30, 100, 10, false))); // 29 elapsed → not yet
        let hb = tick(31, 100, 10, false);
        assert_eq!(g.decide_reason(&hb), Some(SendReason::Heartbeat));
        g.record_sent(&hb);
        // The next heartbeat counts from the LAST send, whatever its reason.
        assert!(!g.decide(&tick(60, 100, 10, false)));
        assert_eq!(
            g.decide_reason(&tick(61, 100, 10, false)),
            Some(SendReason::Heartbeat)
        );
    }

    #[test]
    fn heartbeat_interval_is_clamped_against_a_misbehaving_backend() {
        let mut g = SendGate::default();
        let first = tick(1, 100, 10, false);
        g.decide(&first);
        g.record_sent(&first);
        // A 1 s interval would be spam — clamped up to the 10-tick floor.
        g.set_heartbeat_secs(1);
        assert!(!g.decide(&tick(1 + HEARTBEAT_MIN_TICKS - 1, 100, 10, false)));
        assert!(g.decide(&tick(1 + HEARTBEAT_MIN_TICKS, 100, 10, false)));
        // An absurdly long interval is clamped down to the 1 h ceiling.
        g.set_heartbeat_secs(1_000_000);
        assert!(!g.decide(&tick(1 + HEARTBEAT_MAX_TICKS - 1, 100, 10, false)));
        assert!(g.decide(&tick(1 + HEARTBEAT_MAX_TICKS, 100, 10, false)));
    }

    #[test]
    fn fixed_poll_fires_every_five_ticks_regardless_of_inflight() {
        // The ADR-0026 default (long_poll = false) is unchanged: due exactly on multiples of 5, and
        // the inflight/issued bookkeeping is ignored.
        for wall in 0..=20 {
            let due = control_poll_due(false, wall, true, wall); // inflight true — must not matter
            assert_eq!(
                due,
                wall.is_multiple_of(CONTROL_POLL_EVERY_TICKS),
                "tick {wall}"
            );
        }
    }

    #[test]
    fn long_poll_keeps_one_request_in_flight_and_watchdogs_a_dropped_one() {
        // Nothing in flight → issue now.
        assert!(control_poll_due(true, 10, false, 0));
        // In flight, within the watchdog window → wait (don't pile on a second request).
        assert!(!control_poll_due(true, 10, true, 8));
        assert!(!control_poll_due(
            true,
            8 + CONTROL_WATCHDOG_TICKS - 1,
            true,
            8
        ));
        // In flight but the watchdog elapsed with no result → re-issue (host dropped the held request).
        assert!(control_poll_due(true, 8 + CONTROL_WATCHDOG_TICKS, true, 8));
    }

    #[test]
    fn refresh_force_sends_once_then_clears() {
        let mut g = SendGate::default();
        let first = tick(1, 100, 10, false);
        g.decide(&first);
        g.record_sent(&first);
        g.force();
        let t = tick(3, 100, 10, false); // no change, but forced
        assert!(g.decide(&t));
        g.record_sent(&t);
        assert!(!g.decide(&tick(4, 100, 10, false)), "force is one-shot");
    }

    #[test]
    fn watched_rising_edge_forces_but_a_steady_watched_state_does_not() {
        let mut g = SendGate::default();
        let first = tick(1, 100, 10, false);
        g.decide(&first);
        g.record_sent(&first);
        g.set_watched(true); // false→true edge
        let e = tick(2, 100, 10, false);
        assert!(g.decide(&e));
        g.record_sent(&e);
        g.set_watched(true); // steady watched, no edge
        assert!(!g.decide(&tick(3, 100, 10, false)));
    }
}
