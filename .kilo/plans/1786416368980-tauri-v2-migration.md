# Receipt Manager → Tauri v2 Migration Plan

## Objective

Move Receipt Manager from Electron to a Tauri v2 desktop shell with a TypeScript/Vite frontend and a Rust backend, without changing the receipt-folder format or user-facing behavior in the first release.

This is not a Tauri v1-to-v2 upgrade. There is no Tauri code in this repository; it is a main-process rewrite from Electron/Node.js to Rust plus a frontend build and IPC migration.

## Current Baseline

- Electron main process and IPC handlers: `main.js:116-273`.
- Secure `window.api` bridge: `preload.js:6-27`.
- Pure receipt/tax/numbering logic: `lib/receipts.js:12-162`.
- Folder scanning, migration, renumbering, import, and atomic writes: `lib/folder.js:14-148`.
- GitHub update check: `lib/update.js:4-47`.
- Vanilla JavaScript renderer: `renderer/app.js:1-673`.
- Renderer-local duplicate tax calculations: `renderer/format.js:95-138`.
- Electron packaging: `package.json:21-45`.
- Existing parity tests: `test/logic.test.mjs`.

Current release gates before implementation:

1. Commit or otherwise freeze the current working tree; it contains uncommitted changes and untracked `lib/update.js`.
2. Align package version, tag, Tauri package version, and the version used by the update check. Current `package.json` says `1.2.0` while the latest tag is `v1.2.1`; this can make the app perpetually offer an update.
3. Capture a fixture folder containing schema v1 and v2 receipts, invalid files, duplicate keys, multiple currencies, legacy tax, categories, and renumbering cases.
4. Preserve the Electron implementation on a tag/branch until the Tauri build passes the same behavioral suite.

## Recommended Architecture

### Frontend: TypeScript + Vite, vanilla DOM initially

Keep the existing UI structure and CSS for the parity migration. Convert renderer modules to TypeScript and introduce Vite for bundling. Do not add React, Vue, or Svelte in the same migration; a framework change would confound UI regressions with IPC regressions. A component framework can be adopted later if the UI grows.

Proposed layout:

```text
package.json
vite.config.ts
src/
  main.ts                 # UI bootstrap and view rendering
  api.ts                  # typed invoke wrappers and event subscriptions
  types.ts                # generated/synchronized Rust DTOs
  format.ts               # Intl formatting and input parsing only
  ui/                     # existing views, converted from renderer/app.js
  locales/
src-tauri/
  Cargo.toml
  rust-toolchain.toml
  tauri.conf.json
  capabilities/default.json
  src/
    main.rs
    lib.rs
    state.rs
    error.rs
    commands/
      app.rs
      folder.rs
      receipts.rs
      catalogs.rs          # stores and categories
      reports.rs
      export.rs
      updates.rs
    domain/
      receipt.rs
      money.rs
      numbering.rs
      report.rs
    storage/
      config.rs
      folder.rs
      json.rs
    services/
      watcher.rs
      update.rs
```

Use `tauri-specta` or an equivalent Rust-to-TypeScript binding generator for command arguments, DTOs, results, and events. If generated bindings are not used, `ts-rs` must generate the shared DTOs and CI must fail when checked-in bindings drift.

### Backend: Rust owns all privileged and authoritative work

Move all filesystem access, receipt validation, tax calculation, migration, numbering, import conflict resolution, report aggregation, and update checking into Rust. The webview must not receive the `fs` plugin or arbitrary shell access.

Core responsibilities:

- `domain`: receipt types, schema v1/v2 migration, money/tax arithmetic, key generation, annual numbering, reports.
- `storage`: JSON reading/writing, duplicate detection, atomic replacement, directory scanning, config persistence.
- `commands`: thin Tauri command handlers validating arguments and mapping errors to typed API errors.
- `services`: filesystem watcher, GitHub update check, native dialogs/open folder.
- `state`: app config, current receipt folder, update cache, watcher handle, and mutation queue.

Use Tauri managed state with `Arc` where shared across async commands. Protect config with an async mutex and serialize folder mutations with a separate async mutex or actor. Never hold a lock across a native dialog. Commands should clone the data they need rather than holding borrowed Tauri state across `.await`.

Suggested command surface, preserving current behavior:

- `app_getState`, `app_setLanguage`, `app_setTheme`, `app_setCheckUpdates`
- `update_openRelease`
- `folder_choose`, `folder_openFolder`
- `receipts_list`, `receipts_save`, `receipts_delete`, `receipts_import`
- `stores_list`, `stores_upsert`, `stores_delete`
- `categories_list`, `categories_upsert`, `categories_delete`
- `reports_build`, `reports_receiptsToCsv`, `export_csv`
- `receipts_previewTotals` for live form calculation

Prefer commands that open native dialogs inside Rust (`folder_choose`, `receipts_import`, `export_csv`) so the frontend never supplies an arbitrary output path. The Rust command should validate every path derived from frontend input.

### IPC and events

- Use Tauri commands for request/response calls; async commands should perform filesystem and network work off the main thread.
- Use a webview-targeted event such as `data:changed` only as a small invalidation signal. Do not send large receipt payloads through the event system; use a command to fetch data.
- Emit update metadata as a small event or fetch it through a command.
- Register frontend listeners before initial data loading, matching `renderer/app.js:32-44`.
- Use Tauri `Channel` only for progress streams such as future update downloads or imports; it is unnecessary for current parity work.

### Security model

- Define a least-privilege capability for the single main window.
- Enable only required core permissions and the dialog/opener plugin permissions actually used.
- Keep remote API access disabled.
- Keep CSP restrictive; do not enable `withGlobalTauri` unless a concrete compatibility need appears.
- Validate update URLs against the configured GitHub repository and restrict `openRelease` to the known release URL.
- Do not expose generic read/write/delete/shell commands. File access must be implemented in Rust with the selected receipt folder as the only writable data root.
- Store Tauri updater private keys outside the repository and use CI secrets for signing.

### Theme, locale, and configuration

- Replace Electron `nativeTheme` behavior with a `data-theme` attribute plus the existing `prefers-color-scheme` fallback. Native dialogs may follow the OS theme even when the app theme is forced.
- Detect the initial system language in the frontend or via a Rust locale service; retain the explicit English/German config override.
- Persist `lastCurrency` and `lastTaxRate` in the Rust config. The Electron `localStorage` values will not automatically transfer because the Tauri webview origin differs.
- Migrate `config.json` from the Electron `userData` directory into Tauri's `app_data_dir` on first run. Keep the receipt-folder location unchanged.
- Choose a stable application identifier and bundle name; document that the config migration depends on the old Electron path.

### File and data compatibility

- Keep receipt schema version 2 byte-compatible: same fields, filename grammar, key stability, annual numbering, and JSON pretty-printing.
- Keep `stores.json` and `categories.json` unchanged.
- Match the current rounding behavior before attempting any financial arithmetic improvements. Use integer minor units for stored amounts and add golden tests for half-cent rounding, item discount before receipt discount, included/excluded tax, legacy fixed tax, and negative refunds.
- Reimplement atomic writes with a unique temporary file in the destination directory and a platform-safe replace operation. Windows rename-overwrite semantics differ from Unix; test this explicitly.
- Preserve the watcher's root-only, debounced JSON-change behavior with the `notify` crate. Ignore stale events generated during folder switches and app shutdown.

## Migration Stages

### 0. Baseline and release audit — 0.5 day

- Freeze the current implementation and create `tauri-v2` work from a clean commit.
- Reconcile package/tag/Cargo/update-check versions.
- Record current screenshots and command/event inventory.
- Add fixture-based differential tests before changing behavior.
- Exit: clean build, reproducible Electron test run, version metadata aligned.

### 1. Tauri/Vite scaffold — 1–1.5 days

- Add Tauri v2 CLI, Vite, TypeScript, `src-tauri`, and a strict `tsconfig`.
- Move `renderer/` into the Vite source tree without changing UI behavior.
- Add a single no-op command and prove frontend-to-Rust invocation, event listening, and native dialog availability.
- Add `cargo fmt`, `clippy`, `npm typecheck`, and build jobs.
- Exit: development and release shell launch on the primary target platforms.

### 2. Rust domain and storage parity — 2.5–3.5 days

- Port `receipts.js` and `folder.js` into Rust modules.
- Add typed serde DTOs with camelCase serialization matching the current JSON contract.
- Port validation, migration, deduplication, annual numbering, save/delete/import, and config persistence.
- Add Rust unit tests and fixture tests mirroring `test/logic.test.mjs`.
- Build a differential harness that compares Rust and Electron outputs for generated receipts and folder states.
- Exit: byte-compatible files and identical receipt/report results for the fixture corpus.

### 3. Frontend TypeScript and typed API — 1.5–2 days

- Convert renderer modules to TypeScript and replace `window.api` with typed `api.ts` wrappers.
- Replace direct renderer tax calculations with backend report/preview commands; retain TypeScript only for formatting, parsing, and presentation.
- Preserve all view flows, translations, filters, category menus, and update notices.
- Add frontend unit tests for parsing/formatting and a small mocked API suite.
- Exit: existing UI flows work through Tauri commands with no Node/Electron globals.

### 4. Native services and watcher parity — 1–1.5 days

- Implement folder/file/save dialogs through `tauri-plugin-dialog`.
- Implement folder and release opening through `tauri-plugin-opener`.
- Implement `notify` watcher and webview-targeted `data:changed` events.
- Port the GitHub update check to Rust with a timeout and silent failure behavior.
- Implement theme/locale behavior and configuration migration.
- Exit: folder changes, imports, exports, external edits, theme switching, and update notices match Electron behavior.

### 5. Packaging and CI parity — 1.5–2 days

- Configure Tauri bundle targets: NSIS for Windows, AppImage for Linux, and optionally DMG/app for macOS.
- Choose and document the WebView2 installation mode; offline or embedded-bootstrapper distribution must be an explicit product decision.
- Add native GitHub Actions runners for Windows and Linux; add macOS when cross-platform parity is required.
- Test paths with spaces/Unicode, invalid JSON, interrupted renames, read-only folders, and real WebView behavior.
- Update README with build prerequisites, runtime dependencies, config migration, and distribution changes.
- Exit: installable artifacts launch on clean test machines and preserve the fixture folder.

### 6. Hardening and cutover — 1–1.5 days

- Remove Electron, `chokidar`, and unused Electron Forge configuration only after Tauri parity passes.
- Run the full manual QA matrix twice: upgrade from the old Electron config and first-run setup.
- Add a smoke test against a copy of a real user folder; never mutate the original during testing.
- Publish a Tauri beta release and retain the Electron release as fallback until the beta passes.
- Exit: no receipt loss, no renumbering regression, and no unexplained file-format changes.

## Complexity Assessment

Overall difficulty: **medium**. Tauri v2 itself is a good fit for this application, and the UI is small. The difficult part is preserving data and accounting semantics while moving them from JavaScript to Rust.

| Area | Difficulty | Main concern | Estimated effort |
|---|---|---|---|
| Tauri/Vite scaffolding | Low | Build and native prerequisites | 1–2 days |
| Typed command layer | Low–medium | Keeping Rust/TS contracts synchronized | 1–2 days |
| Receipt/tax/numbering port | High | Rounding and legacy-data parity | 2–3 days |
| Folder/import/watcher | High | Concurrency, atomic replace, cross-platform rename | 2–3 days |
| Renderer conversion | Low–medium | Preserving DOM-heavy UI behavior | 2–3 days |
| Dialogs/theme/update/config | Medium | Electron API behavior has no exact Tauri equivalent | 1–2 days |
| Packaging/signing/CI | Medium–high | Windows WebView2, installers, platform runners | 2–3 days |

Estimated parity effort: **8–12 developer-days** for an engineer already productive in TypeScript and Rust. Add roughly 2–4 days for Rust/Tauri learning, macOS packaging, or code-signing/notarization. Feature expansion should be separate from the parity estimate.

There are no legacy Tauri v1 plugins or configuration to migrate. The relevant Tauri v2 paradigm shifts are:

- Node/Electron main-process APIs become Rust commands and plugins.
- `contextBridge`/`ipcRenderer` becomes generated typed commands/events with capabilities.
- `electron-builder` portable/AppImage targets become Tauri bundle targets; Windows has no direct one-to-one portable `.exe` target.
- `nativeTheme` and `app.getPath('userData')` must be replaced with explicit theme state and Tauri path APIs.
- Tauri v2 plugin permissions are capability-based; current dialog/updater plugin documentation also calls for a recent Rust toolchain, so pin a compatible version such as Rust 1.90 or newer after checking the selected plugin versions.

## Primary Risks and Mitigations

1. **Receipt data corruption or renumbering regression** — highest risk. Use the Electron implementation as a differential oracle, test copies of real folders, and require identical output before cutover.
2. **Tax rounding differences** — port the existing algorithm first, then add golden values and randomized property tests. Do not silently switch to a new rounding policy during migration.
3. **Windows atomic overwrite and watcher behavior** — test `rename` replacement, interrupted writes, file locks, antivirus interference, and path case sensitivity on Windows.
4. **Lost distribution format** — the current Windows portable executable cannot be reproduced directly with standard Tauri targets. Decide between an NSIS installer and a separate portable wrapper before promising parity.
5. **WebView/runtime differences** — validate CSS, native dialogs, `Intl`, locale formatting, and theme detection in actual WebView2/WebKitGTK, not only a browser.
6. **Configuration migration** — old `userData`, Tauri app data, and localStorage are different stores. Implement a one-time migration and retain the receipt folder path independently.
7. **Version/update mismatch** — use one source of version metadata across package, Cargo, tag, and update checks.
8. **Supply chain and signing** — pin Tauri/plugin versions, commit lockfiles, sign release artifacts, and back up updater keys securely.

## Validation Strategy

Automated:

- `npm test` until renderer tests are migrated, then the TypeScript equivalent.
- `npm run typecheck`.
- `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`.
- `npm run tauri build` on each supported platform.
- Differential fixtures: Rust versus Electron for every command that mutates or reads receipt data.
- Property tests for money, discounts, tax rates, legacy tax, negative amounts, numbering, and import conflicts.

Manual QA matrix:

- First run with no config; switch folder; move/copy/leave existing receipts.
- Add an older receipt, change a purchase year, delete a receipt, and verify numbering.
- Import valid, duplicate, stale, and malformed receipt files.
- Edit a JSON file externally and verify watcher refresh.
- Save with read-only or missing folder; verify actionable errors.
- Export CSV with German and English formatting, commas/quotes/newlines, and non-EUR currencies.
- Switch language/theme, restart, and verify persisted settings.
- Check update notice with network disabled, rate-limited GitHub, and a newer release.
- Test Unicode/space paths, schema v1 migration, duplicate keys, and interrupted renames.

## Feature and Performance Expansion After Parity

Keep these out of the parity milestone.

1. **Signed automatic updates with progress UI** — use the Tauri updater plugin, signed artifacts, and a channel for download progress. This upgrades the current “open the release page” notice into a real update flow.
2. **Incremental Rust report/index service** — maintain an in-memory receipt index and reparse only changed files. Current save/refresh paths can scan and renumber the whole folder multiple times; caching and a single authoritative refresh will improve large-folder latency.
3. **Fast search and advanced reports** — move filtered queries and report aggregation to Rust, add arbitrary date ranges, budgets, recurring expenses, and category/store trends. Keep JSON files as the source of truth; add SQLite FTS only if profiling shows the in-memory index is insufficient.
4. **Native OS integration** — tray menu, global-shortcut quick entry, notifications, single-instance handling, file associations, and drag-and-drop import. These are natural Tauri/Rust additions and do not require a cloud service.
5. **Backup and portable export** — ZIP backup containing JSON plus CSV, optional PDF/print output, restore preview, and automatic pre-migration/pre-renumber snapshots. Use Rust for atomic archive creation and restore validation.
6. **Optional receipt attachments/OCR** — attach images/PDFs to receipts and run OCR through a bundled sidecar or user-configured local engine. Treat this as a larger privacy-sensitive feature; do not send receipt data to a remote service by default.
7. **Sync conflict visibility** — surface the existing duplicate-key/newer-version rules in the UI, with per-receipt conflict details instead of silent stale-file cleanup.

## Release Decision

Proceed with Tauri v2 as a parity-first migration, not as a simultaneous UI and backend rewrite. The recommended sequence is: clean/version-align the Electron baseline, scaffold Tauri with TypeScript, port and differential-test the Rust domain/storage layer, connect the existing UI through typed commands, restore native services, then package and run a beta against real receipt folders. Defer auto-update, indexing, OCR, and other expansion features until the Tauri build has demonstrated identical receipt-file behavior.

References: Tauri v2 command/IPC model (`https://v2.tauri.app/develop/calling-rust/`), capabilities (`https://v2.tauri.app/security/capabilities/`), dialog plugin (`https://v2.tauri.app/plugin/dialog/`), updater (`https://v2.tauri.app/plugin/updater/`), and Windows installer options (`https://v2.tauri.app/distribute/windows-installer/`).