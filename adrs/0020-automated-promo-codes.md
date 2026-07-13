# ADR-0020 — Automated promo codes (self-serve PRO, no admin)

- **Status:** Accepted
- **Extends:** [ADR-0011](0011-tiers-and-monetization.md) — makes promo-code creation **automated**
- **Resolves:** the "no operator/admin path to create promo codes" gap (security-audit follow-up)
- **Builds on:** [ADR-0003](0003-multi-tenant-backend-and-token-auth.md) (accounts/tier), [ADR-0004](0004-google-auth-owner-sign-in.md) (owner auth for redeem), [ADR-0009](0009-durable-notification-delivery.md)/[ADR-0018](0018-engineering-and-operational-conventions.md) (cron + rate-limit)
- **Date:** 2026-07-11
- **Deciders:** project owner
- **Tags:** promo, monetization, tiers, cron, no-admin
- **Testing:** unit (CSRNG gen, redeem validation, stacking cap) + BDD (redeem → PRO for a month) + Playwright (homepage shows code, redeem flow) — see [ADR-0014](0014-testing-strategy.md)

## Context

[ADR-0011](0011-tiers-and-monetization.md) made **promo codes** the PRO-granting mechanism (paid
billing is Declined, ADR-0013) but left *creation* manual — and there is **no admin role** anywhere
(flagged as a gap). This ADR **fully automates** promo codes so PRO is entirely self-serve: a job mints
a new code on a schedule, the current code is shown on the **public homepage**, and a logged-in user
redeems it on the site for a month of PRO. **No admin user, endpoint, or UI is needed** — which also
keeps the attack surface small.

## Decision

### 1. Generation — automated, no admin

A backend **cron** (ADR-0018 conventions) runs **every 2 weeks** and creates one `PromoCode`:

- `code` — **CSRNG**, human-friendly (e.g. `ZTF-XXXXXXXX`, uppercase Crockford-base32, unambiguous
  charset). **Unguessable**, so a not-yet-posted future code cannot be redeemed early.
- `grantsTier: pro`, `durationDays: 30` — redemption grants **one month** of PRO.
- `expiresAt = createdAt + 30 days` — the code is **redeemable for a month**.
- `maxRedemptions: unlimited` (it's a public marketing code) · `perAccountLimit: 1` (an account may
  redeem a given code **once**).
- With a 2-week cadence and 1-month validity, **~2 codes are valid at any time** (overlapping).
- Creator is the **system** (the cron), not an admin (`PromoCode.createdBy` = `"auto"`).

### 2. Homepage — public display

The **public homepage** shows the **current** (latest, non-expired) code. `GET /api/v1/promo/current`
→ `{ code, expiresAt }` — **no auth** (the code is public by design; it exposes no PII). *(The
homepage/landing visual design follows ADR-0019 defaults; the data + endpoint are decided here.)*

### 3. Redemption — owner-authenticated

A logged-in user enters the code somewhere on the site → `POST /api/v1/promo/redeem { code }` (owner
session, **strict rate-limit**, ADR-0018 §9) → validate (exists, not expired, within `perAccountLimit`)
→ set `tier = pro`, **extend `tierExpiresAt` by 30 days**, record a `PromoRedemption`. **Generic**
failure messages; authorized only to the redeeming account (ADR-0011).

### 4. Stacking — bounded

Redeeming successive codes **extends** PRO — the intended "free PRO via promo" model (billing is
Declined, ADR-0013). To stop it running ahead indefinitely (redeeming every code = +30 d per 2 weeks),
extension is **capped so `tierExpiresAt` never exceeds `now + 60 days`**; redeeming while already
capped returns a friendly "you're already covered". So a user stays PRO by redeeming regularly, with at
most ~2 months of buffer.

### 5. No admin plane

Generation is a **cron**, redemption is **self-service**, the homepage is **public** — there is **no
admin role, endpoint, or UI**. This closes the promo-creation gap **without** adding an admin auth
plane (a security win, not just a convenience).

## Consequences

**Positive**
- **Zero operator burden** — PRO distribution is fully automated and self-serve.
- Resolves the admin/promo gap **without** an admin plane → smaller attack surface.
- A simple, standing growth lever (a fresh code every 2 weeks on the homepage).

**Negative / costs**
- PRO is effectively **free to anyone who keeps redeeming** — accepted (this is the pre-billing phase,
  ADR-0013); the ~60-day cap bounds the buffer.
- Public codes are redeemable by everyone (intended).
- The cron must run reliably — a **missed run degrades gracefully** (the prior month-long code stays
  valid; the next run mints a fresh one).

**Neutral**
- Extends ADR-0011; resolves the flagged gap; uses ADR-0018's cron + rate-limit + no-secrets-logged
  conventions. `PromoCode`/`PromoRedemption` schema is unchanged (ADR-0011) beyond `createdBy = "auto"`.

## Open Questions / Risks

1. **Cap value** (`now + 60 days`) — tune if the cadence/validity change. **(decided: 60 d.)**
2. **Homepage** shows the single current code (not all ~2 valid). **(decided.)**
3. **Cron reliability** — degrades gracefully (prior code covers the gap); no separate mitigation needed. **(decided.)**

## References

- ADR-0011 (tiers / promo model), ADR-0013 (paid billing Declined), ADR-0003 (accounts/tier), ADR-0004
  (owner auth for redeem), ADR-0018 (cron, rate-limit, no-secrets)
