# Updating the Zellij plugin

How to rebuild the Rust plugin and reload it into the running Zellij **without restarting Zellij**.

> Only needed when you change the **plugin (Rust)** code under `apps/plugin/`.
> Backend (`apps/backend`) and web (`apps/web`) changes hot-reload on their own (tsx-watch / Next
> fast-refresh) — for those, just refresh the browser; do **not** touch the plugin.

## ⚠️ You MUST bump the filename each build

Zellij (0.44.3) compiles a plugin's `.wasm` **once, keyed by its path, and keeps the compiled module
in memory for the life of the server.** `start-or-reload-plugin` on an **already-loaded path re-runs
the plugin but reuses the old compiled bytes** — it does **not** re-read the file from disk. So
overwriting `zantiflow3.wasm` in place and reloading silently keeps running the OLD code. (Confirmed:
a rebuilt binary at the same path showed neither the thinking indicator nor coloured output until the
path changed.) The only reliable trigger short of restarting the Zellij server (forbidden here) is a
**path Zellij has never compiled** — i.e. a new filename.

## The loop

```bash
# 1. Build (run from anywhere inside /repos/zantiflow — it's a cargo workspace)
cargo build -p zantiflow-plugin --target wasm32-wasip1 --release

# 2. Copy to a NEW filename (bump the number every build: 4 -> 5 -> 6 ...).
#    The build output is zantiflow_plugin.wasm (underscore, from the [[bin]] name).
cp /repos/zantiflow/target/wasm32-wasip1/release/zantiflow_plugin.wasm /repos/zantiflow4.wasm

# 3. (optional) Reuse the SAME machineId so no duplicate machine appears in the dashboard —
#    copy the previous plugin's cache dir (holds machine_id + salt + ingest_token) to the new path:
cp -r "$HOME/.cache/zellij/file:/repos/zantiflow3.wasm" "$HOME/.cache/zellij/file:/repos/zantiflow4.wasm"

# 4. Point the config alias at the new file so NEW sessions load it too.
#    Edit ~/.config/zellij/config.kdl:  zantiflow location="file:/repos/zantiflow4.wasm" { ... }

# 5. Load the new path.
zellij action start-or-reload-plugin "file:/repos/zantiflow8.wasm" \
  -c "server_url=http://localhost:4000,machine_name=alias:my-vm,full=true,pane_output=true"
```

Run step 5 from a pane inside the Zellij session you want it to affect (or add `--session <name>`).

**Note:** the OLD instance (loaded at session start via `load_plugins`) keeps running until that
session ends, so briefly two instances report the same machine. For a fully clean single-instance
state, start a **fresh session** after step 4 (it loads the new path from `config.kdl`). If you did
**not** do step 3, the new path registers as a **new** machine in the dashboard — watch that one and
delete the stale duplicates.

## Things to know

- **`-c` fully replaces the config for this load.** Because you pass the *file URL* directly, Zellij
  ignores the `zantiflow` alias block in `~/.config/zellij/config.kdl` and uses **only** this `-c`
  string — so it must be complete. The **ingest token is not needed** here; it's read from the paired
  token in the plugin's `/cache`.

- **Path decides the machineId.** The plugin's `/cache` (which holds its `machineId` + salt +
  ingest token) is keyed by the plugin URL, stored at `~/.cache/zellij/file:/repos/<name>.wasm/`.
  A new filename → new cache → new `machineId` → a new machine in the dashboard, **unless** you copy
  the previous cache dir across (step 3 above). Permission grants (`~/.cache/zellij/permissions.kdl`)
  are keyed the same way, so a brand-new path re-prompts for permissions the first time.

- **New sessions pick it up automatically.** `config.kdl`'s `zantiflow` alias (loaded via
  `load_plugins`) sets `pane_output "true"`, so any freshly started session loads the plugin with
  output sharing on — from whatever path the alias currently points at (keep it in step with step 4).

- **⛔ Never restart/kill Zellij** to pick up plugin changes — `start-or-reload-plugin` is enough. See
  the hard rule in `CLAUDE.md`.

## Verify it worked

It's a headless (`load_plugins`) plugin, so there's no plugin pane to look at. Confirm in the
**dashboard**:

1. The `my-vm` machine shows **online** (updates within ~1s of the reload).
2. Expanding a pane's output drawer loads its "last 50 lines" (requires `pane_output=true`, above).
