# zantiflow — Getting started (Zellij plugin)

> This guide tracks the design in the ADRs. Versions, URLs, and the hosted domain below are
> **placeholders until the first release** (see [ADR-0022](../adrs/0022-plugin-publishing-and-user-docs.md)).
> The plugin reports your Zellij sessions → tabs → panes to a zantiflow backend so you can see them on
> the web dashboard and get notified when a pane needs attention.

> **⚠ Use at your own risk.** zantiflow is early, experimental software provided **"AS IS", without
> warranty of any kind** (Apache-2.0). The plugin runs WASM in your terminal with access to your pane
> contents — **pin a specific release and verify its SHA-256 (never `latest`)**, and note that you are
> responsible for how you configure it and what you choose to send. Want full control? **Self-host** the
> backend ([§5](#5-self-hosting)).

## 1. Prerequisites

- **Zellij** installed and running.
- A **zantiflow account** — open the website and **Sign in with Google** (that's the only sign-in).
- Nothing leaves your machine until you install the plugin **and** it's paired to your account.

## 2. Install

The plugin is a single `zantiflow.wasm` published on **GitHub Releases**. Pick one:

**A. Load directly from the release URL** (Zellij fetches it over HTTPS):
```kdl
// in a Zellij layout (.kdl)
plugin location="https://github.com/ioandev/zantiflow/releases/download/v0.1.0/zantiflow.wasm" {
    pairing "true"
}
```

**B. Download locally** (recommended if you want to verify integrity):
```bash
V=v0.1.0
curl -LO https://github.com/ioandev/zantiflow/releases/download/$V/zantiflow.wasm
curl -LO https://github.com/ioandev/zantiflow/releases/download/$V/zantiflow.wasm.sha256
sha256sum -c zantiflow.wasm.sha256           # verify before use
mkdir -p ~/.config/zellij/plugins && mv zantiflow.wasm ~/.config/zellij/plugins/
```
then reference `location="file:~/.config/zellij/plugins/zantiflow.wasm"`.

**C. One-off launch:**
```bash
zellij plugin --configuration "pairing=true" -- \
  https://github.com/ioandev/zantiflow/releases/download/v0.1.0/zantiflow.wasm
```

> **Pin a version** (not `latest`) — the plugin runs WASM in your terminal with pane-content access, so
> use a fixed release and verify the SHA-256.

**Permissions:** on first load Zellij asks you to grant the plugin: `ReadApplicationState` (session/pane
info), `WebAccess` (send to the backend), `ReadPaneContents` (activity + optional output), and
`RunCommands` **only if** you set `machine_name = real` (to read your hostname). Grant them to proceed.

## 3. First run — pair it to your account

With `pairing "true"` (and no `token`), the plugin shows a short **code** and a URL:

```
zantiflow — pair this machine
  code:  ZTF-4KD9QX7A
  go to: https://<your-zantiflow-host>/pair   (or the hosted site)
```

Open that page (signed in), enter the code → the plugin receives its token, stores it in its private
`/data`, and starts reporting. You can now remove `pairing "true"`. *(Headless/automation? Skip pairing
and paste a token you minted on the website: `token "ztf_…"`.)*

## 4. Configure

All keys are optional except a token (via pairing or `token`). Defaults are **privacy-first**.

```kdl
plugin location="…/zantiflow.wasm" {
    // --- connection ---
    pairing     "true"                 // or:  token "ztf_…"
    // server_url "https://zantiflow.example"   // self-hosting? point at your backend (ADR-0021)

    // --- privacy (default: full — everything below is optional overrides; ADR-0002) ---
    // full          "true"            // master baseline (default true)
    // machine_name  "alias:red-laptop"// real | alias:<name> | hidden
    // session_names "hidden"          // send | hidden
    // tab_names     "hidden"
    // pane_names    "hidden"          // hides the pane title AND its command

    // --- pane output (OFF by default; ADR-0016/0017) ---
    // pane_output       "true"        // PERMITS output — sent ONLY when you request a pane on the site,
    //                                 // never streamed; secrets are scrubbed before send.
    // pane_output_scrub "on"          // on by default when pane_output is on
}
```

**What this controls (short version):**
- `full` on (default) → machine/session/tab/pane **names are sent**; set any field to `hidden` to redact
  it (redacted names show as `<hidden>` on the site; counts/structure still show).
- `pane_output` **OFF** by default → **terminal content never leaves your machine.** Turn it on to
  *allow* viewing a pane's last 50 lines **on request** from the dashboard (colored, secret-scrubbed).
- `server_url` defaults to the hosted zantiflow; override it to self-host.

## 5. Self-hosting

Run your own backend with `deploy/docker-compose.example.yml` ([ADR-0021](../adrs/0021-dockerization-and-deployment.md)),
then set the plugin's `server_url` to your instance and pair against your site.

## 6. Troubleshooting

- **Nothing appears on the dashboard** → confirm the plugin was granted `WebAccess` and it's paired; if
  `WebAccess` is denied the plugin just **warns and idles** (it never crashes Zellij).
- **Hostname shows as hidden/alias unexpectedly** → `machine_name = real` needs the `RunCommands`
  permission; use `alias:<name>` to avoid it.
- **"needs attention" not firing for Claude** → it triggers on output-silence (≥ your tier threshold) or
  a prompt line ending in `?` held ≥15 s; make sure the pane's command is `claude`.
- **Updating** → download the new release, verify its checksum, and bump the pinned version.

---
See also: [ADR-0002](../adrs/0002-configurable-telemetry-privacy-controls.md) (privacy),
[ADR-0016](../adrs/0016-dashboard-page-and-pane-output.md) (pane output),
[ADR-0012](../adrs/0012-plugin-device-pairing.md) (pairing), [FINDINGS.md](../FINDINGS.md) (plugin API facts).
