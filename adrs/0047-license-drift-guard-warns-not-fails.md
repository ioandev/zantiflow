# ADR-0047 — CI license-manifest drift guard warns instead of failing

- **Status:** Accepted (implemented)
- **Amends:** [ADR-0046](0046-ci-license-manifest-drift-guard.md) (flips its Decision step 3: the
  `license-drift` job emits a `::warning::` on drift instead of a fatal `::error::` + `exit 1` — the
  guard, its scope, and its reproducibility carve-out are otherwise unchanged)
- **Relates to:** [ADR-0036](0036-apache-2-0-and-third-party-license-compliance.md) (the manifests +
  `just license`), [ADR-0021](0021-dockerization-and-deployment.md) /
  [ADR-0022](0022-plugin-publishing-and-user-docs.md) (where the manifests ship)
- **Date:** 2026-07-14
- **Deciders:** project owner
- **Tags:** ci, licensing, compliance, tooling

## Context

ADR-0046 added the `license-drift` job to `.github/workflows/tests.yml`: it regenerates the two
byte-reproducible manifests (`apps/web/LICENSES` from the frozen pnpm lockfile, `apps/plugin/LICENSES`
from the committed `Cargo.lock`) and `git diff --exit-code`s them, **failing the build** (`::error::`
+ `exit 1`) when a contributor bumped a dependency but forgot `just license`.

Because `tests.yml` is the reusable suite run by `ci.yml` (PRs/feature pushes) **and** by
`docker-publish.yml` as its pre-publish gate, a hard failure here **blocks merge and blocks publish**
on stale attribution. In practice that couples an easily-remedied, non-code hygiene miss (a forgotten
regenerate-and-commit) to the merge/release path — a stale manifest is a *documentation* defect, not a
correctness or security one, and blocking a release on it is heavier than the problem warrants. The
owner wants the drift **surfaced loudly but non-blocking**: still visible on every run, still
actionable, but never the reason a PR or an image publish is held up.

ADR-0046's own remedy is already self-serve and cheap (`just license` + commit), and its
reproducibility carve-out means the guarded scopes only diff on a *real* forgotten regenerate — so a
warning carries the same signal the error did, minus the gate.

## Decision Drivers

- **Surface drift, don't gate on it.** Stale attribution is a hygiene miss, not a merge/release
  blocker; keep it visible without coupling it to the critical path.
- **Preserve the signal.** The message stays identical and actionable; only its severity drops.
- **Minimal change.** Reuse the existing job, generator, and diff; flip one step.

## Considered Options

1. **Downgrade the drift step to `::warning::`, drop `exit 1`** *(chosen)* — the job still runs the
   same regenerate + `git diff`, and on drift annotates the run with a warning telling the contributor
   to run `just license` and commit, but exits `0`. Non-blocking; keeps the annotation on PRs and on
   the pre-publish run.
2. **Remove the job entirely** — rejected: loses the signal ADR-0046 was created to provide; back to
   ADR-0036 Risk 2 with nothing surfacing drift at all.
3. **Keep it a hard failure but move it out of the publish gate** — rejected: more workflow surgery
   (a separate job/trigger) for a weaker outcome than simply making it non-blocking everywhere, and it
   would still block PR merge.

## Decision

In the `license-drift` job of `.github/workflows/tests.yml`, change the final step from a fatal error
to a warning:

- rename the step `Fail if a committed manifest is stale` → `Warn if a committed manifest is stale`;
- on a non-empty `git diff`, emit `::warning::A committed LICENSES manifest is stale — run \`just
  license\` and commit the result.` and **do not** `exit 1` (the step, and the job, exit `0`).

Everything else from ADR-0046 is unchanged: the guarded scopes (`web` + `plugin`), their lockfile
reproducibility, the `needs.detect.outputs.rust` gate on the plugin scope, and the deliberate
exclusion of the root `LICENSES`. The job's header comment is updated to say it warns (not fails).

## Consequences

**Positive**
- Drift no longer blocks merge or image/plugin publish; a forgotten `just license` can't hold up a
  release for a documentation-only miss.
- The signal is preserved — every affected run still carries the same actionable annotation.

**Negative / costs**
- A warning is easier to ignore than a failure, so a stale manifest can now merge and an image can
  ship with slightly stale attribution until someone runs `just license`. Accepted: attribution
  content is unchanged in kind (same licenses, updated versions/lists), the shipped plugin `.wasm`
  regenerates its manifest fresh at release time (ADR-0046 Context), and the annotation makes the fix
  obvious.

**Neutral**
- The job still runs on every PR and pre-publish; only its exit behavior changed.

## Open Questions / Risks

1. **Warnings get missed.** GitHub surfaces `::warning::` annotations in the run summary and on the
   PR's Files-changed diff (when the path is touched), but they don't fail a required check. If drift
   starts slipping through routinely, a middle ground (e.g. a required check that fails only when the
   *committed* manifest is edited alongside a dependency bump) can be reconsidered in a follow-up ADR.
2. ADR-0046's open risks are unchanged (full-root coverage still pending the bot-dependency pinning;
   toolchain-version reproducibility).

## References

- Job: `.github/workflows/tests.yml` (`license-drift`, `Warn if a committed manifest is stale`)
- [ADR-0046](0046-ci-license-manifest-drift-guard.md) (the guard this amends),
  [ADR-0036](0036-apache-2-0-and-third-party-license-compliance.md) (manifests + `just license`)
