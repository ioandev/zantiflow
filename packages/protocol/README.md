# @zantiflow/protocol

Canonical zantiflow contracts as **Zod schemas** (the single source of truth) → derived **TS types** +
runtime **validators**, shared by the backend (and exported as **JSON Schema** for the Python bots).

- `wire.ts` — the plugin→backend **snapshot wire contract, v4** (ADR-0001/0002/0005).
- `version.ts` — `parseSnapshot()`: ignore unknown fields (forward-compat), **reject unknown-newer**,
  bound depth/lengths (DoS guard).
- `output.ts` — the separate on-demand **pane-output** channel (ADR-0016).
- `sse.ts` — dashboard **SSE** events (ADR-0008).
- `botws.ts` — the internal **backend↔bot** WS protocol (ADR-0007/0010).
- `jsonschema.ts` — JSON Schema export of the above.

Internal (`private`); consumed by `apps/*` via `workspace:*`.
