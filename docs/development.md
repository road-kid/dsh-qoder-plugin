# Development

Everything you need to build, test and release `dsh-qoder-plugin`.

## Prerequisites

- **Node.js** `^22.19.0 || >= 24.0.0` — the plugin uses the built-in TypeScript
  loader in the transport test suite, so the floor is a real constraint.
- **pnpm** — the repo ships a `pnpm-lock.yaml` and a `pnpm-workspace.yaml`.
- **DSH** for manual testing. Install from a local checkout by pointing your profile
  at it; the CLI and the settings card are the two surfaces worth exercising by hand.

## Repository layout

| Path                 | What lives there                                                       |
| -------------------- | ---------------------------------------------------------------------- |
| `src/`               | Host half: plugin entry, credential store, catalog, adapter, scheduler, routes, CLI |
| `src/client/`        | Browser half: settings card, composer quota readout, stylesheet, locale strings |
| `src/qoder/`         | Qoder-specific model vocabulary, regions, queue notices                |
| `src/qoder/transport/` | The wire layer: request building, streaming, encoding, translation    |
| `tests/`             | Vitest suites (`tests/*.spec.ts`) plus the shared test shim            |
| `tests/qoder/`       | Transport tests, run by `node --test` instead of Vitest                |
| `scripts/`           | Ad-hoc verification scripts (live end-to-end, endpoint guard checks)   |
| `lib/`               | Build output — committed, see below                                    |
| `assets/`            | Plugin icon and README screenshots (`icon.svg`, `screenshot-*.png`)    |
| `locale/`            | `en.json` / `zh.json` shipped with the package                          |

## Commands

| Command             | What it does                                                        |
| ------------------- | ------------------------------------------------------------------- |
| `pnpm install`      | Install dependencies.                                               |
| `pnpm run build`    | Bundle both halves with [tsdown](https://tsdown.dev) into `lib/`.    |
| `pnpm test`         | Vitest over `tests/**/*.spec.ts` (host + client units).             |
| `pnpm run test:qoder` | Transport tests via `node --test tests/qoder/*.test.ts`.            |
| `pnpm run typecheck`| `tsc` twice: once for the host config, once for the client config.   |
| `pnpm run check`    | `typecheck` → `test` → `test:qoder` → `build`. This is the gate.     |

`pnpm run check` is the full gate: run it before opening a pull request, and again
as the first step of a release.

## Testing notes

- Unit suites live in `tests/*.spec.ts`. They cover the credential store, the
  catalog lifecycle, the adapter, the check-in scheduler, the settings store and the
  client components.
- Transport tests live in `tests/qoder/*.test.ts` and are run by Node's own test
  runner rather than Vitest, because they exercise the wire layer directly.
- Queue and account-routing behavior has deterministic offline coverage. Tests that
  exercise a non-default fail-fast fixture must not be treated as evidence about the
  shipped default budget; keep a separate schema/runtime contract test for defaults.
- Transport lifecycle regressions should use gated asynchronous operations or fake
  timers rather than real multi-minute sleeps. Do not weaken production defaults or
  remove assertions to make a fixture finish quickly.

## Fixing a reviewed branch

A review that rejects a fix is a specification, not a suggestion. The loop that
closed the transport review, and the one to reuse:

1. **Reproduce before editing.** Read the review's claimed mechanism, then prove
   or disprove it against the branch tip. A branch that "addressed" a finding may
   only have renamed the symptom: of the commits added to the reviewed branch
   after the report, one regenerated `lib/` and one added a doc line, and neither
   touched the reported behaviour.
2. **Fix where the decision is made.** The layer that owns the behaviour is the
   one that must change. Suppressing a user-visible row belongs in the host's
   emit path, not in the transport's attribution; a transport callback that drops
   the session id to mean "stay quiet" hands the row to a fallback that prints it
   somewhere worse.
3. **Make the regression test fail first.** Revert the fix (stash the source file,
   or flip the single line), run the new test, and confirm it fails for the stated
   reason; then restore and confirm it passes. A test that is green on the unfixed
   code is not a regression test, whatever it asserts. `git checkout --` may be
   blocked by the session safety net, so restore with an editor and re-check
   `git status`: `core.autocrlf` can leave a line-ending-only difference that
   `git diff` reports as empty.
4. **Test the layer that owns the claim.** A transport test asserting a callback
   argument does not prove the user sees nothing. The visibility rule needs a
   host-level test that boots the real plugin, keeps a conversation running so a
   stray row would actually be delivered, and asserts the conversation stays
   empty while the status card still records the wait.
5. **Record the outcome next to the code.** Findings that were disproved, findings
   that were real, and behaviour changes the fix implies all go into a
   `docs/review-*.md` record. Reviewers read that file before the diff.

## Build output

`lib/` is committed. This is deliberate: DSH installs the plugin from a GitHub ref
as often as from npm, and a GitHub install runs no build step — the bundle has to be
in the tree. `prepack` re-runs `pnpm run build`, so an npm publish always ships a
fresh bundle even if you forgot to rebuild locally.

If your change touches `src/`, rebuild and commit the resulting `lib/` in the same
commit. A pull request that changes source without the bundle is incomplete.

## Releasing

1. Add the entry to `CHANGELOG.md` **first** — the changelog leads the release, the
   tag follows it.
2. Run `pnpm run check` and make sure it is green.
3. Bump the version: `npm version <patch|minor|major> --no-git-tag-version`.
4. Publish explicitly against the public registry:
   `npm publish --registry https://registry.npmjs.org`. Mirrors are read-only; omitting
   the registry publishes to whatever your local config points at.
5. Tag and push: `git tag -a v<version> -m "v<version>"` then
   `git push origin main --tags`.

The current release line is **1.1.4**. `prepack` guarantees the published tarball is
built from the tagged source.

## Contribution conventions

- **TypeScript strict.** Both `tsconfig.json` and `tsconfig.client.json` are strict;
  do not loosen them to make a change compile.
- **No new runtime dependencies without discussion.** The plugin ships inside DSH's
  process and every dependency is one more thing the host has to load. Open an issue
  before adding one; the answer is usually "write the twenty lines yourself".
- **Keep the host theme tokens.** The client uses DSH theme tokens only — no literal
  colours, no theme selectors, no palette copies. A hard-coded colour is a bug in
  dark mode.
- **Tests for behaviour changes.** If you change what the plugin does, extend the
  suite that covers it. Purely cosmetic changes do not need a new test.
- **Wire ordering is part of the contract.** `chatStream` turns a terminal FIRST
  chunk into an HTTP status; anything yielded before a failure opens a 200 stream
  and demotes that failure to an in-band frame, where the host derives the retry
  code from the message text. A failure that should be retried has to be the
  first chunk, and its test should pin the chunk ORDER, not just the final chunk.
- **User-visible notices are decided in the host.** The transport reports facts
  (which conversation, whether the request is bookkeeping); `src/index.ts`
  decides what reaches a conversation. Never encode "do not print this" as a
  missing session id — `emitUpstreamNotice` falls back to the last running agent
  and prints it in whatever conversation was busiest.
- **Commit messages in imperative English** — `fix: cancel in-flight catalog fetch on
  dispose`, not `fixed` and not `修复`. Keep the subject under ~72 characters and use
  the body for the why.
