// The single error shape for the whole API: `{ error: { code, message, details? } }` (ADR-0018 §1).
// Handlers throw an `AppError` (or one of the helpers); the error middleware renders the envelope.
// Unknown/unexpected errors become an opaque 500 — internals and stack traces never reach clients.
import type { NextFunction, Request, Response } from 'express'
import type { Logger } from '../log'

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown }
}

export const errorEnvelope = (code: string, message: string, details?: unknown): ErrorBody => ({
  error: { code, message, ...(details === undefined ? {} : { details }) },
})

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export const badRequest = (m = 'Bad Request', d?: unknown): AppError => new AppError(400, 'bad_request', m, d)
export const unauthorized = (m = 'Unauthorized'): AppError => new AppError(401, 'unauthorized', m)
export const forbidden = (m = 'Forbidden'): AppError => new AppError(403, 'forbidden', m)
export const notFound = (m = 'Not Found'): AppError => new AppError(404, 'not_found', m)
export const conflict = (m = 'Conflict', d?: unknown): AppError => new AppError(409, 'conflict', m, d)
export const tooManyRequests = (m = 'Too Many Requests'): AppError => new AppError(429, 'rate_limited', m)

/** Terminal 404 for any unmatched route — feeds the standard envelope via the error handler. */
export const notFoundHandler = (_req: Request, _res: Response, next: NextFunction): void => next(notFound())

/** The 4-arg Express error middleware (must be registered last). */
export const makeErrorHandler =
  (logger: Logger) =>
  (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof AppError) {
      res.status(err.status).json(errorEnvelope(err.code, err.message, err.details))
      return
    }
    // A malformed JSON body surfaces as a SyntaxError from express.json — treat as a 400.
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json(errorEnvelope('bad_request', 'Malformed request body'))
      return
    }
    logger.error('unhandled_error', { err: err instanceof Error ? err.message : String(err) })
    res.status(500).json(errorEnvelope('internal', 'Internal Server Error'))
  }
