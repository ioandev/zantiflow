import { describe, it, expect, vi } from 'vitest'
import type { Request, Response } from 'express'
import { AppError, badRequest, errorEnvelope, makeErrorHandler } from '../src/http/errors'
import { nullLogger } from '../src/log'

const mkRes = () => {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: unknown) {
      this.body = b
      return this
    },
  }
  return res as unknown as Response & { statusCode: number; body: unknown }
}

describe('errorEnvelope', () => {
  it('omits details when undefined and includes it otherwise', () => {
    expect(errorEnvelope('c', 'm')).toEqual({ error: { code: 'c', message: 'm' } })
    expect(errorEnvelope('c', 'm', { field: 'x' })).toEqual({
      error: { code: 'c', message: 'm', details: { field: 'x' } },
    })
  })
})

describe('makeErrorHandler', () => {
  const handle = makeErrorHandler(nullLogger)
  const req = {} as Request
  const next = vi.fn()

  it('renders an AppError as its envelope with the right status', () => {
    const res = mkRes()
    handle(badRequest('nope', { why: 'test' }), req, res, next)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: { code: 'bad_request', message: 'nope', details: { why: 'test' } } })
  })

  it('maps a malformed-body SyntaxError to a 400', () => {
    const res = mkRes()
    const err = Object.assign(new SyntaxError('Unexpected token'), { body: '{bad' })
    handle(err, req, res, next)
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: { code: string } }).error.code).toBe('bad_request')
  })

  it('renders an unknown error as an opaque 500 (no internals leaked)', () => {
    const res = mkRes()
    handle(new Error('secret db path /var/lib/mysql exploded'), req, res, next)
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ error: { code: 'internal', message: 'Internal Server Error' } })
    expect(JSON.stringify(res.body)).not.toContain('mysql')
  })

  it('AppError carries status/code/details', () => {
    const e = new AppError(418, 'teapot', 'short and stout', { steep: true })
    expect(e.status).toBe(418)
    expect(e.code).toBe('teapot')
    expect(e.details).toEqual({ steep: true })
  })
})
