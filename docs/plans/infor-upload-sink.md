# Infor Upload Sink (`snk.infor`) — Design

Status: draft / awaiting approval. Author: pairing session 2026-09-03.

A write/upload counterpart to the Infor **source** node: connect an upstream
dataset, pick connection → data area → business class → **action**, visually map
your columns to the action's fields (with auto-map), then **bulk-POST** the whole
dataset (or a row range) to Infor's Action Batch Service.

**UI decision (2026-09-03):** this lives in the **API Playground rail**, with
**identical logic** to the source flow — the same rail shell, Infor provider,
auth, discovery, and pickers — NOT a modal. Rationale: keep the rich full-height
workspace (future Typst editor wants the same space), and share one Infor
provider between read (query) and write (upload). Consolidating the resulting
shared surface is deferred to a tracked follow-up task.

## 1. UX (from the vision)

1. Drop `snk.infor`, wire an upstream node into it (so it knows the dataset's columns).
2. Config on the node: **connection**, **data area** (FSM/HCM), **business class** (e.g. `Item`), **action** (a POST action only, e.g. `Create`, `RequestUpdateItem`).
3. Open the **rail** (same full-height panel as the Playground — the source node's
   "Open in Playground" mirrored as the sink's "Open uploader") showing the mapper:
   - Left panel = the **action's fields** (from the class swagger), required ones flagged.
   - Right of each field = a **dropdown** of the connected dataset's columns.
   - **Auto-map** button: match API field ⇄ column by name (case-insensitive), leave the rest blank; user can override any dropdown.
4. Choose **whole dataset** or a **row range**, then run → batched upload; the node **emits per-record results downstream** (input row + `_status`/`_message`/returned key or error) so you can filter failures, log, or retry in-canvas.

## 2. Infor write mechanics (confirmed from the `Item` swagger)

Server base (per data area): `{ionApiBase}/{tenant}/{app}/{module}/soap` (FSM = `FSM/fsm`, HCM = `LAWSONGHR/hcm`) — same `restBase()` the source uses.

- **Actions are endpoints:** `POST /classes/{Class}/actions/{Action}` (single). The action dropdown in Infor's own "Upload Definition" dialog = these POST actions.
- **Bulk upload (what we use):** `POST /classes/{Class}/actions/{action}/batch?_maxFailures=N`, body:
  ```json
  { "_records": [ { "_fields": { "Item": "...", "ItemGroup": "...", ... } }, ... ] }
  ```
  (record `_fields` shape to be pinned in Phase 3 — the single-action body is a flat field object; the batch wraps records with `_fields` + returns a per-record `message`.)
- **The action decides the fields.** Each action carries field schemas in the swagger, e.g. `Create` → `oneOf: [createMinimumFieldsJSON, allFields]`:
  - minimum = the **required** set (Item: `ItemGroup, Item, Description, StockUOM`)
  - all = every writable field (Item: 138). Other actions have `{Action}_minimumFields` / `{Action}_allFields`.
  The `required` array marks mandatory fields for the left panel's `*`.

## 3. Field/action discovery — reuse the source node's path

The class picker already lists classes via `GET {restBase}/ionapi-doc` (`discovery.ts`, cached by `classCache.ts`), and **each class carries a `swaggerEndpoint`**. The sink:
1. Reuse class discovery (same `ionapi-doc` + cache) to pick the business class.
2. **Fetch that class's `swaggerEndpoint`** (the `Item.json` shape) through the existing `sendRequest` backend path with the playground's bearer token.
3. Parse `paths` for **POST `/classes/{Class}/actions/{Action}`** entries → the action list (this is "the same discovery, but only POST actions").
4. For the chosen action, resolve its request-body schema → field list + `required` → the mapper's left panel.

Auth for discovery = the playground's existing token (frontend). Auth for the actual upload = engine-side, mirroring `src.infor`'s `inforPassword`/client-credentials mint (`builders.rs` ~9428) so it runs headless in a pipeline.

## 4. Node config (props)

`connectionRef`, `dataArea`, `businessClass`, `action`, plus:
- `mapping`: `[{ apiField, column, required }]` (column empty = unmapped/skip).
- `mode`: whole | range; `rangeStart`, `rangeCount` for a range.
- `batchSize` (records per `/batch` call), `maxFailures` (`_maxFailures`), `failOnError`.
- `resultsPath` (optional) — abort-surviving success/error CSVs, matching the Salesforce/DHIS2 pattern.
- cached `actionFields` (the resolved schema) so the node runs without re-fetching.

## 4a. Results & error handling — DELIBERATE divergence: a sink WITH an output

Duckle sinks are terminal (inputs only; `results_path` CSVs are the only "reject
stream", and they survive an aborted stage — `SalesforceBulkSinkSpec`/`Dhis2SinkSpec`).
We want results in-pipeline, so `snk.infor` gets a **`main` output port** (unusual
for a sink; kept in the Sinks group for discoverability).

- **Control:** `failOnError` (fail run on any per-record failure vs. partial success) + `_maxFailures` (server-side tolerance).
- **Output relation** = one row per input record: the input columns plus `_status` (ok/error), `_message`, and any returned record key / error text from the batch response. Engine materializes this as the node's `"<node_id>"` relation so downstream reads it.
- **Optional `resultsPath`:** also write `_success.csv` / `_error.csv` that land even if the stage aborts (parity with the other bulk sinks).
- Surface note: this changes only OUR node's behavior + adds one `portsForComponent` case (a sink with an output) — it does not alter upstream sink semantics. Batch **response** shape is loosely typed in the swagger (200 is generic; 400 = `{code,message}`), so the exact result fields are confirmed live in P3.

## 5. Engine runtime (`InforSinkSpec` + `run_infor_sink`)

Model on `SalesforceBulkSinkSpec` / `run_salesforce_bulk_sink` (`connectors.rs:973`) — the batched-REST-POST-with-auth template:
1. Count rows in `from_view`; 0 → no-op message.
2. Read rows (optionally `LIMIT/OFFSET` for a range) via `run_rows`.
3. For each `batchSize` chunk, build `{ "_records": [ { "_fields": { <apiField>: <column value>, ... } } ] }` using the mapping.
4. Mint/attach the Infor bearer token (engine auth), `POST {restBase}/classes/{Class}/actions/{Action}/batch?_maxFailures=N`.
5. Aggregate per-record `message` results; honor `failOnError`; return a `"infor: N created / M failed"` summary. Optional `results_path` for a success/error CSV (as the SF bulk sink does).

Dispatch: it's a `snk.*`, so it plugs into the `starts_with("snk.")` sink path in `plan/mod.rs`; add an `InforSinkSpec` arm alongside the other HTTP sinks.

## 6. Frontend pieces

- **Palette/manifest:** add `snk.infor` (Sinks group) + a single `main` input port (no output). Register like the other sinks.
- **Rail (identical logic to the Playground):** add an **upload mode** to the API Playground rail, reusing its shell, the Infor provider (`inforAuth`, `discovery`/`classCache`, `sendRequest`), and the connection/data-area/class pickers. The upload workspace hosts: the **action** dropdown (POST actions parsed from the class swagger), the **field→column mapper** (left = action fields with `*`, right = upstream-column `<select>`), an **Auto-map** button (name match), a **whole/range** control, and the **Upload** trigger. Mirror `src.infor`'s "Open in Playground" so `snk.infor` has an "Open uploader" that binds the rail to the node and writes `mapping`/`mode`/range back to node props (same round-trip the source uses for its query).
- Keep the `App.tsx` footprint to the existing rail mount + one branch on node kind (source→query mode, sink→upload mode) — do not add a second rail.

## 7. Open questions / risks

- **Batch record shape** — confirm `{_records:[{_fields:{…}}]}` vs flat `{_records:[{…}]}` against a live `Create/batch` (Phase 3, smallest possible batch).
- **Action variety** — some actions are PUT, some take an id/key, some are side-effect-only. v1 handles **any POST action generically** from its schema; PUT-only actions and required-key actions may need per-action nuance (flag, don't block).
- **Engine auth for upload** — the source's `inforPassword` mint must cover the tenant/data-area the sink targets (the known "no data context" gotcha for service accounts).
- **Discovery vs run split** — discovery (swagger fetch/parse) is frontend; upload is engine. The resolved field list is cached on the node so a headless run needs no frontend.

## 8. Phased plan

- **P1 — Discovery+actions (frontend):** fetch a class's `swaggerEndpoint`, parse POST actions + per-action fields; action dropdown in the config panel. *Deliverable: pick class → see POST actions → see an action's fields.*
- **P2 — Uploader in the rail (frontend):** add the upload mode to the Playground rail (identical logic/shell), with the action dropdown + field→column mapper + auto-map + whole/range; persists mapping to props via the same node round-trip the source uses. *Deliverable: map columns visually in the rail.*
- **P3 — Engine sink (Rust):** `InforSinkSpec` + `run_infor_sink` batch POST to `/actions/{action}/batch`, auth reuse, result summary; confirm payload shape live on a 1–2 row batch. *Deliverable: real upload.*
- **P4 — Polish:** range/whole toggle, `failOnError`, results CSV, error surfacing, palette/manifest, catalog regen, rebuild, smoke test.

## 9. Confirmed live against ROIHS_PP1 (2026-09-03)

- **Class swagger fetch:** the per-class swagger is loaded THROUGH the ionapi-doc
  endpoint, passing the class's relative `swaggerEndpoint` ref (from ionapi-doc
  discovery) as a query param:
  `{restBase}/ionapi-doc/?swaggerEndpoint=<url-encoded ref>`
  (e.g. `…/soap/ionapi-doc/?swaggerEndpoint=..%2F..%2Fconsolidated%2Fic%2FItem`).
  `fetchClassSwagger` tries this first, then direct resolutions as fallback.
- **Action list:** the authoritative full list is the **`{action}` path-param
  `enum`** on the batch endpoint (42 for Item), NOT the handful of dedicated POST
  paths. Each action's fields come from its own endpoint of ANY method (Create is
  POST; Update / ChangeItemStatus / etc. are PUT).
- **Mappable fields per action:** the batch `_fields` accepts any writable field,
  so the mapper offers the class's full writable set (the richest action schema =
  Create's allFields, ~138 for Item) with THIS action's required fields flagged as
  the key(s). Update's own schema is just the Item/ItemGroup KEY - the values to
  change are the other fields.
- **Upload (batch):** `POST {restBase}/classes/{Class}/actions/{action}/batch?_maxFailures=N`,
  body `{ "_records": [ { "_fields": { "<ApiField>": "<value>", … } } ] }`.
- **Single action (reference):** `POST {restBase}/classes/{Class}/actions/{Action}?_out=JSON`.

### Test-vs-run collision on Create — result classification (P3 decision)
The rail **Test** is a REAL batch POST (Infor has no dry-run), so testing N rows
with **Create** actually creates them; the full run then re-attempts those N and
Infor returns an "already exists"-type error per row — noise. Update / idempotent
actions are unaffected.

**Handling (P3):** the engine sink runs `_maxFailures=-1` (never abort) and
**classifies each per-record result** from the response `message` into
`ok` / `skipped` (benign: already-exists / duplicate key) / `error`. `failOnError`
trips only on `error`; the results OUTPUT carries a `_status` column so noise
(`skipped`) is filtered from real `error`s downstream. This also covers Create
re-runs over records that already exist for any reason.

TODO for P3: capture the EXACT duplicate-Create message (test a Create on an
existing Item) to tune the classifier. Alternative considered and rejected for v1:
track successfully-tested row keys on the node and skip them on the run — more
precise but fragile when the upstream data changes between test and run.

### P2 mapper UX target — mirror the Infor Spreadsheet Designer "Upload"
Its Field Map is the model: a list of the class fields, each row =
`[✓ include] <Field, orange if a required key>  →  <Mapped From: dataset column>`.
Plus: **Select All** / **Required Key Fields** quick-select, **Auto-map** by header
name, only checked fields go in the payload, and **Upload / Upload Range / Upload
All** for the row range. The connected dataset shows on the right for reference.
