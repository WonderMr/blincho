# Changelog

Release notes are curated here before a version tag is pushed. The website keeps published GitHub release history and links to the full notes for each version.

## [1.8.1]

### Improved

- Use a narrower sidebar and tighter, consistent spacing across the main views. Keep navigation controls fully visible, including settings and sound at the minimum desktop window size.
- Adapt statistics to the available content width, with readable metric columns and a date selector that stays inside the page. Preserve translated labels and comfortable control sizes.
- Drag the native desktop window from empty areas of the sidebar, page margins and cards. Keep controls, text selection, scrolling and modal interactions available.

## [1.8.0]

### Added

- Check for a person with the camera at the end of a work interval and lock the desktop session after three distinct healthy frames without a detected person. The new setting is disabled by default. Manually enabling it immediately checks camera access and requests permission when needed; denied or unavailable access leaves it off.
- Process camera frames locally with a bundled person-detection model. Frames are not saved or uploaded; camera access ends after each check. Missing cameras, denied permission, unusable frames and failed checks skip locking and preserve the ordinary reminder.
- Expose session locking on macOS, Windows and Linux, verify the lock state, and translate the new controls into all 30 languages. Browser-only use does not lock the operating system.

## [1.7.3]

### Added

- Mark a currently detected call with a phone badge on the tray icon and show its application in the macOS and Windows hover preview. Linux shows the same call status in its tray menu. Restore the usual icon when the call ends or detection becomes unavailable.
- Show translated active, inactive, unavailable and disabled call states in all 30 languages. Keep the call row separate from the next-break countdown and pause, break and exercise phases.
- Refresh transient call status while break postponement or voluntary call history is enabled, including input-idle and manual pauses. Keep history off by default, reject stale detector results and clear the indicator on screen lock or sleep.

## [1.7.2]

### Added

- Show detected calls in daily statistics with their application, observed start and end, duration, per-app timelines and totals, average and longest call, and weekly call time.
- Record calls in the native background timer while the window is hidden, the timer is manually paused or strict mode is enabled. Keep call history locally across restarts and local midnight, and count overlapping calls only once in total elapsed time.
- Attribute detected calls to normalized desktop or browser application names on macOS, Windows and Linux. Localize call statistics in all 30 supported languages. Call detection uses approximate system signals and does not record conversation contents.
- Keep call history off by default with a separate opt-in switch, independent from postponing breaks during calls. Explain which local data is stored and provide call-history deletion without removing work, break, exercise or journal history.

## [1.7.1]

### Added

- Hover over the macOS or Windows tray icon to see the next break countdown and today's recorded work time and completed breaks, without interrupting the foreground application. Linux tray menus show the same live summary.
- Explore daily activity timelines with recorded work, inactivity, screen lock, sleep, manual pause, breaks and exercises. Select previous days and inspect exact intervals, first and last work, and average and longest work sessions.
- Compare weekly averages per calendar day and per day of use. Preserve older totals and explicitly identify hours without detailed records.
- Keep activity history locally, split observations and focus across local midnight, and distinguish unconfirmed time and future hours. Localize the new statistics in all 30 supported languages.

### Fixed

- Retry macOS strict-break focus while native window deminiaturization is pending, and stop requests at the real break deadline or an absence.
- Restore a minimized macOS main window when reopening from the Dock, including while its tray preview is visible.

## [1.6.4]

### Fixed

- macOS removes the Dock icon when Blincho is hidden in the tray and restores it when its window opens, including break completion and hidden startup. Native minimized windows retain their Dock entry.
- Rapid reopen and hide transitions preserve tray state, window placement and the working application focus.

## [1.6.3]

- Return to the previous tray-hidden, minimized or visible window state when a screen break ends or is cancelled.
- Restore the previous work application's focus on macOS, Windows and supported Linux X11 desktops when Blincho still owns the foreground.
- Preserve a newly chosen application or an explicitly started exercise and check real 20-second breaks with native focus fixtures.

## [1.6.2]

- Restore the previous monitor, window position and size after screen lock or sleep on macOS, Windows and Linux.
- Keep tray-hidden and minimized windows in the background after returning, without stealing focus.
- Preserve normal and maximized window placement across overlapping lock and sleep, display scale changes and interrupted fullscreen breaks.
- Use an accessible screen when the original monitor is disconnected and check window restoration in native desktop tests.

## [1.6.1]

- Keep strict macOS breaks above other applications' fullscreen Spaces and consume fresh scroll input with temporary native shield panels.
- Restore window presentation after the break deadline or cancellation and refresh shields when display geometry changes.
- Give downloads descriptive product, platform, architecture and package names while retaining compatibility links for existing update clients.
- Add Linux Debian and RPM installers for x64 and ARM64, with verified receipts, checksums and manual installation.

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
