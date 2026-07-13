//! Building the outbound ingest request (ADR-0003 §3). The account is derived server-side from the
//! Bearer token and is NEVER in the body. Pure: returns the (url, headers, body) for the HostPort to
//! POST via `web_request` — so it is fully testable without any FFI.
use crate::config::PluginConfig;
use crate::model::SnapshotV4;

pub const INGEST_PATH: &str = "/api/v1/ingest";

pub struct IngestRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// Build the ingest POST for a snapshot. Returns `None` when there is no token configured (the plugin
/// must complete device pairing first).
pub fn build_ingest_request(config: &PluginConfig, snapshot: &SnapshotV4) -> Option<IngestRequest> {
    let token = config.token.as_ref()?;
    let base = config.server_url.trim_end_matches('/');
    let body = serde_json::to_vec(snapshot).ok()?;
    Some(IngestRequest {
        url: format!("{base}{INGEST_PATH}"),
        headers: vec![
            ("Content-Type".to_string(), "application/json".to_string()),
            ("Authorization".to_string(), format!("Bearer {token}")),
        ],
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{PluginConfig, PrivacyConfig};
    use crate::model::{
        MachineIdentity, MachineVisibility, NameVisibility, PrivacyEcho, SnapshotV4, WIRE_VERSION,
    };

    fn cfg(token: Option<&str>) -> PluginConfig {
        PluginConfig {
            token: token.map(|t| t.to_string()),
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

    fn snap() -> SnapshotV4 {
        SnapshotV4 {
            version: WIRE_VERSION,
            machine_id: "m-1".into(),
            captured_at_tick: 1,
            privacy: PrivacyEcho {
                full: true,
                machine: MachineVisibility::Real,
                session_names: NameVisibility::Send,
                tab_names: NameVisibility::Send,
                pane_names: NameVisibility::Send,
            },
            machine: MachineIdentity {
                source: MachineVisibility::Real,
                name: Some("host".into()),
            },
            attentions: vec![],
            sessions: vec![],
        }
    }

    #[test]
    fn builds_a_bearer_json_post_to_the_ingest_path() {
        let req = build_ingest_request(&cfg(Some("ztf_abc")), &snap()).unwrap();
        assert_eq!(req.url, "https://api.example.com/api/v1/ingest"); // trailing slash trimmed
        assert!(req
            .headers
            .iter()
            .any(|(k, v)| k == "Authorization" && v == "Bearer ztf_abc"));
        assert!(req
            .headers
            .iter()
            .any(|(k, v)| k == "Content-Type" && v == "application/json"));
        let json: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
        assert_eq!(json["version"], 4);
        assert_eq!(json["machineId"], "m-1");
    }

    #[test]
    fn no_token_means_no_request() {
        assert!(build_ingest_request(&cfg(None), &snap()).is_none());
    }
}
