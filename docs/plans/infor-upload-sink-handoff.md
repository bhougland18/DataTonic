# Infor Upload Sink — Handoff (2026-09-03)

Continuation notes for the Infor bulk-upload sink (`snk.infor`). Read this with
the full design in [infor-upload-sink.md](./infor-upload-sink.md), and the build
memories `duckle-build-commands` / `duckle-web-build` / `datatonic-repo-layout`.

## Status
- **P1 (discovery)** committed `c18b1cf`. **P2 (rail mapper + live test)** committed
  `d0591eb`. Both pushed to `feature/rail` (origin = github.com/bhougland18/DataTonic, the fork).
- **Frontend is done and live-tested** against ROIHS_PP1: sign in → class → action →
  auto-mapped field map → **Test upload** POSTs real rows and shows per-record results.
- **P3 (engine sink) NOT started.** Today `snk.infor` only stores config on the node
  and its uploader runs the test; a pipeline *run* does not yet upload.

## What it is / how it works
Rail-based uploader (mirrors the API Playground rail, NOT a modal — deliberate, see
the DAA.45 fork-complexity task). The Infor sink node has an **"Open Infor uploader"**
button (PropertiesPanel) → opens `Playground` in `kind:'upload'` mode →
`InforUploadWorkspace`. It reuses `InforProvider` (auth), `discovery`/`classCache`
(classes), `fetchClassSwagger`, and `parsePostActions`. "Apply to node" writes the
mapping + options back to the node's props.

## Key files
- `frontend/src/playground/providers/infor/inforActions.ts` — pure swagger parser:
  action list from the batch `{action}` enum; per-action fields = the class's full
  writable set (richest schema = Create's allFields) with that action's required keys.
- `.../infor/discovery.ts` — `fetchClassSwagger` (loads via `ionapi-doc?swaggerEndpoint=<ref>`).
- `.../infor/InforUploadWorkspace.tsx` — the uploader UI (class/action pickers, field
  map with per-field column dropdowns, live dataset preview, **Test upload** → modal,
  `summarizeBatch` parser, Apply-to-node).
- `frontend/src/playground/Playground.tsx` — `kind:'upload'` branch → InforUploadWorkspace.
- `frontend/src/App.tsx` — `handleOpenUploader` (passes datasetColumns + datasetRows from
  the upstream node's `data.schema`/`data.sampleRows`), `handleApplyInforUpload`
  (writes props, alias = `<Class>-Sink`).
- `frontend/src/workflow-ui/PropertiesPanel.tsx` — the "Open Infor uploader" button.
- `frontend/src/workflow-ui/{palette-data.ts, fields/manifest-synth.ts}` — `snk.infor`
  registration: Sinks group, `synthInforSink`, and a **main input + main output** port
  (sinks are normally input-only; this one emits per-record results).

## Confirmed endpoints/mechanics (live)
- `restBase` = `{ionApiBase}/{tenant}/{app}/{module}/soap` (FSM → `FSM/fsm`, HCM → `LAWSONGHR/hcm`).
- **Swagger:** `GET {restBase}/ionapi-doc/?swaggerEndpoint=<url-encoded ref>` (ref e.g. `../../consolidated/ic/Item`).
- **Upload (batch):** `POST {restBase}/classes/{Class}/actions/{action}/batch?_maxFailures=-1`,
  body `{"_records":[{"_fields":{"<ApiField>":"<value>", …}}]}`.
- **Response:** JSON array of `{_fields, message}` per record + a trailing `{"batchStatus":"0"}`
  (0 = success). Success message = `"Item updated"`; errors carry the full descriptive text.
- **Single (reference):** `POST {restBase}/classes/{Class}/actions/{Action}?_out=JSON`.
- **Node props** written by Apply: `connectionRef, dataArea, businessClass, action,
  mapping ({apiField: datasetColumn}), confirmWarnings, trimAlpha`. `alias = "<Class>-Sink"`.

## P3 — Engine batch sink + results output (NEXT)
Model on `run_salesforce_bulk_sink` (`crates/duckdb-engine/src/connectors.rs:973`) — the
batched-REST-POST-with-auth template. Steps:
1. Add `InforSinkSpec` (`plan/specs.rs`) + `run_infor_sink` (`connectors.rs`), wire into the
   `snk.*` dispatch (`plan/mod.rs`) and the runtime (`lib.rs`).
2. Read the node props (mapping/action/businessClass/dataArea/connectionRef/confirmWarnings/trimAlpha).
3. **Auth engine-side:** reuse `src.infor`'s token mint (`builders.rs` ~9428, `inforPassword`/
   client-credentials) — discovery/test run in the frontend, but the sink runs headless.
4. Read upstream rows; build `{_records:[{_fields:{apiField: value}}]}` from the mapping
   (trim string values if `trimAlpha`); POST to the batch endpoint with `_maxFailures=-1`.
5. **Emit a results OUTPUT relation** (`"<node_id>"`): one row per input record with the
   input columns plus `_status` / `_message`. Give the stage an output so downstream reads it.
6. **Classify results:** `ok` / `skipped` (benign "already exists" / duplicate — see the
   design doc's Create test-vs-run section) / `error`. `failOnError` trips only on `error`.
7. Register `snk.infor` in the engine so a run doesn't hit an unknown-sink error.

## P4 — polish
- Optional `resultsPath` success/error CSVs (parity with SF/DHIS2 sinks).
- Rebuild the runner (`cargo build -p duckle-runner`; **stop the running server first** — exe lock),
  restage into the desktop bundle if needed, end-to-end smoke test.
- The minor UI tweaks the user mentioned (unspecified — ask).

## Open questions / TODOs
- **Exact duplicate-Create error message** — capture one (Create on an existing Item) to tune the P3 classifier.
- **`confirmWarnings`** — how it maps to the batch API is unknown; investigate (a param? a header?).
- **Action list** can't be trimmed to Infor Spreadsheet Designer's curated 12 — no swagger signal
  (all actions share `tags:["Actions"]`, no `x-*`). Kept full list + search; a heuristic/allow-list
  trim was offered and deferred.
- **Live preview** uses the upstream node's cached `sampleRows` (needs a prior run). A true
  in-rail preview-run could be added later.

## Build / run (critical)
- Web frontend: `cd frontend && DUCKLE_WEB=1 npx vite build` → outputs `frontend/dist-web`
  (the `DUCKLE_WEB` flag aliases `invoke` to the HTTP shim — WITHOUT it Infor auth breaks with
  "Cannot read properties of undefined (reading 'invoke')").
- Serve: set `DUCKLE_DUCKDB_BIN` to the bundled `.duckdb-cli-v1.5.3/duckdb.exe`, then
  `duckle-runner web --dist frontend/dist-web --port 8734 --workspace <infor-demo-ws>`.
  **Run it from the user's OWN terminal** — an agent-launched server dies at the session
  boundary (symptom: "TypeError: Failed to fetch" on Run).
- Regenerate the MCP catalog after palette/manifest edits: `cd frontend && npm run export-catalog`.
- `npm run build` currently FAILS on pre-existing TS errors in `InforWorkspace.tsx` — use
  `npx vite build` (skips the tsc gate).
