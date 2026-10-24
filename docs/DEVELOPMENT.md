# Development

[Back to the overview](../README.md)

All desktop apps use Tauri, Rust and the system WebView (WKWebView on macOS, WebView2 on Windows and WebKitGTK on Linux). They share the same React interface, local statistics and 30 languages.

Use Node.js 22.12 or newer. Desktop builds need Rust and CMake. macOS also needs Xcode Command Line Tools. Windows needs the MSVC build tools and WebView2. With Visual Studio 2026 on Windows ARM64, install Ninja and set `CMAKE_GENERATOR=Ninja` when using the pinned CMake version. Linux needs Clang, WebKitGTK 4.1, GTK 3, AppIndicator, X11/Xss and D-Bus development libraries. Linux packages use the Ubuntu 24.04 build baseline. Portable Windows packages require an installed WebView2 runtime. CI pins Rust 1.92.0 and CMake 3.31.10; CMake 4 is incompatible with the bundled LevelDB history migration dependency. The macOS bundle targets macOS 14 or newer. Release builds select `aarch64-apple-darwin` for ARM64 or `x86_64-apple-darwin` for Intel explicitly and verify the packaged executable architecture.

```sh
npm ci
npm test
npm run build
npm start
```

`npm start` launches Tauri on every supported OS. Use `npm run dev` for the browser interface. The browser build only sees activity within its own page and pauses when hidden. Desktop packages provide system-wide activity, lock and sleep integration. Linux presence uses the desktop D-Bus interfaces or X11. Unsupported desktop services pause timing until presence can be confirmed.

The Linux desktop uses the maintained GTK 0.19 bindings and GLib 0.22, which include the fix for [GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g). Until the coordinated integration is released, `src-tauri/Cargo.toml` pins the official [Tauri GTK 0.19 migration](https://github.com/tauri-apps/tauri/pull/16170) and its Tao, Wry, WebKitGTK, menu and tray dependencies to the immutable revisions in [the upstream migration lockfile](https://github.com/tauri-apps/tauri/blob/899ca2105ffd06293013b6d2bff4416987d99010/Cargo.lock). These are genuine upstream sources with their original package versions; GTK 3, WebKitGTK 4.1 and AppIndicator support remain enabled. Cargo resolves registry packages with their published checksums. To update these pins, use a compatible coordinated upstream revision, regenerate the lockfile, and run the complete vulnerability scan and native platform matrix. Remove the patches together once released versions provide the same fixed binding chain. The vulnerability scan continues to check the complete locked dependency inventory, including development and platform dependencies, at every severity.

On macOS, run `npm run tauri:test` for Rust and history migration checks, `npm run tauri:build:mac` to build `release/tauri-macos/Blincho.app`, or `npm run tauri:test:mac` for an isolated native smoke test. Install Blincho in `/Applications` before using its login startup feature so the registered executable has a stable path. Windows and Linux builds use `npm run tauri:build:win` and `npm run tauri:build:linux`.

Run `npm run tauri:test:layout` on macOS to check the actual WKWebView at several window sizes, through resize/restore and across all five pages in all 30 languages at three widths. It verifies that Settings and sound share a row whenever they fit, translated controls remain unclipped, and statistics fit the content pane. It uses synthetic settings and a separate WebKit profile. The document and titlebar stay fixed; long page content and sidebar controls retain their own scrolling. AppKit can clamp requested dimensions to the screen's available work area. The reopen check reports a skip when macOS cannot confirm presence, while the viewport checks still run.

## Checks

The badges show the latest workflow runs triggered by pushes to `main`. Pull-request results appear in each PR's checks.

- [App and website validation](../.github/workflows/ci.yml) runs on pull requests and pushes to `main`. It checks the Node test suite, TypeScript/Vite build and website build, plus Rust formatting, checks and tests, native smoke tests and package verification across macOS, Windows and Linux on ARM64 and x64.
- [Vulnerability scan](../.github/workflows/vulnerability-scan.yml) runs on pull requests, merge groups, pushes to `main`, a daily schedule and manual requests. The release workflow also calls it before validation and packaging. It validates npm and Cargo manifests against their committed locks without building or running lifecycle scripts, then checks those dependency inventories with npm audit and Trivy. It includes development and platform dependencies, and fails on known vulnerabilities at every severity, including those without fixes.

After `npm ci`, run `npm test`, `npm run build` and `npm run site:build` locally. For desktop changes, also run `cargo fmt --manifest-path src-tauri/Cargo.toml --check` and `npm run tauri:test` with the native prerequisites described above.

## Website

```sh
npm run site:build
python3 -m http.server 5184 --directory site-dist
```

The static site is generated in 30 languages from `site/locales`. It follows the system theme until a visitor chooses a theme. The only website storage is the language/theme choice. There are no advertising or analytics scripts. Cloudflare hosts the website; GitHub hosts release downloads. Those providers receive ordinary request metadata.

## Releases

See [RELEASE.md](../RELEASE.md) for the tag-driven build and publication pipeline. Update the package version, lockfile, changelog and localized release summary together. A pushed `vX.Y.Z` tag builds release packages, publishes checksums and updates the website and desktop update feeds after successful validation. Production deployment requires the configured Cloudflare Actions secret.

Current Tauri packages on all operating systems use manual download and installation. They check for newer releases after one minute and every six hours while running, and offer a website download. Choosing not to show updates again disables background checks persistently; manual checking remains available in settings. Historical Electron releases keep their compatible verified update feeds. No update forces an immediate restart.

Primary domain: `blincho.app`. Aliases `blincho.com`, `www.blincho.com` and `www.blincho.app` redirect to it, preserving the path and query.
