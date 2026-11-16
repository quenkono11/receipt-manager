# Receipt Manager / Belegverwaltung

Desktop app for Windows and Linux (macOS: run from source) to store receipts as plain JSON files and get expense overviews.
English and German UI (switch in Settings; defaults to your system language).
The app opens maximized. The version number is shown in **Settings** and at the bottom left of the sidebar.

## Run

```bash
npm install
npm start          # run the app
npm test           # unit tests for money, tax, IDs, folder handling, reports (no Electron needed)
npm run dist       # build the Windows portable .exe and the Linux AppImage (electron-builder, output in dist/)
```

### Builds

- **Windows:** a portable `.exe`. There is nothing to install, just run it.
- **Linux:** an AppImage. Make it executable (`chmod +x`) and run it. Some distributions need FUSE 2 for AppImages
  (on Arch/Manjaro: `sudo pacman -S fuse2`).
- **macOS:** not part of `npm run dist`. Run from source with `npm start`; a macOS build has to be made on a Mac.

## Where data lives

On first start you choose a folder (changeable any time in **Settings → Change folder…**; the app offers to
move or copy existing receipts). In that folder:

- `REC-2026-00001_3fa91c0b.json` — one file per receipt: ID, an underscore and the receipt's permanent key
- `stores.json` — your saved stores

The app watches the folder: copy receipt files in from another computer (or let Syncthing/Dropbox do it) and
they appear automatically. **Import files…** adds files from elsewhere (same receipt edited elsewhere → newer
version wins).

### Receipt IDs

IDs follow the purchase date and time, separately for each year: the oldest receipt of 2026 is
`REC-2026-00001`, the next one `REC-2026-00002`, and so on. Receipts with the same date and time are ordered by
when they were created. Whenever the order changes (you add an older receipt, change a date, delete a receipt,
or files arrive from another computer) the IDs and file names are renumbered automatically.

The 8-character **key** in the file name and inside the file never changes. It identifies the receipt itself
and is what lets the app recognise the same receipt after a renumbering.

Receipts created with version 1.0 are converted automatically when the folder is opened (new ID and file
name, nothing else changes; a fixed tax amount stays as it was until you enter tax rates).

## Overview

The **Overview** shows one period at a time. Choose **Day, Week, Month, Quarter or Year**, then the specific one
(a date, a calendar week, a month, a quarter with its year, or a year). The arrows move to the previous or next
period and the button on the right jumps back to the current one. Weeks are ISO weeks (they start on Monday).

For the chosen period you see the total spent (with a comparison to the previous period), tax, number of receipts
and the average per receipt, a chart (a week or month by day, a quarter or year by month; click a column to open
that day or month), the spending by store, the spending by category and the receipts of the period. **Export CSV…**
saves the receipts of the chosen period, one row each. Totals are never mixed across currencies: if a period
contains several, pick the currency in the top right.

## Categories

Each item can have a category (for example *Groceries*). There are no predefined categories: you create your own by typing a
name (the menu shows "Create …"), and the field then offers the categories you already use. A new row starts with the
category of the row above. Typing `groceries` uses the existing
spelling `Groceries`, so categories do not split by capitalisation. Categories are optional: the "By category"
table in the Overview appears as soon as one item in the period has a category. The amounts are item prices after
discounts, so with added tax or rounding the sum can differ from the receipt totals by a few cents.

## Appearance

**Settings → Appearance** switches between *Same as system*, *Light* and *Dark*. Choose Dark or Light explicitly if
your desktop does not report its colour scheme to the app.

## Updates

On startup the app asks GitHub for the latest release of this repository. If it is newer than the running version,
the text "Version x.y.z is available" appears next to the version number (sidebar and Settings); clicking it opens
the release page in the browser. Nothing is downloaded or installed and no receipt data is sent. The check can be
switched off in **Settings → Updates**. Failures (offline, rate limit) are ignored silently.

The repository is read from the `repository` field of `package.json`. Without it the check is off and the switch is
hidden:

```json
"repository": "github:<owner>/<repo>"
```

Releases are compared by version number, so tag them like `v1.2.1` (drafts and pre-releases are ignored).

## Tax and discounts

Each item has a quantity, a unit price, an optional discount in percent and a tax rate in percent (type any
value, or pick 0, 7 or 19). A receipt can also have a discount in percent for the whole receipt. Calculation
order: item discount, then receipt discount, then tax per rate. With **Prices already include tax** (the
default) the tax is taken out of the prices; otherwise it is added on top. Rounding is per line, half away
from zero.

## Receipt file format

```json
{
  "schemaVersion": 2,
  "id": "REC-2026-00001",
  "key": "3fa91c0b",
  "store": { "name": "Rewe", "location": "Berlin-Mitte" },
  "purchasedAt": "2026-03-04T12:30",
  "currency": "EUR",
  "items": [
    { "name": "Milk", "category": "Groceries", "quantity": 2, "unitPriceMinor": 129, "discountPct": 0, "taxRatePct": 7 }
  ],
  "discountPct": 0,
  "taxIncluded": true,
  "taxMinor": 17,
  "totalMinor": 258,
  "notes": "",
  "createdAt": "2026-03-04T11:31:10.000Z",
  "updatedAt": "2026-03-04T11:31:10.000Z"
}
```

Amounts are integers in minor units (cents). `taxMinor` and `totalMinor` are calculated and written for
other tools; the app recalculates them from the items. Receipts converted from 1.0 may also contain
`legacyTaxMinor` (the old fixed tax amount). `category` is optional on every item and left out when empty.

## Code layout

- `main.js`, `preload.js` — Electron main process and secure bridge
- `lib/receipts.js` — pure receipt logic (tax maths, validation, keys, numbering plan)
- `lib/folder.js` — everything that touches the receipt folder (scan, migrate, renumber, save, delete, import)
- `lib/update.js` — update check (version comparison, repository from `package.json`, GitHub request)
- `renderer/` — UI (plain JavaScript modules, no build step): `app.js`, `format.js`, `reports.js` (overview of one period), `i18n.js`
- `renderer/locales/en.js`, `de.js` — all UI text; add a language by adding a file and registering it in `i18n.js`

## About this project

This app is vibe-coded: the code was written together with an AI assistant. The idea behind the app, and the
decisions about what it should do and how it should work, are human.

## License

GNU General Public License v3 (GPL v3). The full text is in `LICENSE`.
