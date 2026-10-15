# Desktop releases and update feeds

The release pipeline builds native macOS, Windows and Linux packages for x64 and arm64. All six targets use Rust/Tauri from version 1.6.0. Historical versions 1.5.0 through 1.5.3 used Tauri on macOS and Electron on Windows and Linux. Older releases used Electron. `com.myeyes.app` remains the application ID. The package version, npm lockfile, Cargo package version, Tauri configuration and `vX.Y.Z` tag must match. Curated release notes come from that version's `CHANGELOG.md` section.

The publication jobs also launch the exact Windows portable executable, Linux AppImage and extracted macOS archive in isolated profiles before uploading them. These checks verify real packaged WebView startup, history import, hidden timer progression, break expiry and persistence after restart. They still model idle and unlocked presence; physical lock/sleep and notification display remain separate checks.

## Publication

After reviewing and merging the version and changelog, create and push its version tag or dispatch the release workflow on main with that tag. A retry accepts an existing immutable version tag. Never move or recreate an existing tag.

1. Validate versions, the pinned Tauri CLI, changelog, tests and frontend build.
2. Build on six native OS and architecture runners. Each installs Rust 1.92.0 and CMake 3.31.10, checks formatting, and runs locked Cargo checks and tests for its explicit target. Linux installs WebKitGTK 4.1, GTK/tray dependencies, packaging tools and GStreamer. Windows runners must include the matching Visual Studio C++ tools and 7-Zip. Each native job also launches the real renderer with isolated history, checks the hidden timer and break, and verifies restart persistence. Linux smoke uses Xvfb, DBus and Openbox. Its isolated presence state models idle and unlocked status, so this check does not establish physical idle, lock or suspend behavior. All six jobs must succeed.
3. Verify the fourteen distinct packages, six compatibility aliases and six receipts against their actual bytes. Generate `SHA256SUMS.txt` over all twenty-six files, upload a draft with twenty-seven assets including the checksum document, compare GitHub digests and sizes, validate the complete metadata, then publish the beta prerelease. Releases through 1.6.0 retain sixteen files.
4. Read published release history, verify checksums and receipts, generate the website manifest and compatible historical Electron feeds, build the localized website, validate the Worker bundle and deploy them together.

A failed build or verification stops publication. A failed upload leaves a draft. Only a matching draft can be resumed. Published assets are never replaced on retry, and their existing checksums, receipts and signing information are verified again. The highest numeric version is latest. Retrying an older tag cannot replace a newer website. Workflow concurrency serializes releases and deployment.

The manual retry for immutable `v1.4.2` repairs one Windows-only test fixture import. Its commit must remain `c77cca3653171ecf84818039ca95913573709b9e`. The `--import` argument changes to a file URL; packaged application sources remain those of the tag. Newer tags do not use this repair.

## Windows CI notification area

Windows desktop preparation normally requires `Shell_NotifyIconW` add, tooltip update and delete operations to succeed. The GitHub Actions ARM64 Windows image can reject `NIM_ADD` even with Explorer and its responsive taskbar in the runner's session. `scripts/prepare-windows-desktop.ps1` permits `-AllowUnavailableNotificationArea` only on that ARM64 CI environment. Before accepting the exception, it compiles and runs the independent native Windows SDK probe on the same VM. The probe must confirm the expected 976-byte ARM64 `NOTIFYICONDATAW` layout, a responsive taskbar, and rejection of all four add variants both initially and after message pumping. Missing evidence or any other desktop preparation failure stops the job. The probe results do not establish the cause of the rejection.

Preparation passes a SHA-256-bound JSON proof in `RUNNER_TEMP` through `GITHUB_ENV`. Both actual call smoke tests validate its machine, runner session, workflow job, run, attempt, commit, timestamp and probe source hashes, then recheck the SDK layout, responsive taskbar and all four failures. A platform or environment flag alone cannot relax icon assertions. If native icon updates succeed after preparation, their successful active and restored transitions remain required. If they return the observed Windows error `-2147467259`, the tests require failed attempt counters, zero successful updates, cleared errors after call end or detection disable, and cooldown behavior. The result reports unavailable native display separately from passing call logic.

Tooltip checks accept only that same native error with the same independently verified SDK proof, and report their native display state as unverified. On working notification areas they require successful tooltip suppression while the hover window exists, text fallback when it is unavailable, and suppression again after recovery.

This exception leaves notification-area display unverified. Live calls with history off, inactive and disabled detection, native hover popups and focus guards, real renderer, history, hidden timer, break expiry, restart persistence, autostart and release-package launch checks must still pass. CI presence is simulated, so physical idle, lock and suspend behavior and visible tray/notification behavior require separate desktop verification.

## Packages and verification

| Current package | Build and verification | Updates |
| --- | --- | --- |
| macOS zip | Locked Cargo build, custom `.app` bundle, plist, native architecture and ad hoc signature checks | Manual |
| Windows setup exe | Tauri NSIS bundler, unpack with 7-Zip, verify embedded native executable and unsigned PE headers | Manual |
| Windows portable exe | The same verified native Rust executable, without an installer | Manual |
| Linux AppImage | Tauri bundler, extract AppDir, verify native executable, AppRun and runtime libraries | Manual |
| Linux tar.gz | Archive the verified AppDir, then extract and verify the final archive's executable | Manual |
| Linux deb | Tauri Debian installer, inspect with dpkg-deb, extract and verify the native executable, desktop entry, icons and dependencies | Manual |
| Linux rpm | Tauri RPM installer, inspect RPM metadata and requirements, extract with bsdtar and verify the native executable, desktop entry, icons and dependencies | Manual |

From 1.6.1, downloads use `Blincho-Screen-Breaks-X.Y.Z-{macOS|Windows|Linux}-{x64|ARM64}-{Setup|Portable}`. Windows installers end in `-Setup.exe`; Windows standalone applications end in `-Portable.exe`. macOS archives end in `-Portable.zip`; portable Linux packages end in `-Portable.AppImage` or `-Portable.tar.gz`. Linux installers end in `-Setup.deb` or `-Setup.rpm`, for example `Blincho-Screen-Breaks-1.6.1-Linux-ARM64-Setup.deb`. Both installer formats are available for x64 and ARM64 and require manual installation. Names contain only ASCII letters, digits, periods and hyphens, so they remain safe in download folders, checksum documents and URLs.

Published releases through 1.6.0 retain their exact `Blincho-X.Y.Z-{macos|windows|linux}-{x64|arm64}` filenames. From 1.6.1, the manifest and receipt validators require the complete descriptive package set, including Debian/RPM installers and six compatibility aliases. New releases include identical legacy aliases for the macOS ZIP, Windows setup EXE and Linux AppImage on each architecture, because published native clients check for those exact names. Debian and RPM installers have only their descriptive filenames. The website shows fourteen distinct descriptive downloads. Receipts keep their existing JSON filenames, record both package names where an alias exists and require matching alias hashes and sizes. Historical packages and update feeds are never renamed.

Windows and Linux invoke the npm-locked `@tauri-apps/cli` 2.12.2 with `build --target TARGET --bundles BUNDLES --ci --no-sign --no-binary-patching -- --locked`. Windows uses `nsis`; Linux uses `appimage,deb,rpm` from 1.6.1 and `appimage` on 1.6.0. Linux CI installs `rpm` and `libarchive-tools` for package inspection and extraction. The bundler output directory is removed before building to prevent stale packages from entering the release. `--no-binary-patching` disables Tauri bundle-type mutation; Linux deployment can still adjust ELF library paths. No Tauri updater artifacts or updater plugin are configured.

The build injects a `BLINCHO_RELEASE_METADATA` JSON string. `get_runtime_metadata` returns that compile-time string, keeping the identity, version, OS, architecture and manual update status in the executable. Packaging checks this exact string and native PE/ELF architecture. Windows verifies there is no PE certificate table and compares the extracted NSIS executable with the portable executable. Linux verifies the bundler's deployed AppDir executable and compares extracted AppImage/archive payloads with it. linuxdeploy may adjust ELF library paths during deployment; `NO_STRIP=1` avoids its stripping step and related Ubuntu 24.04 tool incompatibilities.

The Windows NSIS installer itself is x86 even when its application is native arm64. It uses Tauri's WebView2 `downloadBootstrapper` mode when the runtime is absent. The portable executable requires an installed WebView2 runtime. Linux packages are built on Ubuntu 24.04 with WebKitGTK 4.1. AppImage and tar.gz include the bundler's AppDir libraries and media framework; run `AppRun` from the extracted tar.gz directory. Debian and RPM install the native executable under `usr/bin/blincho`, with a desktop entry and icons. They depend on the distribution's WebKitGTK, GTK, tray libraries and GStreamer base/good plugins instead of bundling the AppDir library set. Compatibility with older distributions needs separate testing; packaging does not claim a lower Linux baseline.

macOS runs `cargo build --manifest-path src-tauri/Cargo.toml --release --locked --target TARGET`, then `scripts/bundle-tauri-macos.cjs`. The custom bundle retains the native `blincho` executable and existing application identity. Its plist, `lipo` architecture, and `codesign` integrity checks must pass before `ditto` creates the public ZIP. `Contents/Resources/blincho-runtime.json` must identify the correct release and `runtime: "tauri"`, `packageType: "manual"`, `signed: false`, `notarized: false`, and `updaterConfig: false`.

Ad hoc macOS signing checks integrity without establishing a Developer ID signature or notarization. Current packages are unsigned beta releases on every OS, and every update requires downloading and installing a package manually. Windows SmartScreen or macOS Gatekeeper may warn or block launch. The workflow does not pass signing secrets to Tauri.

## Receipts and manifest

Each job writes `Blincho-X.Y.Z-updates-{darwin|win32|linux}-{x64|arm64}.json`. It identifies version, platform, architecture, application runtime and only that target's packages. Every package record carries its public filename, size, SHA-256, SHA-512, signing and notarization status, and update support.

Tauri receipts require `runtime: "tauri"`, `bundleVerified: true`, `updaterConfig: false`, `packageType: "manual"`, `signed: false`, and `notarized: false`. These requirements apply to macOS from 1.5.0 and every platform from 1.6.0. Earlier Windows/Linux receipts retain their original Electron semantics. The gate requires exactly six receipts, verifies both hashes against package bytes, and includes the receipt bytes in `SHA256SUMS.txt`.

The manifest accepts canonical GitHub asset URLs for `WonderMr/blincho`. Releases from 1.4.0 require all receipt files. Receipt bytes must match both the checksum list and GitHub asset digests; referenced package sizes and SHA-256 must match GitHub metadata. SHA-512 comes from the publication gate's verified package bytes.

`site/releases.json` retains `schemaVersion: 1`, `generatedAt`, `repository`, `latest`, and the descending `releases` array. Each download carries verified `signing`, `updateSupport`, `runtime`, and SHA-512 when a receipt exists. The website uses each download's own status. Older releases remain visible with their actual downloads; missing historical metadata does not invent signing or update support.

## Historical Electron feeds

Each feed selects the highest compatible verified Electron release for its own platform and architecture. Tauri packages never enter these feeds. Windows/Linux feeds can therefore remain on 1.5.3 after 1.6.0, while a signed historical Electron macOS release remains the macOS feed if available. Electron refuses version downgrades. Portable Windows packages, Linux archives and Debian/RPM installers never enter feeds.

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
RELEASE_TAG=v1.6.1 node scripts/release-check.mjs
npm run build
node site/build.mjs
```

Release tests use synthetic executable/package bytes, real archive creation, receipt hashing, and the installed Electron feed parser. They cover all architectures, native build command selection, PE/ELF and metadata failures, payload tampering, complete Debian/RPM receipt and checksum coverage, historical feed fallback, fourteen canonical website downloads, signing labels and CI dependencies. Tauri bundling, installer extraction and AppImage extraction are stubbed. Native installer and launch checks on Windows/Linux and real six-runner builds remain required before publishing; local tests cannot establish those outcomes.

The manifest command reads real published releases and can use `GH_TOKEN` for read-only GitHub requests. Never commit credentials. Network, schema and digest failures stop generation.
