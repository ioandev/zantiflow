# zantiflow task runner. Run `just` (or `just --list`) to see recipes.

# List available recipes.
default:
    @just --list

# Root = npm workspace + Cargo (plugin) + Python (bots); web = npm; plugin = Cargo.
# Uses pnpm/cargo + the bot venvs; missing ecosystems are skipped with a warning.
# Regenerate the third-party LICENSES files (root monorepo, apps/web, apps/plugin).
license:
    node scripts/generate-licenses.mjs --scope all --out LICENSES
    node scripts/generate-licenses.mjs --scope web --out apps/web/LICENSES
    node scripts/generate-licenses.mjs --scope plugin --out apps/plugin/LICENSES

# Send a notification through the REAL delivery path (dev) — e.g. `just notify claude.idle`.
# type defaults to claude.idle; account/machine are optional (see apps/backend/scripts/notify.ts).
notify type="claude.idle" account="" machine="":
    cd apps/backend && pnpm exec tsx --env-file=.env scripts/notify.ts {{type}} {{account}} {{machine}}
