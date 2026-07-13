//! Built-in attention detectors (ADR-0005 §3, ADR-0025). The plugin reports states worth acting on; it
//! owns NO thresholds — the backend enforces "how often" (tier-gated). These detectors are cheap,
//! best-effort heuristics run over what we already observe. `since` is left 0.0 here (the backend times
//! episodes on its own clock, ADR-0005 §5); the backend keys episodes by target + type.
use crate::model::{Attention, AttentionState, AttentionTarget};

/// Gate for the `claude.*` detectors: the pane is running a `claude` command.
pub fn is_claude_command(command: Option<&str>) -> bool {
    command
        .map(|c| c.to_lowercase().contains("claude"))
        .unwrap_or(false)
}

/// Prompt-dwell heuristic: the last non-blank line ends with `?` (ADR-0005 §3, best-effort).
pub fn last_line_is_prompt(content: &str) -> bool {
    content
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.ends_with('?'))
        .unwrap_or(false)
}

/// The static idle marker Claude Code shows before a task summary once a turn has finished: the `✳`
/// sparkle (U+2733), as opposed to the cycling Braille spinner while a turn is in flight.
const CLAUDE_IDLE_SPARKLE: char = '\u{2733}';

/// A char in the Unicode Braille Patterns block (U+2800..=U+28FF). Claude Code takes over the **pane
/// title** and, while a turn is in flight, prefixes it with a cycling Braille spinner frame (`⠋`, `⠙`,
/// `⠸`, `⠐`, …); once idle the leading glyph is the static `✳` sparkle instead. So "the title starts
/// with a Braille glyph" tells the two apart (see [`is_thinking_marker`]). U+2800 is the *blank*
/// pattern (visually empty) and never a live frame, so it is excluded.
fn is_braille_spinner(c: char) -> bool {
    ('\u{2801}'..='\u{28FF}').contains(&c)
}

/// True if `title` (a pane title), after any leading whitespace, begins with a Claude Code status
/// marker — the `✳` idle sparkle or a Braille spinner frame. Claude prefixes the pane title with this
/// marker, so it is the reliable "this pane runs Claude" signal; the pane `command` can't be relied on
/// (Zellij reports it as `null`). Mirrors the dashboard's `hasClaudeMarker`
/// (apps/web/lib/machineView.ts) — keep the two in step (ADR-0025).
pub fn has_claude_marker(title: &str) -> bool {
    matches!(
        title.trim_start().chars().next(),
        Some(c) if c == CLAUDE_IDLE_SPARKLE || is_braille_spinner(c)
    )
}

/// Gate for the `claude.*` detectors: this is a Claude pane. Primary signal is the pane-title marker
/// ([`has_claude_marker`]); `command` is only a fallback for a just-launched pane that hasn't set its
/// title yet (and is usually `null` anyway), so it can confirm but never exclude.
pub fn is_claude_pane(title: &str, command: Option<&str>) -> bool {
    has_claude_marker(title) || is_claude_command(command)
}

/// Thinking marker (ADR-0025, best-effort): the pane title's leading glyph — after any whitespace — is
/// a Braille spinner frame (a turn is in flight), as opposed to the static `✳` sparkle (idle):
///
/// ```text
/// ⠐ Implement homepage from design file   → spinner frame (maybe thinking)
/// ✳ Fix tabs showing output…              → idle sparkle (not thinking)
/// ```
///
/// This is only HALF the signal. Claude Code leaves the last spinner frame FROZEN in a background
/// pane's title when a turn ends, so a frozen `⠂` looks identical to a live one — the marker alone
/// can't tell "still thinking" from "finished". The caller pairs this with a freshness check
/// (`crate::activity`): thinking fires only while the pane is also still producing output, so a frozen
/// glyph clears within a few seconds of the turn ending. Inspected locally — only the attention *type*
/// ever leaves the machine (`detail` stays off, ADR-0005 §2).
pub fn is_thinking_marker(title: &str) -> bool {
    title
        .trim_start()
        .chars()
        .next()
        .is_some_and(is_braille_spinner)
}

/// A live session with no attached clients → `session.detached`.
pub fn detached(session_sid: &str) -> Attention {
    Attention {
        kind: "session.detached".to_string(),
        target: AttentionTarget {
            session_sid: Some(session_sid.to_string()),
            ..Default::default()
        },
        state: AttentionState::Active,
        since: 0.0,
        detail: None,
    }
}

/// A claude pane sitting on a prompt → `claude.needs-input`.
pub fn needs_input(session_sid: &str, tab_id: usize, pane_id: u32) -> Attention {
    Attention {
        kind: "claude.needs-input".to_string(),
        target: AttentionTarget {
            session_sid: Some(session_sid.to_string()),
            tab_id: Some(tab_id),
            pane_id: Some(pane_id),
            ..Default::default()
        },
        state: AttentionState::Active,
        since: 0.0,
        detail: None,
    }
}

/// A claude pane whose title shows a live (spinner-frame + still-producing-output) turn → `claude.thinking` (ADR-0025).
pub fn thinking(session_sid: &str, tab_id: usize, pane_id: u32) -> Attention {
    Attention {
        kind: "claude.thinking".to_string(),
        target: AttentionTarget {
            session_sid: Some(session_sid.to_string()),
            tab_id: Some(tab_id),
            pane_id: Some(pane_id),
            ..Default::default()
        },
        state: AttentionState::Active,
        since: 0.0,
        detail: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_claude_command_matches_case_insensitively() {
        assert!(is_claude_command(Some("claude")));
        assert!(is_claude_command(Some("/usr/bin/Claude --resume")));
        assert!(!is_claude_command(Some("nvim")));
        assert!(!is_claude_command(None));
    }

    #[test]
    fn last_line_is_prompt_ignores_trailing_blanks() {
        assert!(last_line_is_prompt("thinking...\nWhich file?\n\n  "));
        assert!(last_line_is_prompt("Continue?"));
        assert!(!last_line_is_prompt("done.\n"));
        assert!(!last_line_is_prompt(""));
    }

    #[test]
    fn is_thinking_marker_detects_a_leading_braille_spinner_in_the_pane_title() {
        // Claude Code prefixes the pane title with a cycling Braille spinner frame while working.
        assert!(is_thinking_marker("⠐ Implement homepage from design file"));
        // Any frame in the Braille block counts — the glyph cycles from tick to tick.
        assert!(is_thinking_marker("⠋ Fixing the parser"));
        assert!(is_thinking_marker("⠙ Fixing the parser"));
        assert!(is_thinking_marker("⠸ Fixing the parser"));
        assert!(is_thinking_marker("⠇ Fixing the parser"));
        // The real frozen frame seen on live panes (U+2802) counts as a spinner frame too — the
        // freshness check, not this marker, is what stops a frozen one reading as "thinking".
        assert!(is_thinking_marker("⠂ bug-tile-not-updated"));
        // Leading and/or padding whitespace around the dot is tolerated ("space before or after").
        assert!(is_thinking_marker("  ⠐  Implement homepage from design file"));
        // A spinner frame with no task text after it still counts.
        assert!(is_thinking_marker("⠙"));
    }

    #[test]
    fn is_thinking_marker_rejects_the_idle_sparkle_and_plain_names() {
        // The static ✳ sparkle Claude Code shows when idle is NOT a spinner frame (different block).
        assert!(!is_thinking_marker(
            "✳ Fix tabs showing output from different sessions"
        ));
        // Other non-Braille leading glyphs Claude Code / users might use are likewise not thinking.
        assert!(!is_thinking_marker("● Done"));
        assert!(!is_thinking_marker("* Fix tabs"));
        // A name with no leading glyph at all.
        assert!(!is_thinking_marker("editor"));
        assert!(!is_thinking_marker("Implement homepage from design file"));
        // Empty / whitespace-only.
        assert!(!is_thinking_marker(""));
        assert!(!is_thinking_marker("   "));
        // A Braille glyph that isn't at the start doesn't count — the spinner is always leading.
        assert!(!is_thinking_marker("build ⠐ step"));
        // The blank Braille pattern (U+2800) is visually empty — never a live frame.
        assert!(!is_thinking_marker("\u{2800} idle"));
        assert!(!is_thinking_marker("\u{2800}"));
    }

    #[test]
    fn has_claude_marker_matches_sparkle_or_spinner_but_not_plain_or_command() {
        // Idle sparkle and any spinner frame both mark a Claude pane (the dashboard keys off the same).
        assert!(has_claude_marker("✳ Claude Code"));
        assert!(has_claude_marker("⠂ bug-tile-not-updated"));
        assert!(has_claude_marker("⠐ other's licenses"));
        assert!(has_claude_marker("  ✳ padded"));
        // A plain shell/program title carries no marker.
        assert!(!has_claude_marker("nvim"));
        assert!(!has_claude_marker("nordic@host:/repos"));
        assert!(!has_claude_marker(""));
        // The blank Braille pattern is not a live marker.
        assert!(!has_claude_marker("\u{2800} idle"));
    }

    #[test]
    fn is_claude_pane_uses_the_title_marker_with_command_as_a_fallback() {
        // Primary: the title marker (command reported null, as Zellij usually does).
        assert!(is_claude_pane("✳ Claude Code", None));
        assert!(is_claude_pane("⠂ working", None));
        // Fallback: a just-launched pane whose title has no marker yet but whose command names claude.
        assert!(is_claude_pane("claude", Some("claude --resume")));
        assert!(is_claude_pane("bash", Some("/usr/bin/Claude")));
        // Neither → not a claude pane.
        assert!(!is_claude_pane("nvim", Some("nvim")));
        assert!(!is_claude_pane("nvim", None));
    }

    #[test]
    fn thinking_builder_targets_the_pane() {
        let t = thinking("s1", 2, 9);
        assert_eq!(t.kind, "claude.thinking");
        assert_eq!(t.target.session_sid.as_deref(), Some("s1"));
        assert_eq!(t.target.tab_id, Some(2));
        assert_eq!(t.target.pane_id, Some(9));
        assert_eq!(t.state, AttentionState::Active);
    }

    #[test]
    fn builders_set_type_target_and_active_state() {
        let d = detached("s1");
        assert_eq!(d.kind, "session.detached");
        assert_eq!(d.target.session_sid.as_deref(), Some("s1"));
        assert_eq!(d.state, AttentionState::Active);

        let n = needs_input("s1", 0, 3);
        assert_eq!(n.kind, "claude.needs-input");
        assert_eq!(n.target.pane_id, Some(3));
        assert_eq!(n.target.tab_id, Some(0));
    }
}
