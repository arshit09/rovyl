# Archive

Code that is no longer built or shipped, kept because it is still worth reading.

## `electron/`

Rovyl 1.x — the Electron app that 2.0.0 replaced. The last release cut from this tree was
**1.19.0**; `2.0.0` is the Rust build at the repository root, and every 1.x install updates
itself across to it.

It is complete and unchanged from the day it was retired: the React renderer (`src/`), the
Electron main process and its PowerShell helpers (`backend/`), the electron-builder and NSIS
configuration (`package.json`, `nsis/`), the smoke tests and generators (`scripts/`), the
improvement backlog it was audited against (`TODO.md`), and its own architecture notes
(`docs/ARCHITECTURE.md`) — which explain why a lot of it looks the way it does, and are the
reason this is kept rather than deleted.

Two of the native build's generated tables are still derived from here rather than retyped, so
the two never drift: the settings panel's seven languages come from
`electron/src/i18n/translations.ts`, and the icon picker's English keywords from
`electron/src/utils/iconPickerEnglishKeywords.ts`. See
[docs/BUILD.md](../docs/BUILD.md#development).

Nothing here is wired into the root project. `npm install` and `npm run dist` inside this folder
still work, but what they produce is not published; the release process
(`.claude/skills/release/SKILL.md`) never touches it.
