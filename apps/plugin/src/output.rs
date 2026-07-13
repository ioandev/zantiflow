//! Building an on-demand pane-output delivery (ADR-0016). The plugin captures the last ≤50 lines of a
//! pane's content, SCRUBS each (ADR-0017, in the plugin, before send), and delivers them. The channel
//! is OFF by default (`pane_output`); content otherwise never leaves the machine.
//!
//! **Colour source (verified against zellij 0.44.3).** `get_pane_scrollback` returns the viewport with
//! **all ANSI stripped** (server-side `grid.pane_contents()` keeps only each cell's character), so it
//! can never carry colour. The only plugin-reachable ANSI is the `PaneRenderReportWithAnsi` event,
//! which pushes an ANSI-preserving viewport for each pane **as it renders**. [`OutputCache`] holds the
//! latest such frame per pane; `deliver_output` serves colour from it and falls back to the plain
//! scrollback for panes that haven't rendered since we subscribed.
use crate::scrub::Scrubber;
use std::collections::{HashMap, HashSet};

pub const MAX_OUTPUT_LINES: usize = 50;

/// Per-pane cache of the latest ANSI-coloured viewport, fed by `PaneRenderReportWithAnsi` events.
/// Only populated while `pane_output` is ON (we subscribe/unsubscribe with the flag) and pruned to
/// live panes so it stays bounded.
#[derive(Default)]
pub struct OutputCache {
    latest: HashMap<u32, String>,
}

impl OutputCache {
    /// Record the latest rendered (ANSI-preserving) content for a terminal pane.
    pub fn record(&mut self, pane_id: u32, content: String) {
        self.latest.insert(pane_id, content);
    }

    /// The latest cached ANSI content for a pane, if it has rendered since we subscribed.
    pub fn get(&self, pane_id: u32) -> Option<&str> {
        self.latest.get(&pane_id).map(String::as_str)
    }

    /// Drop entries for panes that no longer exist, bounding memory to the live pane set.
    pub fn retain_panes(&mut self, live: &HashSet<u32>) {
        self.latest.retain(|id, _| live.contains(id));
    }

    /// Forget everything (called when output sharing is turned OFF).
    pub fn clear(&mut self) {
        self.latest.clear();
    }
}

/// The last ≤50 lines of captured content, each scrubbed of secrets (ANSI preserved).
pub fn build_output_lines(scrubber: &Scrubber, content: &str) -> Vec<String> {
    let all: Vec<&str> = content.lines().collect();
    let start = all.len().saturating_sub(MAX_OUTPUT_LINES);
    let tail: Vec<String> = all[start..].iter().map(|s| (*s).to_string()).collect();
    scrubber.scrub_lines(&tail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scrub::MASK;

    #[test]
    fn takes_the_last_50_lines() {
        let content = (1..=120)
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        let lines = build_output_lines(&Scrubber::new(&[]), &content);
        assert_eq!(lines.len(), MAX_OUTPUT_LINES);
        assert_eq!(lines.first().unwrap(), "71"); // 120 - 50 + 1
        assert_eq!(lines.last().unwrap(), "120");
    }

    #[test]
    fn scrubs_each_delivered_line() {
        let content = "line1\ntoken=ztf_ABCDEFGHIJKLMNOPQRSTUV\nline3";
        let lines = build_output_lines(&Scrubber::new(&[]), content);
        assert_eq!(lines.len(), 3);
        assert!(lines[1].contains(MASK));
        assert!(!lines[1].contains("ztf_ABCDEFGHIJKLMNOPQRSTUV"));
    }

    #[test]
    fn preserves_ansi_from_the_cache_through_to_delivered_lines() {
        // The whole point of the cache: colour survives capture → scrub → deliver.
        let mut cache = OutputCache::default();
        cache.record(7, "\x1b[31mred line\x1b[0m\nplain".to_string());
        let content = cache.get(7).unwrap().to_string();
        let lines = build_output_lines(&Scrubber::new(&[]), &content);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("\x1b[31m")); // SGR colour code survives to the wire
        assert_eq!(lines[1], "plain");
    }

    #[test]
    fn cache_records_and_reads_by_pane() {
        let mut cache = OutputCache::default();
        assert!(cache.get(1).is_none());
        cache.record(1, "first".to_string());
        cache.record(1, "second".to_string()); // latest-wins
        assert_eq!(cache.get(1), Some("second"));
        assert!(cache.get(2).is_none());
    }

    #[test]
    fn cache_retain_prunes_dead_panes() {
        let mut cache = OutputCache::default();
        cache.record(1, "a".to_string());
        cache.record(2, "b".to_string());
        cache.record(3, "c".to_string());
        let live: HashSet<u32> = [1, 3].into_iter().collect();
        cache.retain_panes(&live);
        assert_eq!(cache.get(1), Some("a"));
        assert!(cache.get(2).is_none()); // pane 2 gone → dropped
        assert_eq!(cache.get(3), Some("c"));
        cache.clear();
        assert!(cache.get(1).is_none());
    }
}
