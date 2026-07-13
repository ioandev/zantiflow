// The bot WS transport's liveness sweep (ADR-0007): the backend drops a connection it hasn't heard a
// ping/message from within maxIdleMs, and keeps an actively-pinging one. Uses a real http server + a
// real `ws` client with tiny timeouts (no MariaDB — this tests the transport, not the hub/DB).
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { Config } from '../src/config'
import { nullLogger } from '../src/log'
import { attachBotWs } from '../src/bots/ws'

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
const opened = (ws: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
// Resolves true if the socket closes within `ms`, false if it stays open the whole time.
const closesWithin = (ws: WebSocket, ms: number): Promise<boolean> =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms)
    ws.on('close', () => {
      clearTimeout(t)
      resolve(true)
    })
  })

const fakePrisma = {} as never
const fakeConfig = { botServiceSecret: 'x' } as unknown as Config

describe('bot ws liveness sweep', () => {
  let server: Server

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('terminates a connection that goes idle past maxIdleMs (no ping)', async () => {
    server = createServer()
    const port = await listen(server)
    attachBotWs(server, fakePrisma, fakeConfig, nullLogger, { maxIdleMs: 150, checkMs: 50 })

    const ws = new WebSocket(`ws://127.0.0.1:${port}/internal/bots`)
    await opened(ws)
    // A bare `ws` client sends no keepalive pings, so it should be culled by the sweep.
    expect(await closesWithin(ws, 1500)).toBe(true)
  })

  it('keeps an actively-pinging connection alive', async () => {
    server = createServer()
    const port = await listen(server)
    attachBotWs(server, fakePrisma, fakeConfig, nullLogger, { maxIdleMs: 300, checkMs: 50 })

    const ws = new WebSocket(`ws://127.0.0.1:${port}/internal/bots`)
    await opened(ws)
    const pinger = setInterval(() => ws.ping(), 40) // well under maxIdleMs
    const closed = await closesWithin(ws, 700) // ~2.3× maxIdleMs
    clearInterval(pinger)
    ws.terminate()
    expect(closed).toBe(false) // survived — pings kept the liveness clock fresh
  })
})
