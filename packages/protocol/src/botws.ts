// The internal backend ↔ bot WebSocket protocol (ADR-0007/0010). The bots are Python, so this schema
// is the language-neutral source of truth (JSON Schema is generated for their pydantic models).
// A `kind` discriminator identifies each message; `PROTOCOL_VERSION` guards major skew.
import { z } from 'zod'

export const PROTOCOL_VERSION = 1 as const
const platform = z.enum(['discord', 'telegram'])

// --- bot → backend ---
export const BotHello = z.object({
  kind: z.literal('hello'),
  platform,
  serviceSecret: z.string(),
  version: z.number().int(),
})
export const BotLinkRequest = z.object({
  kind: z.literal('link_request'),
  platform,
  platformUserId: z.string().max(128),
  platformUsername: z.string().max(256).optional(),
  token: z.string().max(256),
})
export const BotDeliveryResult = z.object({
  kind: z.literal('delivery_result'),
  deliveryId: z.string().max(128),
  status: z.enum(['delivered', 'failed']),
  error: z.string().max(512).optional(),
})
export const BotUnlinkNotice = z.object({
  kind: z.literal('unlink_notice'),
  platform,
  platformUserId: z.string().max(128),
  reason: z.string().max(256),
})
export const BotToBackend = z.discriminatedUnion('kind', [BotHello, BotLinkRequest, BotDeliveryResult, BotUnlinkNotice])

// --- backend → bot ---
export const BackendHelloAck = z.object({ kind: z.literal('hello_ack'), ok: z.boolean() })
export const BackendDeliver = z.object({
  kind: z.literal('deliver'),
  deliveryId: z.string().max(128),
  platformUserId: z.string().max(128),
  text: z.string().max(4096),
})
export const BackendLinkResult = z.object({
  kind: z.literal('link_result'),
  token: z.string().max(256),
  ok: z.boolean(),
  // Echoed back from the link_request so the bot knows WHICH user to DM the confirmation to.
  platformUserId: z.string().max(128).optional(),
  accountLabel: z.string().max(256).optional(),
  error: z.string().max(512).optional(),
})
export const BackendToBot = z.discriminatedUnion('kind', [BackendHelloAck, BackendDeliver, BackendLinkResult])

export type BotToBackend = z.infer<typeof BotToBackend>
export type BackendToBot = z.infer<typeof BackendToBot>
