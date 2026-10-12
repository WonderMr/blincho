# Blincho

A free screen-break companion for macOS, Windows and Linux. Every feature is free. Optional donations support development.

Website: https://blincho.app

## What it does

- Reminds you to take short breaks and supports configurable work/break intervals.
- Pauses timing when you are away, the screen locks or the computer sleeps.
- Includes exercises, a personal comfort journal and local statistics.
- Offers 30 languages, automatic language detection, light/dark/system themes and calming color palettes.
- Includes Armenian, Bengali, Indonesian, Vietnamese, Thai, Persian, Urdu, Hebrew, Dutch, Swedish, Czech, Romanian, Greek, Tamil and Telugu alongside the original English, Russian, Spanish, French, German, Italian, Portuguese, Chinese, Japanese, Korean, Arabic, Hindi, Turkish, Polish and Ukrainian.

Blincho is a general wellness tool. It does not diagnose or treat eye conditions. Windows and Linux lock/sleep behavior has automated coverage but has not yet been validated on physical hardware. The download page identifies each package's signing and update support. Operating systems can show publisher warnings for unsigned packages.

## Development

Use Node.js 22.12 or newer.

```sh
npm ci
npm test
npm run build
npm run electron:dev
```

The browser build only sees activity within its own page and pauses when hidden. System-wide activity, lock and sleep integration belongs to the Electron desktop app.

## Website

```sh
npm run site:build
python3 -m http.server 5184 --directory site-dist
```

The static site is generated in 30 languages from `site/locales`. It follows the system theme until a visitor chooses a theme. The only website storage is the language/theme choice. There are no advertising or analytics scripts. Cloudflare hosts the website; GitHub hosts release downloads. Those providers receive ordinary request metadata.

## Releases

See [RELEASE.md](RELEASE.md) for the tag-driven build and publication pipeline. Update the package version, lockfile, changelog and localized release summary together. A pushed `vX.Y.Z` tag builds release packages, publishes checksums and updates the website and desktop update feeds after successful validation. Production deployment requires the configured Cloudflare Actions secret.

Supported desktop packages ask before downloading updates by default. Users can explicitly allow background downloads and installation when they quit Blincho, or turn off background checks and prompts. Manual checks remain available. No update forces an immediate restart. Signed and notarized macOS packages, installed Windows NSIS packages and Linux AppImages support this flow; unsigned macOS, portable Windows and Linux archives use manual downloads.

Primary domain: `blincho.app`. Aliases `blincho.com`, `www.blincho.com` and `www.blincho.app` redirect to it, preserving the path and query.

## Data and compatibility

Settings, journal answers and statistics remain on the device. Unless background update checks are turned off, supported packages contact `blincho.app` for update metadata. Downloads come from GitHub. These requests do not send journal answers or activity history. Existing desktop profiles use the legacy `myeyes` data directory to preserve upgrades. No account is required.

## Contributing

Open an issue with your OS, app version and reproduction steps. Do not include personal journal entries or secrets. Run tests and the build before proposing changes. User-facing text must follow [AGENTS.md](AGENTS.md), including the punctuation rule in every language.

MIT licensed. See [LICENSE](LICENSE).
