# ADR-0053 — Dashboard filter nudge on repeated manual refresh

- **Status:** Accepted
- **Relates to:** [ADR-0016](0016-dashboard-and-pane-output.md) (dashboard), [ADR-0026](0026-minimise-plugin-update-cadence.md)
  (the manual-refresh button), [ADR-0019](0019-ux-decisions-deferred.md) (sensible-default UX; this is
  one small decided behavior, not a page design)
- **Date:** 2026-07-22
- **Deciders:** project owner
- **Tags:** web, dashboard, ux
- **Testing:** web unit — the pure click-window logic (2 refreshes within the window → nudge;
  farther apart → none; old entries pruned); the browser-reload trigger with injected
  storage/reload-flag (2nd reload nudges then resets; non-reload navigations don't count; corrupted
  or absent storage is a safe no-op); a static render of the copy + troubleshooting link.
- **Wire contract:** unchanged (**v4**) — client-side only.

## Context

Live incident (2026-07-22): a session was reporting fine but the dashboard's **"Claude only"**
filter (on by default) hid it — the user's response was to refresh repeatedly (the browser's own
reload, and the manual **↻ refresh** button) and conclude the data pipeline was broken. Refreshing
can't help when a *filter* is hiding the data, and nothing pointed at the filters.

## Decision

Treat **2 refreshes within 5 minutes** as a frustration signal — via **either trigger**:

1. **↻ machine-refresh clicks** (any machine's button, dashboard-wide, counted in memory), or
2. **browser reloads** of the dashboard tab (F5/⌘R — detected via the Navigation Timing API's
   `type === 'reload'`, so plain navigations and back/forward don't count; timestamps persist the
   reload itself in **sessionStorage**, per tab, gone when the tab closes)

— and show a **dismissible toast**, at most **once per page load**:

> Not finding what you’re looking for? Check the filters at the top · [Troubleshooting guide →]

The link opens the docs-site **troubleshooting** page (`lib/links.ts`, ADR-0023) in a new tab.

Mechanics: one pure window helper (`lib/refreshNudge.ts`; both triggers share the 5-min/≥2 policy)
tracked at the dashboard page level; disabled-button clicks (the ~5 s busy state) don't count; when
the reload trigger fires, its stored window resets, so re-nagging needs two more rapid reloads. No
backend involvement.

## Consequences

- The filter-hides-my-data trap now self-diagnoses within two refreshes of either kind, with an
  escape hatch into the troubleshooting docs.
- The threshold/window/copy are constants in one module — trivial to tune; a future settings page
  (ADR-0019) could suppress it entirely.
