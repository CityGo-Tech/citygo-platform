# Local PDF materials for conversations

A user can select a TXT or a **text-based PDF**, review and edit its extracted text, then explicitly add an excerpt to the current question. Selection and preview do not upload the file, submit a question or create an AI request. The usual Send action remains separate, with the existing mode, reservation and tariffs.

## Bounds and lifecycle

- TXT keeps its existing UTF-8 / 64 KiB / 4000-character input checks.
- PDF: 8 MiB of actual bytes, at most 50 pages, at most 200,000 extracted UTF-16 code units and 20 seconds from the start of reading. Exceeding a bound rejects the document; it does **not** return a silently truncated excerpt.
- The preview contains the full extracted text within these bounds. The user chooses/edits an excerpt; their current question plus the material heading and separators must fit the existing 4000-character question limit.
- Password-protected files are rejected without asking for or storing a password. A scan/image-only PDF produces an explicit no-text message. There is no OCR or third-party document service.
- PDF reading owns a real, app-bundled module Worker, passed explicitly to PDF.js. No CDN worker or fake-worker fallback is used. The port is terminated on success, failure, timeout, back, close, unmount or session abort.
- The current owner, conversation, session signal, availability and latest draft are checked again before publishing or appending. A synchronous confirmation lock prevents double appends; late reads cannot populate a replacement session.
- Application limits bound accepted input and returned text, not a browser-wide heap quota. Malformed or highly compressed files can still allocate parser memory inside the worker until cancellation.

## Parser surface

`pdfjs-dist` is pinned exactly to **6.5.438**, with the worker and API from the same package. Only `getDocument({data})` and streamed page text are used. No viewer, scripting sandbox, annotation DOM, links, attachments, form actions, document URL, remote font/CMap URL, image rendering or file persistence is enabled. Font-face loading, worker fetch, worker rendering, image decoders, WASM, XFA and streaming/range auto-fetch are disabled. The binary-data factory rejects external font/CMap requests rather than fetching them. In this pinned release the old `isEvalSupported` option and eval execution path have been removed; both installed API and worker sources were checked for absence of `eval(` / `new Function(`. No unsupported configuration cast is used. Text and filenames are rendered as React text/textarea values and masked from analytics.

PDF extraction does not preserve the visual layout. Columns, tables, ligatures or missing Unicode font mappings can change text order or make a file unreadable; the user must review the preview. This feature does not attach the original document or provide an unlimited model context.

Primary references:

- [Mozilla release 6.5.438](https://github.com/mozilla/pdf.js/releases/tag/v6.5.438)
- [Mozilla PDF.js API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html)
- [2026 scripting advisory; fixed in 6.2.108](https://github.com/mozilla/pdf.js/security/advisories/GHSA-hq66-cqwq-w95j)
- [2024 eval advisory; fixed in 4.2.67](https://github.com/mozilla/pdf.js/security/advisories/GHSA-wgrm-67xf-hhpq)

## Synthetic validation

All fixtures in `e2e/fixtures/pdf` are synthetic. No user documents or provider credentials are used. The fixture generator needs ReportLab and pypdf, with DejaVu Sans (set `CITYGO_FIXTURE_FONT` when it is not at the standard Linux path). Only an open font subset is embedded; its license is included beside the fixtures.

```sh
python e2e/fixtures/pdf/generate-fixtures.py
node --import tsx --test apps/web/src/components/text-material-state.test.ts apps/web/src/components/pdf-material-state.test.ts
pnpm build
pnpm test:e2e e2e/text-material-preview.spec.ts e2e/pdf-material-preview.spec.ts
```

The browser tests use real local PDF workers and synthetic routed APIs, cover Cyrillic/multipage extraction, full preview over 4000 characters, explicit edited excerpt, malformed/password/no-text/over-page/oversize rejection, worker cancellation and owner replacement. A fixture with PDF JavaScript and a remote URI verifies that neither executes. There are no live AI, email, SMS or payment calls.
