// Hard PRO gate (ADR-0011/0016 Spotlight). Mount AFTER `requireSession` so `req.account` is set.
// Everywhere else tier only MODULATES behaviour (cadence, channels, auto-refresh window); this is the
// API's first route that PRO fully gates. Returns a distinct `403 requires_pro` (not the generic
// `forbidden`) so the client can tell "sign in" apart from "upgrade" and show the right prompt.
import type { NextFunction, Request, Response } from 'express'
import { AppError } from '../http/errors'
import { effectiveTier } from './service'

export const requirePro = (req: Request, _res: Response, next: NextFunction): void => {
  if (!req.account || effectiveTier(req.account) !== 'pro') {
    next(new AppError(403, 'requires_pro', 'This feature requires PRO'))
    return
  }
  next()
}
