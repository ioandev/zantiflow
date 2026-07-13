# ADR-0019 — UX decisions are deferred (and exactly which ones)

- **Status:** Accepted
- **Cross-cuts:** presentation across [ADR-0006](0006-notifications-web-push-and-channels.md), [ADR-0007](0007-chat-bot-notification-channels.md), [ADR-0008](0008-status-website-dashboard.md), [ADR-0011](0011-tiers-and-monetization.md), [ADR-0012](0012-plugin-device-pairing.md), [ADR-0016](0016-dashboard-page-and-pane-output.md)
- **Date:** 2026-07-10
- **Deciders:** project owner
- **Tags:** ux, design, deferred, website, notifications

## Context

The vendored design (ADR-0016) specifies the **dashboard** — the Machines list, machine detail
(session→tab→pane tree), the colored **pane-output drawer**, and the dark/light theme (nav is Machines
+ Tokens). Beyond that surface, several **UX / visual / interaction** decisions are not yet settled —
either because **no design exists** for those screens yet, or because they're polish best decided with
a design pass. This ADR records that those decisions are **deliberately deferred**, names them, and
sets the interim rule so nothing is blocked. It is the concrete **home** for every "a later UX ADR"
reference elsewhere in the ADRs.

## Decision

### 1. Not deferred (already decided / designed — for the record)

- The **dashboard pages** in the vendored design (ADR-0016): Machines list, machine detail, the
  colored pane-output drawer, dark/light theme.
- All **functional behavior**: what data is shown, privacy/redaction rendering, the adaptive
  "why-unavailable" states (ADR-0017), live **SSE**, the read API, and **history = none** (live/latest
  only, ADR-0008).
- **Badges vs feed** — **resolved: badges only** (history is `none`, so there is no activity feed).

### 2. Deferred UX decisions (the list)

| # | Deferred | Functional model already decided in |
| --- | --- | --- |
| **D1** | **Notifications-settings page** design (which attentions notify, quiet hours, per-type routing, tier-gating UI) | ADR-0006 |
| **D2** | **Integrations page** design (connect Discord/Telegram, show the `/link` token, linked/stale/reconnect states) | ADR-0007 |
| **D3** | **Account / tier / promo page** (tier status, **promo-code redemption** UI, Sponsors link, upsell surfaces) | ADR-0011 |
| **D4** | **Device-pairing UI** (the verification page + code entry) beyond the basic flow | ADR-0012 |
| **D5** | **Notification digest / grouping** (bundling multiple attentions into one; interaction with cooldown) | ADR-0006 §6 |
| **D6** | **Dense-tree / responsive layout** (summarized views for many sessions/tabs/panes; "other sessions" summarization) | ADR-0008 |
| **D7** | **Onboarding & permission copy** (first-run, PWA-install nudges, the pre-permission popup wording) | ADR-0006 |
| **D8** | **Empty / loading / error states, toasts** across the app | — |
| **D9** | **Detailed a11y audit & i18n** (baseline set in ADR-0018; full pass deferred) | ADR-0018 |

### 3. Interim rule

Build these surfaces to **sensible functional defaults** — plain, accessible, and consistent with the
dashboard's look — so the execution plan is **never blocked** on missing design. A **future UX ADR**
(or the delivered design for D1–D4) supersedes those defaults.

## Consequences

- **Nothing blocks the build** — every deferred item is presentation, not behavior; the behavior is
  already decided in the referenced ADRs.
- **Risk (accepted):** interim UIs may need rework when designs land.
- Gives a single, honest inventory of **what is not yet designed**.

## Open Questions / Risks

1. **Trigger** for the UX ADR — most naturally, when designs for D1–D4 (the settings / integrations /
   account / pairing screens) arrive. **(decided: on design delivery.)**

## References

- ADR-0006 (notifications), ADR-0007 (channel linking), ADR-0008 (dashboard/history-none), ADR-0011
  (tiers/promo), ADR-0012 (pairing), ADR-0016 (dashboard design), ADR-0017 (adaptive rendering),
  ADR-0018 (a11y/i18n baseline)
