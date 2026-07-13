# ADR-0037 — Host-shared plugin identity: one machine across per-session instances via `/cache`

- **Status:** Accepted (implemented)
- **Date:** 2026-07-12
- **Deciders:** project owner
- **Tags:** plugin, identity, machine-id, tokens, pairing, persistence, zellij, privacy

> **Retroactive ADR:** This decision was already implemented in the codebase before this ADR was written; it is recorded here after the fact to close a documentation gap — it was not written at the right time.

## Context

Zellij loads a plugin **once per session**: every Zellij session on a host that includes the
zantiflow plugin in its layout runs its **own independent instance** of the WASM module, with its own
`load()`/`update()`/`render()` lifecycle, its own `~1 s` timer loop, and its own `web_request` egress.
The code treats this as a first-class fact — `control.rs::should_serve` states it outright ("Each
Zellij session runs its own plugin instance … and a plugin can only read scrollback for panes in its
OWN session"), and the measured cadence (memory: `adr-0026-cadence-measured`) is "~1 POST/s **per
session**", i.e. one stream per instance.

Three earlier ADRs assumed a **single** plugin persisting to its private **`/data`** dir:

- [ADR-0003](0003-multi-tenant-backend-and-token-auth.md) §Decision/§6: "On first run the plugin
  generates a **random** `machineId` and persists it (e.g. `/data/machine-id`)… If `/data` is wiped, a
  new `machineId` is generated (the machine appears as new)" — flagged as a durability risk in its
  Consequences ("`machineId` lives in `/data`; wiping it makes the machine reappear as new — history
  splits") and Open Questions §4.
- [ADR-0012](0012-plugin-device-pairing.md) §Considered Options/§4: "Token storage: persist in the
  plugin's **`/data`** *(chosen, FINDINGS §12)*… Once paired, the token lives in `/data`."
- [ADR-0022](0022-plugin-publishing-and-user-docs.md) §Decision: the paired "token is stored in the
  plugin's `/data`".
- [ADR-0002](0002-configurable-telemetry-privacy-controls.md) is internally split: §3 says the `sid`
  salt is "persisted in the plugin's `/cache`", while its Open Questions §2 records "salted hash
  persisted in **`/data`** (cross-restart stable)".

But per **FINDINGS §12**, Zellij's WASI sandbox scopes **`/data` per plugin instance / session**,
whereas **`/cache` is shared across all of a host's sessions**. Under the `/data` design, each
session's instance would mint a **different** `machineId`, hold a **different** (unpaired) token, and
derive a **different** `sid` for the very same Zellij session — so a single laptop would appear on the
dashboard as N separate machines and the owner would have to pair every session separately. That is
the opposite of what the product promises ("machines → sessions → tabs → panes").

The implementation therefore diverged from those ADRs, and the reasoning was only ever recorded in code
comments. This ADR records it.

## Decision Drivers

- **One machine = one host.** All sessions on a host must report under a **single** `machineId` and a
  **single** paired token, and the same Zellij session must get the **same** `sid` regardless of which
  instance observes it.
- **Pair once per host, not once per session.** A device-pairing flow (ADR-0012) that had to run in
  every session would be unusable.
- **Survive cache-clears and reinstalls where possible.** ADR-0003 explicitly flagged "wipe → machine
  reappears as new / history splits" as a cost; a stable derivation is preferable to pure randomness.
- **A plugin can only read its own session.** `get_pane_scrollback` (FINDINGS §6/§11/§15) reads the
  **current** session's panes only — no instance can serve another session's pane output, so on-demand
  captures must be routed to the owning instance.
- **Least surprise across restarts / privacy.** Identity must be stable across plugin reloads and must
  stay pseudonymous (ADR-0002): the wire carries salted hashes, never raw hostnames/session names.

## Considered Options

**Where the plugin persists its identity (machineId, ingest token, fingerprint salt)**
1. **Host-shared `/cache`** *(chosen)* — one identity for the whole host; every per-session instance
   reads the same values; pair once. Cost: `/cache` is nominally a *cache* dir, so a cache purge can
   drop it (mitigated by the hostname derivation below).
2. Per-session `/data` (ADR-0003/0012/0022 as originally written) — survives cache purges, but each
   session becomes a *different* machine with a *different* token: rejected as breaking the core model.
3. The layout/config file — rejected by ADR-0012 (the plaintext-secret problem it exists to solve).

**How `machineId` is seeded**
1. **Salted hash of the real hostname when known, random hex otherwise** *(chosen)* — a hostname-derived
   id is **deterministic per host**, so it is stable across `/cache` clears and reinstalls, and any two
   instances (even with an empty cache) derive the **same** id; the random fallback covers hosts with no
   readable hostname. Pseudonymous via the shared salt (ADR-0002), so the raw hostname never leaves.
2. Always random (ADR-0003 as written) — simple, but a `/cache` wipe always splits history, and a fresh
   instance can't reproduce an existing id: rejected.
3. Always the hostname — no fallback for the hostname-unavailable case (FINDINGS §10): rejected.

**Coordinating the many per-session instances**
1. **Shared `/cache` state + deterministic derivation + sid-scoped pane serving** *(chosen)* — no
   inter-instance messaging: instances agree implicitly because they read the same `/cache` (machineId,
   token, salt) and run the same pure derivation, and each serves only pane-output requests naming its
   own `sid`.
2. Elect one "leader" instance to own identity / serve all panes — rejected: needs coordination the
   plugin API doesn't provide, and a leader still can't read other sessions' scrollback.
3. A single instance observing all sessions — impossible: `get_pane_scrollback` is current-session-only.

## Decision

### 1. Identity state lives in host-shared `/cache`, not per-session `/data`

The three pieces of durable plugin identity are all stored in **`/cache`**:

| Value | Key | Code |
| --- | --- | --- |
| Fingerprint / `sid` salt | `fingerprint_salt` | `fingerprint::get_or_create_salt` (`SALT_KEY`) |
| Machine id | `machine_id` | `fingerprint::get_or_create_machine_id` (`MACHINE_ID_KEY`) |
| Paired ingest token | `ingest_token` | `pairing::TOKEN_CACHE_KEY`, written in `plugin.rs::on_pair_poll` (Approved), re-read at `load` and on `PluginConfigurationChanged` |

All three are created once and reused: each `get_or_create_*` returns the persisted value if present,
otherwise mints and writes it. Because Zellij shares `/cache` across the host's sessions (FINDINGS §12),
every per-session instance observes the same salt, the same `machineId`, and — once any one session has
paired — the same token, so **the whole host reports as one machine and you pair once**.

### 2. `machineId` is derived from the salted hostname, random only as a fallback

`get_or_create_machine_id` prefers a **deterministic, hostname-derived** id and falls back to random:

```
Some(hostname) & non-empty → "m-" + hash_hex(salt, hostname)   // stable across cache-clears/reinstalls
otherwise                   → "m-" + random_id()               // hosts with no readable hostname
```

The hostname is only read when the owner opted in (ADR-0024, `wants_hostname()`), but it is used **as a
seed for the pseudonymous id even when the machine name is not sent** — the id is a salted hash, so the
raw hostname never reaches the wire (ADR-0002). This directly addresses ADR-0003's "`/data` wipe →
history splits" risk: on a hostname-known host, wiping `/cache` regenerates the **same** id.

Resolution is **lazy** — `telemetry_tick` computes `machineId` on the first send, not at `load()` —
because the hostname arrives asynchronously via `RunCommandResult` (FINDINGS §10) and must be folded in
before the id is minted.

### 3. `sid`s are deterministic across instances via the shared salt

`fingerprint::sid(salt, name) = "s" + hash_hex(salt, name)` is a pure function of `(salt, session
name)`. Since the salt is shared through `/cache`, **any** instance computes the **same** `sid` for the
same Zellij session name. This is what lets a pane-output request minted against one session's `sid` be
recognised by exactly the instance that owns that session (§4), and what keeps a session's identity
stable on the dashboard regardless of which instance last reported it.

### 4. Pane output is served by the owning instance only, keyed by `sid`

Because an instance can only read its own session's scrollback, `control::should_serve` accepts a
pending pane-output request only when `req.machineId == machineId` **and** `req.sessionSid ==
own_sid` (the current session's sid, refreshed each snapshot in `plugin.rs::telemetry_tick`). A request
with no `sid`, or naming a different session, is declined — the peer instance that owns that `sid`
serves it. A bare `paneId` is deliberately insufficient (the same numeric id names a different pane in
another session). This makes ADR-0016's on-demand pane-output channel correct under the multi-instance
reality.

### 5. The `/data` port methods remain but are vestigial

`HostPort` still exposes `read_data`/`write_data` (implemented by both `WasmHost` → `/data` and
`FakeHost`), but **no logic calls them** — identity moved wholesale to `/cache`. They are retained as a
harmless capability on the port rather than removed, but `/data` no longer holds any zantiflow state.

## Consequences

**Positive**
- One host = one machine on the dashboard; pair once and every current/future session reports under the
  same token and id.
- `machineId` is stable across `/cache` clears, plugin reloads, and reinstalls on any host whose
  hostname is readable — closing ADR-0003's history-splitting gap for the common case.
- No inter-instance coordination code: correctness falls out of shared `/cache` + a pure derivation.
- Pane-output requests always reach the one instance that can actually read the pane.
- Identity stays pseudonymous (salted hashes on the wire), consistent with ADR-0002.

**Negative / costs**
- `/cache` is semantically a *cache*: an aggressive cache purge can drop the token (→ re-pair) and, on
  a hostname-unknown host, the random `machineId` (→ the machine reappears as new). The hostname
  derivation mitigates the id case but not the token.
- Diverges from the letter of ADR-0003/0012/0022 ("/data") and ADR-0002's Open Question §2 — those
  references now read as amended by this ADR.
- Two hosts that happen to share a hostname **and** salt would collide; in practice the salt is a
  per-`/cache` random value, so distinct hosts get distinct salts and therefore distinct ids.
- The `/data` port methods are dead weight until removed.

**Neutral**
- Wire contract **unchanged (v4)** — this is purely about where the plugin persists local state and how
  it seeds ids; the snapshot body is identical.
- Amends [ADR-0003](0003-multi-tenant-backend-and-token-auth.md) (machineId storage + seeding),
  [ADR-0012](0012-plugin-device-pairing.md) and [ADR-0022](0022-plugin-publishing-and-user-docs.md)
  (token storage `/data` → `/cache`); refines [ADR-0002](0002-configurable-telemetry-privacy-controls.md)
  (salt home) and complements [ADR-0016](0016-dashboard-page-and-pane-output.md) (per-instance serving).

## Open Questions / Risks

1. **`/cache` durability vs a `/data`+`/cache` split.** Should the token additionally be mirrored to
   `/data` per instance so a `/cache` purge doesn't force a re-pair, at the cost of first-pair
   propagation across sessions? Deferred — re-pairing is cheap and the current model is simpler. Verify
   `/cache` write/persistence in the real-Zellij smoke check (ADR-0014 §6, throwaway session only).
2. **Hostname-unavailable hosts** fall back to a random, `/cache`-only id and so still split history on a
   wipe. Acceptable; a `/data`-anchored fallback could be added if it bites.
3. **Salt/hostname collision** across hosts is only possible if both the random salt and the hostname
   match — vanishingly unlikely, but not cryptographically prevented.
4. **Removing the vestigial `/data` port methods** — a cleanup, gated on confirming nothing else grows a
   `/data` need (e.g. the durability mirror in §1).

## Testing

Per [ADR-0014](0014-testing-strategy.md), the pure identity logic is unit-tested off the wasm target via
`FakeHost`:

- `fingerprint.rs` — `machine_id_without_a_hostname_is_random_and_shared_via_cache` asserts the id is
  written to **`/cache`** and **not** `/data`, and is reused even when the RNG/salt change;
  `machine_id_prefers_a_stable_hostname_derivation` asserts a second session on the same host (fresh
  empty cache) derives the **same** id; `salt_is_created_once_then_reused`;
  `sid_is_stable_per_name_and_salt_but_differs_across_names`.
- `control.rs` — `serves_only_this_machines_own_session` covers `should_serve` (own sid served, other
  session / other machine / missing-sid declined).
- Runtime confirmation that a real Zellij shares `/cache` across sessions and that `/cache` survives a
  reload belongs to the real-Zellij smoke check (ADR-0014 §6) — a throwaway session only.

## References

- Code: `apps/plugin/src/fingerprint.rs` (`get_or_create_salt`, `get_or_create_machine_id`, `sid`,
  `SALT_KEY`/`MACHINE_ID_KEY`), `apps/plugin/src/pairing.rs` (`TOKEN_CACHE_KEY`),
  `apps/plugin/src/plugin.rs` (`WasmHost` `/cache` vs `/data`, lazy `machineId` in `telemetry_tick`,
  token persist/read on pair + `PluginConfigurationChanged`, `own_sid` + `deliver_pending`),
  `apps/plugin/src/control.rs` (`should_serve`), `apps/plugin/src/host.rs` (vestigial `read_data`/`write_data`).
- [ADR-0001](0001-zellij-session-telemetry-architecture.md) — machineId/telemetry origin; derived activity.
- [ADR-0002](0002-configurable-telemetry-privacy-controls.md) — `sid`/salt, pseudonymity, redaction.
- [ADR-0003](0003-multi-tenant-backend-and-token-auth.md) — `machineId` (originally random, in `/data`).
- [ADR-0012](0012-plugin-device-pairing.md) / [ADR-0022](0022-plugin-publishing-and-user-docs.md) — token storage (originally `/data`).
- [ADR-0016](0016-dashboard-page-and-pane-output.md) — on-demand pane-output channel.
- [ADR-0024](0024-opt-in-hostname-lookup.md) — opt-in real-hostname lookup (the `machineId` seed source).
- FINDINGS.md §10 (hostname via `run_command`), §12 (`/data` per-session vs `/cache` host-shared sandbox).
