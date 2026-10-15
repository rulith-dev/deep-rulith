# Deep Rulith

Deep Rulith is built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh)
and gives it [Rulith](https://rulith.ai) as its tools, beside dsh's read-only web search and fetch. It uses dsh's web UI and agent, with a
profile overlay that adds a Rulith account entry (bottom left) and keeps the Rulith Runtime's three
columns (sessions, conversation, and on the right this environment's execution: goals, operations,
frontier and the local Worker), replaces
every other local dsh tool with Rulith's three MCP tools (`rulith/v4`), and turns off dsh features that would act outside
Rulith or cut its results (subagents, goals, workflows, plan mode, result pruning). Long conversations
are condensed by dsh's automatic compaction; the summary is a recap, not evidence. Reading, editing,
building and testing happen only
through Rulith Actions executed by your own Rulith Worker, so every effect has a receipt on the
Agent's Board and a goal completes only when the Board certifies it from evidence.

It is also a worked example of a third-party agent harness using Rulith.

> Alpha. Not affiliated with DeepSeek. See [NOTICE](NOTICE).

## What is in this repository

| Path | What it is |
| --- | --- |
| `harness/web/` | The dsh web profile overlay (`rulith-web.cordis.yml`), the host plugin that runs the Rulith Runtime manager beside dsh (`rulith-runtime.mjs`), the tool gate, the browser plugin (`rulith-dsh-ui`) and the launcher. |
| `harness/` | The MCP bridge (`rulith-mcp.mjs`), the gate and persona text shared with the web profile, and an experimental headless role. |
| `research-ledger/` | A general Capability for keeping an investigation (hypotheses, data, decisions) on the Board. |
| `engineering-work/` | Worker adapters for programming work on one project directory (`eng.read`, `eng.write_file`, `eng.patch_file`, `eng.run`, `eng.test`, jobs, …) and the Capability that accredits their results. |
| `test/` | Node tests. |

Deep Rulith adds nothing to the Rulith Runtime; it uses the `rulith` package (0.13.0 or later),
installed by `npm install` in this repository.

## What leaves your computer

- Model requests, including file text and command output the model has seen, go to the
  OpenAI-compatible endpoint set in Rulith's model settings. The overlay uses DeepSeek's thinking
  format and a 1M-token context window; change `rulith-web.cordis.yml` for other models.
- Tool calls go to the Rulith Gateway you sign in to. Worker receipts recorded on your Agent's
  Board include bounded file text (up to 1 KiB head and tail), command output and digests.
- The model's native web tools (D-1015c, read-only and outside Rulith): `web_search` sends its queries to DeepSeek's
  search API with the model key, offered only when Rulith's model is DeepSeek's own API; `web_fetch` sends GET requests
  to public http(s) URLs (local, private and link-local addresses are refused). Their results leave nothing on the Board.
- dsh telemetry, feedback, session upload and the DeepSeek account integration are disabled by the overlay.

## Setup (manual, alpha)

Requires the Node.js version dsh requires.

1. Run `npm install` in this repository (it installs the Rulith Runtime). Create a manager home
   directory and a key file holding a random key of at least 16 letters and digits; Deep Rulith
   starts the Runtime manager with that home and key.
2. In Rulith Console create an Agent for this project. Build the `engineering_work` Capability
   with `node engineering-work/pack/build-pack.mjs` (it declares Source `lab`), publish it from
   your Publisher in Console and install it on the Agent.
3. Install dsh in its own folder: `npm install @deepseek-ai/dsh@0.2.1-alpha.1`.
4. Copy [`deep-rulith.example.json`](deep-rulith.example.json) and fill in the paths.
5. Copy `deep-rulith.example.json` to `deep-rulith.json` in this folder (ignored by git) and fill in the paths. Create the dsh profile once: `Deep-Rulith.cmd --init` (or `node harness/web/start-deep-rulith.mjs deep-rulith.json --init`).
6. Start: double-click `Deep-Rulith.cmd` (or `node harness/web/start-deep-rulith.mjs deep-rulith.json`) and open the printed URL.
7. Bottom left → Rulith account: sign in, choose the Agent, enable the local Worker. Set the model
   (endpoint, model name, key) under 更多设置 (the Rulith workbench), then restart Deep Rulith.
   Install the engineering tools on that Agent's Worker with `engineering-work/install.mjs`
   ([engineering-work/README.md](engineering-work/README.md)), then in Console bind Source `lab`
   to the project directory, pin the `eng.*` tools and lock the binding.

## Tests

```bash
RULITH_RUNTIME_DIR=<rulith-runtime checkout> npm test
```

Without `RULITH_RUNTIME_DIR` the tests use the installed `rulith` package. Set `DSH_BASE_FILE` to the installed `@deepseek-ai/dsh-base/cordis.patch.yml` (or `DSH_REFERENCE_DIR` to its source checkout) to run the tool-disable check as well, and `DSH_MODULES_DIR` to the installed dsh's `node_modules` to run the installed-dsh contract checks (sub-agent tools, and the outgoing trim on dsh's real agent loop and request path). The launcher refreshes its shipped browser plugin on every start; upgrading does not require recreating your profile.

## License

Apache-2.0. dsh is MIT-licensed and installed separately; this repository contains none of its code.
