//! Device pairing (ADR-0012), plugin side. When the plugin has no token it asks the backend to
//! START a pairing session, shows the returned short `userCode`, and POLLs until the owner approves
//! it on the website — then the poll returns the freshly minted ingest token, which the FFI adapter
//! persists to `/cache` (shared across the host's sessions). Everything here is PURE — building the requests and
//! interpreting the responses — so it is fully unit-tested on the host; the `plugin` FFI module just
//! drives it (fires the requests, feeds back responses, renders the code).
use serde::Deserialize;

pub const PAIR_START_PATH: &str = "/api/v1/pair/start";
pub const PAIR_POLL_PATH: &str = "/api/v1/pair/poll";
/// `/cache` key under which the minted ingest token is persisted after a successful pairing. `/cache`
/// (not `/data`) so it is SHARED across all of the host's Zellij sessions — pair once, every session
/// sends. Matches the machineId home in [`crate::fingerprint::get_or_create_machine_id`].
pub const TOKEN_CACHE_KEY: &str = "ingest_token";
/// Fallback poll cadence if the backend doesn't return one (matches the server default).
pub const DEFAULT_POLL_SECS: f64 = 5.0;

/// A ready-to-send request (url + headers + JSON body) for the HostPort to POST. Both pairing calls
/// are unauthenticated — the plugin has no token yet — so there is no `Authorization` header.
pub struct PairRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

fn json_headers() -> Vec<(String, String)> {
    vec![("Content-Type".to_string(), "application/json".to_string())]
}

/// `POST {server_url}/api/v1/pair/start`. `machine_hint` labels the token the backend will mint.
pub fn build_start_request(server_url: &str, machine_hint: Option<&str>) -> PairRequest {
    let base = server_url.trim_end_matches('/');
    let body = match machine_hint.filter(|h| !h.trim().is_empty()) {
        Some(h) => serde_json::json!({ "machineHint": h }),
        None => serde_json::json!({}),
    };
    PairRequest {
        url: format!("{base}{PAIR_START_PATH}"),
        headers: json_headers(),
        body: serde_json::to_vec(&body).unwrap_or_default(),
    }
}

/// `POST {server_url}/api/v1/pair/poll` — keyed by the unguessable `sessionId`.
pub fn build_poll_request(server_url: &str, session_id: &str) -> PairRequest {
    let base = server_url.trim_end_matches('/');
    PairRequest {
        url: format!("{base}{PAIR_POLL_PATH}"),
        headers: json_headers(),
        body: serde_json::to_vec(&serde_json::json!({ "sessionId": session_id }))
            .unwrap_or_default(),
    }
}

/// A parsed `/pair/start` success: the code to show + how to poll.
#[derive(Debug, Clone, PartialEq)]
pub struct Started {
    pub session_id: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval_secs: f64,
}

#[derive(Deserialize)]
struct StartWire {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "userCode")]
    user_code: String,
    #[serde(rename = "verificationUri")]
    verification_uri: String,
    #[serde(default)]
    interval: f64,
}

/// Parse a `/pair/start` response. `None` on any non-2xx or malformed body (the caller retries).
pub fn parse_start_response(status: u16, body: &[u8]) -> Option<Started> {
    if !(200..300).contains(&status) {
        return None;
    }
    let w: StartWire = serde_json::from_slice(body).ok()?;
    Some(Started {
        session_id: w.session_id,
        user_code: w.user_code,
        verification_uri: w.verification_uri,
        interval_secs: if w.interval > 0.0 {
            w.interval
        } else {
            DEFAULT_POLL_SECS
        },
    })
}

/// The outcome of one `/pair/poll` (ADR-0012 backend states, RFC-8628 adapted).
#[derive(Debug, Clone, PartialEq)]
pub enum PollOutcome {
    /// Keep polling (covers `authorization_pending` and `slow_down`); carries the next cadence.
    Pending { interval_secs: f64 },
    /// Approved — the minted ingest token to persist and start sending with.
    Approved { token: String },
    /// Code lapsed — restart pairing to get a fresh one.
    Expired,
    /// Owner rejected — terminal.
    Denied,
    /// Account is at its 10-token cap — terminal until a token is revoked.
    CapReached,
    /// `consumed`/`unknown_session`/unparseable — terminal; reload to retry.
    Done,
}

#[derive(Deserialize)]
struct PollWire {
    #[serde(default)]
    status: String,
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    interval: f64,
}

/// Interpret a `/pair/poll` response. A non-2xx (e.g. 404 `unknown_session`) is terminal (`Done`).
pub fn parse_poll_response(status: u16, body: &[u8]) -> PollOutcome {
    if !(200..300).contains(&status) {
        return PollOutcome::Done;
    }
    let Ok(w) = serde_json::from_slice::<PollWire>(body) else {
        return PollOutcome::Done;
    };
    let interval = if w.interval > 0.0 {
        w.interval
    } else {
        DEFAULT_POLL_SECS
    };
    match w.status.as_str() {
        "authorization_pending" | "slow_down" => PollOutcome::Pending {
            interval_secs: interval,
        },
        "approved" => match w.token {
            Some(t) if !t.is_empty() => PollOutcome::Approved { token: t },
            _ => PollOutcome::Done, // "approved" with no token would be a backend bug — don't loop.
        },
        "expired" => PollOutcome::Expired,
        "denied" => PollOutcome::Denied,
        "cap_reached" => PollOutcome::CapReached,
        _ => PollOutcome::Done, // consumed / unknown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_request_targets_the_path_and_carries_the_hint() {
        let r = build_start_request("https://zantiflow.com/", Some("dev-box"));
        assert_eq!(r.url, "https://zantiflow.com/api/v1/pair/start"); // trailing slash trimmed
        assert!(r
            .headers
            .iter()
            .any(|(k, v)| k == "Content-Type" && v == "application/json"));
        let j: serde_json::Value = serde_json::from_slice(&r.body).unwrap();
        assert_eq!(j["machineHint"], "dev-box");
    }

    #[test]
    fn start_request_omits_a_blank_hint() {
        let j: serde_json::Value =
            serde_json::from_slice(&build_start_request("https://x", Some("   ")).body).unwrap();
        assert!(j.get("machineHint").is_none());
        let j2: serde_json::Value =
            serde_json::from_slice(&build_start_request("https://x", None).body).unwrap();
        assert!(j2.get("machineHint").is_none());
    }

    #[test]
    fn poll_request_sends_the_session_id() {
        let r = build_poll_request("http://localhost:4000", "sid-123");
        assert_eq!(r.url, "http://localhost:4000/api/v1/pair/poll");
        let j: serde_json::Value = serde_json::from_slice(&r.body).unwrap();
        assert_eq!(j["sessionId"], "sid-123");
    }

    #[test]
    fn parses_a_start_response() {
        let body = br#"{"sessionId":"S","userCode":"ABCD-EFGH","verificationUri":"https://zantiflow.com/pair","expiresIn":600,"interval":5}"#;
        let s = parse_start_response(201, body).unwrap();
        assert_eq!(s.session_id, "S");
        assert_eq!(s.user_code, "ABCD-EFGH");
        assert_eq!(s.verification_uri, "https://zantiflow.com/pair");
        assert_eq!(s.interval_secs, 5.0);
    }

    #[test]
    fn start_response_defaults_interval_and_rejects_non_2xx() {
        let body = br#"{"sessionId":"S","userCode":"C","verificationUri":"U"}"#;
        assert_eq!(
            parse_start_response(200, body).unwrap().interval_secs,
            DEFAULT_POLL_SECS
        );
        assert!(parse_start_response(500, body).is_none());
        assert!(parse_start_response(200, b"not json").is_none());
    }

    #[test]
    fn poll_pending_states_keep_polling() {
        assert_eq!(
            parse_poll_response(200, br#"{"status":"authorization_pending","interval":5}"#),
            PollOutcome::Pending { interval_secs: 5.0 }
        );
        assert_eq!(
            parse_poll_response(200, br#"{"status":"slow_down","interval":10}"#),
            PollOutcome::Pending {
                interval_secs: 10.0
            }
        );
    }

    #[test]
    fn poll_approved_yields_the_token() {
        assert_eq!(
            parse_poll_response(200, br#"{"status":"approved","token":"ztf_secret"}"#),
            PollOutcome::Approved {
                token: "ztf_secret".to_string()
            }
        );
        // "approved" with an empty/missing token must NOT loop forever.
        assert_eq!(
            parse_poll_response(200, br#"{"status":"approved","token":""}"#),
            PollOutcome::Done
        );
        assert_eq!(
            parse_poll_response(200, br#"{"status":"approved"}"#),
            PollOutcome::Done
        );
    }

    #[test]
    fn poll_terminal_and_error_states() {
        assert_eq!(
            parse_poll_response(200, br#"{"status":"expired"}"#),
            PollOutcome::Expired
        );
        assert_eq!(
            parse_poll_response(200, br#"{"status":"denied"}"#),
            PollOutcome::Denied
        );
        assert_eq!(
            parse_poll_response(200, br#"{"status":"cap_reached"}"#),
            PollOutcome::CapReached
        );
        assert_eq!(
            parse_poll_response(200, br#"{"status":"consumed"}"#),
            PollOutcome::Done
        );
        // 404 unknown_session (or any non-2xx) is terminal.
        assert_eq!(
            parse_poll_response(404, br#"{"error":{"code":"unknown_session"}}"#),
            PollOutcome::Done
        );
    }
}
