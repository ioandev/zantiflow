// Pane-output on-demand channel (ADR-0016) — SEPARATE from ingest. The website registers a request;
// the plugin's ~5 s poll picks it up, captures + scrubs, and delivers ≤50 ANSI lines; the website
// reads the latest. Everything is keyed by (machineId, paneKey) and scoped by accountId, where
// `paneKey = sessionSid:tabId:paneId` is the pane's FULL identity — a raw `paneId` is only unique
// within one Zellij session's id-space (every session numbers panes from 0, and Terminal/Plugin ids
// overlap), so keying by it alone made panes in different tabs/sessions collide and read back each
// other's output. Output is EPHEMERAL and NEVER PERSISTED (ADR-0032, superseding ADR-0030's DB
// storage): the captured content lives only in the in-process `PaneOutputStore` — the request
// lifecycle below (which pane, pending/fulfilled) is the ONLY thing kept in the DB. Each open fetches a
// fresh capture (never a previous one); it is never streamed and otherwise never leaves the machine.
import type { PrismaClient } from '@prisma/client'
import type { OutputReadResponse, OutputRequestRef } from '@zantiflow/protocol'
import type { PaneOutputStore } from './store'

/** How long a registered request stays "pending" before it's considered expired (→ shared:false). */
export const REQUEST_TTL_SEC = 30

/** The composite pane key. Mirrors the `PaneActivity` map key (schema `sid:tabId:paneId`). `sessionSid`
 * is `s` + hex (no colon), and tabId/paneId are numbers, so the key round-trips through `parsePaneKey`. */
const paneKeyOf = (sessionSid: string, tabId: number, paneId: number): string => `${sessionSid}:${tabId}:${paneId}`

/** Recover the pane identity from a stored `paneKey`. The last two `:`-segments are tabId + paneId
 * (numeric); everything before is the sessionSid (which never contains a `:`). */
const parsePaneKey = (paneKey: string): { sessionSid: string; tabId: number; paneId: number } => {
  const parts = paneKey.split(':')
  const paneId = Number(parts[parts.length - 1])
  const tabId = Number(parts[parts.length - 2])
  const sessionSid = parts.slice(0, -2).join(':')
  return { sessionSid, tabId, paneId }
}

/** Verify the machine belongs to the account (IDOR/hijack guard); returns false if not owned. */
const ownsMachine = async (prisma: PrismaClient, accountId: string, machineId: string): Promise<boolean> => {
  const m = await prisma.machine.findFirst({ where: { id: machineId, accountId }, select: { id: true } })
  return m !== null
}

/** Owner registers a request to view a pane's output (upsert pending). Returns false if not owned. */
export const registerRequest = async (
  prisma: PrismaClient,
  store: PaneOutputStore,
  accountId: string,
  machineId: string,
  sessionSid: string,
  tabId: number,
  paneId: number,
): Promise<boolean> => {
  if (!(await ownsMachine(prisma, accountId, machineId))) return false
  const paneKey = paneKeyOf(sessionSid, tabId, paneId)
  // Fresh-on-open (ADR-0030 §2): drop any previously-captured output for this pane so the read shows a
  // spinner until a NEW capture arrives — never the stale prior snapshot — and so a plugin that has
  // since stopped sharing degrades to "not shared" instead of the old content.
  store.delete(accountId, machineId, paneKey)
  // Re-arm every existing row for this pane in one statement (the table has no unique key, so there
  // can be more than one), and only create when there are genuinely none. Keeps the pending set from
  // growing on each re-open and avoids handing the plugin duplicate work for the same pane.
  const rearmed = await prisma.outputRequest.updateMany({
    where: { accountId, machineId, paneKey },
    data: { status: 'pending', requestedAt: new Date() },
  })
  if (rearmed.count === 0) {
    await prisma.outputRequest.create({ data: { accountId, machineId, paneKey, status: 'pending' } })
  }
  return true
}

/** Plugin poll: the panes this account has asked to view that are still pending + fresh. */
export const pendingRequests = async (
  prisma: PrismaClient,
  accountId: string,
  now: Date = new Date(),
): Promise<OutputRequestRef[]> => {
  const cutoff = new Date(now.getTime() - REQUEST_TTL_SEC * 1000)
  const rows = await prisma.outputRequest.findMany({
    where: { accountId, status: 'pending', requestedAt: { gte: cutoff } },
  })
  // Collapse duplicate rows for the same pane so the plugin captures + delivers each pane at most once
  // per poll — no point handing it the same capture work twice in one tick.
  const seen = new Set<string>()
  const refs: OutputRequestRef[] = []
  for (const r of rows) {
    const key = `${r.machineId}:${r.paneKey}`
    if (seen.has(key)) continue
    seen.add(key)
    const { sessionSid, tabId, paneId } = parsePaneKey(r.paneKey)
    refs.push({ machineId: r.machineId, sessionSid, tabId, paneId })
  }
  return refs
}

/** Plugin delivers captured+scrubbed lines. Holds latest-only in memory + marks the request fulfilled. */
export const submitOutput = async (
  prisma: PrismaClient,
  store: PaneOutputStore,
  accountId: string,
  machineId: string,
  sessionSid: string,
  tabId: number,
  paneId: number,
  lines: string[],
  capturedAt: string,
): Promise<boolean> => {
  if (!(await ownsMachine(prisma, accountId, machineId))) return false
  const paneKey = paneKeyOf(sessionSid, tabId, paneId)
  // The plugin captures ~now; if its timestamp isn't parseable, stamp server-receipt time.
  const parsed = new Date(capturedAt)
  const captured = Number.isNaN(parsed.getTime()) ? new Date() : parsed
  // Latest-only, in memory only — never the DB (ADR-0032). The plugin can deliver the same pane twice
  // near-simultaneously; a Map put is last-write-wins, so concurrent deliveries just leave the newest
  // (no unique-constraint race to handle any more).
  store.put(accountId, machineId, paneKey, lines, captured)
  await prisma.outputRequest.updateMany({
    where: { accountId, machineId, paneKey, status: 'pending' },
    data: { status: 'fulfilled' },
  })
  return true
}

/** Owner read: the latest output, a pending marker, or "not shared". */
export const readOutput = async (
  prisma: PrismaClient,
  store: PaneOutputStore,
  accountId: string,
  machineId: string,
  sessionSid: string,
  tabId: number,
  paneId: number,
  now: Date = new Date(),
): Promise<OutputReadResponse> => {
  const paneKey = paneKeyOf(sessionSid, tabId, paneId)
  // Fresh-on-open (ADR-0030): while a just-registered request is still unfulfilled, report `pending`
  // so the drawer waits for a NEW capture rather than showing an earlier one. Only once the request
  // has been fulfilled (and not aged out) do we serve the held output — which was captured FOR this
  // request cycle (`registerRequest` deleted any prior snapshot).
  const cutoff = new Date(now.getTime() - REQUEST_TTL_SEC * 1000)
  const pending = await prisma.outputRequest.findFirst({
    where: { accountId, machineId, paneKey, status: 'pending', requestedAt: { gte: cutoff } },
  })
  if (pending) return { pending: true }

  const output = store.get(accountId, machineId, paneKey)
  if (output) return { lines: output.lines, capturedAt: output.capturedAt.toISOString() }
  return { shared: false }
}
