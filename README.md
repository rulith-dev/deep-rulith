# Deep Rulith

Deep Rulith is built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh)
and gives it [Rulith](https://rulith.ai) as its only tools. It uses dsh's web UI and agent, with a
profile overlay that adds a Rulith account entry (bottom left) and keeps the Rulith Runtime's three
columns (sessions, conversation, and on the right this environment's execution: Cases, operations,
frontier and the local Worker), replaces
every local dsh tool with Rulith's six MCP tools, and turns off dsh features that would act or
rewrite context outside Rulith (subagents, goals, compaction, result pruning). Reading, editing, building and testing happen only
through Rulith Actions executed by your own Rulith Worker, so every effect has a receipt on the
Agent's Board and a Case closes only on evidence.

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

Deep Rulith adds nothing to the Rulith Runtime; it uses the `rulith` package (0.12.0 or later),
installed by `npm install` in this repository.

## What leaves your computer

- Model requests, including file text and command output the model has seen, go to the
  OpenAI-compatible endpoint set in Rulith's model settings. The overlay uses DeepSeek's thinking
  format and a 1M-token context window; change `rulith-web.cordis.yml` for other models.
- Tool calls go to the Rulith Gateway you sign in to. Worker receipts recorded on your Agent's
  Board include bounded file text (up to 1 KiB head and tail), command output and digests.
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
5. Create the dsh profile once: `node harness/web/start-deep-rulith.mjs <your deep-rulith.json> --init`.
6. Start: `node harness/web/start-deep-rulith.mjs <your deep-rulith.json>` and open the printed URL.
7. Bottom left → Rulith account: sign in, choose the Agent, enable the local Worker. Set the model
   (endpoint, model name, key) under 更多设置 (the Rulith workbench), then restart Deep Rulith.
   Install the engineering tools on that Agent's Worker with `engineering-work/install.mjs`
   ([engineering-work/README.md](engineering-work/README.md)), then in Console bind Source `lab`
   to the project directory, pin the `eng.*` tools and lock the binding.

## Tests

```bash
RULITH_RUNTIME_DIR=<rulith-runtime checkout> npm test
```

Without `RULITH_RUNTIME_DIR` the tests use the installed `rulith` package.

## License

Apache-2.0. dsh is MIT-licensed and installed separately; this repository contains none of its code.
