# Changelog

Release notes are curated here before a version tag is pushed. The website keeps published GitHub release history and links to the full notes for each version.

## [1.5.0]

- Make Tauri the primary macOS app with a Rust timer and the system WKWebView. Windows and Linux continue to use Electron with the same React interface and 30 languages.
- Keep timing active while the macOS window is hidden, minimized or closed to the tray, with native idle, screen lock, sleep and meeting handling.
- Import existing Electron settings, journal answers and statistics once from a private copy of its Chromium database. Preserve the original profile and any existing Tauri data.
- Preserve the application identity, native menus, notifications, strict breaks and login startup behavior on macOS.
- Build macOS packages for Apple silicon and Intel with verified bundle metadata and checksums. Current macOS packages remain unsigned and install updates through manual website downloads.
- Keep verified historical Electron macOS feeds and the existing Windows and Linux release and update behavior.

## [1.4.2]

- Notify macOS users about newer releases without requiring Apple Developer signing. The notification opens the Blincho download page; installation remains manual.
- Remember the choice to stop update notifications and background checks across app restarts, while keeping manual checks available.
- Check release metadata with request cancellation, time and size limits, numeric version comparison and architecture matching.
- Clarify update settings and notifications in all 30 interface languages.

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
