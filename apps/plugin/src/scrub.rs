//! Secret scrubbing for the on-demand pane-output channel (ADR-0017). Runs IN THE PLUGIN, before any
//! output leaves the machine — the backend never receives raw secrets. The `regex` crate is
//! linear-time, so the ruleset (built-in + any user-supplied patterns) is **ReDoS-safe by
//! construction**. Scrubbing preserves ANSI escapes (we replace secret substrings, not whole lines).
use regex::Regex;
use std::sync::OnceLock;

pub const MASK: &str = "«redacted»";
/// Only the last N bytes of a line are scanned — a hostile pane can't force unbounded work.
const MAX_LINE_SCAN: usize = 8 * 1024;

// Built-in ruleset (Appendix C). Ordered longest/most-specific first so broad rules don't pre-empt.
const BUILTIN: &[&str] = &[
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
    r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", // JWT
    r"ztf_[A-Za-z0-9]{20,}",
    r"gh[pousr]_[A-Za-z0-9]{20,}",
    r"xox[baprs]-[A-Za-z0-9-]+",
    r"sk_live_[A-Za-z0-9]+",
    r"sk-[A-Za-z0-9]{20,}",
    r"AKIA[0-9A-Z]{16}",
    // Value-matchers stop at ANSI ESC (\x1b) so a trailing colour reset is preserved, not eaten.
    r"(?i)(password|secret|token|api[_-]?key)\s*[:=]\s*[^\s\x1b]+",
    r"[a-z][a-z0-9+.-]*://[^:@\s\x1b]+:[^@\s\x1b]+@", // connection-string credentials
];

fn builtin() -> &'static Vec<Regex> {
    static P: OnceLock<Vec<Regex>> = OnceLock::new();
    P.get_or_init(|| BUILTIN.iter().filter_map(|p| Regex::new(p).ok()).collect())
}

/// A compiled scrubber: the built-in ruleset plus any user-supplied patterns (invalid ones dropped).
pub struct Scrubber {
    patterns: Vec<Regex>,
}

impl Scrubber {
    pub fn new(user_patterns: &[String]) -> Self {
        let mut patterns = builtin().clone();
        for p in user_patterns {
            if let Ok(re) = Regex::new(p) {
                patterns.push(re);
            }
        }
        Self { patterns }
    }

    /// Scrub one line, preserving its ANSI escapes. Over-redaction is acceptable; under-redaction is not.
    pub fn scrub_line(&self, line: &str) -> String {
        // Bound the scanned region (a very long line is truncated for scanning but kept in full only
        // up to the cap — the tail is where fresh output/secrets live).
        let scanned = if line.len() > MAX_LINE_SCAN {
            &line[line.len() - MAX_LINE_SCAN..]
        } else {
            line
        };
        let mut out = scanned.to_string();
        for re in &self.patterns {
            out = re.replace_all(&out, MASK).into_owned();
        }
        out
    }

    /// Scrub a set of lines.
    pub fn scrub_lines(&self, lines: &[String]) -> Vec<String> {
        lines.iter().map(|l| self.scrub_line(l)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scrub(line: &str) -> String {
        Scrubber::new(&[]).scrub_line(line)
    }

    #[test]
    fn redacts_known_secret_shapes() {
        assert!(scrub("token=ztf_ABCDEFGHIJKLMNOPQRSTUV").contains(MASK));
        assert!(scrub("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345").contains(MASK));
        assert!(scrub("Bearer eyJhbGciOi.payloadpart123.sigpart456").contains(MASK));
        assert!(scrub("AKIAABCDEFGHIJKLMNOP").contains(MASK));
        assert!(scrub("export API_KEY=supersecretvalue").contains(MASK));
        assert!(scrub("postgres://user:pa55word@db:5432/x").contains(MASK));
        assert!(
            scrub("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----")
                .contains(MASK)
        );
    }

    #[test]
    fn leaves_innocent_text_alone() {
        assert_eq!(scrub("just a normal log line"), "just a normal log line");
        assert_eq!(scrub("cargo build --release"), "cargo build --release");
    }

    #[test]
    fn preserves_ansi_escapes_around_redactions() {
        let out = scrub("\x1b[31mtoken=ztf_ABCDEFGHIJKLMNOPQRSTUV\x1b[0m");
        assert!(out.starts_with("\x1b[31m")); // color preserved
        assert!(out.ends_with("\x1b[0m"));
        assert!(out.contains(MASK));
        assert!(!out.contains("ztf_ABCDEFGHIJKLMNOPQRSTUV"));
    }

    #[test]
    fn user_patterns_are_appended() {
        let s = Scrubber::new(&["INTERNAL-[0-9]+".to_string()]);
        assert!(s.scrub_line("id INTERNAL-4242 here").contains(MASK));
    }
}
