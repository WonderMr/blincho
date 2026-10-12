# Changelog

Release notes are curated here before a version tag is pushed. The website keeps published GitHub release history and links to the full notes for each version.

## [1.4.1]

- Launch the Blincho website and desktop app in 30 languages, including Armenian, with automatic detection and a saved manual language choice.
- Add Bengali, Indonesian, Vietnamese, Thai, Persian, Urdu, Hebrew, Dutch, Swedish, Czech, Romanian, Greek, Tamil and Telugu alongside the original 15 languages.
- Support right-to-left pages and app layouts for Arabic, Persian, Urdu and Hebrew, including native menus and notifications.
- Include the compact desktop interface, light/dark/system themes, localized settings and brief activity notifications.
- Ask before downloading updates, with explicit opt-in for automatic downloads and installation at the next app quit. Users can skip a version or disable background checks and prompts, while keeping manual checks available.
- Cancel pending checks, downloads and installation consent when updates are disabled. Keep unsupported packages on the manual download path.
- Publish native macOS, Windows and Linux downloads for Intel/AMD and ARM computers, with SHA-256 checksums and localized release history.
- Show verified signing and update support per download. macOS in-app updates require Developer ID signing and notarization. Windows and Linux lock/sleep behavior has automated coverage but has not been verified on physical hardware.

## Earlier development versions

Earlier versions were developed before this public release process. Their local validation records are not a public release archive. Future published releases remain available in the [GitHub release history](https://github.com/WonderMr/blincho/releases).

Release preparation note: the v1.3.2 build stopped before publication because the Linux AppImage architecture filename differed. The packaging script now normalizes that filename. The v1.3.3 attempt was cancelled before publication to include the expanded language set. Neither tag has public release files.

The v1.4.0 preparation build stopped before publication because a test fixture compared Windows paths with Unix separators. The fixture now uses portable path handling; the existing tag remains unchanged.
