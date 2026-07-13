// Token management API (ADR-0003 §4) — the OWNER plane. The whole router is gated by an owner
// session; ingest tokens themselves grant no access here (the two planes are never conflated).
// The secret is returned exactly once (on create) and never again.
import type { PrismaClient } from '@prisma/client'
import { Router } from 'express'
import { z } from 'zod'
import { requireSession } from '../auth/session'
import type { Config } from '../config'
import { asyncHandler } from '../http/async'
import { badRequest } from '../http/errors'
import type { PaneOutputStore } from '../output/store'
import { listTokens, mintToken, renameToken, revokeAllTokens, revokeTokenAndForgetMachines } from './service'

const CreateTokenBody = z.object({
  label: z.string().max(100).optional(),
  ttl: z.union([z.string(), z.number()]).optional(),
})

// Rename accepts an empty string (→ cleared to null) so the owner can drop a label they no longer want.
const RenameTokenBody = z.object({
  label: z.string().max(100).nullable(),
})

export const createTokensRouter = (prisma: PrismaClient, config: Config, outputStore: PaneOutputStore): Router => {
  // Mounted at /tokens by the API router; routes below are relative to that.
  const router = Router()
  router.use(requireSession(prisma, config)) // entire plane is owner-only

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const parsed = CreateTokenBody.safeParse(req.body ?? {})
      if (!parsed.success) throw badRequest('invalid_body', parsed.error.issues)
      const minted = await mintToken(prisma, req.account!.id, parsed.data)
      res.setHeader('Cache-Control', 'no-store')
      res.status(201).json({
        id: minted.id,
        secret: minted.secret, // shown ONCE — never returned again
        label: minted.label,
        expiresAt: minted.expiresAt,
        createdAt: minted.createdAt,
      })
    }),
  )

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      res.json({ tokens: await listTokens(prisma, req.account!.id) })
    }),
  )

  // Bulk revoke: unlink ALL of this account's ingest tokens at once. Distinct path from `/:id`, so
  // no routing ambiguity. Returns the count revoked (200) rather than 204 — the caller shows it.
  router.delete(
    '/',
    asyncHandler(async (req, res) => {
      const revoked = await revokeAllTokens(prisma, req.account!.id)
      res.json({ revoked })
    }),
  )

  // Rename a token in place (its secret is unchanged; label only). Empty label clears it to null.
  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const parsed = RenameTokenBody.safeParse(req.body ?? {})
      if (!parsed.success) throw badRequest('invalid_body', parsed.error.issues)
      const label = parsed.data.label && parsed.data.label.trim() ? parsed.data.label.trim() : null
      await renameToken(prisma, req.account!.id, String(req.params.id), label)
      res.status(204).end()
    }),
  )

  // Revoke a token AND forget the machines it last pushed for (combined "kick + remove token"). Returns
  // the machine count forgotten (200) so the UI can report it. Machines with no recorded token are
  // untouched (they're cleaned via DELETE /machines/:id from the /tokens page).
  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const { forgotten } = await revokeTokenAndForgetMachines(
        prisma,
        outputStore,
        req.account!.id,
        String(req.params.id),
      )
      res.json({ forgotten })
    }),
  )

  return router
}
