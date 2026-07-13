# TIMING-discoveries.md — live measurement of plugin→backend cadence

Empirical measurement of what the **running** Zellij plugin actually sends to the backend, taken to
ground **[ADR-0026](adrs/0026-minimise-plugin-update-cadence.md)** (change-driven, presence-aware
sends) in real numbers rather than theory.

- **Date:** 2026-07-11
- **Setup measured:** the live dev stack on this machine — plugin → dev backend (`tsx watch
  src/index.ts`, port `4000`) → dev MariaDB (`zantiflow_dev_db`, `127.0.0.1:3308`). All measurements
  are **read-only** queries against the `Snapshot` table; Zellij, the plugin, and the backend were not
  touched.
- **Method:** the `Snapshot` table stores latest-only per `(machineId, sid)`; `capturedAtTick`
  increments once per plugin POST for that session, and each pane carries a `contentFingerprint`.
  Polling those fields over time gives the true POST rate and how much each POST actually changed.

## TL;DR

- Every live Zellij session POSTs a **full snapshot ~1.00×/s, unconditionally** — as ADR-0001 specifies.
- **Two waste modes:** an **idle** session re-sends a **byte-identical** body every second (100%
  redundant); a **busy** Claude session "changes" every tick but is **~82% redundant** (only its
  spinner pane churns — 9 of 12 panes are re-sent identical every POST).
- A **closed** session's slice **lingers unpruned** in the DB (~2 h stale row still present).
- These directly justify ADR-0026's **two** mechanisms: *skip-when-unchanged* (kills idle spam) **and**
  *coalescing* (tames the repainting-TUI / Claude-pane case). Projected reduction ≈ **30–60× fewer
  full-snapshot POSTs**.

## 1. Send cadence — ~1.00 POST/s per live session, unconditional

Sampled the active machine `m-d438…` every 2 s for 26.2 s and watched `capturedAtTick` advance:

| Session | Δtick / 26.2 s | Rate | Interval | Body/POST | What it is |
|---|---|---|---|---|---|
| `s2c48…` | 26 | **0.99 POST/s** | 1.01 s | 2,123 B | busy session (Claude pane) |
| `sd470…` | 26 | **0.99 POST/s** | 1.01 s | 555 B | second live session (idle shell) |
| `se10cc…` | 0 | 0 | — | 952 B | dead session (see §3) |

The tick marched in lockstep with the wall clock (5676→5702). Confirms ADR-0001 §2 ("~1 s POST each
tick") is live and literal — **no skip-if-unchanged exists today**.

## 2. Redundancy — how much of each POST is actually new

The ingest body carries the tree + per-pane `contentFingerprint` (not pane *content* — that's the
separate output channel, ADR-0016). "Redundant" here means the fingerprints were unchanged, so the
POST re-transmitted (and the backend re-parsed, re-upserted, re-derived activity, re-reconciled
attentions for) content the backend already had.

### 2a. Whole-session, over ~40 s (fast sample, deduped by tick)

| Session | POSTs | fingerprint-set changed | byte-identical |
|---|---|---|---|
| `s2c48…` (busy Claude) | 42 | **41 / 41 transitions** | **0%** |
| idle / dead sessions | — | 0 | (not posting during window) |

So the busy session is "dirty" **every tick** — a plain *skip-if-unchanged* would **not** help it,
because Claude's own TUI (spinner + elapsed-time / token counter) redraws each second.

### 2b. Per-pane, busy Claude session (21 ticks, 20 transitions)

But "the session changed" is misleading — it changed because **one** pane redraws:

| Pane | Changed on % of ticks |
|---|---|
| p6 | **100%** (Claude's live spinner / status line) |
| p8 | 90% |
| p9 | 25% |
| **p1–p5, p7, p10–p12 (9 panes)** | **0% — re-sent byte-identical every POST** |

- **9 of 12 panes never changed.** Only ~3 churned.
- **Avg new panes per POST: 2.15 of 12 → ~82% of every POST is redundant re-transmission.**

This is the "repainting TUI" case ADR-0026 flags (H6): the fix is **coalescing to ~30 s**, not
skip-if-unchanged — still a ~30× cut for this session.

### 2c. Idle session — 100% redundant

While alive, the idle shell (`sd470…`) re-POSTed an **identical ~555 B body every 1.01 s** (constant
size, unchanging prompt). ADR-0026's *skip-when-unchanged* drops these to **~0 POST/s**.

## 3. Closed sessions linger unpruned (the "immortal slice")

`se10cc…` closed ~2 h before measurement (its `receivedAt` frozen at 18:38, `capturedAtTick` static at
911) yet its row was **still in the DB**. Storage is upsert-only — nothing deletes a closed session's
slice; only the 60 s read-filter (`machines/service.ts` `STALE_AFTER_MS`) hides it. This is the live
proof of the concern ADR-0026 addresses with the control-poll `receivedAt` **touch**: it keeps a
quiet-but-live session fresh under that same 60 s filter, so a genuinely-closed session ages out while
a live-idle one does not.

## 4. Aggregate cost (one machine, 2 live sessions)

- **~2 POST/s ≈ 120/min ≈ 7,200/hr ≈ 172,800/day.**
- **~2.7 KB/s of request bodies ≈ 9.4 MB/hr ≈ ~226 MB/day** (bodies only, before HTTP overhead).
- **~2 DB write-transactions/s** (each: machine upsert + per-session snapshot upsert + pane-activity
  read+upsert + attention reconcile).

## 5. Implication for ADR-0026

| Session type | Today | Under ADR-0026 (unwatched) |
|---|---|---|
| Idle shell | ~1 POST/s (100% redundant) | **~0** (skip-when-unchanged) |
| Busy Claude pane | ~1 POST/s (~82% redundant) | **~1 per 30 s** (coalesce floor) — ~30× fewer; 0 when quiet |
| Liveness / control | (rides the 1 s snapshot) | **~1 tiny control poll / 5 s / session** (no snapshot DB write) |

Neither mechanism alone suffices: *skip* only fixes idle sessions; the busy Claude pane keeps hammering
at 1/s off cosmetic redraws unless *coalescing* is also applied. Together ≈ **30–60× fewer full-snapshot
POSTs**, with idle-session traffic → zero.

## Appendix — reproduce

Dev DB creds are all `zantiflow` (see `plans`/memory `backend-dev-db`). From the host:

```bash
export MYSQL_PWD=zantiflow
DB() { mariadb -h127.0.0.1 -P3308 -uzantiflow zantiflow -N -B -e "$1"; }

# Current cadence state (ticks + payload sizes + machine liveness)
DB "SELECT machineId, sid, capturedAtTick, receivedAt, LENGTH(data) AS bytes FROM Snapshot ORDER BY machineId, sid;"

# POST rate: sample capturedAtTick twice, N seconds apart → Δtick / Δt = POST/s.
# Redundancy: sample per tick and compare
#   MD5(JSON_EXTRACT(data,'$.sessions[0].tabs[*].panes[*].contentFingerprint'))   -- whole-session
#   the array itself, element-wise across ticks                                   -- per-pane
```

(The exact sampling loops used live in the session scratchpad; the tables above are their output.)
