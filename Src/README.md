# Component Log

A static, mobile-friendly website for photographing electronic parts, reading their package markings, reviewing a session, and archiving an inventory in the current browser.

## Run locally

From `Src`, start any static file server. For example:

```powershell
python -m http.server 8000
```

Open `http://localhost:8000`. Localhost is allowed to use the browser camera; deployed use requires HTTPS. No app installation or build step is required.

Run the focused logic tests with:

```powershell
npm test
```

## Deploy to GitHub Pages

The workflow at `.github/workflows/pages.yml` publishes the contents of `Src`. Add this project to a GitHub repository, push the `main` branch, then in the repository open **Settings → Pages** and select **GitHub Actions** as the deployment source. The workflow deploys on later pushes to `main`.

The page and assets use relative URLs so the app also works at a GitHub project-page subpath.

## Deploy to IIS

Publish the contents of `Src` into the physical folder configured as the IIS application. Keep the `ocr/models` directory structure and include `web.config`; it maps `.onnx` model files and `.wasm` runtime files to their required static-content MIME types. If IIS returns an error after adding the config, ensure the IIS Static Content feature is installed and check that the `system.webServer/staticContent` section is allowed for the application.

## Tabs and capture

- **Tools** is the start page. **Scan components** requests camera access only after the user taps **Open scanner**. The **Multi capture** and **Video capture** cards are visibly marked as planned and disabled.
- The camera scanner opens in a near-full-screen view to maximize the preview area. On devices that expose camera zoom controls, a zoom slider appears over the preview. Take a still photo or choose photos from the device; each photo is processed immediately and results appear in **Session**.
- To try the supplied examples, choose photos from `tests/sample-images/`; the folder includes all 96 labeled Pi reference photos and `labels.csv`. Low-confidence OCR is flagged for review, and markings can be edited before archiving.
- The browser uses foreground segmentation to propose separate visible objects and aligns each component crop before running the supplied PP-OCRv3 detector and PP-OCRv5 English recognizer locally with ONNX Runtime Web. If segmentation finds no separate object, it tries OCR on the full photo so a missed boundary does not automatically discard the capture. The roughly 10 MB model files are served with the site; the ONNX Runtime Web JavaScript/WASM runtime is fetched from jsDelivr on first use. No image is sent to a service and Gemini is not used for recognition.
- **Session** is saved on the device so unarchived scans survive a page reload. Click a scan thumbnail to open its full-size photo and edit its name, marking, manufacturer, description, datasheet URL, and pinout/notes; save changes to the local session before archiving. Capture time and OCR confidence are shown for reference. Duplicate and low-confidence scans are automatically selected for quick deletion (you can uncheck them); select and delete individual or multiple scans, delete all pending scans, and archive the remaining scans into History.
- **History** groups matching part numbers, shows captured quantities, supports substring search across record fields, and paginates results (50 per page by default). Deleting a History component requires confirmation and removes all archived captures grouped under it.
- **About** describes recognition and storage limitations. **Config** stores the optional Gemini API key.
- Continuous live auto-scanning and dedicated multi-capture mode are not implemented yet; they are follow-on capabilities.

Run `tests/ocr-benchmark.html` from the local server to measure exact and one-character-near matches on the 96 labeled sample photos without changing the inventory. An exact match means the labeled part number appears in the OCR text; the near-match score allows one edit. The current browser run measured 77/96 exact matches (80.2%) and 87/96 within one edit (90.6%), up from 73/96 exact before conservative O/0 and S/5 ambiguity correction. The Pi reference reports 84/96 exact matches (87.5%) for its native Go/ONNX pipeline; that is a separate implementation and remains more accurate on this sample set. The sample set is useful for tuning but is not a held-out evaluation, and it mostly contains single-component photos. Validate detection and OCR with your own camera, lighting, component spacing, and mobile devices before relying on inventory accuracy. A connected silhouette may be reported as one candidate, and closely spaced parts or shadows can affect detection. OCR is a marking suggestion, not a guaranteed component identity.

Run `tests/iphone-ocr-benchmark.html` to evaluate the labeled phone images in `tests/IPhoneTests/`. This set tests larger, less controlled photos and multi-part scenes; its token-hit score is specific to its labels and is not directly comparable to the single-marking sample benchmark. It reports both the selected OCR rotation and the best possible result across all rotations, and ignores descriptive words in unquoted labels. The resistor photos and chart are annotated in `tests/IPhoneTests/resistor-labels.csv`; the chart examples are marked `train` and the six desk resistors are held out as `test`. `resistor-code.js` decodes supplied band names using the standard resistor color code, and tests validate all 18 labels. This is a deterministic decoder, not a trained image-recognition model; one chart and one photo are not enough to train a reliable visual classifier.

## History export and AI details

- Accepted captures are stored in IndexedDB for the current browser origin/device. Clearing browser/site data can erase the inventory. No cloud sync is provided.
- Export downloads `components.md`, with the sample's title/count/table format and an `Items` quantity column so repeated physical captures are retained.
- Gemini details are optional and requested only by tapping **Details** on a History record. The app uses Google's Interactions API with `gemini-3.8-flash`. Enter your own Gemini API key in Config; it is saved in browser local storage on this device and sent directly to Google's Gemini API. No photo is sent in the details request.
- This public client-side app is not a key vault: a saved key is accessible to this app and the browser environment. Use a restricted key, manage quotas, and remove it when finished. Do not reuse a sensitive key. The key is not included in the Markdown export.
- Verify AI-provided pinouts and datasheets against manufacturer documentation.

## Project files

- `index.html`, `styles.css`, and `app.js`: responsive tabbed interface and capture/session/history flows.
- `vision.js`: browser-side multi-object segmentation, body alignment, and marking normalization.
- `ocr/browser-ocr.js` and `ocr/models/`: local PP-OCR inference in the browser; model provenance is documented alongside the assets.
- `inventory.js`: IndexedDB persistence, duplicate suggestions, and Markdown export.
- `tests/`: focused image-segmentation, duplicate-review, and export tests.
- `../requirements.md`: agreed product requirements.
