# HOMEPAGE.md — what the marketing homepage should show

This is the content/marketing spec for the **public homepage** of the zantiflow website
(`apps/web`, the anonymous view of `app/page.tsx`). It is not an implementation ticket — it says
*what to say, in what order, and why*, so the page can be built or rewritten without re-deriving the
pitch. Behaviour is decided in the ADRs; this doc only governs the marketing surface (UX beyond the
vendored dashboard design is deliberately deferred — ADR-0019 — so build the marketing page to
sensible defaults and the brand notes below).

**Grounding rule (non-negotiable):** every claim on this page must be true per the ADRs and
`docs/src/content/docs/*`. Telemetry is **approximate** (activity is *derived*, not signalled by
Zellij), attention detection is **best-effort**, and privacy is **redact-before-send**. Do not
overclaim. See "Accuracy guardrails" at the end — treat it as a hard constraint, not a footnote.

---

## 1. Positioning

**Who it's for (in priority order)**

1. Developers running **AI coding agents** (Claude Code and friends) in the terminal, who kick off a
   long task, walk away, and lose minutes — or an hour — before they notice the agent stopped and is
   waiting on them.
2. Developers with **many Zellij sessions across several machines** (laptop, dev box, servers) who
   want one live bird's-eye view instead of `tmux ls`-ing over SSH.
3. **Privacy-conscious** developers who would never pipe their terminal into a SaaS — and need to see
   *before* they'll trust it that names are redacted on their machine and nothing is retained.

**The problem, in one breath**

> You start something in a terminal, switch away, and the terminal has no way to reach you. The AI
> agent that was coding for you finished five minutes ago and is sitting there waiting. The build
> died. The session detached. You find out when you happen to look.

**The promise**

> zantiflow gives you a live view of every Zellij session on every machine — sessions → tabs → panes,
> updated once a second — and pings your phone the moment a pane needs you.

**One-liner candidates** (pick one for the hero; the rest are backups / A-B fodder)

- **Know the moment your terminal needs you.** ← recommended primary
- Your terminals, live — and they tell you when they need you. *(evolves the current live headline)*
- Stop watching the spinner.
- Your AI agent finished. You just didn't know yet.

**What makes it different (the wedge):** it's built around the **attention** — not just "here are your
sessions", but "*this* pane needs you, now, and here's why". That's the AI-agent-babysitting pain, and
it's the reason to install rather than admire.

---

## 2. Page structure (top to bottom)

Order is deliberate: hook → make them feel the problem → show the product → earn trust (privacy) →
remove friction (free/OSS/self-host) → convert. Each section lists its **goal**, **copy**, and
**visual**.

### 2.1 Hero (above the fold)

- **Goal:** in five seconds, a Zellij + AI-agent user thinks "that's my problem" and sees one button.
- **Eyebrow:** `A Zellij plugin + live dashboard` (mono, muted — orients the unfamiliar visitor fast).
- **Headline:** **Know the moment your terminal needs you.**
- **Subhead:** A Zellij plugin reports your sessions → tabs → panes to a live dashboard, once a
  second — and pings you when a pane needs your attention, like a Claude session waiting on input.
  Redaction happens in the plugin, before anything is sent.
- **Primary CTA:** **Get started** → the plugin getting-started guide (`docs` /plugin/getting-started).
  Installing the plugin is the real activation event; sign-in alone shows an empty dashboard.
- **Secondary CTA:** **Sign in with Google** → `loginHref('/dashboard')` (keep the existing OAuth
  entrypoint and post-login redirect; a signed-in visitor is redirected straight to `/dashboard`).
- **Tertiary link:** **See how it works** (anchors to §2.3) · **GitHub** (external).
- **Live promo:** keep the `PromoBanner` (ADR-0020) — the homepage shows the current auto-minted PRO
  code. It's a real, recurring reason to land here and a soft PRO on-ramp. Keep it understated, near
  the CTAs, not shouting.
- **Visual:** a real, redacted **dashboard screenshot** (light + dark, matching the theme toggle) —
  the machines → sessions → tabs → panes tree with a live green dot, an amber **"quiet 6m"** pane, and
  one **"needs input"** badge and one cyan **"thinking…"** indicator visible. The product *is* the hero
  image; a real tree beats an abstract illustration. Build to the canonical v2 design
  (`design/dashboard/zantiflow-status-v2.dc.html`).

### 2.2 The problem (empathy strip)

- **Goal:** name the pain precisely so the reader feels seen; this is the emotional core.
- **Copy (short, punchy):**
  - *Heading:* You can't watch every terminal at once.
  - You start a task and switch away. The agent hits a prompt and waits. The build fails. A session
    detaches. Nothing in the terminal can reach you — so you lose minutes, or the whole coffee break,
    before you look back and notice.
- **Visual:** three tiny "before" vignettes (icon + one line): *agent waiting on input · session
  stopped · build gone quiet.* Keep it to one scannable row.

### 2.3 How it works (the loop)

- **Goal:** make the architecture obvious and trustworthy in three steps. Reuse the docs' mental model.
- **Three steps:**
  1. **Install the plugin.** A Rust → WebAssembly plugin runs inside Zellij and builds a snapshot of
     your sessions, tabs, and panes once a second.
  2. **It reports to your dashboard.** The snapshot is POSTed to the backend over an authenticated,
     write-only ingest token. Redaction is applied *in the plugin, before anything is sent.*
  3. **You get pinged when a pane needs you.** The dashboard shows every machine live; when an
     attention fires, you get a notification — browser push for everyone, Discord/Telegram DM for PRO.
- **Visual:** the loop diagram from `docs/overview.mdx`, cleaned up for marketing:
  `Zellij plugin → backend → your dashboard`, with `attention fires → Web Push / bot DM` branching off.
- **Reassurance line:** Two separate keys, never mixed — a **write-only** token pushes snapshots and
  can't read a thing; **your Google sign-in** is the only thing that can read or manage your account.

### 2.4 Features (the grid)

- **Goal:** let a skimmer collect reasons to try it. 4–6 cards, benefit-led headline + one honest line.
- **Cards:**
  - **Live, once a second.** Machines → sessions → tabs → panes, streaming over SSE. Current session
    first, then other live, then resurrectable/dead.
  - **Attention badges.** The dashboard flags the pane that needs you — needs-input, session stopped,
    session detached — and shows a distinct **"thinking…"** indicator when Claude is busy (not counted
    as needing you).
  - **Notifications that reach you.** Installable PWA with browser **Web Push** for everyone;
    **Discord + Telegram** DMs for PRO. Tune when, what, and where.
  - **Peek at a pane, on demand.** Optionally pull the **last ~50 lines** of a pane — ANSI colors and
    all — only when you ask. Off by default; content otherwise never leaves your machine.
  - **Multi-machine, multi-tenant.** One dashboard for your laptop, dev box, and servers, each named
    (real hostname, a custom alias, or hidden).
  - **Dark & light.** Built to a hand-tuned terminal-native theme; follows your system, toggle to pin.
- **Visual:** icon + text cards, matching the dashboard's pill/badge language (green live, amber quiet,
  orange needs-attention, cyan thinking) so the marketing and product read as one system.

### 2.5 Privacy (a full section, not a footnote)

- **Goal:** convert the skeptic. For this audience, privacy *is* a feature and a differentiator —
  give it real estate and be specific, because vague privacy claims read as marketing and specific
  ones read as engineering.
- **Heading:** Your terminal is yours. Redaction happens before anything is sent.
- **Three concrete promises** (each maps to something true):
  - **Redacted on your machine.** Names you hide never leave the plugin — they transmit as `null` and
    the dashboard shows `<hidden>`. Settings **fail closed**: a typo redacts *more*, never less.
  - **Nothing is stored.** The backend keeps only the **latest snapshot** per machine and current
    attentions — no history. Notifications are pruned after a few hours.
  - **Raw output stays home.** Pane contents are never sent by default. The opt-in peek scrubs known
    secret shapes **in the plugin** first, and the dashboard escapes markup so output can't execute.
- **Trust footer for this section:** **Open source and self-hostable** — read exactly what's sent, or
  run the whole thing yourself. Link: Privacy docs · the `deploy/` example.

### 2.6 Pricing / PRO (honest and low-pressure)

- **Goal:** set expectations — it's free, PRO is real but not sold — without a fake paywall.
- **Heading:** Free and open source. PRO when you want it.
- **Two-column compare:**
  - **Free** — live dashboard, all attention detection, browser Web Push, unlimited-ish machines
    (token cap ≤10), self-host. Attention thresholds at the free tier (≥5 min).
  - **PRO** — everything in Free, plus **tighter thresholds (≥1 min)** and **Discord + Telegram** DMs.
- **How PRO happens (state it plainly — no dark patterns):** There's **no checkout**. A fresh promo
  code appears on this homepage every couple of weeks and grants a month of PRO — sign in, redeem, done.
  Or self-host and configure it yourself.
- **Support line:** Like it? **Sponsor it on GitHub.** Donations fund the work; they're support-only
  and don't buy anything.

### 2.7 Final CTA

- **Goal:** one clean close for anyone who scrolled the whole way.
- **Heading:** Give your terminals a way to reach you.
- **Buttons:** **Get started** (plugin guide) · **Sign in with Google**.
- **Micro-reassurance under the buttons:** Free · open source · redacted before send · self-hostable.

### 2.8 Footer

- Brand `zantiflow` (mono). Links: Docs · Privacy · Contributing · Donations · GitHub. Theme toggle.
- No newsletter capture, no tracking pixels — it would contradict the privacy pitch. Keep it clean.

---

## 3. Voice & tone

- **Developer-to-developer, plain.** Short sentences. No "revolutionize", no "seamless", no
  "supercharge". The docs already set this register — match `docs/src/content/docs/overview.mdx`.
- **Lowercase `zantiflow`** as the brand, always, in mono. It's a terminal tool; it should feel like one.
- **Concrete over abstract.** "Pings your phone when Claude is waiting" beats "intelligent
  notification system". Name Zellij and Claude Code by name — the audience self-selects on them.
- **Confident, not hype.** The honesty ("approximate", "best-effort", "off by default") is a trust
  signal to this audience, not a weakness. Lean into it.

---

## 4. Brand & design notes (so marketing ≠ a different product)

- **Typography:** IBM Plex Sans (body) + IBM Plex Mono (brand, code, machine names) — already loaded.
- **Palette:** reuse the CSS variables in `apps/web/app/globals.css`. Blue `--blu` is the action/brand
  color; **green** = live, **amber** = quiet/needs-attention-soon, **orange** `--att` = needs input,
  **cyan** `--think` = thinking. Using the *product's own status colors* in the marketing sections is
  the cheapest way to make the two feel like one system.
- **Theme:** light default, system-dark aware, explicit toggle wins — reuse the existing mechanism; no
  flash of the wrong theme (theme is set pre-paint in `layout.tsx`).
- **Imagery:** real redacted dashboard captures over illustrations. If a hero animation is used, keep
  it a lightweight looping SSE-style tree, and respect `prefers-reduced-motion` (as the dashboard's
  spinner already does).
- **Restraint:** the dashboard is calm and information-dense; the homepage should feel like its lobby,
  not a louder, different brand.

---

## 5. Conversion mechanics

- **Two front doors, and they're different.** *Get started* (install the plugin) is the true
  activation path — without a plugin reporting, a signed-in dashboard is empty. *Sign in* is for people
  ready to set up an account/token. Lead with **Get started**, keep **Sign in** as the clear secondary.
- **Signed-in visitors skip the pitch.** Keep the existing behaviour: if `getMe()` succeeds, redirect
  to `/dashboard` (they don't need marketing). The full homepage is the **anonymous** view only.
- **The promo banner is a recurring hook.** Because a new code is minted here every two weeks
  (ADR-0020), the homepage has an organic reason for repeat visits and a friendly PRO on-ramp — keep it.
- **OAuth entrypoint is fixed:** the sign-in link must point at the backend Google entrypoint with a
  post-login redirect (`/api/v1/auth/google?redirect=…`) — the landing e2e test asserts this shape.

---

## 6. SEO & metadata

- **`<title>`:** `zantiflow — live Zellij session dashboard with attention notifications`
- **Meta description:** `See every Zellij terminal session across your machines, live — and get pinged
  the moment a pane needs you, like a Claude Code session waiting on input. Free, open source,
  privacy-first, self-hostable.`
- **Primary keywords to earn:** *Zellij plugin, terminal session dashboard, Claude Code notifications,
  AI agent waiting for input, monitor terminal sessions remotely, tmux/Zellij session monitor.*
- **Open Graph / social card:** the redacted dashboard screenshot + the headline. This is the image
  people will actually see when the link is shared in a dev Slack.

---

## 7. Accuracy guardrails (do NOT overclaim)

Marketing must not write checks the product can't cash. Concrete rules:

- **"Live / once a second" is the report cadence, not a guarantee of instant truth.** Per-pane
  activity is *derived* by polling and diffing scrollback (Zellij emits no "new stdout" event), so it's
  **approximate**. Never say "real-time to the keystroke" or "we know the instant output appears".
- **Attention detection is best-effort.** Say "pings you when a pane looks like it needs you", not
  "never miss a prompt". The thinking/needs-input detectors are heuristic (ADR-0025) and can be wrong.
- **Privacy claims must match the ADRs exactly.** Redaction is *in the plugin, before send*; pane
  output is *opt-in, off by default*; secret scrubbing is *best-effort*, not a guarantee — don't imply
  it catches every secret. Retention is *latest snapshot only*.
- **No enterprise/scale claims** the backend doesn't support, and **no paid-plan language** — there is
  no checkout (ADR-0013). PRO is promo-code or self-host only.
- **Don't imply it captures your whole terminal.** It reports the *tree* (names/commands, redactable)
  plus change-fingerprints; full pane content only on the separate opt-in channel.

When in doubt, prefer the more modest phrasing — this audience punishes overclaiming and rewards
honesty. If a line here ever drifts from the ADRs, the ADRs win; update this file.
