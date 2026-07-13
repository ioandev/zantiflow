# ADR-0016 — Dashboard page (per the zantiflow design) + pane-output capture

- **Status:** Accepted
- **Implements:** [ADR-0008](0008-status-website-dashboard.md) — the concrete dashboard, per the design
- **Extends:** [ADR-0002](0002-configurable-telemetry-privacy-controls.md) (adds an opt-in **pane-output** share axis); output is a **separate on-demand channel** (ingest contract unchanged, v4)
- **Extended by:** [ADR-0017](0017-secret-scrubbing-and-adaptive-rendering.md) — secret scrubbing (mask secrets before send) + adaptive content rendering
- **Builds on:** [ADR-0003](0003-multi-tenant-backend-and-token-auth.md) (machines/tokens), [ADR-0004](0004-google-auth-owner-sign-in.md) (owner auth), [ADR-0005](0005-attentions-detection-and-triggering.md) (attentions), [ADR-0014](0014-testing-strategy.md), [ADR-0015](0015-modular-code-organization.md)
- **Date:** 2026-07-10
- **Deciders:** project owner
- **Tags:** website, dashboard, ui, pane-output, privacy, wire-contract
- **Testing:** Playwright (dashboard render, pane-output drawer, SSE live, theme) + integration (output read API + MariaDB) + unit (output capture cap/redaction) — see [ADR-0014](0014-testing-strategy.md)
- **Wire contract:** snapshot/ingest **unchanged (v4)**; pane output is a **separate on-demand ~5 s poll channel**

## Context

The dashboard design is vendored at **`design/dashboard/`** (a `dc-runtime` React mockup):
**`zantiflow-status-v2.dc.html` is canonical**; `…-v1` is an earlier iteration without the two v2
additions. The website must build to this design.

Mapping the design to what the backend already provides: **almost everything is already supported** by
ADR-0008's read API + the ADR-0001/0002/0005 data — machines list, `live`/`stale`, privacy badges,
attention badges, counts (shown even under full redaction), first/last seen, `machineId`, the
session→tab→pane tree, statuses (current/live/resurrectable/exited/focused/active), activity
(`Xs ago` / `quiet 12m` / `Unknown`), the Tokens page, the account menu.

**Two things are new** and must be added here:

1. **Pane output — "last 50 lines".** Clicking a pane opens a drawer showing the tail of its stdout
   ("pane output — last 50 lines · captured X ago"). This is **real terminal content leaving the
   machine** — a deliberate reversal of the "content never leaves; only fingerprint hashes" default
   (ADR-0001/0002/0005). It is added here as an **explicit, privacy-gated opt-in**.
2. **Theme** — a dark (default) / light toggle. Frontend-only.

## Decision Drivers

- Build the dashboard to the **actual design**.
- Keep the **strong privacy default intact**: by default, still **no content leaves the machine**.
- Make pane-output **cheap** (piggyback on existing fingerprinting) and **consent-driven**.

## Decision

### A. Dashboard information architecture (implements ADR-0008)

- **Nav:** `zantiflow` · **Machines** · **Tokens** · theme toggle · account menu (email/avatar, logout).
- **Machines list (`/`):** "N reporting for this account"; per-machine **card** — name (or
  `<machine hidden>`), `live`/`stale`, privacy badges (`real hostname`/`alias`/`hidden`, `privacy:
  full` / `restricted (…)`), attention badge (`k needs attention`), counts (`sessions · tabs · panes`,
  shown even under full redaction), `first seen`, `last seen` (stale → warning color). Copy: *"Counts
  are shown even under full redaction — structure leaks by design."* Click → detail.
- **Machine detail (`/m/:machineId`):** header (name, badges, `updated Xs ago`, first/last seen,
  `machineId`); **sessions** in ADR-0001 order — current → live → resurrectable (`died Xm ago · no
  tab/pane detail for dead sessions`); **tabs** (active); **panes** (name, command, status
  focused/active/exited/**needs attention**, activity / `quiet Xm` / `Unknown`).
- **Pane-output drawer:** click a pane → expand → *"pane output — last 50 lines · captured X ago ·
  click row to close"* → the tail. If output isn't shared for that machine → show **"output not
  shared"** instead of content.
- **Live** via SSE (ADR-0008). **Theme** dark-default + light toggle, persisted (localStorage; optional
  account pref).

### B. Pane-output capture — the new capability

**B1. Opt-in & privacy-gated (extends ADR-0002).** A new plugin setting **`pane_output`** (share
output) — **default OFF**. With it off, the plugin sends **no** content and the drawer shows "output
not shared", so the **default posture is unchanged**. **Even when ON, `pane_output` only *permits*
output to be sent — it is sent solely when a specific pane is *requested from the website* (§B3), never
streamed or sent continuously.** The plugin **states this plainly** in its config docs/setting
description (and any enable prompt), so turning it on is never mistaken for "stream everything".
Granularity: global on/off plus per-scope overrides via ADR-0002's config-pattern model (e.g. only
specific panes). Output-sharing is a **separate axis** from name-redaction. **Enabling it is a
deliberate, higher-trust choice** — shared output **can contain secrets** (tokens, env, keys), so it is
**scrubbed before send** (ADR-0017).

**B2. Capture on demand (plugin).** Output is captured **only when requested** — never streamed. When
`pane_output` is on and a request is pending (§B3), the plugin reads the pane's **last N lines (default
50, byte-capped)** via `get_pane_scrollback`, **scrubs** it (ADR-0017), and delivers it. **ANSI colors
are preserved** — the lines keep their escape sequences so the browser renders them **as in the
terminal**. If `pane_output` is off, requests are ignored (the drawer shows "output not shared").

**B3. A separate 5-second output channel (NOT the ingest contract).** Output does **not** ride the
1-second snapshot POST (which carries the tree + attentions, **unchanged, v4**). Instead the plugin
runs an **independent ~5 s poll** on dedicated, token-authed endpoints:
- `GET /api/v1/output/pending` → `{ requests: [{ machineId, sessionSid?, tabId?, paneId }] }` — the panes the user asked to see.
- `POST /api/v1/output` → `{ machineId, paneId, lines[] (≤50, ANSI-colored), capturedAt }` — the captured tail.

The **snapshot wire contract is unchanged** (no `output` field). Attentions/snapshots stay on the 1 s
cadence and are **not** sent on this 5 s channel.

**B4. Storage (backend).** Store the **latest fetched** output per pane (byte-capped, tenant-scoped,
**latest-only**); purge on `pane_output` disable or forget-machine. A pane that is **never requested is
never captured, sent, or stored**.

**B5. Website flow (ADR-0008).** Click a pane → `POST /api/v1/machines/:machineId/panes/:paneId/output/request`
(registers it) → the drawer shows a **spinner** until the plugin's next 5 s poll captures + delivers →
the drawer polls (or is SSE-pushed) `GET …/panes/:paneId/output` → `{ lines, capturedAt }` /
`{ pending: true }` / `{ shared: false }`. Expect **~5 s** to load; it is a **one-shot snapshot**
("captured …"), **not auto-refreshing** — click again to refresh.

### C. Privacy summary (the load-bearing point)

**Default is unchanged: no terminal content leaves the machine.** Pane-output is a **new explicit
opt-in** that, when enabled, captures + sends a capped last-50-lines **only when you request that
pane** (never streamed); otherwise the drawer says "output not shared". Users are warned that shared output may contain secrets. This is a
deliberate, consent-driven exception to the content-never-leaves default, scoped to those who enable it.

### D. Safe rendering of untrusted terminal content (security)

Pane output — **and session/tab/pane names + `command`** — are **untrusted bytes**. The dashboard must:
- **Escape all markup** and render text as text — **never `dangerouslySetInnerHTML`** untrusted spans.
- Convert ANSI to styled spans with an **allowlist of SGR (color/style) codes only**; **strip** OSC /
  hyperlink / cursor / other escape sequences and control chars — never pass raw escapes to the DOM.
- Rely on a **strict CSP** (ADR-0018) as defense-in-depth.

This closes the terminal-escape → **XSS** surface (a crafted command name or output line must not
execute), complementing the plugin-side scrubbing of ADR-0017.

## Consequences

**Positive**
- The dashboard matches the real design; pane-output is a compelling feature.
- Capture is **on-demand only** — output for unopened panes never leaves the machine; a **separate ~5 s poll** keeps it off the 1 s ingest path.
- The strong privacy **default is preserved** (opt-in only).

**Negative / costs**
- A **major new privacy surface**: real terminal content (possibly secrets) can leave the machine when
  enabled — mitigated by default-off + **on-demand-only** + **scrubbing** (ADR-0017) + warnings.
- A **separate output channel** (request + poll + deliver endpoints) to build; content storage (capped,
  latest-only) + purge-on-disable; ~5 s load latency (spinner); the plugin must capture/scrub/cap.

**Neutral**
- Implements ADR-0008 concretely; extends ADR-0002 (new axis); v1 design superseded by v2.

## Open Questions / Risks

1. **Secret leakage** — **addressed by [ADR-0017](0017-secret-scrubbing-and-adaptive-rendering.md):**
   the plugin scrubs common secrets before send (on by default when output is shared). Best-effort;
   an extra confirmation step remains an open detail there.
2. **ANSI** — strip (v1) vs preserve colors (later). **Decided:** **preserve colors** — send ANSI; the browser renders them as in the terminal.
3. **Caps** — 50 lines / byte budget — tune. **Decided:** 50 lines, cap ~16 KB/pane.
4. **Delivery model** — **decided: on-demand pull via a separate ~5 s poll** (never streamed, off the ingest path); one-shot per click. Live-while-open via SSE is a possible later enhancement.
5. **Output retention** — tied to latest snapshot; purge on disable — confirm cost. **Decided:** latest-only; purge on disable.
6. **Granularity** — global off + config-pattern overrides; finalize with the privacy config (ADR-0002). **Decided:** global off + config-pattern overrides (ADR-0002 model).

## References

- **Design:** `design/dashboard/zantiflow-status-v2.dc.html` (canonical), `…-v1` (earlier)
- ADR-0008 (website/read API/SSE), ADR-0002 (privacy — extended), ADR-0001/0005 (wire contract,
  scrollback), ADR-0014 (testing), ADR-0015 (modules)
