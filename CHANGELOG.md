# Changelog

Release notes are curated here before a version tag is pushed. The website keeps published GitHub release history and links to the full notes for each version.

## [1.6.0]

- Move Windows and Linux desktop packages to Tauri and Rust, alongside macOS, on x64 and ARM64.
- Run the shared work and break timer in Rust while the window is hidden or minimized, with native activity, session lock and sleep integration.
- Preserve existing Electron settings and history through a private, one-time import into the system WebView.
- Keep localized tray controls, notifications, strict breaks and login startup on all supported operating systems.
- Publish verified native packages and checksums. Current Tauri packages are unsigned and use manual update installation.
- Preserve compatible historical Electron update feeds for already installed packages.

## [1.5.3]

- Keep the macOS titlebar and document fixed to the native viewport, removing the small whole-window scrollbar when opening the Timer.
- Resize the sidebar with the window and retain scrolling for long pages, short windows and sidebar controls.
- Check native viewport sizing, resize/restore, all five pages and reopening with an isolated WKWebView profile.

## [1.5.2]

- Make macOS package fixtures portable on Windows without relaxing real bundle permission checks.
- Validate the full Node suite and React build on Windows before merging.

## [1.5.1]

- Recover from failed Electron history imports with localized Retry and Continue without history actions, preserving original data and keeping app defaults out of failed imports.
- Preserve manual skipped-version checks when they join a background update request.
- Avoid timer-triggered compatibility exports, clean stale local bundles and bind macOS packages to their explicit Rust architecture.
- Accept an existing release tag after a concurrent creation only when it resolves to the expected commit.

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

The v1.5.0 release was cancelled before publication to handle review findings. Its tag remains unchanged; the corrected release is v1.5.1.

The v1.5.1 release stopped before publication because synthetic macOS package tests assumed POSIX file mode bits on Windows. Its tag remains unchanged; v1.5.2 contains the portable fixtures.
