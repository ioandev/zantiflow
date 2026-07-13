# UI-ELEMENTS.md — what the UI needs

Derived from the accepted ADRs (`adrs/0001`, `0002`, `0003`) and the v3 wire contract. This
enumerates the **elements, data, and states the UI must render and handle** — it is a requirements
inventory, not a visual design. Every element below is traced to the decision that requires it.

> **Scope & status.** The *authoritative* UI — a read API + status website — is **planned as
> ADR-0005 and not yet accepted** (owner login is **ADR-0004**, also planned). So the website
> sections here are **requirements a future design must satisfy**, derived from the data model that
> *is* decided, not an approved design. The only UI that is fully specified today is the **console
> dev/debug render** (ADR-0001 §6, ADR-0002 §7), which ADR-0003 §8 **demoted to an optional
> dev/debug view**. Where a requirement depends on an unaccepted ADR it is marked **⚠ ADR-0004** /
> **⚠ ADR-0005**.

---

## 1. The UI surfaces

| Surface | Status | Owner ADR | Purpose |
| --- | --- | --- | --- |
| **Console dev/debug render** | Decided, demoted | ADR-0001 §6, ADR-0002 §7 | Plain-text tree in the backend console; dev/debug only. |
| **Status website — read/monitor UI** | ⚠ Planned | ADR-0005 | "Show everything" for an account: machines → sessions → tabs → panes, live. **The real UI.** |
| **Token management UI** | Surface decided; auth planned | ADR-0003 §4 (API), ⚠ ADR-0004 (login) | Create / list / revoke ingest tokens; show a new secret once. |
| **Owner auth (Google)** | ⚠ Planned | ADR-0004 | Log in / out; establishes the `accountId` everything is scoped to. |

Everything except the console view sits behind **owner authentication** (ADR-0004): the website reads
data and manages tokens, and both require owner auth. **Ingest tokens are write-only** and grant no
read/manage ability (ADR-0003 §3) — so a token is never a website credential.

---

## 2. The data the UI has to work with

The UI can only render what reaches the backend. That is the **v3 wire contract** (ADR-0003 §7,
extending ADR-0002 §6 and ADR-0001 §5) plus fields the **backend derives**. Do not invent fields the
plugin does not send (e.g. `connected_clients`, `creation_time`, viewport sizes exist in the Zellij
structs but are **not** on the wire — see FINDINGS §3).

**Top level (per machine, per tick):** `version`, `machineId`, `capturedAtTick`, `privacy{full,
machine, sessionNames, tabNames, paneNames}`, `machine{source, name}`, `sessions[]`.

**Per session:** `sid`, `name` *(nullable)*, `isCurrent`, `state` ∈ `live | resurrectable`,
`diedSecondsAgo` *(nullable)*, `tabs[]`. Resurrectable/dead sessions carry **only** a name + death
age — Zellij gives **no tab/pane detail** for them (ADR-0001 §3), so they render as a leaf.

**Per tab:** `tabId`, `name` *(nullable)*, `position`, `active`, `panes[]`.

**Per pane:** `id`, `name` *(nullable)*, `command` *(nullable)*, `isFocused`, `exited`,
`contentFingerprint` (opaque; the UI never shows it — it exists only so the backend can diff).

**Backend-derived (not on the wire):**

- **`lastUpdated` per pane** — the backend stamps a change time (its own clock) when a pane's
  `contentFingerprint` changes, keyed by identity **`sid + tabId + paneId`** (ADR-0002 §3). Rendered
  as "updated Ns ago" or, if no change has been observed yet, **`Unknown`** (ADR-0001 §4).
- **Machine `displayName`, `firstSeenAt`, `lastSeenAt`** (ADR-0003 §1) — drives the machine list and
  the online/stale indicator.
- **Token metadata** — `id`, `label?`, `createdAt`, `expiresAt` (`null` = infinite), `lastUsedAt`,
  and derived status `active | expired | revoked` (ADR-0003 §1–2).

---

## 3. Load-bearing UI rules (easy to get wrong)

These come straight from the ADRs and shape every screen. Get them wrong and the UI misrepresents
privacy or activity.

1. **Three distinct "no value" states — never collapse them.**
   - **`<hidden>`** — a `name`/`command` is `null` because the user **redacted** it (ADR-0002 §7).
     Render literally `<hidden>` (or `<machine hidden>` for `machine.source == "hidden"`).
   - **`Unknown`** — a pane whose fingerprint **has not changed since observation began**; no update
     time is known yet (ADR-0001 §4). This is about *activity*, not names.
   - **Offline / stale machine** — `lastSeenAt` is old (no recent ingest). This is about the
     *machine*, not a field.
   A hidden pane can also be `Unknown` at the same time — both render together (see ADR-0002 §7's
   example: `<hidden>  Unknown`).

2. **Every name is nullable, everywhere.** `machine.name`, session/tab/pane `name`, and pane
   `command` may all be `null` (ADR-0002 §7). Never assume presence; default to `<hidden>`.

3. **Show the effective privacy policy, not the user's intent.** The `privacy` object echoes the
   **effective** settings after fail-closed resolution (ADR-0002 §2/§6). Surface it (e.g.
   `privacy: restricted (pane names hidden)`) so the user can confirm redaction actually took effect.
   Invalid config **fails closed to hidden** — the echo is how the user notices.

4. **Structure and timing still leak under full redaction — don't imply otherwise.** Even with
   everything hidden, session/tab/pane **counts and per-pane activity timing are still shown** by
   design (ADR-0002 Consequences / Open Q3). The UI shouldn't present "names hidden" as "nothing
   revealed."

5. **The website is read-only.** It **displays** state; it cannot control Zellij sessions. There is
   no start/stop/kill affordance — none exists in the data flow.

6. **Freshness ≠ tick.** `capturedAtTick` is a **monotonic counter, not a clock** (ADR-0001 §2); it
   coalesces/drifts under load. Human-facing "N seconds ago" and online/offline come from the
   **backend clock** (`lastUpdated`, `lastSeenAt`), never from the tick.

7. **A token secret is shown exactly once.** At creation only (ADR-0003 §1/§4). It is stored hashed
   and never returned again — the UI must never display it after the create moment, and lists show
   **metadata only**.

---

## 4. Surface: console dev/debug render (decided)

Already fully specified — reproduced here as the baseline element set. Plain text + indentation, no
persistence, re-rendered each tick (clear console + reprint). ADR-0001 §6 / ADR-0002 §7:

```
zantiflow — red-laptop — 2 sessions — privacy: restricted (pane names hidden) — 2026-07-10 18:42:07

● main (current) [live]
    ▸ editor (active)
        • <hidden>        updated 0.3s ago
● other [live]
    ▸ shell (active)
        • <hidden>        Unknown
○ old-build [resurrectable, died 5m ago]
```

Elements: header (machine name / `<machine hidden>`, session count, **privacy echo**, timestamp);
session line with current/state badges; tab line with active flag; pane line with name-or-`<hidden>`
and `updated Ns ago` / `Unknown`; resurrectable sessions as a leaf with death age. `●` live vs `○`
resurrectable. This set is the **minimum** the website must also cover.

---

## 5. Surface: status website (⚠ planned — ADR-0005)

The real UI. Requirements below are derived from the decided data model; visual design is ADR-0005's.

### 5.1 Auth & account (⚠ ADR-0004)

- **Google sign-in / sign-out**, and a display of the signed-in owner identity.
- Everything is **scoped to one `accountId`** (ADR-0003 §1); the UI never shows cross-account data.
- Empty/first-run state for an account with **no machines** and **no tokens** yet — with a path to
  "create your first token" (see 5.4).

### 5.2 Machines overview ("show everything")

The account's landing view — a list/grid of the account's machines (ADR-0003 §1, "show everything"
per ADR-0005 scope). Per machine card:

| Element | Source | Notes |
| --- | --- | --- |
| Machine display name | `machine.name` / `displayName` | `<machine hidden>` when `source == "hidden"`. |
| Machine-name source badge | `machine.source` ∈ `real \| alias \| hidden` | So the user can tell an alias from the real hostname. |
| Online / stale indicator | derived from `lastSeenAt` | "live" vs "last seen Nm ago". Threshold ≈ a few ticks. |
| Session / tab / pane counts | `sessions[]` tree | Leaks by design even when names hidden (rule §3.4). |
| Effective privacy summary | `privacy` echo | e.g. "names hidden". |
| First seen / last seen | `firstSeenAt` / `lastSeenAt` | ADR-0003 §1. |

Selecting a machine opens its detail tree (5.3). Needs empty ("no machines reporting"), loading, and
**offline machine** (last snapshot shown, marked stale) states.

### 5.3 Machine detail — the sessions → tabs → panes tree (core view)

The heart of the app. A three-level tree rendered from one machine's latest snapshot.

**Machine header:** display name / `<machine hidden>` + source badge; **privacy echo** (effective);
online/stale (from `lastSeenAt`); `machineId` (for support/debug); snapshot freshness ("updated Ns
ago", from backend clock).

**Ordering (ADR-0001 §3):** sessions render **current → other live → resurrectable/dead**; tabs by
`TabInfo.position`; panes in manifest order, keyed to their tab.

**Element inventory:**

| Level | Element | Field | Rendering rule |
| --- | --- | --- | --- |
| Session | Name | `name` | text, or **`<hidden>`** if `null`. |
| Session | Current badge | `isCurrent` | mark the one current session. |
| Session | State badge | `state` | `live` vs `resurrectable`. |
| Session | Death age | `diedSecondsAgo` | only for `resurrectable`; "died 5m ago". |
| Session | (identity) | `sid` | stable id; not usually shown, used for keys/deep-links. |
| Session | Dead = leaf | — | resurrectable sessions have **no tabs/panes** (ADR-0001 §3). |
| Tab | Name | `name` | text, or **`<hidden>`**. |
| Tab | Active flag | `active` | mark the focused tab. |
| Tab | (identity) | `tabId` | key. |
| Pane | Name | `name` | text, or **`<hidden>`**. |
| Pane | Command | `command` | secondary label; `<hidden>` if `null`; may equal name. |
| Pane | Focused flag | `isFocused` | mark the focused pane. |
| Pane | Exited flag | `exited` | mark exited panes distinctly. |
| Pane | **Last updated** | derived `lastUpdated` | "updated Ns ago" **or `Unknown`** (rule §3.1). |

**Live refresh.** Snapshots arrive ~1s (ADR-0001 §2), so the view should feel live (auto-refresh /
push). **⚠ The read/refresh transport is not decided** (ADR-0005 open; poll vs WebSocket) — and
whether the backend keeps **history or latest-only** is an open question (ADR-0003 Open Q5). If
latest-only, the UI shows *current state* only, no timeline.

### 5.4 Token management (ADR-0003 §4 — surface decided; ⚠ login is ADR-0004)

Maps directly onto the three token endpoints. All require owner auth.

**Token list** (`GET /api/v1/tokens`, metadata only — never secrets):

| Column | Field | Notes |
| --- | --- | --- |
| Label | `label?` | optional, user-set. |
| Status | derived | **`active` / `expired` / `revoked`** — must be visually distinct. |
| Created | `createdAt` | |
| Expires | `expiresAt` | date, or **"never"** when `null` (infinite). |
| Last used | `lastUsedAt` | tells the user if a token is live/idle. |
| Actions | — | **Revoke** (immediate; ADR-0003 §2). |

**Create token** (`POST /api/v1/tokens`):

- Inputs: optional **label**; **TTL** picker — a duration (`1h / 24h / 7d / 30d / 90d / 365d` or an
  explicit seconds value) **or `infinite`** (ADR-0003 §2).
- **≤10 active tokens per account** (ADR-0003 §2). The UI shows the count (e.g. "7 / 10 active") and
  must handle the **409** when an 11th is attempted — ideally disable "create" at the cap and explain
  that revoking/expiring frees a slot.
- **Show-secret-once modal**: the full `ztf_…` secret displayed **once**, with a copy button and a
  clear "you won't see this again" warning (ADR-0003 §1/§4). After dismissal it's gone.
- **Setup helper** in that same modal: how to put the token into the plugin config — the `token` key,
  and `server_url` (defaults to the hosted instance; override for self-hosting, **must be https**,
  ADR-0003 §6). Prefer showing the **CLI `--configuration`** form over a shared layout file, because
  the token is a plaintext secret (ADR-0003 §6 secret-handling note). Example both ways:

  ```bash
  zellij action launch-or-focus-plugin file:/path/to/zantiflow-plugin.wasm \
    --configuration "token=ztf_…,server_url=https://ingest.myhost.example"
  ```

**Revoke** (`DELETE /api/v1/tokens/:id`): immediate; needs a confirm step (irreversible; running
plugins using it start getting 401 — ADR-0003 §2/§3).

---

## 6. States every data view must handle

- **Loading** — fetching the snapshot / list.
- **Empty** — no machines; no sessions; no tokens (first-run guidance).
- **Redacted** — `<hidden>` names, `<machine hidden>`; still render the structure.
- **`Unknown` activity** — pane observed but no fingerprint change yet.
- **Exited pane** — `exited: true`, possibly still listed.
- **Dead session** — `resurrectable`, name-or-`<hidden>` + death age, no children.
- **Stale / offline machine** — old `lastSeenAt`; show last snapshot, marked stale.
- **Backend/ingest gap** — plugin is fire-and-forget (ADR-0001 Consequences); the UI can't tell "no
  output" from "plugin/network down" except via `lastSeenAt` — reflect that honestly.
- **Token at cap (10/10)** / **expired** / **revoked**.

---

## 7. Status & badge vocabulary (keep consistent across surfaces)

- Session: **current**, **live**, **resurrectable** (+ death age).
- Tab: **active**.
- Pane: **focused**, **exited**; activity **updated Ns ago** / **Unknown**.
- Machine: **live** / **stale-offline**; name source **real** / **alias** / **hidden**.
- Privacy: **full** vs **restricted (…​)** from the `privacy` echo.
- Token: **active** / **expired** / **revoked**; expiry **never** (infinite) vs a date.

---

## 8. Out of scope / blocked on future ADRs

- **Owner authentication (Google)** — ⚠ ADR-0004. Until then the token-management UI has no
  authenticated caller (ADR-0003 Open Q1, the bootstrap gap).
- **Read API shape, history-vs-latest, and refresh transport** — ⚠ ADR-0005 / ADR-0003 Open Q5.
  Determines whether the tree view has a timeline or only "now," and poll vs push.
- **Per-session/per-pane redaction granularity, stricter counts-only/activity-off modes** — deferred
  (ADR-0002 Open Q3/Q4); today only global category toggles exist, so the UI can't offer finer
  privacy display than the four `privacy` fields.
- **Plugin config UI** — `token` / `server_url` / privacy keys are set via Zellij (KDL / CLI), **not**
  in this UI (ADR-0002 §1, ADR-0003 §6). The website only *hands out* a token and shows setup
  instructions (5.4); it does not configure the plugin.
- **Visual design** (layout, color, typography) — this doc lists *what* must appear, not *how*.

---

## References

- ADR-0001 §2 (cadence/tick), §3 (ordering/tree), §4 (`Unknown`/derived `lastUpdated`), §5 (wire v1),
  §6 (console render) — [0001](adrs/0001-zellij-session-telemetry-architecture.md)
- ADR-0002 §2 (precedence/fail-closed), §3 (`sid`, null-name redaction), §6 (wire v2 / `privacy` /
  `machine`), §7 (backend acceptance: `<hidden>` vs `Unknown`) —
  [0002](adrs/0002-configurable-telemetry-privacy-controls.md)
- ADR-0003 §1 (entities: machine/token fields), §2 (≤10 cap, expiry, revoke), §3 (write-only ingest),
  §4 (token management API surface), §6 (`token`/`server_url`), §7 (wire v3), §8 (persistence,
  console demoted) — [0003](adrs/0003-multi-tenant-backend-and-token-auth.md)
- FINDINGS §3 (which struct fields exist / are **not** on the wire) — [FINDINGS.md](FINDINGS.md)
- Planned: **ADR-0004** (owner/Google auth), **ADR-0005** (read API + status website).
