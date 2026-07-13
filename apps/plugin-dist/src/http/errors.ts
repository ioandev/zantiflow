// The single error shape for the whole API: `{ error: { code, message, details? } }` (ADR-0018 §1).
// Handlers throw an `AppError` (or a helper); the error middleware renders the envelope. Unknown
// errors become an opaque 500 — internals and stack traces never reach clients.
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

export const notFound = (m = 'Not Found'): AppError => new AppError(404, 'not_found', m)
export const serviceUnavailable = (m = 'Service Unavailable'): AppError => new AppError(503, 'unavailable', m)

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
    logger.error('unhandled_error', { err: err instanceof Error ? err.message : String(err) })
    res.status(500).json(errorEnvelope('internal', 'Internal Server Error'))
  }
