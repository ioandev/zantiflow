# ADR-0022 — Plugin publishing (GitHub Releases) & user documentation

- **Status:** Accepted
- **Builds on:** [ADR-0001](0001-zellij-session-telemetry-architecture.md) (the plugin), [ADR-0012](0012-plugin-device-pairing.md) (pairing onboarding), [ADR-0002](0002-configurable-telemetry-privacy-controls.md)/[ADR-0016](0016-dashboard-page-and-pane-output.md)/[ADR-0018](0018-engineering-and-operational-conventions.md) §3 (config), [FINDINGS.md](../FINDINGS.md)
- **Refined by:** [ADR-0023](0023-documentation-site-starlight.md) — `docs/` becomes a **Starlight** site; this guide migrates into it as a content page
- **Corrected by:** [ADR-0036](0036-apache-2-0-and-third-party-license-compliance.md) — the source license is **Apache-2.0**, not MIT (corrects §1)
- **Amended by:** [ADR-0037](0037-host-shared-plugin-identity-via-cache.md) — the token/identity persist in `/cache`, not `/data`. [ADR-0038](0038-self-hosted-plugin-distribution-origin.md) — adds an optional self-hosted stable-URL `.wasm` mirror (`plugin-dist`) alongside the GitHub-Releases / `file:` loads
- **Date:** 2026-07-11
- **Deciders:** project owner
- **Tags:** plugin, publishing, distribution, docs, onboarding, security
- **Testing:** CI release build + **SHA-256 checksum** publish/verify; a docs link-check — see [ADR-0014](0014-testing-strategy.md)

## Context

The plugin is a Rust → `wasm32-wasip1` module (`apps/plugin`). Unlike the backend/web (Docker Hub,
ADR-0021) and the `@zantiflow/oauth*` packages (npm, ADR-0004), a Zellij plugin is distributed as a
**`.wasm` loaded by Zellij** — there is no official plugin registry. This ADR decides **how it's
published** and **what user documentation** ships so people can install, start, and configure it.

## Decision

### 1. Publish via GitHub Releases

- The compiled **`zantiflow.wasm`** is attached to **versioned (SemVer) GitHub Releases** of
  `github.com/ioandev/zantiflow`, built by **CI on tag**. WASM is arch-independent → one
  artifact. Source is **MIT/OSS** (`apps/plugin`); `zellij-tile` is **pinned** (FINDINGS).
- **Integrity is a security requirement** (a Zellij plugin loaded from a URL runs **untrusted WASM in
  the user's terminal with pane-content access**): each release publishes a **`SHA-256` checksum** (and
  we may sign releases later); docs **recommend pinning an exact version**, not `latest`.
- **Not** on Docker Hub or npm — those are the server images / OSS libs; the plugin is GitHub-Releases-only.

### 2. Loading methods (documented; user's choice)

- **Direct URL** (Zellij fetches the `.wasm` over HTTPS — the zjstatus model):
  `plugin location="https://github.com/ioandev/zantiflow/releases/download/v<X.Y.Z>/zantiflow.wasm"`.
- **Local file:** download the `.wasm` (verify checksum) to `~/.config/zellij/plugins/` and reference
  `file:…`.
- **One-off / keybinding:** `zellij plugin` or a `LaunchOrFocusPlugin` binding.
- **Permissions:** on first load Zellij **prompts to grant** `ReadApplicationState`, `WebAccess`,
  `ReadPaneContents`, and (only if `machine_name = real`) `RunCommands` — least-privilege (ADR-0014 H3);
  docs explain each.
- Distro/AUR packages — **deferred**.

### 3. Version ↔ backend compatibility

The plugin's snapshot **wire-contract version (v4)** must fall in the backend's supported range
(ADR-0018 §2). Release notes state which plugin versions work with the current hosted backend; the
backend rejects unknown-newer with a clear `400`.

### 4. User documentation

Ship a **getting-started guide** at **`docs/plugin-getting-started.md`** (and, later, surfaced on the
website), covering:

1. **Prerequisites** — Zellij installed; a zantiflow account (Google sign-in on the website).
2. **Install** — the three loading methods above (+ checksum verification).
3. **First run — device pairing** (ADR-0012): the plugin shows a short code → approve it on the website
   → the token is stored in the plugin's `/data`. (Or paste a website-minted **token** for headless
   use.)
4. **Configure** — the full **config-key catalog** (ADR-0018 §3): `pairing`/`token`, `server_url`
   (default hosted; override to **self-host**, ADR-0021), privacy (`full`, `machine_name`
   real/alias/hidden, `session_names`/`tab_names`/`pane_names`, **`pane_output`** default-OFF +
   `pane_output_scrub`), attention toggles — with KDL examples.
5. **Privacy defaults** — `full` by default; **content never leaves the machine** unless `pane_output`
   is on **and** requested from the website (ADR-0016).
6. **Self-hosting** — set `server_url` to your instance (ADR-0021).
7. **Troubleshooting** — permission prompts, `WebAccess` denied → the plugin warns + idles (ADR-0018
   §10), hostname needs `RunCommands`, pinning the version.

## Consequences

**Positive**
- Familiar OSS distribution (GitHub Releases + direct-URL load, like zjstatus); one clear getting-started
  path from "installed Zellij" to "reporting".
- Checksums + version-pinning guidance address the load-untrusted-WASM risk.

**Negative / costs**
- No registry auto-update — users pin/update manually (mitigated by the direct-URL `latest` option for
  those who accept it).
- Docs must track config-key and wire-version changes across releases.

**Neutral**
- Distinct from ADR-0021 (images) and ADR-0004 (npm); the getting-started doc lives in `docs/`.

## Open Questions / Risks

1. **Release signing** (cosign/minisign) beyond SHA-256 — **(decided: checksums now; signing later.)**
2. **Background vs pane hosting** — whether the plugin runs headless or in a small status pane (it must
   render the pairing code at least once, ADR-0012) — an implementation detail for `apps/plugin`.
3. **A Homebrew/AUR formula** for one-command install — deferred.

## References

- ADR-0001 (plugin), ADR-0012 (pairing), ADR-0002/0016/0018 §3 (config), ADR-0021 (self-host backend),
  FINDINGS.md (permissions, `web_request`, pinning)
- `docs/plugin-getting-started.md`
