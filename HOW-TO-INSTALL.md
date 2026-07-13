# How to install the zantiflow plugin

The zantiflow plugin is a Zellij plugin — a WebAssembly module (`zantiflow.wasm`) built from Rust
(`wasm32-wasip1`, pinned to the Zellij version it was built against). It monitors your sessions →
tabs → panes and pushes a per-second snapshot to your backend.

> **New: device pairing.** You no longer need to paste a secret token into a config file. The plugin
> can now print a short code that you approve on the website, and it fetches + stores its token
> itself. See [Authenticate](#4-authenticate) — pairing is the recommended path.

---

## 1. Get the plugin

Download `zantiflow.wasm` from the **GitHub Releases** page and verify its checksum:

```bash
sha256sum -c zantiflow.wasm.sha256
```

Or build it yourself from the repo:

```bash
cargo build -p zantiflow-plugin --target wasm32-wasip1 --release
# → target/wasm32-wasip1/release/zantiflow_plugin.wasm
```

Put the `.wasm` somewhere stable and note its **absolute** path (e.g. `~/.config/zellij/plugins/zantiflow.wasm`).

---

## 2. Choose how to load it

| Mode | When | How |
| --- | --- | --- |
| **App-wide (background)** — *recommended* | You want it always running for every session | `load_plugins` block in `config.kdl` ([§3](#3-install-app-wide-recommended)) |
| Single pane | Quick try / one layout only | `pane { plugin … }` in a layout file ([§5](#5-alternative-load-in-a-single-pane)) |

Because zantiflow is a headless monitor for your **whole** Zellij, the background mode is the right
one — it runs with no visible pane and starts automatically with every new session.

---

## 3. Install app-wide (recommended)

Zellij's `load_plugins` block loads plugins in the background on session startup. Its entries take a
bare URL or alias (no inline config), so define an **alias** carrying the config once, then load that
alias.

Edit `~/.config/zellij/config.kdl` (run `zellij setup --check` if you're unsure of the path):

```kdl
plugins {
    // The alias carries all zantiflow config.
    zantiflow location="file:/absolute/path/to/zantiflow.wasm" {
        // server_url is OPTIONAL — defaults to the hosted service (https://zantiflow.com).
        // Set it only when self-hosting your own backend.
        server_url    "https://your-backend.example"

        // Leave `token` out to use device pairing (recommended — see §4).
        // token      "ztf_…"

        machine_name  "alias:my-laptop"   // real | alias:<text> | hidden
        full          "true"              // privacy master switch
        session_names "send"              // per-field: send | hidden
        tab_names     "send"
        pane_names    "send"
        pane_output   "false"             // on-demand pane output is OFF by default
    }
}

load_plugins {
    // Loads the alias headless, on every session startup.
    zantiflow
}
```

Start a **fresh** Zellij session for `load_plugins` to take effect. On first load the plugin appears
once to request four permissions — grant them (see [§6](#6-permissions)).

---

## 4. Authenticate

You have two options. **Pairing is preferred** — it keeps your ingest token off disk.

### Pairing (recommended, new)

1. Leave `token` **out** of the config above.
2. Start Zellij. The plugin prints a short pairing code.
3. Open **https://zantiflow.com/pair** (signed in) and enter the code.
4. The plugin receives its token automatically and stores it under its `/data` dir — the secret
   never sits in your `config.kdl` in plaintext.

### Manual token

1. In the dashboard, create an ingest token (shown once, ≤10 active per account).
2. Put it in the config: `token "ztf_…"`.

> ⚠ A manual token is a plaintext secret in `config.kdl`. Prefer pairing, or pass the token at launch
> via `--configuration` instead of committing it to a shared config/layout file.

---

## 5. Alternative: load in a single pane

To try it in one tab (visible pane), drop this into a layout file instead of using `load_plugins`:

```kdl
pane {
    plugin location="file:/absolute/path/to/zantiflow.wasm" {
        // token omitted → pairing; or set token "ztf_…"
        machine_name "alias:my-laptop"
        pane_output  "false"
    }
}
```

Open it with `zellij --layout /path/to/that-layout.kdl`. To show it in a pane on *every* session,
add the same `pane { plugin … }` to your `default_layout`.

---

## 6. Permissions

On first load the plugin requests:

- **Read application state** — to see the session/tab/pane tree.
- **Web access** — to send snapshots to the backend.
- **Read pane contents** — to derive per-pane activity (and, if you enable it, pane output).
- **Run commands** — only used to look up your hostname when `machine_name` is `real`.

Grant them in the plugin pane. `alias:` and `hidden` machine-name modes don't need the run-commands
permission.

---

## 7. Configuration keys

| Key | Values | Notes |
| --- | --- | --- |
| `server_url` | `https://…` (or `http://localhost`) | HTTPS only, except localhost; **optional** — defaults to `https://zantiflow.com` |
| `token` | `ztf_…` | omit to use device pairing |
| `machine_name` | `real` \| `alias:<text>` \| `hidden` | invalid → fails closed to `hidden` |
| `full` | `true` \| `false` | master privacy baseline (default on) |
| `session_names` / `tab_names` / `pane_names` | `send` \| `hidden` | per-field overrides |
| `pane_output` | `true` \| `false` | on-demand output channel (default off; content otherwise never leaves the machine) |

Config values can change **without a restart** via Zellij's `PluginConfigurationChanged` event.
(Adding the plugin to `load_plugins` itself still needs a new session.)

---

## Notes & gotchas

- **Absolute paths for `file:`** — relative paths don't resolve reliably. A remote
  `https://…/zantiflow.wasm` URL also works.
- **New session required** for `load_plugins` changes to take effect.
- **Config path** — Linux default is `~/.config/zellij/config.kdl`; confirm with `zellij setup --check`.
- **Pin matters** — the `.wasm` is built against a specific Zellij version; use the plugin release
  that matches your Zellij.
