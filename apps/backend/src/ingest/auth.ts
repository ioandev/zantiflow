// Ingest authentication middleware — the WRITE plane. Verifies the `Authorization: Bearer ztf_…`
// token (constant-time, server-side expiry/revocation) and attaches the principal. This plane is
// entirely separate from owner sessions and can reach NO read/management handler (ADR-0003 §3).
import type { PrismaClient } from '@prisma/client'
import type { NextFunction, Request, Response } from 'express'
import { unauthorized } from '../http/errors'
import { authenticateIngest, type IngestPrincipal } from '../tokens/service'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ingest?: IngestPrincipal
    }
  }
}

export const ingestAuth =
  (prisma: PrismaClient) =>
  async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = await authenticateIngest(prisma, req.header('authorization') ?? undefined)
      if (!principal) return next(unauthorized())
      req.ingest = principal
      next()
    } catch (e) {
      next(e)
    }
  }
