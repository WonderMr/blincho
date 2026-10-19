# Blincho

A free screen-break companion for macOS, Windows and Linux. Every feature is free.

Blincho is an open-source break reminder for people who spend long hours at a computer. It reminds you to take short screen breaks and rest your eyes (for example with the 20-20-20 rule), offers short exercises, pauses when you step away and keeps work-time statistics on your device. No account is required.

From version 1.6.0, all desktop apps use Tauri, Rust and the system WebView (WKWebView on macOS, WebView2 on Windows and WebKitGTK on Linux). All desktop versions share the same React interface, local statistics and 30 languages.

Website: https://blincho.app

## What it does

- Reminds you to take short breaks and supports configurable work/break intervals.
- Pauses timing when you are away, the screen locks or the computer sleeps.
- Can check for a person with the camera after a timed break finishes, locking the computer if no one is detected. Disabled by default. Enabling it in desktop Settings immediately checks camera access and requests permission when needed. Denied or unavailable access leaves the setting off. Frames are processed locally, never saved or uploaded. The camera turns off after each check. An unavailable check skips locking and preserves normal timer behavior.
- Optional enhanced presence checks start after one minute without keyboard or mouse input when a fresh system call check confirms no call. A short camera check keeps reading time active when a person is present. Confirmed absence pauses work, with a separate opt-in to lock the session. New input, calls, sleep and settings changes invalidate pending decisions. Unknown camera results fall back to input-idle handling and never lock. The mode requires the native app, camera support and a supported call detector.
- Optional input statistics keep only key-down, click, scroll and mouse-motion event counts in five-minute intervals, with a daily chart and local CSV export. No text, key identities, apps, coordinates or individual event timestamps are recorded. macOS requires Input Monitoring permission; Windows uses passive hooks; Linux requires a native X11 session with XInput2. Wayland and browser builds report unsupported. Counts depend on device and OS event delivery, including repeat and scrolling behavior, and do not provide medical diagnoses. Collection is off by default and can be disabled independently. Deleting input statistics leaves other history intact. Detailed input buckets are excluded from Local MCP.
- Keeps the desktop timer running in Rust when the window is hidden or minimized.
- When call postponement is enabled, detected calls delay automatic breaks by five minutes, including in strict mode. Blincho checks again at the next deadline; strict break behavior resumes when the call is no longer detected.
- Restores the window on its previous monitor after lock or sleep, keeping hidden and minimized windows in the background. If that monitor is disconnected, the window returns to an available screen.
- Includes exercises, a personal comfort journal and local statistics.
- Uses a compact sidebar with fully visible controls and statistics that adapt to the available content width. Drag the native desktop window from empty page or sidebar space while retaining text selection, scrolling and controls.
- Shows a small tray preview with the next break countdown, recorded work time, completed breaks and current call status on macOS and Windows. A phone badge marks a detected call on the tray icon. Linux exposes the live summary and call application in its tray menu.
- Records daily work, absence, lock, sleep, manual pauses and rest intervals locally. Browse previous days, average and longest work intervals, and weekly averages per calendar day or day of use. Older totals stay available; missing time records remain unknown.
- Optionally records detected calls with their application, observed start/end and duration after you enable call history. Browse daily call lanes and per-app totals, average call lengths and weekly call time. Browser calls identify the browser; detection is approximate.
- Adapts the Blinchiborg character and localized build name to six optional features, with 64 combinations. In Settings, choose Create shortcut to add a desktop shortcut whose name and icon follow the build. macOS uses a separate .blincho document, preserving the signed app; Windows uses .lnk and Linux uses .desktop.
- Offers 30 languages, automatic language detection, light/dark/system themes and calming color palettes.
- Includes Armenian, Bengali, Indonesian, Vietnamese, Thai, Persian, Urdu, Hebrew, Dutch, Swedish, Czech, Romanian, Greek, Tamil and Telugu alongside the original English, Russian, Spanish, French, German, Italian, Portuguese, Chinese, Japanese, Korean, Arabic, Hindi, Turkish, Polish and Ukrainian.

Blincho is a general wellness tool. It does not diagnose or treat eye conditions. Windows and Linux lock/sleep behavior has automated coverage but has not yet been validated on physical hardware. The download page identifies each package's signing and update support. Operating systems can show publisher warnings for unsigned packages.

Camera use is identified by a camera badge on Blincho's tray icon and a localized label. It follows live capture, including presence checks and permission probes, and clears when the final stream is released.

## Development

Use Node.js 22.12 or newer. Desktop builds need Rust and CMake. macOS also needs Xcode Command Line Tools. Windows needs the MSVC build tools and WebView2. With Visual Studio 2026 on Windows ARM64, install Ninja and set `CMAKE_GENERATOR=Ninja` when using the pinned CMake version. Linux needs Clang, WebKitGTK 4.1, GTK 3, AppIndicator, X11/Xss and D-Bus development libraries. Linux packages use the Ubuntu 24.04 build baseline. Portable Windows packages require an installed WebView2 runtime. CI pins Rust 1.92.0 and CMake 3.31.10; CMake 4 is incompatible with the bundled LevelDB history migration dependency. The macOS bundle targets macOS 14 or newer. Release builds select `aarch64-apple-darwin` for ARM64 or `x86_64-apple-darwin` for Intel explicitly and verify the packaged executable architecture.

```sh
npm ci
npm test
npm run build
npm start
```

`npm start` launches Tauri on every supported OS. For Electron development with live reloading, use `npm run electron:dev`. Use `npm run dev` for the browser interface. The browser build only sees activity within its own page and pauses when hidden. Desktop packages provide system-wide activity, lock and sleep integration. Linux presence uses the desktop D-Bus interfaces or X11. Unsupported desktop services pause timing until presence can be confirmed.

On macOS, run `npm run tauri:test` for Rust and history migration checks, `npm run tauri:build:mac` to build `release/tauri-macos/Blincho.app`, or `npm run tauri:test:mac` for an isolated native smoke test. Install Blincho in `/Applications` before using its login startup feature so the registered executable has a stable path. Windows and Linux builds use `npm run tauri:build:win` and `npm run tauri:build:linux`.

Run `npm run tauri:test:layout` on macOS to check the actual WKWebView at several window sizes, through resize/restore and across all five pages in all 30 languages at three widths. It verifies that Settings and sound share a row whenever they fit, translated controls remain unclipped, and statistics fit the content pane. It uses synthetic settings and a separate WebKit profile. The document and titlebar stay fixed; long page content and sidebar controls retain their own scrolling. AppKit can clamp requested dimensions to the screen's available work area. The reopen check reports a skip when macOS cannot confirm presence, while the viewport checks still run.

## Local MCP

Desktop settings include an optional **Local MCP** switch, off by default. Turn it on to connect a local AI client, then choose **Copy connection** for the server URL and Bearer token in MCP JSON format. The listener binds only to `127.0.0.1`, prefers port `47831`, and uses a free local port if that port is occupied. Disabling the switch closes the listener and discards pending commands. Re-enabling or restarting changes the token, so copy the connection again.

The stateless Streamable HTTP endpoint supports `get_status`, `get_settings`, `get_today_stats`, `get_data_range`, `get_stats`, `start_break`, `pause_timer`, `resume_timer` and `skip_break`. Actions are queued requests, then checked against the current app state. They respect presence checks, active exercises, pending camera checks and strict breaks. Poll `get_status` to observe the result. Settings and daily aggregate totals are shared; detailed activity/call history, journal answers and camera frames are excluded. Browser access is not supported.

`get_data_range` reports `dataStartDate`, `dataEndDate`, `activityStartDate`, `recordedDays` and the device's `timeZone`. The first two dates describe saved daily counters; `activityStartDate` is the first saved date with activity observations and can be later or `null` for older history. These are available-data boundaries, not the installation date or a guarantee of continuous recording.

`get_stats` accepts inclusive local calendar dates `startDate` and `endDate` (`YYYY-MM-DD`) and `groupBy: "day"` (default) or `"week"` (Monday through Sunday). Omitted bounds use the first and last saved dates. For one day, set both dates to that day. Each result includes focus minutes, completed breaks/exercises and observed work, away, manual pause, rest and recorded minutes. Observed work is separate from older focus counters. Missing dates have no period record; `recordedDays` and `calendarDays` make gaps visible. Weekly bounds are clipped to the requested range. `totals` always covers the entire range; paginate `periods` with `offset` (default 0) and `limit` (default 100, maximum 366), following `hasMore`. Empty history has `null` data boundaries and zero totals.

For example, call `get_stats` with `{"startDate":"2026-10-01","endDate":"2026-10-18","groupBy":"week"}` to compare calendar weeks in that range. Neither tool returns individual activity intervals or call names. The MCP projection omits invalid calendar dates and keeps the first saved record for a duplicate date. Completion counts are rounded down to nonnegative safe integers and invalid numeric totals become zero; these rules do not modify saved history.

In Codex, use the copied URL in an HTTP MCP entry and provide the token through an environment variable:

```toml
[mcp_servers.blincho]
url = "http://127.0.0.1:47831/mcp"
bearer_token_env_var = "BLINCHO_MCP_TOKEN"
```

Use the actual URL shown by Blincho when its port differs. Keep the token private. See the [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) and [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Website

```sh
npm run site:build
python3 -m http.server 5184 --directory site-dist
```

The static site is generated in 30 languages from `site/locales`. It follows the system theme until a visitor chooses a theme. The only website storage is the language/theme choice. There are no advertising or analytics scripts. Cloudflare hosts the website; GitHub hosts release downloads. Those providers receive ordinary request metadata.

## Releases

See [RELEASE.md](RELEASE.md) for the tag-driven build and publication pipeline. Update the package version, lockfile, changelog and localized release summary together. A pushed `vX.Y.Z` tag builds release packages, publishes checksums and updates the website and desktop update feeds after successful validation. Production deployment requires the configured Cloudflare Actions secret.

Current Tauri packages on all operating systems use manual download and installation. They check for newer releases after one minute and every six hours while running, and offer a website download. Choosing not to show updates again disables background checks persistently; manual checking remains available in settings. Historical Electron releases keep their compatible verified update feeds. No update forces an immediate restart.

Primary domain: `blincho.app`. Aliases `blincho.com`, `www.blincho.com` and `www.blincho.app` redirect to it, preserving the path and query.

## Data and compatibility

Settings, journal answers and statistics remain on the device. Unless background update checks are turned off, packages contact `blincho.app` for update metadata. Downloads come from GitHub. These requests do not send journal answers or activity history. No account is required.

The tray shows the current detected call and its application while either call feature is enabled. This transient status does not enable recording. Call history is off by default and has its own switch, separate from postponing breaks during calls. It stores only observed times and normalized application names locally, without conversation content, audio, participants, meeting titles or URLs. Turn recording off to stop future records, or delete call history from Statistics while keeping your other local history.

The application identity remains `com.myeyes.app`. Electron keeps its legacy `myeyes` profile. On the first Tauri desktop launch, Blincho imports settings, journal answers and statistics from a private copy of that profile into the system WebView storage. It does not change the original Electron database or overwrite an existing Tauri profile. Quit the old Electron app before the first migration so its database is stable. Windows paths that cannot be represented in the legacy LevelDB encoding require an available short path; otherwise the app shows the history recovery screen without modifying the source. Later launches use the migrated profile without importing it again.

If history migration fails, a localized recovery screen appears before the app creates settings or history. Close the old Electron app and choose Retry after correcting the source. Continue without history records an explicit choice for this Tauri profile and allows new local records; later launches do not attempt the legacy import. The original Electron database remains unchanged.

## Contributing

Open an issue with your OS, app version and reproduction steps. Do not include personal journal entries or secrets. Run tests and the build before proposing changes. User-facing text must follow [AGENTS.md](AGENTS.md), including the punctuation rule in every language.

MIT licensed. See [LICENSE](LICENSE).
