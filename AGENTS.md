# Blincho

Blincho is a free, open-source screen-break reminder for macOS, Windows and Linux: break timer,
presence and lock/sleep detection, call postponement, exercises, a comfort journal and local
statistics in 30 languages. Desktop apps use Tauri 2 with Rust and the system WebView; the same
React + TypeScript UI also builds as a browser app, and `site/` generates the website
https://blincho.app.
User-facing overview: `README.md`; release pipeline: `RELEASE.md`.

## User-facing text style

This rule covers all user-facing text in every language: notifications, errors, labels, user
documentation, accessibility text, and also the assistant's replies about working with this
repository. The em dash U+2014 and the horizontal bar U+2015 are forbidden; the
en dash U+2013 must not separate parts of a phrase either. Rewrite the phrase naturally with
commas, periods, colons or parentheses; do not just delete the dash or replace it with a spaced
hyphen. The en dash is allowed in numeric ranges and in the established notation of the 20–20–20
rule. Tests enforce this for the UI and website catalogues.

## Layout

- `src/`: React 19 + TypeScript UI shared by every runtime. `App.tsx`, `components/`, `utils/`
  (timer session, activity, meetings, camera presence, storage, `tauriBridge.ts`, `localMcp.ts`),
  `i18n/` (`runtime.ts`, `useI18n.ts`, `locales/<lang>.json`), `styles/`, `audio/`, `data/`.
- `src-tauri/`: Rust desktop app (crate `blincho`). `src/timer.rs` (native timer),
  `src/platform/` (macOS, Windows and Linux presence, lock and sleep), `src/history/` (import from
  the legacy Electron profile), `src/local_mcp.rs`, `src/tray_preview/`, `src/updates.rs`,
  `src/window_session.rs`; `native/*.m` (macOS Objective-C); `locales.json` (tray and menu
  strings); `tauri.conf.json`.
- `public/`: PWA manifest and the offline camera model (`public/camera/`, TensorFlow.js weights
  and WASM backends with `SHA256SUMS.txt`).
- `site/`: website generator (`build.mjs`, `locales/<lang>.json`, `index.html`, `site.js`,
  `style.css`) and the Cloudflare Worker `worker.mjs`; output goes to `site-dist/`.
- `scripts/`: desktop start, macOS bundling, release pipeline (`release-*.mjs`,
  `prepare-release-tag.mjs`, `update-feed.mjs`), Windows CI helpers (`*.ps1`, a `.cpp` probe).
- `tests/`: `*.test.cjs` (run by `npm test`); `tauri-*-smoke.cjs` and `macos-strict-smoke.cjs`
  native smoke tests (CI or explicit scripts); `native/` fixtures; `support/` helpers.
- `.github/workflows/`: `ci.yml` (PRs and `main`: tests, build, site build, six native Tauri
  targets with smoke and package checks) and `release.yml` (tag-driven release and website deploy).

## Setup / Build / Run / Test

Node.js 22.12+ (`engines`). Desktop builds need Rust and CMake; CI pins Rust 1.92.0 and CMake
3.31.10 (CMake 4 breaks the bundled LevelDB dependency). Per-OS prerequisites: `docs/DEVELOPMENT.md`.

```sh
npm ci
npm test                 # node --test tests/*.test.cjs
npm run build            # tsc && vite build, output in dist/
npm start                # Tauri desktop app (runs npm run tauri:dev)
npm run dev              # browser UI on http://127.0.0.1:5173 (strict port)
npm run site:build       # website into site-dist/
npm run tauri:test       # cargo test --locked + tests/historyTransfer.test.cjs
cargo fmt --manifest-path src-tauri/Cargo.toml --check   # CI formatting gate
```

- macOS: `npm run tauri:build:mac`, `tauri:test:mac`, `tauri:test:layout`, `tauri:test:strict`,
  `tauri:test:mcp`. Windows and Linux packages: `tauri:build:win`, `tauri:build:linux`.
- Release checks without publishing: the "Local validation" block in `RELEASE.md`.

## Local MCP client tools

Connecting an AI client needs a running Blincho desktop app with Local MCP enabled and a local
client supporting authenticated Streamable HTTP. Use the URL from Copy connection and supply its
token through `BLINCHO_MCP_TOKEN` in the client process's environment. No separate MCP server
package is needed. See the [Claude Code](docs/LOCAL_MCP.md#claude-code), [Cursor](docs/LOCAL_MCP.md#cursor) and
[Codex](docs/LOCAL_MCP.md#codex) connection examples.

Discover the `blincho` server's tools through the client's MCP tool listing. Clients may prefix
these server tool names. The public contract is:

| Tool | Access | Purpose |
| --- | --- | --- |
| `get_status` | Read | Current timer and break state; check the result of a queued action. |
| `get_settings` | Read | Public app settings. |
| `get_today_stats` | Read | Today's aggregate timer statistics. |
| `get_data_range` | Read | Saved date boundaries and recorded-day count. |
| `get_stats` | Read | Daily or weekly aggregate statistics over an inclusive local-date range. |
| `start_break` | Action | Request a break using the app's configured settings. |
| `pause_timer` | Action | Request pausing the work timer. |
| `resume_timer` | Action | Request resuming the work timer. |
| `skip_break` | Action | Request skipping an eligible, non-strict break. |

No tool requires arguments. Pass `{}` for every tool except `get_stats`, which also accepts
optional `startDate`, `endDate` (`YYYY-MM-DD`), `groupBy` (`day` or `week`), `offset` (default 0)
and `limit` (default 100, range 1 to 366). Unknown properties are rejected. Use `get_data_range`
before a historical query and follow `hasMore` when paginating `get_stats` results.

Use read tools for status or statistics requests. Call action tools only when the user requests
that timer action. An accepted action is queued, not proof of completion: poll `get_status` and
respect the app's presence, exercise, camera and strict-break checks. These tools do not expose
file access, arbitrary commands, settings writes, detailed activity spans, call names, journal
answers or camera frames. Never put connection tokens in documentation, logs or commits.

## Conventions

- Translations are keyed by Russian source text: `t('...')` keys equal the keys of
  `src/i18n/locales/ru.json`. All 30 catalogues must have exactly the same keys, non-empty values,
  the same `{placeholders}` and URLs, and no Cyrillic outside `ru` and `uk`
  (`tests/i18nCatalogs.test.cjs`). Add a new string to every catalogue in the same change.
- Website catalogues `site/locales/<lang>.json` must match the key set of `site/locales/en.json`
  (checked by `site/build.mjs`). Native tray and menu strings live in `src-tauri/locales.json`.
- Versions in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`,
  `src-tauri/tauri.conf.json`, the `CHANGELOG.md` section and the `vX.Y.Z` tag must match. README
  also asks to update the localized release summary with them (`release.<version>` keys in
  `site/locales/`; the newest present is 1.6.0, so confirm before adding one).
- Cargo commands use `--locked`; TypeScript runs in `strict` mode.
- Commit subjects follow Conventional Commits in English (`feat:`, `fix:`, `test:`); changes land on
  `main` through pull requests. Run `npm test` and `npm run build` before proposing changes.

## Gotchas and boundaries

- Keep the application identity `com.myeyes.app` (and the Electron `myeyes` profile): history
  migration and published update feeds depend on it.
- Never move or recreate an existing release tag, and never replace published assets.
- Git-ignored outputs, never commit: `dist/`, `site-dist/`, `release/`, `release-upload/`,
  `src-tauri/target`, `src-tauri/gen`, `site/releases.json`,
  `site/copy-source.json`, `site/DESIGN.txt`, `history.md`, `.env*`, `.dev.vars*`.
- `public/camera/*` and `camera-model/*` are binary and hash-pinned: a model change must update both
  `public/camera/SHA256SUMS.txt` and the hashes in `tests/camera-assets.test.cjs`.
- Privacy guarantees are product requirements: settings, journal and statistics stay on the
  device; camera frames are processed locally and never stored or uploaded; call history keeps
  only times and normalized app names. Local MCP is off by default, binds `127.0.0.1` (port 47831
  preferred), uses a rotating bearer token and may expose daily aggregate totals. It must not expose
  detailed activity spans, call history or names, event IDs, journal answers or frames.
- Blincho is a general wellness tool; do not add text that claims diagnosis or treatment.
- System-wide activity, lock and sleep detection exist only in desktop builds; the browser build
  sees only its own page. CI simulates presence, so physical lock and sleep need manual checks.
- Linux builds need Clang (set in `.cargo/config.toml` for LevelDB); Windows targets link the
  static CRT.
- Website deployment runs in `release.yml` with the `CLOUDFLARE_API_TOKEN` Actions secret
  (`npm run site:deploy` wraps `wrangler deploy`); release manifest generation can use `GH_TOKEN`
  for read-only GitHub requests. Do not deploy, tag or publish unless asked.

## Working with tools

Before displaying metadata, filter the fields and check the result type. Do not load the full
catalogue or shared protocol into context. Parse JSON strings with error handling first; do not
call Object.keys on a string. If a result is truncated, retain the source reference and use a
bounded read instead of displaying the full result again.

Before launching a worker, save worker_context directly from the prepared package without
rewriting it. Verify the file against the original field in the parent's package, pass its path
and checksum, and require the worker to read it in full. The parent must retain the original
contract until every result has been validated.

Before the first coordination request, read the tool-specific instructions and the complete
agents-core://cooperation/schema. Do not construct a request from the argument declaration
alone. If a response is incomplete or unparsed, describe the client limitation rather than
claiming the server is offline, and keep a single writer.

When first exploring code, call tokensave_context according to the server's instructions and
check freshness with tokensave_status({}). Do not pass graph_root for the default project. If
the current branch is not tracked or the index is stale, verify the output against the current
file or a pinned Git object. Do not enable indexing without the owner's request. In a project
indexed by CodeGraph, continue to use CodeGraph first for architecture and relationships.

When first entering a repository, call describe_repo(workspace=<absolute path>). If the response
is needs_summary, complete it through write_repo_summary with the unchanged repo_hash and
workspace_id after checking the sources, provided memory writes are permitted. Before replacing
large historical memory, save a complete copy in the existing recovery directory. After writing,
verify the up-to-date status and preservation of unmanaged sections.

## Pull request workflow entry

When asked to review or merge a pull request, discover the matching workflow with
`list_flows(workspace=<absolute path>)` and call `run_flow` for `builtin:pr-review`
with the target URL, current persona and user constraints before remote merge
mutations. Apply the returned persona activation. If the flow is unavailable,
report that limitation without claiming that the flow ran. Before any merge,
directly verify the repository-required tests and builds (including `npm test`
and `npm run build`), current-head CI, completed required reviews, required
approvals, resolved actionable review findings and threads, mergeability, and
the user's merge authorization. Block the merge if any required gate fails or
cannot be verified.
