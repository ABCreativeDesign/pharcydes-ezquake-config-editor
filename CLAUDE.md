# ezQuake Config Editor — Project Instructions

## Built artifacts

### PharCyde's ezQuake Config Editor
A standalone Electron desktop app for editing ezQuake QuakeWorld client config files (.cfg).

**What it does:** Presents the raw config as a structured UI matching ezQuake's 7-tab in-game menu — human-readable labels, sliders with correct ranges, enum dropdowns, palette color pickers, favorites, and direct file save.

**Key files:**
- `config-editor-template.html` — primary source file (edit this, not the assembled output)
- `build-meta.js` — parses ezQuake source → `meta-generated.js`
- `assemble.js` — injects metadata into template → `config-editor.html` (the actual app)
- `main.js` / `preload.js` — Electron main process + IPC bridge
- `package.json` — Electron + electron-builder config

**Build commands:**
- `npm start` — run the app in dev mode
- `node assemble.js` — rebuild after template changes
- `node build-meta.js && node assemble.js` — rebuild after metadata changes
- `npm run dist` — build portable .exe (requires Windows Developer Mode ON)

**ezQuake source:** `ezquake-source-master/` — used by `build-meta.js`, not tracked in git

**GitHub:** https://github.com/ABCreativeDesign/pharcydes-ezquake-config-editor
**Latest release:** v1.0.1

**Launch:** `taskkill /f /im electron.exe 2>/dev/null; npm start`
