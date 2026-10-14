# Blincho

A free screen-break companion for macOS, Windows and Linux. Every feature is free.

From version 1.6.0, all desktop apps use Tauri, Rust and the system WebView (WKWebView on macOS, WebView2 on Windows and WebKitGTK on Linux). All desktop versions share the same React interface, local statistics and 30 languages.

Website: https://blincho.app

## What it does

- Reminds you to take short breaks and supports configurable work/break intervals.
- Pauses timing when you are away, the screen locks or the computer sleeps.
- Keeps the desktop timer running in Rust when the window is hidden or minimized.
- Restores the window on its previous monitor after lock or sleep, keeping hidden and minimized windows in the background. If that monitor is disconnected, the window returns to an available screen.
- Includes exercises, a personal comfort journal and local statistics.
- Shows a small tray preview with the next break countdown, recorded work time and completed breaks on macOS and Windows. Linux exposes the live summary in its tray menu.
- Records daily work, absence, lock, sleep, manual pauses and rest intervals locally. Browse previous days, average and longest work intervals, and weekly averages per calendar day or day of use. Older totals stay available; missing time records remain unknown.
- Records detected calls with their application, observed start/end and duration. Browse daily call lanes and per-app totals, average call lengths and weekly call time. Browser calls identify the browser; detection is approximate and requires meeting detection to be enabled.
- Offers 30 languages, automatic language detection, light/dark/system themes and calming color palettes.
- Includes Armenian, Bengali, Indonesian, Vietnamese, Thai, Persian, Urdu, Hebrew, Dutch, Swedish, Czech, Romanian, Greek, Tamil and Telugu alongside the original English, Russian, Spanish, French, German, Italian, Portuguese, Chinese, Japanese, Korean, Arabic, Hindi, Turkish, Polish and Ukrainian.

Blincho is a general wellness tool. It does not diagnose or treat eye conditions. Windows and Linux lock/sleep behavior has automated coverage but has not yet been validated on physical hardware. The download page identifies each package's signing and update support. Operating systems can show publisher warnings for unsigned packages.

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

Run `npm run tauri:test:layout` on macOS to check the actual WKWebView at several window sizes, through resize/restore and across all five pages. It uses synthetic settings and a separate WebKit profile. The document and titlebar stay fixed; long page content and sidebar controls retain their own scrolling. AppKit can clamp requested dimensions to the screen's available work area. The reopen check reports a skip when macOS cannot confirm presence, while the viewport checks still run.

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

The application identity remains `com.myeyes.app`. Electron keeps its legacy `myeyes` profile. On the first Tauri desktop launch, Blincho imports settings, journal answers and statistics from a private copy of that profile into the system WebView storage. It does not change the original Electron database or overwrite an existing Tauri profile. Quit the old Electron app before the first migration so its database is stable. Windows paths that cannot be represented in the legacy LevelDB encoding require an available short path; otherwise the app shows the history recovery screen without modifying the source. Later launches use the migrated profile without importing it again.

If history migration fails, a localized recovery screen appears before the app creates settings or history. Close the old Electron app and choose Retry after correcting the source. Continue without history records an explicit choice for this Tauri profile and allows new local records; later launches do not attempt the legacy import. The original Electron database remains unchanged.

## Contributing

Open an issue with your OS, app version and reproduction steps. Do not include personal journal entries or secrets. Run tests and the build before proposing changes. User-facing text must follow [AGENTS.md](AGENTS.md), including the punctuation rule in every language.

MIT licensed. See [LICENSE](LICENSE).
