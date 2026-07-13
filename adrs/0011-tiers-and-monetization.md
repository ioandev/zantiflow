# ADR-0011 — Tiers & monetization: GitHub Sponsors donations + promo codes (paid billing declined)

- **Status:** Accepted
- **Backs:** the `tier` hook used by [ADR-0005](0005-attentions-detection-and-triggering.md) (thresholds), [ADR-0006](0006-notifications-web-push-and-channels.md) (channels), [ADR-0008](0008-status-website-dashboard.md) (features)
- **Builds on:** [ADR-0003](0003-multi-tenant-backend-and-token-auth.md) (accounts), [ADR-0004](0004-google-auth-owner-sign-in.md) (owner auth), [ADR-0009](0009-durable-notification-delivery.md) (MariaDB)
- **Extended by:** [ADR-0020](0020-automated-promo-codes.md) — automated promo-code generation (no admin)
- **Date:** 2026-07-10
- **Deciders:** project owner
- **Tags:** monetization, tiers, stripe, donations, promo, pro
- **Testing:** unit (promo redemption, effective-tier, lapse → downgrade) + Playwright (redeem code) — see [ADR-0014](0014-testing-strategy.md)

## Context

Every prior ADR treats account **`tier` (free|pro)** as an unbacked policy hook. This ADR defines how
an account becomes **pro**. Decision: **no paid checkout** — **GitHub Sponsors** donations (fund the
OSS project, support-only) plus **promo codes** (published every few weeks) that grant PRO for a
period. **Paid subscriptions (Stripe/Polar) are declined for the foreseeable future — see
[ADR-0013](0013-paid-subscriptions-declined.md).**

## Decision Drivers

- Launch **without payment infrastructure**; defer Stripe + tax complexity.
- Reward early supporters and the community; OSS-friendly funding.
- Keep `tier` a clean, time-bounded hook the other ADRs already consume.

## Considered Options

- **Now:** GitHub Sponsors donations + **promo codes** *(chosen)* vs immediate Stripe (deferred).
- **Donation platform:** **GitHub Sponsors only** *(chosen, per owner)* — 0% platform fee, OSS-native,
  audience already on GitHub. (Ko-fi/Open Collective/Liberapay considered; kept to Sponsors for
  simplicity now.)
- **Paid tier:** **declined** for now — see [ADR-0013](0013-paid-subscriptions-declined.md); PRO is
  promo-code-only.

## Decision

### 1. Tier model

Account gains **`tier (free|pro)`** + **`tierExpiresAt`** (nullable). PRO is **time-bounded**: a promo
grants N days. **Effective tier = `pro` iff `tierExpiresAt > now`, else `free`.** A periodic job (or on-read computation)
downgrades lapsed PRO → free. The backend gates ADR-0005 thresholds / ADR-0006 channels / ADR-0008
features on the **effective** tier.

### 2. Now — donations + promo codes

- **Donations = GitHub Sponsors** — a link on the site + a "Sponsor" button on the repo. Pure external
  link, ~no engineering. **Donations do not auto-grant PRO** (they're support); messaging must make
  that clear.
- **Promo codes = the PRO-granting mechanism for now:**
  - `PromoCode { code, grantsTier: pro, durationDays, maxRedemptions, perAccountLimit, expiresAt, createdBy }`.
  - `PromoRedemption { code, accountId, redeemedAt }`.
  - **Redeem:** a logged-in user (ADR-0004) enters a code on the website → backend validates (exists,
    not expired, under `maxRedemptions`, within `perAccountLimit`) → sets `tier = pro` and **extends
    `tierExpiresAt` by `durationDays`** → records the redemption. Redemption attempts are **rate-limited**.
  - Codes are **auto-generated every 2 weeks** and posted on the homepage — **no admin** (ADR-0020).

### 3. Paid subscriptions — declined (for now)

There is **no paid checkout**. Paid PRO via Stripe/Polar is **declined for the foreseeable future** —
see **[ADR-0013](0013-paid-subscriptions-declined.md)**. **PRO is granted solely via promo codes**
(§2); donations stay support-only. The `tier` / `tierExpiresAt` model above is fed **only by promo
codes**.

## Consequences

**Positive**
- Launch with **zero payment infra**; rewards early supporters via promo codes; realizes the `tier`
  hook used across ADRs; OSS funding via Sponsors.

**Negative / costs**
- Promo-code administration (generation, tracking, abuse); PRO is time-bounded bookkeeping.
- Donations **don't** grant PRO — needs clear messaging to avoid confusion.
- Promo-code sharing/abuse to police (mitigated in §2).

**Neutral**
- Backs the tier hook; **paid billing declined** ([ADR-0013](0013-paid-subscriptions-declined.md)); no plugin/wire-contract impact.

## Open Questions / Risks

1. **Paid subscriptions (Stripe/Polar)** — **declined** for the foreseeable future
   ([ADR-0013](0013-paid-subscriptions-declined.md)). If ever revisited, weigh a merchant-of-record
   (Polar / Paddle / Lemon Squeezy, which absorb VAT) vs raw Stripe.
2. Do donations ever grant a perk (e.g. a PRO month for Sponsors above $X)? **Now: no**; revisit. **(decided: no perk now.)**
3. **Promo abuse** (code sharing) — `maxRedemptions` + `perAccountLimit` + `expiresAt` + rate limiting;
   monitor. **Decided:** ship those mitigations by default.
4. **Downgrade/grace UX** when PRO lapses (promo expires / subscription ends). **Decided:** on lapse, downgrade to free + show a banner; no grace period.
5. Refunds / chargebacks — n/a while paid subscriptions are declined ([ADR-0013](0013-paid-subscriptions-declined.md)).

## References

- ADR-0003 (accounts/tier), ADR-0004 (owner auth for redemption), ADR-0005/0006/0008 (tier-gated
  features)
- GitHub Sponsors; [ADR-0013](0013-paid-subscriptions-declined.md) (paid billing declined)
