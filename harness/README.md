# Harness

| File | Role |
| --- | --- |
| `web/rulith-web.cordis.yml` | Overlay for dsh's web profile: disables dsh's local tools, tool presets, DeepSeek account, feedback, telemetry and session upload, and its own file browser and terminal (they act on dsh's workspace folder outside Rulith); adds the tool-free preset `rulith` and the plugins below. It does not set the model (see the launcher). |
| `web/rulith-runtime.mjs` | Host plugin. Starts or attaches the Rulith Runtime manager, registers the six Rulith MCP tools for the selected Agent, waits for held calls to settle, and serves `/rulith/api/*` (same-origin header and loopback Host required) for the browser half. |
| `web/board-transcript.mjs` | Before each model request, lays out the Rulith results the model sees: the latest shows the whole Board one item per line with `+`/`-` marking what changed since the previous Board, earlier ones keep only their changes (the person's transcript keeps the originals; see `model-visible.md`). |
| `web/rulith-web-gate.mjs` | Restricts dsh agents to the six Rulith tools and appends the gate addendum to the persona. |
| `web/rulith-dsh-ui/` | Browser plugin: the Rulith account entry (bottom left) and, as in the Rulith Runtime's three columns, the right column of every session: Cases, recent operations, the current frontier and the local Worker's activity, with the Source bindings Console locked. It holds no key: the workbench link is fetched on demand through `/rulith/api/workbench`. |
| `web/start-deep-rulith.mjs` | Launcher. Reads the settings file, takes the model from Rulith's model settings and keeps it as the route `rulith-model` in the profile's own `cordis.patch.yml` (the layer dsh's Models page edits, so providers added there survive restarts; the default model points at `rulith-model` until the person picks another), then starts dsh's web profile with the overlay. The model key is passed only in the child's environment. |
| `rulith-mcp.mjs` | The only MCP client: one serial session per Agent; HTTP only to loopback. |
| `rulith-gate.mjs` | Gate addendum text. |
| `runtime-persona.txt` | Persona snapshot. |
| `model-visible.md` | Every string the model sees beyond the Rulith tool schemas and results. |
| `rulith.cordis.yml`, `rulith-dsh-role.mjs` | Experimental headless role for the Runtime manager (no web UI), with per-session step, wall-time and prompt-token caps. |

Long calls: the Gateway holds a call for up to 50 s and then answers `running`; the host plugin
keeps waiting until the call settles. `RULITH_DSH_WAIT_SECONDS` sets an optional upper bound.
