# Receipt Manager / Belegverwaltung

Desktop app (Windows, macOS, Linux) to store receipts as plain JSON files and get expense overviews.
English and German UI (switch in Settings; defaults to your system language).

## Run

```bash
npm install
npm start          # run the app
npm test           # unit tests for IDs, money parsing, ISO weeks and reports (no Electron needed)
npm run dist       # build an installer for the current OS (electron-builder)
```

## Where data lives

On first start you choose a folder (changeable any time in **Settings → Change folder…**; the app offers to
move or copy existing receipts). In that folder:

- `REC-2026-20589.json` — one file per receipt, named after its ID
- `stores.json` — your saved stores

The app watches the folder: copy receipt files in from another computer (or let Syncthing/Dropbox do it) and
they appear automatically. **Import files…** adds files from elsewhere and handles ID clashes
(same receipt edited elsewhere → newer version wins; different receipt with the same ID → renumbered).

## Receipt file format

```json
{
  "schemaVersion": 1,
  "id": "REC-2026-20589",
  "store": { "name": "Rewe", "location": "Berlin-Mitte" },
  "purchasedAt": "2026-03-04T12:30",
  "currency": "EUR",
  "items": [{ "name": "Milk", "quantity": 2, "unitPriceMinor": 129 }],
  "taxMinor": 17,
  "taxIncluded": false,
  "totalMinor": 275,
  "notes": "",
  "createdAt": "2026-03-04T11:31:10.000Z",
  "updatedAt": "2026-03-04T11:31:10.000Z"
}
```

Amounts are integers in minor units (cents). The year in the ID is the purchase year when the receipt was
created; the ID never changes afterwards, even if you edit the date.

## Code layout

- `main.js`, `preload.js`, `lib/receipts.js` — Electron main process, secure bridge, pure receipt logic
- `renderer/` — UI (plain JavaScript modules, no build step): `app.js`, `format.js`, `reports.js`, `i18n.js`
- `renderer/locales/en.js`, `de.js` — all UI text; add a language by adding a file and registering it in `i18n.js`
