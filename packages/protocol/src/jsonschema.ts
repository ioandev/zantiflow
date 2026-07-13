// JSON Schema export — the language-neutral form of the contracts, consumed by the Python bots'
// codegen (ADR-0010) and available for docs/tooling. Generated from the Zod source of truth.
import { zodToJsonSchema } from 'zod-to-json-schema'
import { SnapshotV4 } from './wire'
import { OutputDelivery, OutputPendingResponse } from './output'
import { ControlRequest, ControlResponse } from './control'
import { BotToBackend, BackendToBot } from './botws'

// `zodToJsonSchema`'s inferred return type is pathological — leaving it un-annotated makes tsc OOM
// while type-checking these calls. Cast to a simple signature; runtime behaviour is unchanged.
const gen = zodToJsonSchema as unknown as (schema: unknown, name?: string) => unknown

export const jsonSchemas: Record<string, unknown> = {
  snapshotV4: gen(SnapshotV4, 'SnapshotV4'),
  outputPending: gen(OutputPendingResponse, 'OutputPendingResponse'),
  outputDelivery: gen(OutputDelivery, 'OutputDelivery'),
  controlRequest: gen(ControlRequest, 'ControlRequest'),
  controlResponse: gen(ControlResponse, 'ControlResponse'),
  botToBackend: gen(BotToBackend, 'BotToBackend'),
  backendToBot: gen(BackendToBot, 'BackendToBot'),
}
