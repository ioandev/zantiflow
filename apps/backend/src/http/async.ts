// Express 4 does not forward rejected promises to the error middleware. Wrap async handlers so
// a thrown/rejected error reaches `makeErrorHandler` instead of hanging the request.
import type { NextFunction, Request, RequestHandler, Response } from 'express'

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next)
