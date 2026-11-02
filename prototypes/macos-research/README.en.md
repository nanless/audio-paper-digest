# Mac paper-research prototype

[简体中文](README.md)

This browser prototype demonstrates Mac window layout, single-column explanations, side-by-side PDFs, the paper list, personal study, notes, tasks, and settings. Its model and Zotero panels are disconnected displays. For installation and actual native application features, see [Paper Digest Workbench for Mac](../../apps/macos/README.en.md).

Explanations, scientific figures, tables, formulas, the paper list, and the PDF come from real published material. PDF.js renders the original PDF with working page navigation, zoom, and text selection; returning to a selection is bound to a rendered page. Model and Zotero services remain disconnected: no API requests, library writes, or fabricated study responses occur.

## Open the prototype

A local web server supplies the prototype, and the browser displays it. Prepare the sample below, run `npm start` in this directory, then open `http://127.0.0.1:8766/`. That address refers to the current computer; the server is not exposed to other devices. The design reference is 1440 × 900, but desktop windows can be resized. Minimum preview width is 1000 CSS pixels, with no phone-layout reflow.

A fresh checkout needs the fixed sample PDF:

```bash
python3 -m pip install PyMuPDF==1.26.5
python3 prepare_assets.py --pdf /absolute/path/to/2610.27491v1.pdf
```

The public PDF address is in the [asset instructions](assets/README.en.md). Replace `/absolute/path/to/2610.27491v1.pdf` with your original file's absolute path. If using an existing sealed project PDF, pass only its explicit path; the source file remains unchanged.

`prepare_assets.py` does not access the network, read `.env`, or scan internal runtime records. It reconstructs three figures using the PDF pages, point coordinates, and 3× scale in `sample.json`, checking expected SHA values for the PDF and every figure. SHA is a byte-level content fingerprint establishing the fixed sample identity, not a new scientific review. Missing or mismatched assets are shown as unprepared. Installing dependencies and obtaining the public PDF are separate preparation steps; the preparation script itself only reads the supplied file.

## Review interactions

- Reading starts in one column. “打开 PDF” shows the explanation on the left and original paper on the right. Closing it preserves reading position.
- Drag the divider or adjust it with arrow keys. Navigate pages 1–13, zoom, select real text, and inspect the actual selection and pages in personal study.
- Open figures at larger size and jump to their PDF pages. Original captions and eight-dimension scoring details can be expanded.
- The library has 15 real published samples, with title, author, identifier search, and three sorting modes. Only MiCLA has its complete explanation cached; other records explicitly link to the website explanation.
- Favorites, the reading list, and plain-text notes use the current browser's local storage and survive refresh. Storage failure keeps edited text and displays an error.
- Open a nonmodal settings window from the top application menu or `⌘,`. The window moves and remains reachable after resizing. Keys are not saved and are cleared when settings closes.
- Tasks shows actual sample checks and disconnected service states. The Zotero panel shows archive scope and disconnected status rather than simulating a successful write.
- Appearance can follow the system or use light or dark mode. Scientific figures and PDFs retain original colors.

First check that assets are complete, then reading and source return, and finally tasks, settings, and disconnected states. The 15 records are an interface sample, not evidence that site-wide synchronization works. Opening model or Zotero panels does not mean they can call a model or write to a library.

## Tests

Run `npm ci --ignore-scripts` to install Playwright from the lockfile. Use local Chrome, or run `npx playwright install chromium` for the matching Playwright browser. Keep the preview server running, then run `npm test`.

`MAC_PROTOTYPE_PLAYWRIGHT` can specify an existing Playwright module path; `MAC_PROTOTYPE_BROWSER` selects a Chrome executable; `MAC_PROTOTYPE_URL` selects the local preview address. Results and screenshots go to ignored `.qa/`. Tests use an independent browser context and do not alter notes in the user's prototype session.

Visual acceptance separately checks one and two columns, scientific figures, formulas, wide tables, library, study, notes, tasks, settings, archiving, dark mode, and different desktop sizes for readable content and usable controls.

## Dependencies and data boundaries

Local rendering does not require a CDN. Third-party code is retained in `vendor/`: PDF.js 5.6.205 under Apache-2.0, Marked 17.0.5 under MIT, and Lucide 1.8.0 under ISC with some MIT icons. Their licenses remain included; this is not original project code.

`sample.json` contains existing public explanations, references, structured original formulas, and public content fingerprints. It excludes model configuration, API keys, fee ledgers, internal requests, and complete production state. It defines this interface sample's format and content, not a site-wide synchronization API.

Current clients synchronize through the [website index and published pages (Chinese)](../../docs/mac-app-data.md). The [`desktop/v1` design (Chinese)](../../docs/desktop-data-contract.md) describes an optional future interface. Prototype samples, the current compatibility adapter, and the proposed interface have separate formats. Website generation, review, and publishing keep their normal workflow.
