# Harness

| File | Role |
| --- | --- |
| `web/rulith-web.cordis.yml` | Overlay for dsh's web profile: disables dsh's local tools, tool presets, DeepSeek account, feedback, telemetry and session upload, and its own file browser and terminal (they act on dsh's workspace folder outside Rulith); adds the tool-free preset `rulith` and the plugins below. It does not set the model (see the launcher). |
| `web/rulith-runtime.mjs` | Host plugin. Starts or attaches the Rulith Runtime manager, registers the three Rulith MCP tools (`rulith/v4`) for the selected Agent, waits for held calls to settle, and serves `/rulith/api/*` (same-origin header and loopback Host required) for the browser half. |
| `web/shadow-reviewer.mjs` | Advisory pilot: Board-only review, independent shadow seat, one-shot suggestion delivery and local measurements. |
| `web/board-transcript.mjs` | Before each model request, lays out the Rulith results the model sees: the latest shows the whole Board one item per line with `+`/`-` marking what changed since the previous Board, earlier ones keep only their changes (the person's transcript keeps the originals; see `model-visible.md`). |
| `web/rulith-web-gate.mjs` | Restricts dsh agents to the three Rulith tools and appends the gate addendum to the persona. |
| `web/rulith-dsh-ui/` | Browser plugin: the Rulith account entry (bottom left) and, as in the Rulith Runtime's three columns, the right column of every session: goals, recent operations, the current frontier and the local Worker's activity, with the Source bindings Console locked. It holds no key: the workbench link is fetched on demand through `/rulith/api/workbench`. |
| `web/start-deep-rulith.mjs` | Launcher. Reads the settings file, takes the model from Rulith's model settings and keeps it as the route `rulith-model` in the profile's own `cordis.patch.yml` (the layer dsh's Models page edits, so providers added there survive restarts; the default model points at `rulith-model` until the person picks another), then starts dsh's web profile with the overlay. The model key is passed only in the child's environment. |
| `rulith-mcp.mjs` | The only MCP client: one serial session per Agent and seat, declaring `rulith/v4` at initialize; HTTP only to loopback. |
| `rulith-gate.mjs` | Gate addendum text. |
| `runtime-persona.txt` | Persona snapshot. |
| `model-visible.md` | Every string the model sees beyond the Rulith tool schemas and results. |
| `rulith.cordis.yml`, `rulith-dsh-role.mjs` | Experimental headless role for the Runtime manager (no web UI), with per-session step, wall-time and prompt-token caps. |

Long calls: the Gateway holds a call for up to 50 s and then answers `running`; the host plugin
keeps waiting until the call settles. `RULITH_DSH_WAIT_SECONDS` sets an optional upper bound.

Seats (C1, D-1008h): each name in the settings' `seats` (`[{"name":"reviewer","label":"审查"}]`) becomes a dsh Agent preset
`rulith-seat-<name>`. A conversation started with that preset uses its own MCP session declaring the seat at initialize;
the default preset `rulith` is the seat `main` and declares no seat. Add the seat to the Agent in Console first, or the
session is refused. Presets carry no plugins and no model-visible text: tell the conversation its role yourself.

## Shadow reviewer pilot (2026-10-12)

Enabled by default. After the main model receives an accepted Set or a delivered Execute outcome, the Host schedules a
fresh, silent review. An unchanged set of fact/node IDs skips inference; one review runs at a time, and intervening
beats coalesce into the next. Get itself does not trigger review; a later Get can deliver an earlier accepted Set or Execute outcome.
Review does not hold the main tool result or wait at certification. A finding can arrive after a turn or certification;
it is advisory, and another Rulith tool result is needed to deliver it. Shared inference resources may still compete.

The input is the current Get discovery view plus `include:["nodes"]` for the main seat's authority-reported focused
goals, with full view limits preserved, new model facts and prior suggestions. No conversation or reasoning is sent.
The Host writes only `suggestion(id,node,advice)` through an MCP session declaring seat `shadow`. It does not declare
goals, sign off, write defect claims or create a discharge chain. A refusal is visible on stderr and the suggestion
still reaches its originating conversation once, appended to its next Rulith tool result. Transcript rewriting keeps
that note at its original step. If the seat cannot initialize, review uses the delivered view with an explicit missing
supplemental-read marker; its write is recorded as refused. Other read/model/parse failures are visible errors.

Before enabling writes, in Console check the Agent's sign-off setting: adding another seat must not make goals wait
for an extra seat's `sign_off`. Then add a seat named **shadow** to that Agent. The pilot never signs off. Do not add
shadow to the launcher's `seats` list: that list makes interactive presets, which would replace the pilot's session.

In the settings file, `"shadow":{"enabled":false}` switches the pilot off on restart. Otherwise the exact model/provider
of the main request is reused. Override `shadow.provider` and/or `shadow.model` with a configured dsh route, or set
`shadow.modelHome` to a separate Rulith manager home containing the same `model-defaults.json` format the launcher uses
for the main model. This opens route `rulith-shadow`; its key travels only in the child environment. `shadow.maxTokens`
(default 8000, room for the model's thinking) and `shadow.timeoutMs` (default 120000) bound output and model-call time. No input truncation is added.

Local measurements are in `$DSH_HOME/logs/shadow-reviews.jsonl` (manager home fallback). One row is appended per review:
reviewId, time, triggerTool, boardFingerprintSize, deltaSize, provider/model, input/output/cache tokens when returned,
latencyMs, result (pass/suggestion/write_refused/error), node, advice, error when present, noteDeliveredAt and
nextSetReferencedNode. The last two initially remain null and are updated in that same row after delivery and the next
Set of that conversation. Exact node references in the Set arguments count; this measures reference, not adoption or
correctness. A new log row is never counted for that observation. Undelivered/unused suggestions stay null. Reviewer
memory is process-local; restart begins a fresh fingerprint, while Board suggestions remain in the next context.
