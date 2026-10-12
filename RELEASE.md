# Releasing Blincho

The `Release desktop packages and website` GitHub Actions workflow starts when an existing `vX.Y.Z` tag is pushed. It can also be started manually with that tag. The tag must exactly match `package.json` and both root versions in `package-lock.json`. Add a curated `## [X.Y.Z]` section with meaningful bullet points to `CHANGELOG.md` before tagging.

All current desktop releases are **unsigned beta builds**. macOS packages are not notarized. Windows packages have no trusted publisher signature. The GitHub release is marked as a prerelease, and the website exposes this status. A successful package build does not establish that installation or every system integration has been tested on a physical computer.

## Initial repository setup

Use the public repository `WonderMr/blincho`. The scripts intentionally reject a different repository, so a fork cannot accidentally publish downloads under the official name. Merge the release workflow into `main` before tagging that commit. GitHub's built-in workflow token has repository `contents: write` only in the publication job. No personal GitHub token is required.

Enable Actions, permit the pinned official GitHub actions, and allow the release workflow to write repository contents. Configure tag protection or a repository ruleset so only maintainers can create release tags. Avoid moving or reusing a published tag. Release immutability can provide additional protection.

Create these Actions secrets at repository level or in the `production` environment:

| Secret | Required value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | A token scoped to the deployment account and relevant zones using Cloudflare's **Edit Cloudflare Workers** template. It needs Worker deployment access and access to the custom domain routes configured in `wrangler.jsonc`. |
| `CLOUDFLARE_ACCOUNT_ID` | `c5768935c9474bc1c561a7a0868e97ec` |

The Worker is `blincho-site`. Its account and domains must agree with `wrangler.jsonc`; the primary domain is `blincho.app`, with the configured `.com` redirects. A local Wrangler OAuth session is not available inside GitHub Actions. A CI token is required even after a successful local deployment. A missing secret produces an explicit deployment failure; the existing website stays in place and the published desktop release remains available.

If the `production` environment requires approval in repository settings, GitHub pauses there. The workflow does not create an approval requirement by itself. Restrict who can modify the release workflow because it receives deployment credentials in its final step.

## Native packages

Every platform job runs `npm ci`, the test suite and `npm run build`, then uses the installed and locked `electron-builder`. No job cross-compiles another platform or CPU architecture.

| Runner | Architecture | Packages |
| --- | --- | --- |
| `macos-15` | ARM64 | ZIP containing the macOS app |
| `macos-15-intel` | x64 | ZIP containing the macOS app |
| `windows-11-arm` | ARM64 | NSIS installer and portable EXE |
| `windows-2022` | x64 | NSIS installer and portable EXE |
| `ubuntu-24.04-arm` | ARM64 | AppImage and tar.gz |
| `ubuntu-24.04` | x64 | AppImage and tar.gz |

Runner labels are explicit to avoid a moving `latest` OS image. The CPU architecture is checked at runtime. If any runner is unavailable or its packaging tools fail, publication and deployment are blocked. ARM64 packaging, installers, first launch, desktop notifications, tray behavior, session lock and sleep still need real platform checks in addition to CI. Linux desktop behavior depends on the session's logind and idle support as described in the application documentation.

The filename contract is:

```text
Blincho-X.Y.Z-macos-arm64.zip
Blincho-X.Y.Z-macos-x64.zip
Blincho-X.Y.Z-windows-arm64-setup.exe
Blincho-X.Y.Z-windows-arm64-portable.exe
Blincho-X.Y.Z-windows-x64-setup.exe
Blincho-X.Y.Z-windows-x64-portable.exe
Blincho-X.Y.Z-linux-arm64.AppImage
Blincho-X.Y.Z-linux-arm64.tar.gz
Blincho-X.Y.Z-linux-x64.AppImage
Blincho-X.Y.Z-linux-x64.tar.gz
SHA256SUMS.txt
```

Only these ten packages and the checksum document are uploaded. Unpacked apps, build logs and local environment files are excluded. GitHub also supplies its own source code archives.

## Publish a version

For example, after making and reviewing the release changes:

```sh
npm version 1.3.3 --no-git-tag-version
# Edit CHANGELOG.md and commit all intended release changes to main first.
npm test
npm run build
node site/build.mjs
node scripts/release-check.mjs v1.3.3
git tag -a v1.3.3 -m "Blincho 1.3.3 unsigned beta"
git push origin main
git push origin v1.3.3
```

Choose a new version rather than repeating this example after `1.3.3` is released. `npm version` updates both package files. The tag must point at the reviewed commit on the public repository's main branch.

The workflow has four stages:

1. Validate the tag, lockfile and changelog, then test and build the app.
2. Build all six native OS and architecture combinations. All six must succeed.
3. Require the complete ten-package set, calculate SHA-256 checksums, create a draft release, upload files, verify GitHub-reported byte sizes and digests, and publish the draft as an unsigned beta prerelease with curated notes.
4. Read all published GitHub releases with pagination, validate their metadata and checksums, generate `site/releases.json`, build the browser app and website, validate the Worker bundle, then deploy the site and manifest together through Wrangler.

A package failure never reaches publication or deployment. An upload failure leaves a draft that can be resumed. A malformed release or checksum fails manifest generation. The manifest is written through a temporary file and rename after validation, and it is never separately pushed to the live server. A website build or deployment failure leaves the previous live release list intact.

Retry failed jobs from the Actions run after fixing a transient error or adding missing secrets. A full manual retry can also use the same existing tag. Already published packages are checked against their published checksums and are never replaced with a rebuilt archive. A draft is only resumed when its title, notes and beta status match this release. Unexpected drafts or changed published metadata require maintainer review.

The highest numeric `X.Y.Z` is the website's latest version, including unsigned beta prereleases. Publication time does not override version ordering. Releasing or retrying an older tag does not deploy its older website/browser app over a newer release. Older published versions are included on the next current-version deployment. Non-version tags and drafts are excluded. Legacy releases without the new filename convention remain visible through their release page and notes, with no invented downloads or signing claims.

## Manifest contract

`site/releases.json` has `schemaVersion: 1`, an ISO `generatedAt`, `repository`, `latest` and a descending semantic-version `releases` array. Each release has `version`, `tag`, `name`, `publishedAt`, `url`, `prerelease`, `signing`, `notes`, `assets` and `checksumUrl`. `signing` is `unsigned` when the notes explicitly describe an unsigned beta, otherwise `unknown`. Legacy entries may have no recognized assets and `checksumUrl: null`.

Each asset has `name`, `url`, `size`, `platform` (`macos`, `windows`, `linux`), `architecture` (`arm64`, `x64`), `format` (`zip`, `exe`, `AppImage`, `tar.gz`), `kind` (`installer`, `portable`) and a lowercase 64-character `sha256`. Only download URLs for the declared repository, tag and filename are accepted. The current release must include every required download and checksum. Notes are untrusted plain text; website rendering must escape them.

To build a manifest locally after a release is public:

```sh
node scripts/release-manifest.mjs v1.3.3 site/releases.json
npm run build
node site/build.mjs
```

Public reads do not require a GitHub token, although an authenticated `GH_TOKEN` raises API rate limits. Do not commit the token. An HTTP, validation or checksum error stops the process instead of substituting invented release data.

## Signing later

Adding certificates alone will not change these beta packages: `release-package.mjs` explicitly disables certificate discovery, macOS signing/notarization and Windows executable signing. Enabling signed releases requires a reviewed workflow and metadata change, followed by verification on each target platform.

For macOS, prepare an Apple Developer ID Application certificate and private key, its protected CI import material, and the notarization credential method chosen for the build. For Windows, prepare a trusted Authenticode signing service or certificate accessible to the runner. Keep those credentials in restricted Actions secrets or the signing service. Exact secret names should be added alongside the chosen signing integration. Remove unsigned labels and prerelease enforcement only after signatures and notarization are actually verified.

## Validation and reference documentation

Run `node --test tests/release-*.test.cjs` for tag and lockfile matching, curated notes, semantic version sorting, manifest trust boundaries, malformed GitHub metadata, pagination, checksums and complete-package checks. `npm test` also includes this suite. Tests use synthetic release assets; they do not claim that a native installer has launched successfully.

Official references: [GitHub runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [release API](https://docs.github.com/en/rest/releases/releases), [workflow artifacts](https://docs.github.com/en/actions/tutorials/store-and-share-data), and [Cloudflare authentication for GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).
