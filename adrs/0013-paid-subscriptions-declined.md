# ADR-0013 — Paid PRO subscriptions (Stripe / Polar) — Declined

- **Status:** Declined
- **Relates to:** [ADR-0011](0011-tiers-and-monetization.md) (tiers & monetization)
- **Date:** 2026-07-10
- **Deciders:** project owner
- **Tags:** monetization, stripe, polar, billing, declined

## Context

[ADR-0011](0011-tiers-and-monetization.md) established the `tier` model with **PRO granted via promo
codes** and **GitHub Sponsors** donations for support, and floated **Stripe** (later) plus a
**Polar / merchant-of-record** evaluation for a future paid tier.

## Decision

**Declined — for the foreseeable future.** We will **not** build paid subscriptions: no Stripe, no
Polar, no paid checkout, no merchant-of-record integration. **PRO is granted solely via promo codes**
(ADR-0011); donations remain **support-only** (they do not grant PRO). This will not be revisited for
a long time.

## Rationale

- Keep the product free / community-funded; avoid payment, tax/VAT, and compliance overhead entirely.
- **Promo codes already cover PRO distribution**, so paid billing buys little right now.
- Payment infrastructure is a large, ongoing commitment better deferred until there's a compelling
  reason.

## Consequences

- **No billing infrastructure** to build, secure, or maintain; **no VAT/sales-tax** concerns.
- PRO **monetization is deferred indefinitely**; the `tier` / `tierExpiresAt` model (ADR-0011) stays
  but is fed **only by promo codes**.
- If this is ever revisited, a **future ADR supersedes this one** and — at that time — weighs a
  merchant-of-record (Polar / Paddle / Lemon Squeezy, which absorb global VAT) vs raw Stripe.

## References

- ADR-0011 (tiers & monetization; promo codes + donations)
