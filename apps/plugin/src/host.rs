//! The host boundary. `HostPort` wraps EVERY zellij-tile side effect the plugin needs, expressed in
//! our own plain types — so the pure logic (snapshot build, privacy, fingerprint, net) is written and
//! tested against this trait, never against `zellij-tile` directly (ADR-0014). The real wasm adapter
//! implements it with the FFI; `FakeHost` implements it in memory for native unit tests.
use std::collections::HashMap;

/// A pane as observed from Zellij (subset of `PaneInfo` we care about).
#[derive(Debug, Clone, Default)]
pub struct ObservedPane {
    pub id: u32,
    pub title: String,
    pub command: Option<String>,
    pub is_focused: bool,
    pub exited: bool,
}

/// A tab as observed from Zellij (subset of `TabInfo`).
#[derive(Debug, Clone, Default)]
pub struct ObservedTab {
    pub tab_id: usize,
    pub name: String,
    pub position: usize,
    pub active: bool,
    pub panes: Vec<ObservedPane>,
}

/// A live session with its full tab/pane tree (from `SessionUpdate`'s first vec).
#[derive(Debug, Clone, Default)]
pub struct ObservedSession {
    pub name: String,
    pub is_current: bool,
    /// Clients currently attached (0 ⇒ detached — a `session.detached` attention, FINDINGS §3).
    pub connected_clients: usize,
    pub tabs: Vec<ObservedTab>,
}

/// A resurrectable/dead session (from `SessionUpdate`'s second vec): name + time since death.
#[derive(Debug, Clone, Default)]
pub struct DeadSession {
    pub name: String,
    pub died_seconds_ago: f64,
}

pub trait HostPort {
    /// Live sessions with their nested tabs/panes.
    fn live_sessions(&self) -> Vec<ObservedSession>;
    /// Resurrectable (dead) sessions.
    fn dead_sessions(&self) -> Vec<DeadSession>;
    /// A bounded tail of a pane's scrollback for activity fingerprinting (`ReadPaneContents`), or None.
    fn pane_scrollback(&self, pane_id: u32) -> Option<String>;
    /// The host machine name (via `run_command(["hostname"])`), or None if unavailable.
    fn hostname(&self) -> Option<String>;
    /// Persistent `/data` key/value (survives restarts) — used for the stable machineId.
    fn read_data(&self, key: &str) -> Option<String>;
    fn write_data(&mut self, key: &str, value: &str);
    /// `/cache` key/value — used for the fingerprint/sid salt.
    fn read_cache(&self, key: &str) -> Option<String>;
    fn write_cache(&mut self, key: &str, value: &str);
    /// Fire-and-forget outbound POST (`web_request`); the response arrives via a separate event.
    fn http_post(
        &mut self,
        url: &str,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
        context: Vec<(String, String)>,
    );
    /// Fire-and-forget outbound GET (`web_request`); the response arrives via a separate event.
    fn http_get(
        &mut self,
        url: &str,
        headers: Vec<(String, String)>,
        context: Vec<(String, String)>,
    );
    /// Re-arm the ~1s telemetry timer.
    fn set_timeout(&mut self, secs: f64);
    /// A fresh random hex id (≥128-bit) for one-time values: the stable machineId + fingerprint salt.
    fn random_id(&self) -> String;
    /// Host-side structured log line (never logs secrets or pane content).
    fn log(&self, msg: &str);
}

/// An in-memory `HostPort` for native unit tests: seed `live`/`dead`/`scrollback`/`hostname`,
/// drive the logic, then assert on `posts`/`data`/`cache`/`timeouts`.
#[derive(Default)]
pub struct FakeHost {
    pub live: Vec<ObservedSession>,
    pub dead: Vec<DeadSession>,
    pub scrollback: HashMap<u32, String>,
    pub hostname: Option<String>,
    pub data: HashMap<String, String>,
    pub cache: HashMap<String, String>,
    pub posts: Vec<PostRecord>,
    pub gets: Vec<PostRecord>,
    pub timeouts: Vec<f64>,
    pub logs: Vec<String>,
    /// What `random_id()` returns (deterministic for tests).
    pub random: String,
}

#[derive(Debug, Clone)]
pub struct PostRecord {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub context: Vec<(String, String)>,
}

impl HostPort for FakeHost {
    fn live_sessions(&self) -> Vec<ObservedSession> {
        self.live.clone()
    }
    fn dead_sessions(&self) -> Vec<DeadSession> {
        self.dead.clone()
    }
    fn pane_scrollback(&self, pane_id: u32) -> Option<String> {
        self.scrollback.get(&pane_id).cloned()
    }
    fn hostname(&self) -> Option<String> {
        self.hostname.clone()
    }
    fn read_data(&self, key: &str) -> Option<String> {
        self.data.get(key).cloned()
    }
    fn write_data(&mut self, key: &str, value: &str) {
        self.data.insert(key.to_string(), value.to_string());
    }
    fn read_cache(&self, key: &str) -> Option<String> {
        self.cache.get(key).cloned()
    }
    fn write_cache(&mut self, key: &str, value: &str) {
        self.cache.insert(key.to_string(), value.to_string());
    }
    fn http_post(
        &mut self,
        url: &str,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
        context: Vec<(String, String)>,
    ) {
        self.posts.push(PostRecord {
            url: url.to_string(),
            headers,
            body,
            context,
        });
    }
    fn http_get(
        &mut self,
        url: &str,
        headers: Vec<(String, String)>,
        context: Vec<(String, String)>,
    ) {
        self.gets.push(PostRecord {
            url: url.to_string(),
            headers,
            body: vec![],
            context,
        });
    }
    fn set_timeout(&mut self, secs: f64) {
        self.timeouts.push(secs);
    }
    fn random_id(&self) -> String {
        if self.random.is_empty() {
            "fake-random-id".to_string()
        } else {
            self.random.clone()
        }
    }
    fn log(&self, msg: &str) {
        // Interior mutability would be needed to record; tests rarely assert logs, so this is a no-op
        // sink that still satisfies the trait. (Kept &self to match the real host's cheap logging.)
        let _ = msg;
    }
}
