//! Applying privacy (ADR-0002 Model A) to produce wire values. Redaction happens HERE, in the plugin,
//! before anything is sent — the backend never receives a name the user chose to hide. A hidden name
//! becomes `None` → serialized as JSON `null` → the backend renders `<hidden>` (distinct from
//! `Unknown` = "no update seen").
use crate::config::PrivacyConfig;
use crate::model::{MachineIdentity, MachineVisibility, NameVisibility, PrivacyEcho};

/// A session/tab/pane name for the wire: `Some(name)` when sent, `None` when redacted.
pub fn name_to_wire(visibility: NameVisibility, name: &str) -> Option<String> {
    match visibility {
        NameVisibility::Send => Some(name.to_string()),
        NameVisibility::Hidden => None,
    }
}

/// The effective machine identity to send, given the resolved visibility + the real hostname + alias.
pub fn machine_identity(
    visibility: MachineVisibility,
    hostname: Option<&str>,
    alias: Option<&str>,
) -> MachineIdentity {
    let name = match visibility {
        MachineVisibility::Real => hostname.map(|h| h.to_string()),
        // Prefer the configured alias; fall back to the hostname if none was given.
        MachineVisibility::Alias => alias
            .map(|a| a.to_string())
            .or_else(|| hostname.map(|h| h.to_string())),
        MachineVisibility::Hidden => None,
    };
    MachineIdentity {
        source: visibility,
        name,
    }
}

/// The privacy config echoed back to the backend (effective, post-resolution).
pub fn privacy_echo(c: &PrivacyConfig) -> PrivacyEcho {
    PrivacyEcho {
        full: c.full,
        machine: c.machine,
        session_names: c.session_names,
        tab_names: c.tab_names,
        pane_names: c.pane_names,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_names_become_none() {
        assert_eq!(
            name_to_wire(NameVisibility::Send, "editor"),
            Some("editor".to_string())
        );
        assert_eq!(name_to_wire(NameVisibility::Hidden, "editor"), None);
    }

    #[test]
    fn machine_identity_respects_visibility() {
        let real = machine_identity(MachineVisibility::Real, Some("red-laptop"), Some("alias-x"));
        assert_eq!(real.source, MachineVisibility::Real);
        assert_eq!(real.name.as_deref(), Some("red-laptop"));

        let alias = machine_identity(
            MachineVisibility::Alias,
            Some("red-laptop"),
            Some("alias-x"),
        );
        assert_eq!(alias.name.as_deref(), Some("alias-x"));

        // Alias with no configured alias falls back to the hostname.
        let alias_fallback = machine_identity(MachineVisibility::Alias, Some("red-laptop"), None);
        assert_eq!(alias_fallback.name.as_deref(), Some("red-laptop"));

        let hidden = machine_identity(
            MachineVisibility::Hidden,
            Some("red-laptop"),
            Some("alias-x"),
        );
        assert_eq!(hidden.name, None);
    }

    #[test]
    fn echo_mirrors_config() {
        let c = PrivacyConfig {
            full: false,
            machine: MachineVisibility::Alias,
            session_names: NameVisibility::Send,
            tab_names: NameVisibility::Hidden,
            pane_names: NameVisibility::Hidden,
        };
        let e = privacy_echo(&c);
        assert!(!e.full);
        assert_eq!(e.machine, MachineVisibility::Alias);
        assert_eq!(e.tab_names, NameVisibility::Hidden);
    }
}
