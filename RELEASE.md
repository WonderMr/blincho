# Desktop releases and update feeds

The release pipeline builds native macOS, Windows and Linux packages for x64 and arm64. From version 1.5.0, macOS uses Tauri and Windows and Linux retain Electron. `com.myeyes.app` remains the application ID so existing installations retain their identity and data. The package version, lockfile versions and `vX.Y.Z` tag must match. Curated notes come from that version's `CHANGELOG.md` section.

## Publish a version

After reviewing and merging the version and changelog, create and push its version tag. The workflow also accepts an existing version tag for a retry. Do not move or recreate an existing tag.

The manual retry for immutable `v1.4.2` repairs one Windows-only test fixture import before running the complete test suite. Its checked-out commit must remain `c77cca3653171ecf84818039ca95913573709b9e`. Only the test's `--import` argument changes from a filesystem path to a file URL; packaged application sources remain exactly those of the tag. Newer tags already include the portable test fixture and do not use this repair.

1. Validate the tag, lockfile, tests and browser build.
2. Build on six native OS and architecture runners. macOS installs Rust 1.92.0 for its native Apple target and CMake 3.31.10 for the native history migration dependency, checks formatting and runs locked Cargo checks and tests. These tools are needed only to build the app. Windows and Linux build Electron without Rust. All six jobs must succeed.
3. Verify the ten packages and six update receipts against their actual bytes. Generate `SHA256SUMS.txt` over all sixteen files, upload a draft, compare GitHub digests and sizes, validate the complete metadata, then publish the beta prerelease.
4. Read every published release, verify its checksums and receipts, generate the release manifest and generic update feeds, build the localized website, validate the Worker bundle and deploy the site and feeds together.

A failed build or verification stops publication. A failed upload leaves a draft. Only a matching draft can be resumed. Published assets are never replaced on retry; their existing checksums, receipts and signing information are verified again. A signing configuration change therefore does not relabel previously published unsigned packages.

The highest numeric version is latest. Retrying an older tag does not deploy its older website over a newer release. Historical releases remain in the manifest. Older releases without update receipts stay visible with their known downloads and no invented in-app update capability. Unknown historical signing remains unknown at the download level.

## Package support

| Package | In-app updates | Signing label |
| --- | --- | --- |
| macOS Tauri zip | Manual | Unsigned |
| Historical Electron macOS zip with verified Developer ID signature and notarization | Supported | Signed and notarized |
| Historical unsigned Electron macOS zip | Manual | Unsigned |
| Installed Windows NSIS setup | Supported | Unsigned |
| Windows portable executable | Manual | Unsigned |
| Linux AppImage launched as an AppImage | Supported | Unsigned |
| Linux tar.gz | Manual | Unsigned |

Each Windows and Linux target is built separately with `electron/update-support.json` inside its application archive and `resources/app-update.yml` outside it. The support document identifies schema version, runtime platform, architecture, package type and signing status. The runtime also checks that NSIS is installed and that the running Linux package is an AppImage. The portable/archive packages explicitly bundle `manual` support. Generated source support metadata is restored or removed after packaging and is ignored by Git.

## Tauri macOS packaging

The macOS job runs `cargo build --manifest-path src-tauri/Cargo.toml --release --locked` against the checked-out sources, removes any stale bundle, then runs `scripts/bundle-tauri-macos.cjs`. The bundler produces `release/tauri-macos/Blincho.app` with the native `blincho` executable. The release packager checks the Tauri configuration and bundle plist for product name, application identity and release version, verifies the executable architecture with `lipo`, and verifies its ad hoc signature with `codesign`.

`Contents/Resources/blincho-runtime.json` must match the release version and native architecture and identify `runtime: "tauri"`, `platform: "darwin"`, `identifier: "com.myeyes.app"`, `packageType: "manual"`, `signed: false`, `notarized: false` and `updaterConfig: false`, with `schemaVersion: 1`. Missing or altered metadata, invalid signatures or inconsistent plist fields stop packaging. The signed bundle is then archived with `ditto` under the existing `Blincho-X.Y.Z-macos-{x64|arm64}.zip` filenames.

Ad hoc signing checks bundle integrity but does not establish a Developer ID signature or notarization. Current macOS packages therefore remain labeled unsigned and use manual download and installation. The workflow does not pass Apple signing secrets to Tauri. A signed Tauri updater would require a separately designed and verified signing and update pipeline. Historical Electron signing receipts remain valid for their original releases. Windows signing is not configured.

## Receipts and manifest

Each native job writes `Blincho-X.Y.Z-updates-{darwin|win32|linux}-{x64|arm64}.json`. Every receipt identifies its version, runtime platform and architecture and describes only that target's packages: public filename, size, SHA-256, SHA-512, package type and signed/notarized flags. New receipts also identify the application runtime. Tauri macOS receipts require `runtime: "tauri"`, `bundleVerified: true` and `updaterConfig: false`; Electron receipts require verified bundled updater configuration. From 1.5.0, macOS receipts cannot claim Electron runtime, signing, notarization or in-app update support. The publication gate requires exactly six receipts, compares both hashes against local package bytes, and hashes the receipt bytes in `SHA256SUMS.txt` along with the packages.

The manifest builder accepts only canonical `https://github.com/WonderMr/blincho/releases/download/vX.Y.Z/FILENAME` asset URLs. For releases from 1.4.0 onward it downloads every receipt, compares its bytes with both the checksum list and GitHub's asset digest, and requires each referenced package's size and SHA-256 to match GitHub metadata. Package SHA-512 values are established by the byte-level publication gate and carried in the digest-verified receipts. The site build consumes this verified manifest; it does not independently download packages.

`site/releases.json` retains `schemaVersion: 1`, `generatedAt`, `repository`, `latest` and the descending `releases` array. Each download additionally carries `signing` (`signed-notarized`, `unsigned`, `unknown`), `updateSupport` (`mac-signed`, `nsis`, `appimage`, `manual`), application `runtime` and SHA-512 when verified by a receipt. Historical receipts without an explicit runtime identify Electron packages. Release-level signing is `mixed` if any macOS package is signed, `unsigned` if all modern packages are unsigned, or the historical value. Website labels use each download's own status.

## Feed compatibility

Each Electron feed directory selects the highest compatible verified release for its own platform and architecture. Tauri macOS packages never enter Electron feeds. If a later release uses Tauri or is unsigned, an earlier compatible signed Electron macOS feed remains available. The Electron runtime refuses version downgrades. Windows portable and Linux archives never enter feeds.

| Runtime target | Canonical channel path |
| --- | --- |
| macOS x64 / arm64 | `/updates/darwin/{arch}/latest-mac.yml` |
| Windows x64 / arm64 | `/updates/win32/{arch}/latest.yml` |
| Linux x64 | `/updates/linux/x64/latest-linux.yml` |
| Linux arm64 | `/updates/linux/arm64/latest-linux-arm64.yml` |

These names match the installed electron-updater 6.8.9 `Provider.getChannelFilePrefix`. Feed documents use JSON syntax, which its YAML parser accepts, and include version, release date, one exact architecture-specific HTTPS release asset URL, size and SHA-512. The x64 AppImage produced by builder uses `x86_64` internally; packaging renames it to the public `x64` filename before hashing and receipt generation. Feeds refer to the public name.

The updater can fall back to full downloads when differential blockmaps are unavailable. No package blockmap is required or advertised by this pipeline. The shared deployment transaction and workflow concurrency prevent partial feed/site updates and concurrent release deployment races.

## Local checks

```sh
node --test tests/release-pipeline.test.cjs tests/update-feed.test.cjs tests/tauri-release.test.cjs
node scripts/release-manifest.mjs v1.4.1 site/releases.json
npm run build
node site/build.mjs
```

The manifest command requires a real published release. Read-only GitHub requests can use `GH_TOKEN` for rate limits. Do not commit it. A network, schema or digest failure stops generation; missing data is never replaced with invented releases.

Automated tests use synthetic package bytes and the installed updater parser. They cover Tauri bundle metadata and receipt validation, current locked Cargo build commands, both hashes, URL and architecture selection, historical signed Electron fallback, verification failure, feed filenames, release history and CI gates. Native bundle commands are stubbed in these tests. They do not replace macOS launch checks or native installer checks on Windows and Linux.
