# Blinchiborg source art

The approved full build is `blinchiborg-master-v1.png`. The clean character was edited from it in `blinchiborg-clean-v1.png`; prompts are preserved alongside both images. Both sources share a 1254px canvas and the same character position.

`layers.json` traces six physical modules on the master. A mask enables approved master pixels over the clean source, preserving their materials, lighting and character geometry. The lower six bits select presence, automatic locking, call history, input statistics, strict mode and local MCP respectively. No cloud service is enabled.

Regenerate the checked-in runtime assets after editing the sources or masks:

```sh
BLINCHO_SHARP_MODULE=/absolute/path/to/sharp node scripts/render-symbiote-icons.cjs
```

Sharp is a development asset tool only. It is not required to build or run Blincho from the checked-in PNGs. The script writes `public/symbiote/00.png` through `3f.png` at 256px and a manifest containing source hashes, exact enabled modules and asset hashes. The complete `3f` build is resized directly from the approved master; `00` uses the clean source. `install.png` is the clean 512px installation icon.

The UI, browser favicon and notification helper use the same fixed asset paths. Native builds embed the same 64 PNGs for runtime Dock/window/tray updates. The tray retains its independent live-call badge. Installer icons, pinned shortcuts and already-installed PWA icons are controlled by their operating system or installation metadata, rather than runtime window APIs.

The dedicated native check is `node tests/tauri-symbiote-smoke.cjs` after building the desktop executable. It uses an isolated profile to verify every portrait, overlapping requests, call-badge restoration, IPC validation, settings-driven branding and localized RTL summaries without camera or input permissions.
