//! The always-on control channel client (ADR-0026). Every ~5 s the plugin POSTs its `machineId` + the
//! session ids it is currently reporting; the backend touches liveness (keeping quiet-but-live sessions
//! fresh) and replies with the pending pane-output requests, whether a dashboard is watching, and a
//! per-machine refresh sequence. This runs REGARDLESS of `pane_output` — it is what tells the plugin
//! how live to be. Pure + native-testable (no FFI): build the request bytes, parse the response bytes.
use crate::config::PluginConfig;

pub const CONTROL_PATH: &str = "/api/v1/control";

pub struct ControlRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

fn is_zero(n: &u64) -> bool {
    *n == 0
}

#[derive(serde::Serialize)]
struct ControlRequestWire<'a> {
    #[serde(rename = "machineId")]
    machine_id: &'a str,
    #[serde(rename = "liveSids")]
    live_sids: &'a [String],
    /// Long-poll hold in ms (ADR-0029), opt-in. Omitted when 0 so the default fixed-poll body is
    /// byte-for-byte the pre-0029 request; the backend treats absent as "respond immediately".
    #[serde(rename = "waitMs", skip_serializing_if = "is_zero")]
    wait_ms: u64,
}

/// Build the control POST. `None` when there is no token (the plugin must pair first). `wait_ms > 0`
/// requests a long-poll hold (ADR-0029); pass 0 for the default immediate-response poll.
pub fn build_control_request(
    config: &PluginConfig,
    machine_id: &str,
    live_sids: &[String],
    wait_ms: u64,
) -> Option<ControlRequest> {
    let token = config.token.as_ref()?;
    let base = config.server_url.trim_end_matches('/');
    let body = serde_json::to_vec(&ControlRequestWire {
        machine_id,
        live_sids,
        wait_ms,
    })
    .ok()?;
    Some(ControlRequest {
        url: format!("{base}{CONTROL_PATH}"),
        headers: vec![
            ("Content-Type".to_string(), "application/json".to_string()),
            ("Authorization".to_string(), format!("Bearer {token}")),
        ],
        body,
    })
}

/// One pane the website asked to view (scoped to this machine by the backend). A pane is identified by
/// its FULL `sessionSid + tabId + paneId` — a bare paneId is only unique within one session's id-space.
#[derive(serde::Deserialize, Debug, PartialEq)]
pub struct PendingRef {
    #[serde(rename = "machineId")]
    pub machine_id: String,
    #[serde(default, rename = "sessionSid")]
    pub session_sid: Option<String>,
    #[serde(default, rename = "tabId")]
    pub tab_id: Option<usize>,
    #[serde(rename = "paneId")]
    pub pane_id: u32,
}

/// Whether THIS plugin instance should capture `req`. Each Zellij session runs its own plugin instance
/// (machineId + salt are shared via `/cache`, so every instance derives the same sids), and a plugin
/// can only read scrollback for panes in its OWN session — the same raw `paneId` names a DIFFERENT pane
/// in another session. So an instance serves a request only when it names *its* session; the peer
/// instance that owns that sid serves the rest. A request without a sid (legacy/malformed) is declined
/// rather than risk delivering another pane's content under it.
pub fn should_serve(req: &PendingRef, machine_id: &str, own_sid: Option<&str>) -> bool {
    req.machine_id == machine_id
        && matches!((req.session_sid.as_deref(), own_sid), (Some(s), Some(o)) if s == o)
}

#[derive(serde::Deserialize, Default)]
struct Viewers {
    #[serde(default)]
    active: bool,
}

/// The control response. Unknown fields are ignored; every field defaults so a lean body still parses.
#[derive(serde::Deserialize, Default)]
pub struct ControlResponse {
    #[serde(default, rename = "pendingOutput")]
    pub pending_output: Vec<PendingRef>,
    #[serde(default)]
    viewers: Viewers,
    #[serde(default, rename = "refreshSeq")]
    pub refresh_seq: u64,
}

impl ControlResponse {
    /// Is a dashboard currently watching this account?
    pub fn watched(&self) -> bool {
        self.viewers.active
    }
}

/// Parse a control response body; `None` if it isn't valid JSON of the expected shape.
pub fn parse_control_response(body: &[u8]) -> Option<ControlResponse> {
    serde_json::from_slice(body).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{PluginConfig, PrivacyConfig};
    use crate::model::{MachineVisibility, NameVisibility};

    fn cfg(token: Option<&str>) -> PluginConfig {
        PluginConfig {
            token: token.map(str::to_string),
            machine_alias: None,
            server_url: "https://api.example.com/".to_string(),
            privacy: PrivacyConfig {
                full: true,
                machine: MachineVisibility::Real,
                session_names: NameVisibility::Send,
                tab_names: NameVisibility::Send,
                pane_names: NameVisibility::Send,
            },
            pane_output: false,
            control_long_poll: false,
            hostname_enabled: true,
            warnings: vec![],
        }
    }

    #[test]
    fn builds_a_bearer_json_post_with_machine_and_live_sids() {
        let sids = vec!["s1".to_string(), "s2".to_string()];
        let req = build_control_request(&cfg(Some("ztf_abc")), "m-1", &sids, 0).unwrap();
        assert_eq!(req.url, "https://api.example.com/api/v1/control"); // trailing slash trimmed
        assert!(req
            .headers
            .iter()
            .any(|(k, v)| k == "Authorization" && v == "Bearer ztf_abc"));
        let json: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
        assert_eq!(json["machineId"], "m-1");
        assert_eq!(json["liveSids"], serde_json::json!(["s1", "s2"]));
        // wait_ms = 0 → the field is omitted, so the fixed-poll body is unchanged from pre-0029.
        assert!(json.get("waitMs").is_none());
    }

    #[test]
    fn long_poll_request_carries_wait_ms() {
        let req = build_control_request(&cfg(Some("ztf_abc")), "m-1", &[], 25_000).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
        assert_eq!(json["waitMs"], 25_000);
    }

    #[test]
    fn no_token_means_no_request() {
        assert!(build_control_request(&cfg(None), "m-1", &[], 0).is_none());
    }

    #[test]
    fn parses_a_full_response() {
        let body = br#"{"pendingOutput":[{"machineId":"m-1","sessionSid":"sabc","tabId":2,"paneId":7}],"viewers":{"active":true},"refreshSeq":4}"#;
        let r = parse_control_response(body).unwrap();
        assert!(r.watched());
        assert_eq!(r.refresh_seq, 4);
        assert_eq!(
            r.pending_output,
            vec![PendingRef {
                machine_id: "m-1".into(),
                session_sid: Some("sabc".into()),
                tab_id: Some(2),
                pane_id: 7,
            }]
        );
    }

    fn pending(machine: &str, sid: Option<&str>, pane: u32) -> PendingRef {
        PendingRef {
            machine_id: machine.into(),
            session_sid: sid.map(str::to_string),
            tab_id: Some(0),
            pane_id: pane,
        }
    }

    #[test]
    fn serves_only_this_machines_own_session() {
        // Ours → served.
        assert!(should_serve(
            &pending("m-1", Some("sA"), 0),
            "m-1",
            Some("sA")
        ));
        // Another session on this machine → declined (its own plugin instance serves it).
        assert!(!should_serve(
            &pending("m-1", Some("sB"), 0),
            "m-1",
            Some("sA")
        ));
        // Another machine → declined.
        assert!(!should_serve(
            &pending("m-2", Some("sA"), 0),
            "m-1",
            Some("sA")
        ));
        // Missing sid, or we don't know our own sid yet → declined (never guess).
        assert!(!should_serve(&pending("m-1", None, 0), "m-1", Some("sA")));
        assert!(!should_serve(&pending("m-1", Some("sA"), 0), "m-1", None));
    }

    #[test]
    fn parses_a_lean_response_with_defaults_and_ignores_unknown_fields() {
        let r = parse_control_response(br#"{"somethingNew":123}"#).unwrap();
        assert!(!r.watched());
        assert_eq!(r.refresh_seq, 0);
        assert!(r.pending_output.is_empty());
    }

    #[test]
    fn rejects_non_json() {
        assert!(parse_control_response(b"not json").is_none());
    }
}
