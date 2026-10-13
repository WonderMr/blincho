# Desktop releases and update feeds

The release pipeline builds native macOS, Windows and Linux packages for x64 and arm64. All six targets use Rust/Tauri from version 1.6.0. Historical versions 1.5.0 through 1.5.3 used Tauri on macOS and Electron on Windows and Linux. Older releases used Electron. `com.myeyes.app` remains the application ID. The package version, npm lockfile, Cargo package version, Tauri configuration and `vX.Y.Z` tag must match. Curated release notes come from that version's `CHANGELOG.md` section.

The publication jobs also launch the exact Windows portable executable, Linux AppImage and extracted macOS archive in isolated profiles before uploading them. These checks verify real packaged WebView startup, history import, hidden timer progression, break expiry and persistence after restart. They still model idle and unlocked presence; physical lock/sleep and notification display remain separate checks.

## Publication

After reviewing and merging the version and changelog, create and push its version tag or dispatch the release workflow on main with that tag. A retry accepts an existing immutable version tag. Never move or recreate an existing tag.

1. Validate versions, the pinned Tauri CLI, changelog, tests and frontend build.
2. Build on six native OS and architecture runners. Each installs Rust 1.92.0 and CMake 3.31.10, checks formatting, and runs locked Cargo checks and tests for its explicit target. Linux installs WebKitGTK 4.1, GTK/tray dependencies, packaging tools and GStreamer. Windows runners must include the matching Visual Studio C++ tools and 7-Zip. Each native job also launches the real renderer with isolated history, checks the hidden timer and break, and verifies restart persistence. Linux smoke uses Xvfb, DBus and Openbox. Its isolated presence state models idle and unlocked status, so this check does not establish physical idle, lock or suspend behavior. All six jobs must succeed.
3. Verify the ten packages and six receipts against their actual bytes. Generate `SHA256SUMS.txt` over all sixteen files, upload a draft, compare GitHub digests and sizes, validate the complete metadata, then publish the beta prerelease.
4. Read published release history, verify checksums and receipts, generate the website manifest and compatible historical Electron feeds, build the localized website, validate the Worker bundle and deploy them together.

A failed build or verification stops publication. A failed upload leaves a draft. Only a matching draft can be resumed. Published assets are never replaced on retry, and their existing checksums, receipts and signing information are verified again. The highest numeric version is latest. Retrying an older tag cannot replace a newer website. Workflow concurrency serializes releases and deployment.

The manual retry for immutable `v1.4.2` repairs one Windows-only test fixture import. Its commit must remain `c77cca3653171ecf84818039ca95913573709b9e`. The `--import` argument changes to a file URL; packaged application sources remain those of the tag. Newer tags do not use this repair.

## Packages and verification

| Current package | Build and verification | Updates |
| --- | --- | --- |
| macOS zip | Locked Cargo build, custom `.app` bundle, plist, native architecture and ad hoc signature checks | Manual |
| Windows setup exe | Tauri NSIS bundler, unpack with 7-Zip, verify embedded native executable and unsigned PE headers | Manual |
| Windows portable exe | The same verified native Rust executable, without an installer | Manual |
| Linux AppImage | Tauri bundler, extract AppDir, verify native executable, AppRun and runtime libraries | Manual |
| Linux tar.gz | Archive the verified AppDir, then extract and verify the final archive's executable | Manual |

Every format retains the existing `Blincho-X.Y.Z-{macos|windows|linux}-{x64|arm64}` filenames. Windows adds `-setup.exe` or `-portable.exe`; Linux uses `.AppImage` or `.tar.gz`; macOS uses `.zip`.

Windows and Linux invoke the npm-locked `@tauri-apps/cli` 2.12.2 with `build --target TARGET --bundles nsis|appimage --ci --no-sign --no-binary-patching -- --locked`. The bundler output directory is removed before building to prevent stale packages from entering the release. `--no-binary-patching` disables Tauri bundle-type mutation; Linux deployment can still adjust ELF library paths. No Tauri updater artifacts or updater plugin are configured.

The build injects a `BLINCHO_RELEASE_METADATA` JSON string. `get_runtime_metadata` returns that compile-time string, keeping the identity, version, OS, architecture and manual update status in the executable. Packaging checks this exact string and native PE/ELF architecture. Windows verifies there is no PE certificate table and compares the extracted NSIS executable with the portable executable. Linux verifies the bundler's deployed AppDir executable and compares extracted AppImage/archive payloads with it. linuxdeploy may adjust ELF library paths during deployment; `NO_STRIP=1` avoids its stripping step and related Ubuntu 24.04 tool incompatibilities.

The Windows NSIS installer itself is x86 even when its application is native arm64. It uses Tauri's WebView2 `downloadBootstrapper` mode when the runtime is absent. The portable executable requires an installed WebView2 runtime. Linux packages are built on Ubuntu 24.04 with WebKitGTK 4.1 and include the bundler's AppDir libraries and media framework. Run `AppRun` from the extracted tar.gz directory. Compatibility with older distributions needs separate testing; packaging does not claim a lower Linux baseline.

macOS runs `cargo build --manifest-path src-tauri/Cargo.toml --release --locked --target TARGET`, then `scripts/bundle-tauri-macos.cjs`. The custom bundle retains the native `blincho` executable and existing application identity. Its plist, `lipo` architecture, and `codesign` integrity checks must pass before `ditto` creates the public ZIP. `Contents/Resources/blincho-runtime.json` must identify the correct release and `runtime: "tauri"`, `packageType: "manual"`, `signed: false`, `notarized: false`, and `updaterConfig: false`.

Ad hoc macOS signing checks integrity without establishing a Developer ID signature or notarization. Current packages are unsigned beta releases on every OS, and every update requires downloading and installing a package manually. Windows SmartScreen or macOS Gatekeeper may warn or block launch. The workflow does not pass signing secrets to Tauri.

## Receipts and manifest

Each job writes `Blincho-X.Y.Z-updates-{darwin|win32|linux}-{x64|arm64}.json`. It identifies version, platform, architecture, application runtime and only that target's packages. Every package record carries its public filename, size, SHA-256, SHA-512, signing and notarization status, and update support.

Tauri receipts require `runtime: "tauri"`, `bundleVerified: true`, `updaterConfig: false`, `packageType: "manual"`, `signed: false`, and `notarized: false`. These requirements apply to macOS from 1.5.0 and every platform from 1.6.0. Earlier Windows/Linux receipts retain their original Electron semantics. The gate requires exactly six receipts, verifies both hashes against package bytes, and includes the receipt bytes in `SHA256SUMS.txt`.

The manifest accepts canonical GitHub asset URLs for `WonderMr/blincho`. Releases from 1.4.0 require all receipt files. Receipt bytes must match both the checksum list and GitHub asset digests; referenced package sizes and SHA-256 must match GitHub metadata. SHA-512 comes from the publication gate's verified package bytes.

`site/releases.json` retains `schemaVersion: 1`, `generatedAt`, `repository`, `latest`, and the descending `releases` array. Each download carries verified `signing`, `updateSupport`, `runtime`, and SHA-512 when a receipt exists. The website uses each download's own status. Older releases remain visible with their actual downloads; missing historical metadata does not invent signing or update support.

## Historical Electron feeds

Each feed selects the highest compatible verified Electron release for its own platform and architecture. Tauri packages never enter these feeds. Windows/Linux feeds can therefore remain on 1.5.3 after 1.6.0, while a signed historical Electron macOS release remains the macOS feed if available. Electron refuses version downgrades. Portable Windows packages and Linux archives never enter feeds.

| Runtime target | Canonical channel path |
| --- | --- |
| macOS x64 / arm64 | `/updates/darwin/{arch}/latest-mac.yml` |
| Windows x64 / arm64 | `/updates/win32/{arch}/latest.yml` |
| Linux x64 | `/updates/linux/x64/latest-linux.yml` |
| Linux arm64 | `/updates/linux/arm64/latest-linux-arm64.yml` |

These filenames match the pinned electron-updater 6.8.9 parser. JSON feed documents are accepted by its YAML parser and carry the exact architecture's URL, size and SHA-512. No blockmap is required or advertised. Keeping these compatible feeds avoids offering a Tauri package to an installed Electron updater. Migration to Tauri is a manual installation.

## Local validation

```sh
node --test tests/release-pipeline.test.cjs tests/update-feed.test.cjs tests/tauri-release.test.cjs tests/tauri-desktop-release.test.cjs tests/release-tag.test.cjs
RELEASE_TAG=v1.6.0 node scripts/release-check.mjs
npm run build
node site/build.mjs
```

Release tests use synthetic executable/package bytes, real archive creation, receipt hashing, and the installed Electron feed parser. They cover all architectures, native build command selection, PE/ELF and metadata failures, payload tampering, historical feed fallback, signing labels and CI dependencies. Tauri bundling, installer extraction and AppImage extraction are stubbed. Native installer and launch checks on Windows/Linux and real six-runner builds remain required before publishing; local tests cannot establish those outcomes.

The manifest command reads real published releases and can use `GH_TOKEN` for read-only GitHub requests. Never commit credentials. Network, schema and digest failures stop generation.
