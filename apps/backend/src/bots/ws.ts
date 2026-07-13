// The WebSocket transport for the bot hub (ADR-0007). Bots dial out to `wss://…/internal/bots`; this
// attaches a WS server to the HTTP server, validates each frame against the `botws` schema, and hands
// it to the transport-agnostic `BotHub`. No public bot ingress — bots connect out.
import type { Server } from 'node:http'
import type { PrismaClient } from '@prisma/client'
import { BotToBackend } from '@zantiflow/protocol'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Config } from '../config'
import type { Logger } from '../log'
import { BotHub, type BotConnection } from './hub'

const INTERNAL_PATH = '/internal/bots'

// A live bot keepalive-pings every ~10 s (see notify-protocol client). If we hear NOTHING — no ping,
// no message — from a connection for longer than this, treat it as dead and drop it, freeing the slot
// and the hub registration. Swept on a coarse interval; actual cutoff lands in [MAX_IDLE, +CHECK).
const MAX_IDLE_MS = 15_000
const CHECK_MS = 1_000 // fine granularity → termination lands in [15s, 16s); the sweep is a cheap WeakMap lookup per conn

export interface BotWsOptions {
  maxIdleMs?: number
  checkMs?: number
}

export const attachBotWs = (
  server: Server,
  prisma: PrismaClient,
  config: Config,
  logger: Logger,
  opts: BotWsOptions = {},
): BotHub => {
  const maxIdleMs = opts.maxIdleMs ?? MAX_IDLE_MS
  const checkMs = opts.checkMs ?? CHECK_MS
  const hub = new BotHub(prisma, config.botServiceSecret)
  const wss = new WebSocketServer({ noServer: true })

  // Last time we heard ANY inbound frame (ping/pong/message) from a socket — its liveness clock.
  const lastSeen = new WeakMap<WebSocket, number>()
  const touch = (ws: WebSocket): void => {
    lastSeen.set(ws, Date.now())
  }

  server.on('upgrade', (req, socket, head) => {
    // Only the internal bot path upgrades; everything else is refused.
    if (req.url !== INTERNAL_PATH) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws))
  })

  wss.on('connection', (ws: WebSocket) => {
    touch(ws)
    ws.on('ping', () => touch(ws)) // the bot's keepalive ping (ws auto-replies with pong)
    ws.on('pong', () => touch(ws))
    const conn: BotConnection = { authed: false, platform: null, send: (msg) => ws.send(JSON.stringify(msg)) }
    ws.on('message', (data) => {
      touch(ws)
      let parsed: unknown
      try {
        parsed = JSON.parse(data.toString())
      } catch {
        return
      }
      const result = BotToBackend.safeParse(parsed)
      if (!result.success) return
      void hub.handleMessage(conn, result.data).catch((e) => logger.error('bot_msg_failed', { err: String(e) }))
    })
    ws.on('close', () => hub.unregister(conn))
    ws.on('error', () => hub.unregister(conn))
  })

  // Idle sweep: terminate connections we haven't heard from within maxIdleMs (ADR-0007 liveness).
  const heartbeat = setInterval(() => {
    const now = Date.now()
    for (const ws of wss.clients) {
      if (now - (lastSeen.get(ws) ?? now) > maxIdleMs) {
        logger.warn('bot_ws_idle_terminated', { idleMs: now - (lastSeen.get(ws) ?? now) })
        ws.terminate() // fires 'close' → hub.unregister
      }
    }
  }, checkMs)
  heartbeat.unref?.() // never keep the process alive just for the sweep
  wss.on('close', () => clearInterval(heartbeat))

  return hub
}
