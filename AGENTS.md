# Blincho

Blincho is a free, open-source screen-break reminder for macOS, Windows and Linux: break timer,
presence and lock/sleep detection, call postponement, exercises, a comfort journal and local
statistics in 30 languages. Desktop apps use Tauri 2 with Rust and the system WebView; the same
React + TypeScript UI also builds as a browser app, and `site/` generates the website
https://blincho.app. Version 1.8.14, under active development (last commit 2026-10-17).
User-facing overview: `README.md`; release pipeline: `RELEASE.md`.

## User-facing text style

This rule covers all user-facing text in every language: notifications, errors, labels, user
documentation, accessibility text, and also the assistant's replies about working with this
repository. English rendering: the em dash U+2014 and the horizontal bar U+2015 are forbidden; the
en dash U+2013 must not separate parts of a phrase either. Rewrite the phrase naturally with
commas, periods, colons or parentheses; do not just delete the dash or replace it with a spaced
hyphen. The en dash is allowed in numeric ranges and in the established notation of the 20–20–20
rule. Tests enforce this for the UI and website catalogues.

### Original wording (Russian, authoritative)

Во всех языках интерфейса запрещены длинные тире U+2014 (EM DASH) и U+2015 (HORIZONTAL BAR). Правило распространяется на весь пользовательский текст приложения: уведомления, ошибки, подписи, пользовательскую документацию, текст для специальных возможностей, а также ответы ассистента о работе с этим репозиторием. Среднее тире U+2013 (EN DASH) также нельзя использовать как разделитель частей фразы.

Переписывайте фразы естественно, используя запятые, точки, двоеточия или скобки. Не удаляйте тире механически и не заменяйте его дефисом с пробелами.

Среднее тире в числовых диапазонах и устоявшемся обозначении правила 20–20–20 разрешено.

## Layout

- `src/`: React 19 + TypeScript UI shared by every runtime. `App.tsx`, `components/`, `utils/`
  (timer session, activity, meetings, camera presence, storage, `tauriBridge.ts`, `localMcp.ts`),
  `i18n/` (`runtime.ts`, `useI18n.ts`, `locales/<lang>.json`), `styles/`, `audio/`, `data/`.
- `src-tauri/`: Rust desktop app (crate `blincho`). `src/timer.rs` (native timer),
  `src/platform/` (macOS, Windows and Linux presence, lock and sleep), `src/history/` (import from
  the legacy Electron profile), `src/local_mcp.rs`, `src/tray_preview/`, `src/updates.rs`,
  `src/window_session.rs`; `native/*.m` (macOS Objective-C); `locales.json` (tray and menu
  strings); `tauri.conf.json`.
- `electron/`: legacy Electron runtime (`main.cjs` is the npm `main`), kept for `electron:*` scripts
  and historical update feeds.
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
3.31.10 (CMake 4 breaks the bundled LevelDB dependency). Per-OS prerequisites: README "Development".

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
- Electron (legacy): `npm run electron:dev`, `electron:build`, `electron:build:<mac|win|linux>`.
- Release checks without publishing: the "Local validation" block in `RELEASE.md`.

## Conventions

- Translations are keyed by Russian source text: `t('...')` keys equal the keys of
  `src/i18n/locales/ru.json`. All 30 catalogues must have exactly the same keys, non-empty values,
  the same `{placeholders}` and URLs, and no Cyrillic outside `ru` and `uk`
  (`tests/i18nCatalogs.test.cjs`). Add a new string to every catalogue in the same change.
- Website catalogues `site/locales/<lang>.json` must match the key set of `site/locales/en.json`
  (checked by `site/build.mjs`). Native tray and menu strings live in `src-tauri/locales.json`,
  Electron strings in `electron/locales.cjs`.
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
  `src-tauri/target`, `src-tauri/gen`, `electron/update-support.json`, `site/releases.json`,
  `site/copy-source.json`, `site/DESIGN.txt`, `history.md`, `.env*`, `.dev.vars*`.
- `public/camera/*` is binary and hash-pinned: a model change must update both
  `public/camera/SHA256SUMS.txt` and the hashes in `tests/camera-assets.test.cjs`.
- Privacy guarantees are product requirements: settings, journal and statistics stay on the
  device; camera frames are processed locally and never stored or uploaded; call history keeps
  only times and normalized app names. Local MCP is off by default, binds `127.0.0.1` (port 47831
  preferred), uses a rotating bearer token and must not expose history, journal answers or frames.
- Blincho is a general wellness tool; do not add text that claims diagnosis or treatment.
- System-wide activity, lock and sleep detection exist only in desktop builds; the browser build
  sees only its own page. CI simulates presence, so physical lock and sleep need manual checks.
- Linux builds need Clang (set in `.cargo/config.toml` for LevelDB); Windows targets link the
  static CRT.
- Website deployment runs in `release.yml` with the `CLOUDFLARE_API_TOKEN` Actions secret
  (`npm run site:deploy` wraps `wrangler deploy`); release manifest generation can use `GH_TOKEN`
  for read-only GitHub requests. Do not deploy, tag or publish unless asked.

## Выполнение задач с инструментами

Перед выводом метаданных фильтруйте поля и проверяйте тип результата. Не передавайте полный каталог или общий протокол в контекст. Для строкового JSON сначала выполните разбор с обработкой ошибки; не вызывайте Object.keys на строке. Если результат усечён, сохраните ссылку на источник и используйте ограниченное чтение вместо повторного полного вывода.

Перед запуском исполнителя сохраняйте worker_context непосредственно из подготовленного пакета без переписывания. Сверяйте файл с исходным полем родительского пакета, передавайте путь и контрольную сумму, требуйте полного чтения. Исходный contract остаётся у родителя до проверки каждого результата.

Перед первым запросом координации прочитайте специфическую инструкцию инструмента и полную agents-core://cooperation/schema. Не составляйте запрос по одному объявлению аргументов. При неполном или неразобранном ответе не называйте сервер отключённым: укажите ограничение клиента и сохраняйте одного исполнителя записи.

При первом исследовании кода вызовите tokensave_context по инструкции сервера и проверьте свежесть через tokensave_status({}). Для проекта по умолчанию не передавайте graph_root. Если текущая ветка не отслеживается или индекс устарел, проверьте вывод по текущему файлу либо закреплённому Git-объекту. Не включайте индексацию без запроса владельца. В индексированном CodeGraph проекте продолжайте соблюдать его первоочередное использование для архитектуры и связей.

При первом входе в репозиторий вызовите describe_repo(workspace=<абсолютный путь>). Ответ needs_summary завершайте через write_repo_summary с неизменными repo_hash и workspace_id после проверки источников, если запись памяти разрешена. Перед заменой большой исторической памяти сохраните её полную копию в существующем recovery. После записи проверьте up-to-date и сохранность неуправляемых разделов.
