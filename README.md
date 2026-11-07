# Receipt Manager / Belegverwaltung

Desktop app (Windows, macOS, Linux) to store receipts as plain JSON files and get expense overviews.
English and German UI (switch in Settings; defaults to your system language).
The version number is shown in **Settings** and at the bottom left of the sidebar.

## Run

```bash
npm install
npm start          # run the app
npm test           # unit tests for money, tax, IDs, folder handling, reports (no Electron needed)
npm run dist       # build an installer for the current OS (electron-builder)
```

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
    { "name": "Milk", "quantity": 2, "unitPriceMinor": 129, "discountPct": 0, "taxRatePct": 7 }
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
`legacyTaxMinor` (the old fixed tax amount).

## Code layout

- `main.js`, `preload.js` — Electron main process and secure bridge
- `lib/receipts.js` — pure receipt logic (tax maths, validation, keys, numbering plan)
- `lib/folder.js` — everything that touches the receipt folder (scan, migrate, renumber, save, delete, import)
- `renderer/` — UI (plain JavaScript modules, no build step): `app.js`, `format.js`, `reports.js`, `i18n.js`
- `renderer/locales/en.js`, `de.js` — all UI text; add a language by adding a file and registering it in `i18n.js`

## License

GNU General Public License v3 (GPL v3). The full text is in `LICENSE`.
