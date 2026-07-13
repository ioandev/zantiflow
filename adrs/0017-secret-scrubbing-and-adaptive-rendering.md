# ADR-0017 — Secret scrubbing for shared pane output (+ adaptive content rendering)

- **Status:** Accepted
- **Extends:** [ADR-0016](0016-dashboard-page-and-pane-output.md) (pane-output), [ADR-0002](0002-configurable-telemetry-privacy-controls.md) (privacy — redact at the source)
- **Builds on:** [ADR-0008](0008-status-website-dashboard.md) (dashboard), [ADR-0005](0005-attentions-detection-and-triggering.md) (pattern-safety caps), [ADR-0014](0014-testing-strategy.md), [ADR-0015](0015-modular-code-organization.md)
- **Date:** 2026-07-10
- **Deciders:** project owner
- **Tags:** privacy, security, scrubbing, pane-output, website, ui
- **Testing:** unit (scrub ruleset hits/misses/false-positives) + BDD (a token in output is masked **before send**) + Playwright (drawer shows masked spans; "output not shared") — see [ADR-0014](0014-testing-strategy.md)

## Context

[ADR-0016](0016-dashboard-page-and-pane-output.md) added opt-in **pane-output** ("last 50 lines") and
flagged that shared output can contain **secrets** (API keys, tokens, env vars, connection strings,
private keys). This ADR adds **secret scrubbing** — masking likely secrets **before output leaves the
machine** — and, because content availability now varies a lot, makes the **website render adaptively**
to whatever content is actually present.

## Decision Drivers

- **Redact at the source** (ADR-0002): the backend must never receive raw secrets.
- **Defense-in-depth** for an already-opt-in, sensitive feature.
- Be **honest**: scrubbing is best-effort, not a guarantee.
- The UI must **communicate availability** (why content is/ isn't shown), not blank out.

## Decision

### 1. Scrub in the plugin, before send

When `pane_output` is on and a pane is **requested** (ADR-0016), the plugin captures its last ≤50 lines
→ **scrubs** → caps → emits it on the **pane-output channel**. Scrubbing sits **between capture and send**, so the backend and wire only ever carry
**already-masked** text (**no wire-contract change**). Matches are replaced with a sentinel mask, e.g.
`«redacted:token»` / `••••`. Because output now retains **ANSI color codes** (ADR-0016), scrubbing is
**ANSI-aware**: it matches on the de-ANSI'd text and masks the corresponding spans **in place**, keeping
the surrounding color codes (a secret split across color codes could evade — a residual limitation).

### 2. Built-in ruleset (denylist) — best-effort

Ship a maintained default ruleset covering common shapes:

- **Assignments / headers with sensitive names:** `*_TOKEN|*_SECRET|*_KEY|*_PASSWORD|PASS`,
  `Authorization: Bearer …`, `AWS_SECRET_ACCESS_KEY`, connection strings `scheme://user:pass@host`.
- **Known token formats:** `ztf_…`, GitHub `ghp_/gho_…`, Slack `xox…`, Stripe `sk_live_…`, OpenAI
  `sk-…`, AWS `AKIA…`, **JWTs**, Google API keys.
- **Private-key blocks:** `-----BEGIN … PRIVATE KEY-----` … `END`.
- **High-entropy blobs** above a length threshold (hex/base64) — optional, tunable (false-positive risk).

Regexes obey the **ADR-0005 pattern-safety caps** (anchored where possible, bounded scan) to avoid
ReDoS/cost.

### 3. On by default, extensible

- Scrubbing is **ON whenever `pane_output` is ON** — you cannot share output *without* scrubbing except
  via an explicit, discouraged **`pane_output_scrub = off`** opt-out (a deliberate "I understand" flag).
- Users may **add** custom patterns/keywords (via the ADR-0002 config-pattern model) to scrub
  project-specific secrets.

### 4. Honest limits

Scrubbing **reduces, does not eliminate**, leakage — novel/obfuscated secrets slip through, and
over-broad rules can hide legitimate content. The real protection remains **not sharing output for
sensitive panes**. The UI/config must state this plainly.

### 5. Adaptive content rendering (the website adjusts to what's available)

The dashboard (ADR-0016) **renders based on the content actually present**, and always shows **why**
something is absent rather than a blank:

| Situation | The website shows |
| --- | --- |
| `pane_output` off | **"output not shared"** (no drawer content) |
| Output shared, secrets scrubbed | the tail with **masked spans** (`••••` / "‹redacted›") inline |
| Names redacted (ADR-0002) | `<hidden>` for the name; structure/counts still shown |
| Machine `stale` / offline | stale badge, dimmed, `last seen …` in warning color |
| Resurrectable/dead session | "no tab/pane detail for dead sessions" |
| No change observed yet | `Unknown` / "no change observed yet" |

**Principle:** never assume a field is present; **degrade gracefully** and **disclose the reason**
(privacy vs not-yet vs dead vs scrubbed). This is a rendering rule for the whole dashboard, not just
the output drawer.

## Consequences

**Positive**
- Meaningfully reduces secret leakage for the opt-in output feature; defense-in-depth at the source.
- The UI clearly communicates availability, so redaction/scrubbing/staleness never read as bugs.

**Negative / costs**
- **Best-effort** — secrets can still slip through (documented); over-scrubbing can mask real content
  (false positives to tune).
- A ruleset to **maintain** as new token formats appear.

**Neutral**
- No wire-contract change (scrubbing is a pre-send transform on the pane output). Extends ADR-0016 +
  ADR-0002; the adaptive-rendering rule complements ADR-0016.

## Open Questions / Risks

1. **Ruleset maintenance** + false-positive tuning; entropy-threshold detection defaults. **Decided:** a versioned built-in ruleset (Rust module) ships with the plugin; entropy detection opt-in & tunable.
2. Should scrubbed spans be **marked** in the payload (for distinct UI styling) vs plain masked text?
   Default: plain masked text (no contract change). **(decided.)**
3. Whether to allow the **`scrub = off`** opt-out at all, or require sharing-with-scrubbing only. **Decided:** allow `scrub=off` behind an explicit "I understand" flag.
4. Per-pane vs global scrub config granularity (& **Decided:** global + config-pattern overrides (ADR-0002).

## References

- ADR-0016 (pane-output), ADR-0002 (privacy / redact-at-source), ADR-0005 (pattern-safety caps),
  ADR-0008 (dashboard)
