//! Behavioral (BDD-style) scenarios for the ADR-0026 send cadence. These drive the pure `SendGate`
//! decision core over a simulated multi-minute ~1 s timer loop and count how many snapshots would be
//! POSTed — the "idle unwatched → ~0 sends" guarantee, at the layer that is testable off-wasm
//! (`plugin.rs` is the thin FFI wiring; all the decision logic lives in `cadence`). Given / When /
//! Then are called out in each test.
use zantiflow_plugin::cadence::{SendGate, Tick};

const THREE_MINUTES: u64 = 180;

/// Run `SendGate` over `ticks` wall-ticks and return how many snapshots it would send. `inputs(w)`
/// yields `(salient, structural, attention_active)` for wall-tick `w`, so a scenario can hold them
/// constant (idle) or vary them (a repainting pane, an onset, …).
fn sends_over(ticks: u64, watched: bool, mut inputs: impl FnMut(u64) -> (u64, u64, bool)) -> u64 {
    let mut gate = SendGate::default();
    if watched {
        gate.set_watched(true); // an open dashboard: forces the cold-start send, tightens the floor
    }
    let mut sends = 0;
    for w in 1..=ticks {
        let (salient, structural, attention_active) = inputs(w);
        let t = Tick {
            wall_tick: w,
            salient,
            structural,
            attention_active,
        };
        if gate.decide(&t) {
            sends += 1;
            gate.record_sent(&t);
        }
    }
    sends
}

#[test]
fn idle_unwatched_machine_sends_only_the_cold_start_over_three_minutes() {
    // GIVEN an idle, unwatched machine — nothing changes, nobody is watching, no attention.
    // WHEN three minutes of ~1 s ticks pass.
    let sends = sends_over(THREE_MINUTES, false, |_| (42, 7, false));
    // THEN it POSTs exactly ONCE (the cold-start snapshot) — versus 180 under the old per-second model.
    assert_eq!(
        sends, 1,
        "an idle unwatched machine must go silent after cold-start"
    );
}

#[test]
fn a_repainting_pane_coalesces_to_the_30s_idle_floor_when_unwatched() {
    // GIVEN an unwatched machine whose pane repaints every tick (salient churns; structure stable).
    // WHEN three minutes pass.
    let sends = sends_over(THREE_MINUTES, false, |w| (w, 7, false));
    // THEN it sends at cold-start then once per 30-tick floor: ticks 1,31,61,91,121,151 = 6 (a ~30×
    // cut vs 180), never per-second.
    assert_eq!(sends, 6);
}

#[test]
fn a_watched_repainting_pane_uses_the_tighter_15s_floor() {
    // GIVEN a WATCHED machine whose pane repaints every tick.
    // WHEN three minutes pass.
    let sends = sends_over(THREE_MINUTES, true, |w| (w, 7, false));
    // THEN the rising-edge forces tick 1, then the 15-tick watched floor governs:
    // 1,16,31,46,61,76,91,106,121,136,151,166 = 12 — livelier than idle, still far from per-second.
    assert_eq!(sends, 12);
}

#[test]
fn an_active_attention_keeps_alive_so_the_backend_can_fire() {
    // GIVEN an unwatched machine with a persistent attention but no other change.
    // WHEN three minutes pass.
    let sends = sends_over(THREE_MINUTES, false, |_| (42, 7, true));
    // THEN after cold-start it re-sends every 30-tick keepalive (1,31,…,151 = 6) so the backend keeps
    // evaluating the threshold and fires (and re-fires after cooldown) within the ~2 min budget.
    assert_eq!(sends, 6);
}

#[test]
fn an_attention_onset_is_sent_promptly_not_after_the_idle_floor() {
    // GIVEN an idle unwatched machine that is quiet until, at tick 50, an attention appears (which
    // moves BOTH signatures — it is a notable change).
    let mut gate = SendGate::default();
    let mut first_send_after_onset = None;
    for w in 1..=120u64 {
        let attention = w >= 50;
        let structural = if attention { 8 } else { 7 };
        let salient = if attention { 100 } else { 42 };
        let t = Tick {
            wall_tick: w,
            salient,
            structural,
            attention_active: attention,
        };
        if gate.decide(&t) {
            gate.record_sent(&t);
            if attention && first_send_after_onset.is_none() {
                first_send_after_onset = Some(w);
            }
        }
    }
    // THEN the onset is POSTed within the ~2-tick debounce (tick 50), NOT after the 30-tick idle floor
    // — so `claude.needs-input` reaches the backend promptly and the notification fires on time.
    let onset = first_send_after_onset.expect("a send after the onset");
    assert!(
        onset <= 52,
        "onset should send by the 2-tick debounce, got tick {onset}"
    );
}
