//! Stable identifiers + derived activity. Zellij gives sessions only a name (no id), so we derive a
//! stable synthetic `sid = hash(salt + name)` (ADR-0002). Per-pane activity has no push event
//! (FINDINGS §6), so it's DERIVED: each tick we hash a bounded tail of the pane's scrollback and the
//! backend compares fingerprints across ticks to stamp "last updated". A per-machine salt (persisted
//! in `/cache`) makes both hashes pseudonymous so raw names/content can't be recovered from the wire.
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use crate::host::HostPort;

const SALT_KEY: &str = "fingerprint_salt";
const MACHINE_ID_KEY: &str = "machine_id";
/// Only the last N bytes of scrollback are hashed — bounds the O(panes) per-tick cost (FINDINGS §6).
const SCROLLBACK_TAIL_BYTES: usize = 16 * 1024;

fn hash_hex(salt: &str, data: &[u8]) -> String {
    let mut h = DefaultHasher::new();
    salt.hash(&mut h);
    data.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Stable pseudonymous session id derived from the (unstable) session name.
pub fn sid(salt: &str, session_name: &str) -> String {
    format!("s{}", hash_hex(salt, session_name.as_bytes()))
}

/// Fingerprint of a pane's current content: hash of a bounded tail. Same content → same hash (so the
/// backend detects *change*); `None` (couldn't read) → a constant so the pane never looks "active".
pub fn content_fingerprint(salt: &str, scrollback: Option<&str>) -> String {
    match scrollback {
        None => "none".to_string(),
        Some(content) => {
            let bytes = content.as_bytes();
            let tail = if bytes.len() > SCROLLBACK_TAIL_BYTES {
                &bytes[bytes.len() - SCROLLBACK_TAIL_BYTES..]
            } else {
                bytes
            };
            hash_hex(salt, tail)
        }
    }
}

/// The per-machine fingerprint salt — created once, persisted in `/cache`.
pub fn get_or_create_salt(host: &mut impl HostPort) -> String {
    if let Some(s) = host.read_cache(SALT_KEY) {
        if !s.is_empty() {
            return s;
        }
    }
    let salt = host.random_id();
    host.write_cache(SALT_KEY, &salt);
    salt
}

/// The stable, host-wide machineId. Persisted in `/cache`, which Zellij SHARES across all of a host's
/// sessions — unlike `/data`, which it scopes per session (a `/data` id makes every session look like a
/// different machine). Derived from the hostname when it's known (stable across cache clears/reinstalls,
/// pseudonymous via the salt); otherwise a random id. Created once, then reused — so every session on
/// the host reports as the SAME machine. Resolve it lazily (after the async hostname lookup lands), not
/// at `load()` time when the hostname isn't known yet.
pub fn get_or_create_machine_id(host: &mut impl HostPort, salt: &str) -> String {
    if let Some(id) = host.read_cache(MACHINE_ID_KEY) {
        if !id.is_empty() {
            return id;
        }
    }
    let id = match host.hostname() {
        Some(h) if !h.trim().is_empty() => format!("m-{}", hash_hex(salt, h.trim().as_bytes())),
        _ => format!("m-{}", host.random_id()),
    };
    host.write_cache(MACHINE_ID_KEY, &id);
    id
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::FakeHost;

    #[test]
    fn sid_is_stable_per_name_and_salt_but_differs_across_names() {
        assert_eq!(sid("salt", "main"), sid("salt", "main"));
        assert_ne!(sid("salt", "main"), sid("salt", "other"));
        assert_ne!(sid("salt-a", "main"), sid("salt-b", "main")); // salt separates machines
    }

    #[test]
    fn content_fingerprint_detects_change_and_handles_missing() {
        let a = content_fingerprint("s", Some("hello"));
        assert_eq!(a, content_fingerprint("s", Some("hello")));
        assert_ne!(a, content_fingerprint("s", Some("hello world")));
        assert_eq!(content_fingerprint("s", None), "none");
    }

    #[test]
    fn salt_is_created_once_then_reused() {
        let mut host = FakeHost {
            random: "abc123".into(),
            ..Default::default()
        };
        assert_eq!(get_or_create_salt(&mut host), "abc123");
        assert_eq!(host.cache.get("fingerprint_salt").unwrap(), "abc123");
        // Even if the RNG changes, the persisted value is reused.
        host.random = "different".into();
        assert_eq!(get_or_create_salt(&mut host), "abc123");
    }

    #[test]
    fn machine_id_without_a_hostname_is_random_and_shared_via_cache() {
        let mut host = FakeHost {
            random: "rand1".into(),
            ..Default::default()
        };
        let id = get_or_create_machine_id(&mut host, "salt");
        assert_eq!(id, "m-rand1");
        // Stored in /cache (shared across sessions), NOT /data (per-session).
        assert_eq!(host.cache.get("machine_id").unwrap(), "m-rand1");
        assert!(!host.data.contains_key("machine_id"));
        // Reused from /cache even if the RNG and salt change — one machine per host.
        host.random = "rand2".into();
        assert_eq!(get_or_create_machine_id(&mut host, "other-salt"), "m-rand1");
    }

    #[test]
    fn machine_id_prefers_a_stable_hostname_derivation() {
        let mut host = FakeHost {
            hostname: Some("red-laptop".into()),
            random: "rand1".into(),
            ..Default::default()
        };
        let id = get_or_create_machine_id(&mut host, "salt");
        // Deterministic in (salt, hostname) — not the random fallback.
        assert_eq!(id, format!("m-{}", hash_hex("salt", b"red-laptop")));
        assert_ne!(id, "m-rand1");
        // A different session on the same host (fresh empty cache) derives the SAME id.
        let mut other_session = FakeHost {
            hostname: Some("red-laptop".into()),
            random: "rand2".into(),
            ..Default::default()
        };
        assert_eq!(get_or_create_machine_id(&mut other_session, "salt"), id);
    }
}
