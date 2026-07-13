# ADR-0024 — Opt-in real-hostname lookup (and its `RunCommands` permission)

- **Status:** Accepted
- **Amends:** [ADR-0002](0002-configurable-telemetry-privacy-controls.md) — the machine-name posture: the real hostname (and the `RunCommands` permission it needs) is now **opt-in, OFF by default**, rather than the `full`-baseline default of `real`
- **Date:** 2026-07-11
- **Deciders:** project owner
- **Tags:** privacy, permissions, plugin, configuration
- **Testing:** unit (`config`: default-off, on/off/invalid, `wants_hostname()` gate, explicit-`real`-without-flag warning; `snapshot`: hostname withheld when the flag is off even with `machine == Real`) — see [ADR-0014](0014-testing-strategy.md). The two-phase permission handshake itself is wasm-only and validated by the real-Zellij smoke check (ADR-0014 §6), which can only be run in a throwaway session.

## Context

[ADR-0002](0002-configurable-telemetry-privacy-controls.md) made the machine name configurable
(`real` / `alias:<text>` / `hidden`) under the master `full` switch. Because `full` defaults **on**,
the default machine posture is `real`, and to send the real hostname the plugin must call
`run_command(["hostname"])` (the only reliable way to obtain it — see `FINDINGS.md`), which requires
the Zellij **`RunCommands`** permission.

Two problems with the shipped implementation surfaced in the ADR audit:

1. **The `RunCommands` permission was requested unconditionally in `load()`**, for *every* user,
   even those using `alias` or `hidden`. ADR-0002 §4/§8 explicitly wanted that prompt to appear
   *only* when the machine resolves to `real`, so privacy-conscious users "never see it." Requesting
   the ability to run arbitrary host commands is the plugin's most sensitive permission, and it was
   being asked for by default.
2. **Sending the real hostname was on by default.** The hostname is identifying information; a
   privacy-first default should not exfiltrate it unless the user opts in.

The user asked for an explicit feature flag, defaulted off, that gates *both* the hostname feature
and its permission.

## Decision Drivers

- **Least privilege** — don't request `RunCommands` unless the feature that needs it is enabled.
- **Privacy-first default** — the real hostname should not leave the machine unless explicitly turned on.
- **Robust core telemetry** — the optional permission must be separable: denying `RunCommands` must
  never disable the base snapshot loop.
- **No surprises** — a user who asks for `machine_name=real` but forgets the flag should be told why
  their machine shows as hidden, not left guessing.

## Considered Options

- **Flip `machine_name`'s default to `hidden`/`alias`.** Rejected: couples the "what to report"
  axis to the "may we look it up" axis, and reinterprets ADR-0002's `full` semantics more broadly
  than needed.
- **Request `RunCommands` conditionally but keep the hostname on by default.** Rejected: fixes the
  permission-prompt half but still exfiltrates the hostname by default.
- **A dedicated `hostname` boolean flag (default OFF) gating both the lookup and the permission.**
  **Chosen.** One narrow switch; orthogonal to `machine_name`; trivially defaults closed.

## Decision

Add a plugin config key **`hostname`** (`on`/`off`, **default `off`**). The real hostname is looked
up and sent **only** when the single gate `PluginConfig::wants_hostname()` holds:

```
hostname == on  AND  machine == Real
```

This gate governs three things at once:

1. **The wire value.** `snapshot` reads `host.hostname()` only when `wants_hostname()` is true;
   otherwise the machine identity is `{ source: Real, name: null }` → the backend renders `<hidden>`.
2. **The `hostname` command.** `run_command(["hostname"])` fires only after the permission is in hand.
3. **The `RunCommands` permission request**, via a **two-phase permission handshake**:
   - `load()` requests only the base set — `ReadApplicationState`, `WebAccess`, `ReadPaneContents`.
   - When (and only when) the feature is wanted and base perms are granted, the plugin *then*
     requests `RunCommands` (lazily; also re-evaluated on `PluginConfigurationChanged`, so toggling
     the flag on at runtime acquires it without a reload).
   - Because Zellij grants a request all-or-nothing, base telemetry and the optional `RunCommands`
     grant are tracked as **separate** flags (`permissions_granted` vs
     `run_commands_requested`/`run_commands_granted`). A `RunCommands` **denial** after base perms
     were granted logs a notice and falls back to a hidden machine name — **core telemetry keeps
     running**.

If a user sets `machine_name=real` explicitly but leaves `hostname` off, the plugin emits a
**warning** (the machine will report as hidden; set `hostname=on` or use `machine_name=alias:<label>`).
The default case (no `machine_name` set) stays quiet.

## Consequences

- **Positive:** `alias`/`hidden` users — and the default user — are never prompted for `RunCommands`;
  the real hostname never leaves the machine unless explicitly enabled; denying `RunCommands` degrades
  gracefully instead of killing telemetry; the audit's ADR-0002 least-privilege finding is resolved.
- **Negative / behavior change:** the **default machine name is now `null` (`<hidden>`)** rather than
  the real hostname. Users who want their hostname shown must set `hostname = on`; users who want a
  friendly label use `machine_name = alias:<text>` (no permission needed). This is a deliberate
  departure from ADR-0002's `full`-baseline default, captured here rather than by rewriting ADR-0002.
- **Neutral:** `machineId` (the salted, non-reversible machine identifier used for multi-tenancy) is
  unaffected — with the flag off it simply uses its existing random-fallback derivation.

## Open Questions / Risks

- **Runtime handshake behavior is not statically verifiable.** Requesting `RunCommands` *after* the
  base grant (and again on a live config toggle) relies on Zellij's mid-session permission-request
  behavior, which `FINDINGS.md` flags as smoke-check-only. Validate the on/deny/toggle paths in a
  throwaway session before release (never the user's live session).
- Whether to also expose the alias→hostname fallback (an `alias:` with empty text) under this same
  flag is left as-is: that path already yields no hostname today.

## References

- [ADR-0002 — Configurable privacy controls](0002-configurable-telemetry-privacy-controls.md)
- `FINDINGS.md` §7 (permissions), §hostname (why `run_command(["hostname"])`)
- Zellij permissions — https://zellij.dev/documentation/plugin-api-permissions.html
