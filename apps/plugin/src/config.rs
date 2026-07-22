//! Plugin configuration (ADR-0002 privacy Model A; ADR-0003 `server_url`). Parsed from Zellij's
//! `BTreeMap<String, String>` load config. Privacy **fails closed**: an invalid value redacts (hidden)
//! and records a warning rather than sending. `server_url` is HTTPS-only (localhost may use http).
use std::collections::BTreeMap;

use crate::model::{MachineVisibility, NameVisibility};

/// Backend the plugin talks to when `server_url` is not configured (ADR-0003: "defaults to hosted;
/// overridable for self-hosting"). Self-hosters set `server_url` to their own https origin.
pub const DEFAULT_SERVER_URL: &str = "https://zantiflow.com";

#[derive(Debug, Clone, PartialEq)]
pub struct PrivacyConfig {
    /// Master baseline: full=true → send everything; false → redact everything (per-field overrides win).
    pub full: bool,
    pub machine: MachineVisibility,
    pub session_names: NameVisibility,
    pub tab_names: NameVisibility,
    pub pane_names: NameVisibility,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PluginConfig {
    /// Ingest token; `None` means the plugin must run device-pairing to obtain one.
    pub token: Option<String>,
    /// Alias to advertise when `machine == Alias` (falls back to the real hostname when empty).
    pub machine_alias: Option<String>,
    /// Backend base URL — HTTPS (or http://localhost). Defaults to [`DEFAULT_SERVER_URL`] (the hosted
    /// service) when unset; validated, and a bad value is flagged in `warnings`.
    pub server_url: String,
    pub privacy: PrivacyConfig,
    /// On-demand pane output channel — OFF by default (ADR-0016).
    pub pane_output: bool,
    /// Long-poll for the control channel — ON by default (ADR-0031, flipping ADR-0029). The plugin asks
    /// the backend to hold each control poll open, delivering pending pane-output / refresh in ≈1 s
    /// instead of up to ~5 s, and re-issues on each response. If the host won't hold the request it
    /// self-degrades to a ~1 s poll (still faster than the 5 s fixed poll). Set `off` to force the
    /// ADR-0026 fixed ~5 s poll.
    pub control_long_poll: bool,
    /// Whether the plugin may look up the **real hostname** via `run_command(["hostname"])`, which
    /// needs the Zellij `RunCommands` permission. OFF by default (ADR-0024): the permission is only
    /// requested — and the hostname only read and sent — when this is on AND `machine == Real`.
    pub hostname_enabled: bool,
    /// Debug logging (ADR-0049): OFF by default. When on, the plugin emits transition-only diagnostic
    /// lines (attention onsets/clears, ingest sends + a contents summary, claude-pane activity) via
    /// `HostPort::log` (plugin stderr → Zellij's own `zellij.log`). Local-only; never the token or
    /// pane content.
    pub debug: bool,
    /// Non-fatal parse/validation warnings (fail-closed decisions) to surface to the user.
    pub warnings: Vec<String>,
}

impl PluginConfig {
    /// The single gate for the real-hostname feature (ADR-0024): the opt-in `hostname` flag is on
    /// AND the machine is reported as `real`. Governs both the `RunCommands` permission request and
    /// whether the `hostname` command runs / its value reaches the wire. Off → machine name is
    /// `null` (backend renders `<hidden>`), and alias/hidden users are never prompted for `RunCommands`.
    pub fn wants_hostname(&self) -> bool {
        self.hostname_enabled && self.privacy.machine == MachineVisibility::Real
    }
}

fn parse_bool(s: &str) -> Option<bool> {
    match s.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Some(true),
        "false" | "0" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// HTTPS everywhere, except plain http is allowed only for a localhost/loopback host (dev).
pub fn is_valid_server_url(u: &str) -> bool {
    if let Some(rest) = u.strip_prefix("https://") {
        return !rest.is_empty();
    }
    if let Some(rest) = u.strip_prefix("http://") {
        let host = rest.split(['/', ':']).next().unwrap_or("");
        return host == "localhost" || host == "127.0.0.1" || host == "[::1]";
    }
    false
}

/// `machine_name` = `"real"` | `"alias:<text>"` | `"hidden"` (ADR-0002 §config). Returns the
/// visibility plus, for alias mode, the alias text. Any unrecognized value fails closed to hidden.
fn resolve_machine(
    v: Option<&String>,
    baseline: MachineVisibility,
    warnings: &mut Vec<String>,
) -> (MachineVisibility, Option<String>) {
    let Some(raw) = v else {
        return (baseline, None);
    };
    let t = raw.trim();
    match t.to_ascii_lowercase().as_str() {
        "real" => (MachineVisibility::Real, None),
        "hidden" => (MachineVisibility::Hidden, None),
        lower if lower.starts_with("alias:") => {
            let alias = t[6..].trim(); // "alias:" is 6 ASCII bytes
            if alias.is_empty() {
                warnings
                    .push("machine_name 'alias:' has no text — failing closed to hidden".into());
                (MachineVisibility::Hidden, None)
            } else {
                (MachineVisibility::Alias, Some(alias.to_string()))
            }
        }
        other => {
            warnings.push(format!(
                "invalid machine_name '{other}' — failing closed to hidden"
            ));
            (MachineVisibility::Hidden, None)
        }
    }
}

fn resolve_name(
    v: Option<&String>,
    baseline: NameVisibility,
    warnings: &mut Vec<String>,
    key: &str,
) -> NameVisibility {
    match v {
        None => baseline,
        Some(raw) => match raw.trim().to_ascii_lowercase().as_str() {
            "send" => NameVisibility::Send,
            "hidden" => NameVisibility::Hidden,
            other => {
                warnings.push(format!(
                    "invalid {key} '{other}' — failing closed to hidden"
                ));
                NameVisibility::Hidden
            }
        },
    }
}

pub fn parse_config(raw: &BTreeMap<String, String>) -> PluginConfig {
    let mut warnings = Vec::new();

    // Master privacy baseline (default: send everything).
    let full = match raw.get("full") {
        None => true,
        Some(v) => parse_bool(v).unwrap_or_else(|| {
            warnings.push(format!("invalid full '{v}' — failing closed to false"));
            false
        }),
    };
    let baseline_name = if full {
        NameVisibility::Send
    } else {
        NameVisibility::Hidden
    };
    let baseline_machine = if full {
        MachineVisibility::Real
    } else {
        MachineVisibility::Hidden
    };

    let (machine, machine_alias) =
        resolve_machine(raw.get("machine_name"), baseline_machine, &mut warnings);
    let privacy = PrivacyConfig {
        full,
        machine,
        session_names: resolve_name(
            raw.get("session_names"),
            baseline_name,
            &mut warnings,
            "session_names",
        ),
        tab_names: resolve_name(
            raw.get("tab_names"),
            baseline_name,
            &mut warnings,
            "tab_names",
        ),
        pane_names: resolve_name(
            raw.get("pane_names"),
            baseline_name,
            &mut warnings,
            "pane_names",
        ),
    };

    let server_url = match raw.get("server_url") {
        Some(u) if is_valid_server_url(u) => u.clone(),
        Some(u) => {
            warnings.push(format!(
                "invalid server_url '{u}' — must be https:// (or http://localhost)"
            ));
            u.clone()
        }
        // Unset → talk to the hosted service (ADR-0003). Self-hosters override it explicitly.
        None => DEFAULT_SERVER_URL.to_string(),
    };

    let pane_output = match raw.get("pane_output") {
        None => false, // OFF by default (ADR-0016)
        Some(v) => parse_bool(v).unwrap_or_else(|| {
            warnings.push(format!("invalid pane_output '{v}' — defaulting OFF"));
            false
        }),
    };

    // Long-poll control channel is ON by default (ADR-0031, flipping ADR-0029): it cuts pane-output /
    // refresh latency from up to ~5 s to ≈1 s and self-degrades to a ~1 s poll if the host won't hold
    // the request. Set `control_long_poll off` to force the ADR-0026 fixed ~5 s poll. Invalid → default.
    let control_long_poll = match raw.get("control_long_poll") {
        None => true,
        Some(v) => parse_bool(v).unwrap_or_else(|| {
            warnings.push(format!("invalid control_long_poll '{v}' — defaulting ON"));
            true
        }),
    };

    // Real-hostname lookup is opt-in (ADR-0024): OFF by default, so no `RunCommands` permission is
    // requested and no hostname leaves the machine unless the user explicitly enables it.
    let hostname_enabled = match raw.get("hostname") {
        None => false,
        Some(v) => parse_bool(v).unwrap_or_else(|| {
            warnings.push(format!("invalid hostname '{v}' — defaulting OFF"));
            false
        }),
    };
    // Debug logging is opt-in and quiet by default (ADR-0049); an invalid value stays OFF.
    let debug = match raw.get("debug") {
        None => false,
        Some(v) => parse_bool(v).unwrap_or_else(|| {
            warnings.push(format!("invalid debug '{v}' — defaulting OFF"));
            false
        }),
    };

    // Asking for the real machine name without enabling the lookup is a silent no-op (machine reports
    // as hidden). Warn only when `machine_name=real` was set explicitly, so the default stays quiet.
    if !hostname_enabled
        && raw
            .get("machine_name")
            .is_some_and(|m| m.trim().eq_ignore_ascii_case("real"))
    {
        warnings.push(
            "machine_name=real but hostname=off — the real hostname is NOT sent and no RunCommands \
             permission is requested; set hostname=on to send it, or use machine_name=alias:<label>"
                .into(),
        );
    }

    PluginConfig {
        token: raw
            .get("token")
            .filter(|t| !t.trim().is_empty())
            .map(|t| t.trim().to_string()),
        machine_alias,
        server_url,
        privacy,
        pane_output,
        control_long_poll,
        hostname_enabled,
        debug,
        warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(pairs: &[(&str, &str)]) -> PluginConfig {
        let map: BTreeMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        parse_config(&map)
    }

    #[test]
    fn defaults_send_everything_and_use_the_hosted_server_url() {
        let c = cfg(&[]);
        assert!(c.privacy.full);
        assert_eq!(c.privacy.machine, MachineVisibility::Real);
        assert_eq!(c.privacy.session_names, NameVisibility::Send);
        assert_eq!(c.privacy.pane_names, NameVisibility::Send);
        assert!(!c.pane_output);
        // Long-poll control channel is ON by default (ADR-0031) → ≈1 s pane-output latency.
        assert!(c.control_long_poll);
        // Real-hostname lookup is opt-in (ADR-0024): OFF by default even though machine == Real,
        // so no RunCommands permission is requested unless the user turns it on.
        assert!(!c.hostname_enabled);
        assert!(!c.wants_hostname());
        assert_eq!(c.token, None);
        // No server_url configured → default to the hosted service, with no warning.
        assert_eq!(c.server_url, DEFAULT_SERVER_URL);
        assert!(c.warnings.is_empty());
    }

    #[test]
    fn hostname_lookup_is_opt_in_and_gated_on_real() {
        // Explicit opt-in with the default (real) machine → wants the hostname.
        let on = cfg(&[("hostname", "on"), ("server_url", "https://x")]);
        assert!(on.hostname_enabled);
        assert!(on.wants_hostname());
        assert!(on.warnings.is_empty());

        // Opt-in but the machine is an alias → the flag is set, but no hostname is wanted/sent.
        let alias = cfg(&[
            ("hostname", "true"),
            ("machine_name", "alias:box"),
            ("server_url", "https://x"),
        ]);
        assert!(alias.hostname_enabled);
        assert!(!alias.wants_hostname());

        // Explicit off is honored.
        let off = cfg(&[("hostname", "off"), ("server_url", "https://x")]);
        assert!(!off.hostname_enabled);
        assert!(!off.wants_hostname());

        // Invalid value fails to OFF with a warning.
        let bad = cfg(&[("hostname", "maybe"), ("server_url", "https://x")]);
        assert!(!bad.hostname_enabled);
        assert!(bad.warnings.iter().any(|w| w.contains("hostname")));
    }

    #[test]
    fn explicit_real_without_hostname_flag_warns() {
        // machine_name=real but no hostname flag → warn (the real name would silently not be sent).
        let c = cfg(&[("machine_name", "real"), ("server_url", "https://x")]);
        assert_eq!(c.privacy.machine, MachineVisibility::Real);
        assert!(!c.wants_hostname());
        assert!(c
            .warnings
            .iter()
            .any(|w| w.contains("machine_name=real") && w.contains("hostname=off")));

        // With the flag on, no such warning and the hostname is wanted.
        let ok = cfg(&[
            ("machine_name", "real"),
            ("hostname", "on"),
            ("server_url", "https://x"),
        ]);
        assert!(ok.wants_hostname());
        assert!(ok.warnings.is_empty());

        // The default (machine_name unset) does NOT warn, even though machine resolves to real.
        let quiet = cfg(&[("server_url", "https://x")]);
        assert!(quiet.warnings.is_empty());
    }

    #[test]
    fn full_false_redacts_the_baseline() {
        let c = cfg(&[("full", "false"), ("server_url", "https://api.example")]);
        assert_eq!(c.privacy.machine, MachineVisibility::Hidden);
        assert_eq!(c.privacy.session_names, NameVisibility::Hidden);
        assert_eq!(c.privacy.tab_names, NameVisibility::Hidden);
        assert_eq!(c.privacy.pane_names, NameVisibility::Hidden);
    }

    #[test]
    fn per_field_overrides_win_over_the_master() {
        let c = cfg(&[
            ("full", "true"),
            ("pane_names", "hidden"),
            ("machine_name", "alias:red-laptop"),
            ("server_url", "https://x"),
        ]);
        assert_eq!(c.privacy.session_names, NameVisibility::Send); // baseline
        assert_eq!(c.privacy.pane_names, NameVisibility::Hidden); // override
        assert_eq!(c.privacy.machine, MachineVisibility::Alias); // override
        assert_eq!(c.machine_alias.as_deref(), Some("red-laptop"));
    }

    #[test]
    fn machine_name_modes_parse_per_adr_0002() {
        assert_eq!(
            cfg(&[("machine_name", "real")]).privacy.machine,
            MachineVisibility::Real
        );
        assert_eq!(
            cfg(&[("machine_name", "hidden")]).privacy.machine,
            MachineVisibility::Hidden
        );
        let a = cfg(&[("machine_name", "alias:my box")]);
        assert_eq!(a.privacy.machine, MachineVisibility::Alias);
        assert_eq!(a.machine_alias.as_deref(), Some("my box"));
        // bare "alias:" with no text fails closed to hidden.
        let empty = cfg(&[("machine_name", "alias:")]);
        assert_eq!(empty.privacy.machine, MachineVisibility::Hidden);
    }

    #[test]
    fn invalid_values_fail_closed_and_warn() {
        let c = cfg(&[
            ("full", "maybe"),
            ("machine_name", "bogus"),
            ("session_names", "leak"),
            ("server_url", "https://x"),
        ]);
        assert!(!c.privacy.full); // invalid full → false
        assert_eq!(c.privacy.machine, MachineVisibility::Hidden);
        assert_eq!(c.privacy.session_names, NameVisibility::Hidden);
        assert!(c.warnings.len() >= 3);
    }

    #[test]
    fn server_url_is_https_only_except_localhost() {
        assert!(is_valid_server_url("https://api.example.com"));
        assert!(is_valid_server_url("https://api.example.com:8443/base"));
        assert!(is_valid_server_url("http://localhost:4000"));
        assert!(is_valid_server_url("http://127.0.0.1:4000"));
        assert!(!is_valid_server_url("http://evil.example.com"));
        assert!(!is_valid_server_url("ftp://x"));
        assert!(!is_valid_server_url("https://"));

        let bad = cfg(&[("server_url", "http://evil.example.com")]);
        assert!(bad.warnings.iter().any(|w| w.contains("server_url")));
    }

    #[test]
    fn reads_token_and_pane_output() {
        let c = cfg(&[
            ("token", "ztf_abc"),
            ("pane_output", "true"),
            ("server_url", "https://x"),
        ]);
        assert_eq!(c.token.as_deref(), Some("ztf_abc"));
        assert!(c.pane_output);
        // whitespace-only token is treated as absent (pairing mode)
        assert_eq!(cfg(&[("token", "   ")]).token, None);
    }

    #[test]
    fn debug_defaults_off_and_invalid_values_stay_off() {
        // Quiet by default (ADR-0049) — and absent from the default-config warning set.
        let c = cfg(&[("server_url", "https://x")]);
        assert!(!c.debug);
        assert!(c.warnings.is_empty());
        // Explicit on/off parse like every other bool key.
        assert!(cfg(&[("debug", "on"), ("server_url", "https://x")]).debug);
        assert!(!cfg(&[("debug", "off"), ("server_url", "https://x")]).debug);
        // Invalid → OFF with a warning (default, not fail-closed — it's not a privacy key).
        let bad = cfg(&[("debug", "loud"), ("server_url", "https://x")]);
        assert!(!bad.debug);
        assert!(bad.warnings.iter().any(|w| w.contains("debug")));
    }

    #[test]
    fn control_long_poll_defaults_on_and_can_be_disabled() {
        // ON by default (ADR-0031), and an explicit `off` forces the fixed ~5 s poll.
        assert!(cfg(&[("server_url", "https://x")]).control_long_poll);
        assert!(cfg(&[("control_long_poll", "on"), ("server_url", "https://x")]).control_long_poll);
        assert!(
            !cfg(&[("control_long_poll", "off"), ("server_url", "https://x")]).control_long_poll
        );
        // Invalid → the default (ON) with a warning.
        let bad = cfg(&[("control_long_poll", "maybe"), ("server_url", "https://x")]);
        assert!(bad.control_long_poll);
        assert!(bad.warnings.iter().any(|w| w.contains("control_long_poll")));
    }
}
