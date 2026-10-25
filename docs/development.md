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
- A few **long-standing baseline failures** exist in `tests/adapter.spec.ts`,
  `tests/catalog-lifecycle.spec.ts` and `tests/reasoning-merge.spec.ts`. They predate
  the current work, and they are timing-sensitive: the failing cases hit the default
  5 s timeout rather than asserting something wrong, so which of them fails depends
  on the machine. Do not quote pass counts. The rule is simply: **your change must not
  add to the list.** If you fix one, say so in the pull request.

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

The current release line is **1.0.4**. `prepack` guarantees the published tarball is
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
- **Commit messages in imperative English** — `fix: cancel in-flight catalog fetch on
  dispose`, not `fixed` and not `修复`. Keep the subject under ~72 characters and use
  the body for the why.
