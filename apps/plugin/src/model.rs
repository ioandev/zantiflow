//! The plugin → backend wire contract, **version 4** — the Rust mirror of `packages/protocol`'s Zod
//! schemas. Field names serialize to the exact camelCase keys the backend validates. `null` name =
//! redacted (the backend renders `<hidden>`); an absent name field is never sent as an empty string.
use serde::Serialize;

pub const WIRE_VERSION: u8 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MachineVisibility {
    Real,
    Alias,
    Hidden,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NameVisibility {
    Send,
    Hidden,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    Live,
    Resurrectable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AttentionState {
    Active,
    Cleared,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyEcho {
    pub full: bool,
    pub machine: MachineVisibility,
    pub session_names: NameVisibility,
    pub tab_names: NameVisibility,
    pub pane_names: NameVisibility,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineIdentity {
    pub source: MachineVisibility,
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pane {
    pub id: u32,
    pub name: Option<String>,
    pub command: Option<String>,
    pub is_focused: bool,
    pub exited: bool,
    pub content_fingerprint: String,
    /// Additive optional on the wire (ADR-0055, still v4): this plugin's Claude-pane verdict —
    /// title marker OR live-content signatures (ADR-0054). Authoritative for the backend's
    /// `claude.idle` scope; sent for every pane so the backend never re-derives identity.
    pub claude: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    pub tab_id: usize,
    pub name: Option<String>,
    pub position: usize,
    pub active: bool,
    pub panes: Vec<Pane>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub sid: String,
    pub name: Option<String>,
    pub is_current: bool,
    pub state: SessionState,
    pub died_seconds_ago: Option<f64>,
    pub tabs: Vec<Tab>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionTarget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_sid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attention {
    // `type` is a Rust keyword → serialize the field under that JSON key explicitly.
    #[serde(rename = "type")]
    pub kind: String,
    pub target: AttentionTarget,
    pub state: AttentionState,
    pub since: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotV4 {
    pub version: u8,
    pub machine_id: String,
    pub captured_at_tick: u64,
    pub privacy: PrivacyEcho,
    pub machine: MachineIdentity,
    pub attentions: Vec<Attention>,
    pub sessions: Vec<Session>,
    /// Additive optional on the wire (ADR-0051, still v4): ≥1 claude pane THIS instance observes is
    /// producing output. Own-session view — the backend merges instances per machine (ADR-0027).
    pub claude_active: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_the_backend_wire_keys() {
        let snap = SnapshotV4 {
            version: WIRE_VERSION,
            machine_id: "m-1".into(),
            captured_at_tick: 42,
            privacy: PrivacyEcho {
                full: true,
                machine: MachineVisibility::Alias,
                session_names: NameVisibility::Send,
                tab_names: NameVisibility::Send,
                pane_names: NameVisibility::Hidden,
            },
            machine: MachineIdentity {
                source: MachineVisibility::Alias,
                name: Some("red-laptop".into()),
            },
            attentions: vec![],
            sessions: vec![Session {
                sid: "s1".into(),
                name: Some("main".into()),
                is_current: true,
                state: SessionState::Live,
                died_seconds_ago: None,
                tabs: vec![Tab {
                    tab_id: 0,
                    name: Some("editor".into()),
                    position: 0,
                    active: true,
                    panes: vec![Pane {
                        id: 1,
                        name: None, // redacted → serializes as null
                        command: None,
                        is_focused: true,
                        exited: false,
                        content_fingerprint: "ab12".into(),
                        claude: true,
                    }],
                }],
            }],
            claude_active: true,
        };
        let v: serde_json::Value = serde_json::to_value(&snap).unwrap();
        assert_eq!(v["version"], 4);
        assert_eq!(v["machineId"], "m-1");
        assert_eq!(v["capturedAtTick"], 42);
        assert_eq!(v["claudeActive"], true); // additive optional wire key (ADR-0051)
        assert_eq!(v["privacy"]["sessionNames"], "send");
        assert_eq!(v["privacy"]["paneNames"], "hidden");
        assert_eq!(v["machine"]["source"], "alias");
        assert_eq!(v["sessions"][0]["isCurrent"], true);
        assert_eq!(v["sessions"][0]["state"], "live");
        assert_eq!(v["sessions"][0]["diedSecondsAgo"], serde_json::Value::Null);
        let pane = &v["sessions"][0]["tabs"][0]["panes"][0];
        assert_eq!(pane["name"], serde_json::Value::Null);
        assert_eq!(pane["isFocused"], true);
        assert_eq!(pane["claude"], true); // additive optional wire key (ADR-0055)
        assert_eq!(pane["contentFingerprint"], "ab12");
    }
}
