# Desktop releases and update feeds

The release pipeline builds native macOS, Windows and Linux packages for x64 and arm64. `com.myeyes.app` remains the application ID so existing installations retain their identity and data. The package version, lockfile versions and `vX.Y.Z` tag must match. Curated notes come from that version's `CHANGELOG.md` section.

## Publish a version

After reviewing and merging the version and changelog, create and push its version tag. The workflow also accepts an existing version tag for a retry. Do not move or recreate an existing tag.

1. Validate the tag, lockfile, tests and browser build.
2. Build on six native OS and architecture runners. All six jobs must succeed.
3. Verify the ten packages and six update receipts against their actual bytes. Generate `SHA256SUMS.txt` over all sixteen files, upload a draft, compare GitHub digests and sizes, validate the complete metadata, then publish the beta prerelease.
4. Read every published release, verify its checksums and receipts, generate the release manifest and generic update feeds, build the localized website, validate the Worker bundle and deploy the site and feeds together.

A failed build or verification stops publication. A failed upload leaves a draft. Only a matching draft can be resumed. Published assets are never replaced on retry; their existing checksums, receipts and signing information are verified again. A signing configuration change therefore does not relabel previously published unsigned packages.

The highest numeric version is latest. Retrying an older tag does not deploy its older website over a newer release. Historical releases remain in the manifest. Older releases without update receipts stay visible with their known downloads and no invented in-app update capability. Unknown historical signing remains unknown at the download level.

## Package support

| Package | In-app updates | Signing label |
| --- | --- | --- |
| macOS zip with verified Developer ID signature and notarization | Supported | Signed and notarized |
| Unsigned macOS zip | Manual | Unsigned |
| Installed Windows NSIS setup | Supported | Unsigned |
| Windows portable executable | Manual | Unsigned |
| Linux AppImage launched as an AppImage | Supported | Unsigned |
| Linux tar.gz | Manual | Unsigned |

Each target is built separately with `electron/update-support.json` inside its application archive and `resources/app-update.yml` outside it. The support document identifies schema version, runtime platform, architecture, package type and signing status. The runtime also checks that NSIS is installed and that the running Linux package is an AppImage. The portable/archive packages explicitly bundle `manual` support. Generated source support metadata is restored or removed after packaging and is ignored by Git.

## Optional macOS signing

Without any of the following secrets the macOS jobs produce an explicitly unsigned beta with manual updates. Providing only some secrets fails the job. Supply all six through GitHub Actions secrets to enable signing:

| Secret | Value |
| --- | --- |
| `MAC_CSC_LINK` | Existing Developer ID Application certificate and private key exported as password-protected PKCS#12, encoded as base64 |
| `MAC_CSC_KEY_PASSWORD` | Password protecting that certificate export |
| `MAC_SIGNING_IDENTITY` | Certificate owner qualifier, including team when needed, without the `Developer ID Application:` prefix |
| `APPLE_ID` | Apple account used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | Existing app-specific notarization password |
| `APPLE_TEAM_ID` | Ten-character Apple Developer team ID |

These inputs reach only the macOS packaging step. Certificate auto-discovery is disabled; signing uses the specified identity, requires distribution signing and enables hardened runtime and notarization with the installed electron-builder 26 API. Credentials are never printed or stored in a release receipt. This workflow does not create accounts, certificates, keys or API credentials.

After signing and notarization, and before zip creation, the job requires `codesign --verify --deep --strict`, a Developer ID authority matching the configured team and hardened runtime, `xcrun stapler validate`, and Gatekeeper assessment. Failure stops packaging. The provisional signed support flag cannot reach publication without these checks. Signed macOS packages do not imply that Windows or Linux packages are signed. Windows signing is not configured.

## Receipts and manifest

Each native job writes `Blincho-X.Y.Z-updates-{darwin|win32|linux}-{x64|arm64}.json`. Every receipt identifies its version, runtime platform and architecture and describes only that target's packages: public filename, size, SHA-256, SHA-512, package type, signed/notarized flags and verified bundled updater configuration. The publication gate requires exactly six receipts, compares both hashes against local package bytes, and hashes the receipt bytes in `SHA256SUMS.txt` along with the packages.

The manifest builder accepts only canonical `https://github.com/WonderMr/blincho/releases/download/vX.Y.Z/FILENAME` asset URLs. For releases from 1.4.0 onward it downloads every receipt, compares its bytes with both the checksum list and GitHub's asset digest, and requires each referenced package's size and SHA-256 to match GitHub metadata. Package SHA-512 values are established by the byte-level publication gate and carried in the digest-verified receipts. The site build consumes this verified manifest; it does not independently download packages.

`site/releases.json` retains `schemaVersion: 1`, `generatedAt`, `repository`, `latest` and the descending `releases` array. Each download additionally carries `signing` (`signed-notarized`, `unsigned`, `unknown`), `updateSupport` (`mac-signed`, `nsis`, `appimage`, `manual`) and SHA-512 when verified by a receipt. Release-level signing is `mixed` if any macOS package is signed, `unsigned` if all modern packages are unsigned, or the historical value. Website labels use each download's own status.

## Feed compatibility

Each feed directory selects the highest compatible verified release for its own platform and architecture. Unsigned macOS packages never enter a macOS update feed. If a later release is unsigned, an earlier compatible signed macOS feed remains available. The runtime refuses version downgrades. Windows portable and Linux archives never enter feeds.

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
node --test tests/release-pipeline.test.cjs tests/update-feed.test.cjs
node scripts/release-manifest.mjs v1.4.1 site/releases.json
npm run build
node site/build.mjs
```

The manifest command requires a real published release. Read-only GitHub requests can use `GH_TOKEN` for rate limits. Do not commit it. A network, schema or digest failure stops generation; missing data is never replaced with invented releases.

Automated tests use synthetic package bytes and the installed updater parser. They cover missing/tampered metadata, both hashes, URL and architecture selection, unsigned fallback, partial signing credentials, verification failure, feed filenames, release history and CI gates. They do not replace native installer launch checks or a real signed and notarized release. Signing and notarization require valid credentials and successful CI runs.
