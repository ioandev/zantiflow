# zantiflow

A Zellij plugin (Rust → WASM) that pushes a per-second snapshot of your terminal
sessions → tabs → panes to a multi-tenant backend, with a live status dashboard,
attention detection, and notifications.

> **Status:** early development — mostly architecture decisions plus the first
> shipped code (the `@zantiflow/*` packages). See [`CLAUDE.md`](./CLAUDE.md) and
> [`adrs/`](./adrs/) for the design, and [`plans/`](./plans/) to build.

## Use at your own risk

zantiflow is **early, experimental software** and you run it **at your own risk.** It ships **"AS IS",
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND** — see the "Disclaimer of Warranty" and "Limitation of
Liability" sections of the [Apache-2.0 `LICENSE`](./LICENSE). Some things to keep in mind:

- The plugin runs **WASM in your terminal** with access to your session/pane contents. **Pin a specific
  release and verify its SHA-256** — never load `latest`.
- Defaults are privacy-first (pane output OFF; names redactable), but **you are responsible** for how
  you configure it and what you choose to send.
- No guarantees are made about data security, availability, correctness, or fitness for any purpose.
  For full control, **self-host** the backend (see [`deploy/`](./deploy/)).

## License

Licensed under the **Apache License, Version 2.0** — see [`LICENSE`](./LICENSE)
and [`NOTICE`](./NOTICE). The same license applies to the `@zantiflow/*`
packages under [`packages/`](./packages/).

## Credits & attribution

zantiflow is built and maintained by **Ioan** ([@ioandev](https://github.com/ioandev)).

If you use, fork, or build a project on top of zantiflow — the plugin, the
backend, or the packages — a mention of the original source is appreciated:

- **Source:** https://github.com/ioandev/zantiflow
- **Website:** https://zantiflow.com
- **Author:** https://ioan.dev

Apache-2.0's `NOTICE` covers redistribution of the *code* (keep the `NOTICE`
file with any copy). Crediting the *idea* isn't a license term — it's a request,
but a genuinely appreciated one. 🙏
