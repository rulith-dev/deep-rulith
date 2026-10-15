# Harness

| File | Role |
| --- | --- |
| `web/rulith-web.cordis.yml` | Overlay for dsh's web profile: disables dsh's local tools except the read-only `web_search` and `web_fetch` (D-1015c), tool presets, DeepSeek account, feedback, telemetry and session upload, and its own file browser and terminal (they act on dsh's workspace folder outside Rulith); adds the tool-free preset `rulith` and the plugins below. It does not set the model (see the launcher). |
| `web/rulith-runtime.mjs` | Host plugin. Starts or attaches the Rulith Runtime manager, registers the three Rulith MCP tools (`rulith/v4`) for the selected Agent, waits for held calls to settle, and serves `/rulith/api/*` (same-origin header and loopback Host required) for the browser half. |
| `web/shadow-reviewer.mjs` | Board-only allow/note/block review before every write on the shared channel; no separate session. |
| `web/board-transcript.mjs` | Before each model request, lays out the Rulith results the model sees: the latest shows the whole view one item per line, earlier ones keep only their changes. The parts a goal read includes (the nodes group: facts, findings, goalNodes, total, rootScope; the gaps group) are compared with the last view that had them, and a view that lacks one is named, not listed as gone; every other key is compared with the previous view. A result's head is one line of JSON with nested JSON strings decoded and long or multi-line text as labelled blocks. A result is laid out when it arrives and when it is demoted, then kept. When the prompt dsh recorded reaches the relief line, older results are relieved in one batch that must free at least 20000 tokens; the batch's boundary is a marked Board result (the person's transcript keeps the originals; see `model-visible.md`). |
| `web/outgoing-trim.mjs` | Trims only the copy of each request that goes out to the model, at dsh's `llm/stream` waterfall: no reasoning from before the latest message from a person, and long string arguments of calls before the latest context-relief boundary (a marked Board result, recognised by `board-transcript.mjs`) shortened to a head and a digest. The session is not changed; a failure or a request path that bypasses it is logged once per conversation. |
| `web/rulith-web-gate.mjs` | Restricts children to the three Rulith tools and the web tools, at depth 1; the main agent also has delegation and control tools. |
| `web/rulith-dsh-ui/` | Browser plugin: the Rulith account entry (bottom left) and, as in the Rulith Runtime's three columns, the right column of every session: goals, recent operations, the current frontier and the local Worker's activity, with the Source bindings Console locked. It holds no key: the workbench link is fetched on demand through `/rulith/api/workbench`. |
| `web/start-deep-rulith.mjs` | Launcher. Reads the settings file, takes the model from Rulith's model settings and keeps it as the route `rulith-model` in the profile's own `cordis.patch.yml` (the layer dsh's Models page edits, so providers added there survive restarts; the default model points at `rulith-model` until the person picks another), then starts dsh's web profile with the overlay. The model key is passed only in the child's environment. It also passes the two context lines from the settings, `reliefRatio` (default 0.7) and `compactionRatio` (default 0.8, dsh's compaction), refusing to start only when the ratios are invalid in themselves, and writes the platform reviewer's route into each enabled Worker's `worker.env`. |
| `web/launcher-settings.mjs` | The launcher's pure parts: the ratio check, the environment that carries the lines to the overlay, and the reviewer's `worker.env` lines, including the optional request extra from `reviewerThinking` or `reviewerRequestExtra`. |
| `web/context-relief.mjs` | The context-relief rules shared by `board-transcript.mjs`, `outgoing-trim.mjs` and the launcher: the two lines (each route's effective lines follow its window and output cap: relief stays at least 20000 tokens before dsh's real compaction line), the relief mark, and how a long argument is shortened. |
| `rulith-mcp.mjs` | The only MCP client: one main session for every hand, declaring `rulith/v4` at initialize; HTTP MCP. |
| `rulith-gate.mjs` | Gate addendum text; restricts the headless agent to the three Rulith tools and the web tools. |
| `web-tools.mjs` | D-1015c: the native read-only web tools (`web_search`, `web_fetch`) beside Rulith's three. `web_search` only with DeepSeek's own key (`RULITH_DSH_WEB_SEARCH_KEY`, passed only when Rulith's model is `https://api.deepseek.com`, and the search endpoint is pinned to DeepSeek's); without it it is not registered. Before dsh fetches, a `tools/execute` guard refuses non-http(s) URLs and hosts that are or resolve to loopback, private, shared (100.64/10) or link-local addresses. |
| `runtime-persona.txt` | Persona snapshot. |
| `model-visible.md` | Every string the model sees beyond the Rulith tool schemas and results. |
| `rulith.cordis.yml`, `rulith-dsh-role.mjs` | Experimental headless role for the Runtime manager (no web UI), with per-session step, wall-time and prompt-token caps. |

Context relief and open sessions: a conversation that was already relieved by the sliding window of 2026-10-14 morning
keeps its relieved results but carries no relief mark, so after an upgrade its old long tool-call arguments go out in full
until the next relief batch (a one-time growth of the prompt). Start long runs on a fresh session after upgrading.

The upgrade is one-way. Results laid out by this version (per-group comparison, result heads with text blocks, relief
marks) are not understood by earlier versions: after any downgrade, including back to 9a52924, start a fresh session.

Reviewer thinking (D-1014c addendum, owner 2026-10-14): the platform reviewer runs on the local Worker's model route, and
`reviewerThinking` in deep-rulith.json decides whether that reviewer thinks, independently of the main agent. `false` or
`true` sends `{"chat_template_kwargs":{"enable_thinking":<bool>}}` with each review request; `"low"`, `"medium"` or
`"high"` sends `{"chat_template_kwargs":{"enable_thinking":true},"reasoning_effort":"<level>"}`; absent sends nothing.
`reviewerRequestExtra` (a JSON object) is written as it is and takes precedence over `reviewerThinking`, so another
engine parameter (for example a thinking budget, if the engine ignores `reasoning_effort`) needs no code change. On every
start the launcher writes the result as `RULITH_REVIEWER_REQUEST_EXTRA` into each enabled instance's `worker.env`, next to
the other `RULITH_REVIEWER_*` keys, and removes that key when neither setting is present. It refuses to start on any other
value of `reviewerThinking`, on a `reviewerRequestExtra` that is not an object, or on a key the Worker controls
(`model`, `messages`, `max_tokens`, `temperature`, `stream`, `tools`, `tool_choice`, `n`). The Worker honours the
key from Runtime 0.16.3; with the rulith dependency still at ^0.16.2 it is ignored.

Long calls: the Gateway holds a call for up to 50 s and then answers `running`; the host plugin
keeps waiting until the call settles. `RULITH_DSH_WAIT_SECONDS` sets an optional upper bound.

Headless disables delegation and shadow because its caps and main-turn lifetime cannot account for those extra calls.

D-1013a: the web main agent delegates with dsh's subagent and subagent_fork, and can send_message or interrupt_agent.
Children inherit the main provider/model and have exactly Get, Set, Execute (and the web tools, D-1015c), at depth 1. Background calls use dsh's
continuable driver; run_in_background:false uses one-shot. dsh's own maxActiveSubagents is 4; the gate additionally
reserves a slot at agent/created across both drivers and cold resume. A scope effect returns it on creation rollback
or quiescent disposal; continuable children naturally dispose after settlement, so completed children free capacity.
Stock presets and shell/file/plugin-manager/job tools remain disabled; every hand also has dsh's web_search and web_fetch (D-1015c).

## One Board channel and shadow (D-1013a)

board-channel.mjs owns one FIFO for all hands and shadow calls on the main MCP bridge. The panel refreshes only
the host's local cache of the latest tool result's Board view and operations strip, with its receipt time;
before the first Board-bearing result it shows no view. Panel reads never send MCP calls. Review reads,
inference and the initial write form one queue entry, keeping the Board and proposed step adjacent. Once the authority
returns running, the FIFO entry releases but a separate operation slot stays held through awaitOutcome and any
suggestion write; other operations wait outside the FIFO while plain Gets and polls pass. Operations are matched
by tool/label/at on the main line; a settled outcome delivered by any other hand is retained for the original requester.
No seat selection, preset generation, per-seat bridge or shadow MCP session remains. Platform admission still permits
only one operation in progress; parallel local thinking does not grant parallel writes in Rulith.
Outcomes belong to the Agent, not a hand: a settled outcome may also appear in another hand's operations strip,
and a waiting_for_decision outcome reaches whichever hand calls next.

In web mode Set always reviews. Execute uses the current authority Action kind when present; Runtime 0.15.1 normally exposes the
managed description [worker tool] <id>, not kind. That exact id is joined to the selected Worker's explicit manifest
kind (local.json worker.env.RULITH_TOOLS_FILE). Only an explicit read
exempts it. Missing, unknown, ambiguous or truncated Action declarations conservatively review. Names, model arguments and an empty returns array
are never read-only signals. This uses existing Gateway managed descriptions and Worker manifests, without a platform change.

Before dispatch the shadow sees default Get plus include:["nodes"] for authority-reported focused goals, the delta
since the last review, prior suggestions and the proposed tool/arguments. File/patch bodies are previewed at 4096
characters. Views retain their limits and omissions. No hand conversation, reasoning or identity is sent to inference.
The exact prompt and model-visible tool/messages are in model-visible.md; the new web main addendum sentence is proposed
for owner review. Children use the headless addendum. Completion certification stays evidence-only.

Allow sends the original call. Note sends it, records only assert_fact suggestion {id,node,advice} through the same
channel without reviewing the suggestion, then appends advice exactly once to that hand's result. A refused or uncertain
suggestion write is visibly logged and is not retried. Block sends nothing and returns the platform's pre-execution refusal shape (errorCode review_blocked);
a second block for the same hand/tool/target/goal/action asks the hand to explain the disagreement to the user.
Malformed, unanchored, failed and timed-out reviews fail open with visible diagnostics. Every write is reviewed even
if the Board is unchanged. Shadow memory and block counts are process-local; Board suggestions survive restart.

shadow.enabled (default true), shadow.maxTokens (8000), shadow.timeoutMs (120000), provider/model/modelHome overrides
keep their existing meanings. In web mode shadow follows the actual request route unless overridden. No separate credential or MCP session is opened for shadow.
Logs remain in $DSH_HOME/logs/shadow-reviews.jsonl (web manager-home fallback): one append-only JSON row per review,
with time, hand, tool, action, verdict, node, advice, latencyMs, tokens and error (null when absent).
