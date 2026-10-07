# Engineering work tools

Worker adapters for programming work on one project directory, bound in Rulith as Source `lab`
(type `file`). Plain Node 20+, no dependencies. They give the model ordinary engineering moves —
read, search, list, write, patch, run a command, run a long job, run the owner-pinned test or
measurement — and every one returns a receipt the Board records.

This is a side-effect fence, not a sandbox: commands run as the Worker's operating-system user.

## Install on a Worker

1. Create a kit home directory outside the project with `specs/test.json` (the pinned test; see
   `pinned-test.example.json`), optional `specs/<id>.json` measurements
   (`pinned-measure.example.json`) and optional `settings.json` (below).
2. With the Agent paired and its Worker enabled once in the Rulith Runtime manager, run
   `node engineering-work/install.mjs --manager-home <dir> --agent <name> --kit-home <dir>`.
   It copies the adapters into that Agent's Worker root, merges the twelve `eng.*` tools into the
   Agent's own tool manifest and sets the Worker environment: `ENG_KIT_HOME`,
   `RULITH_WORKSPACE_TOOLS=read` (Console uses the built-in read tools to bind the Source) and
   `RULITH_WORKER_RUN_TIMEOUT_SECONDS` (the longer of `runDeadlineSeconds` and
   `pollMaxWaitSeconds`, plus 60). Turn the Agent's Worker off and on afterwards.
3. Run it again after changing `settings.json` limits.
4. Accreditation: the Board records a Worker result only for predicates its Source accredits.
   Build the Capability with `node pack/build-pack.mjs` and install it on the Agent; it declares
   Source `lab` with the `eng.*` words and adds no rules or Actions.
5. Console: bind Source `lab` to the project root and the Worker Connection, pin the twelve
   `eng.*` tools (allow direct use) and lock. Non-strict exploration mode lets the model supply
   write and run inputs; each such call is marked as not grounded.

## Settings (`<kit home>/settings.json`)

See `settings.example.json`. All fields are optional.

| Field | Default | Meaning |
| --- | --- | --- |
| `runDeadlineSeconds` | 35 | Longest ordinary command; its process tree is killed after this. |
| `jobLimitSeconds` | 0 | Longest background job; 0 means no limit. |
| `pollMaxWaitSeconds` | 35 | Longest wait of one `eng.job_poll`. |
| `allowedPaths` | `[]` | Absolute directories outside the project that commands may name (toolchains, model files). Reads and writes stay inside the project. |
| `allow` | `[]` | Relaxed rules: `install` (project-local dependency installs), `delete` (deletion inside the project), `git_rewrite` (`git reset`, `git clean`), `git_commit` (commits, merges, rebases, tags). |
| `shell` | `false` | Run commands through the system shell (pipes, redirects, `.cmd` scripts). |
| `treeExclude` | `[]` | Project-relative directories left out of the tree digest (build outputs, caches). `.git` is always excluded. |

Always refused: privilege elevation, killing processes or stopping services, push/publish, global
installs or configuration (git subcommands are checked anywhere in a shell line), inline interpreter code (`node -e`, `python -c`, …) and paths that
escape the project or the allowed directories. With `shell: true` these checks see only the
command line as written: a shell or script can still run anything the Worker's user can, so enable
it only for a project you trust.

## Behaviour

- `eng.run` takes a command line and a project-relative `cwd`.
- `eng.read` returns as much text as fits the Worker's inline receipt (8 KiB on rulith.ai; the text is
  counted as it is encoded there): about 5 KB of plain code per call. `eng.read(path)` gives the start
  of the file in `head` and, when the rest does not fit, its last KiB in `tail`; `eng.read(path, offset)`
  gives the window from `offset` in `head`. Both say `next_offset` (where the unread part starts, or
  null), `complete` and `start_line`; paging by `next_offset` from 0 returns the file exactly.
- `eng.write_file` with `expect_digest` `""` creates a file that must not exist yet; to replace a file,
  pass the digest `eng.read` reported for it.
- A read (`list`, `read`, `search`, `tree_state`) walks the tree once, before it runs. `treeExclude`
  entries are paths from the project root, or `**/<name>` for a folder of that name at any depth (for
  example `**/node_modules`). `eng.search` over a path inside a skipped folder walks that folder on demand.
- `eng.list` and `eng.search` keep at most 1.8 KB of rows (a receipt carries every row twice within the
  Worker's inline budget) and add `truncated: true` when they stop short.
- `eng.tree_state` also lists the pinned measurement specs as `measure_specs`.
- `eng.write_file` and `eng.patch_file` require the expected SHA-256 of the current file (the
  digest of empty bytes for a new file) and read the bytes back after writing.
- Long work goes through `eng.job_start`, `eng.job_poll`, `eng.job_stop`. Jobs run in a detached
  supervisor and survive the adapter; while a job is live, only poll and stop are accepted.
- The tree digest covers the project except exclusions; it is cached by size and modification
  time. The generation advances once per receipt whose tree differs from the last one.
- Only `eng.test` produces `eng.test_result` and only `eng.measure_pinned` produces measurement
  facts; numbers printed by other commands never become facts.
- All adapters for one Source serialize through a lock in the kit home.

## Pinned measurements

`<kit home>/specs/<spec_id>.json` pins one measurement; `eng.measure_pinned(spec_id)` runs it `repeats`
times and records `eng.measurement` facts in integer milli-units. The measuring program is `binary`
(inside the project, digest-pinned); `candidate_binary`, `workload` and `config` are recorded or
rechecked on every repeat. Two ways to read the number:

- `json_integer_milli`: the program prints one JSON object (at most 1 KiB) with an integer `field`.
- `json_file_number_milli`: the program writes a JSON `file` inside the project; `path` (keys and
  array indexes, negative from the end) names one number, scaled by 1000. The file must be rewritten
  by the run.

An interpreted harness (for example a Python script) names its `interpreter` (a command name or
absolute path); the command is then `[interpreter, binary, ...]`. See `pinned-measure.example.json`
and `pinned-measure-interpreted.example.json`.

The agent may pin a measurement itself instead of waiting for the owner: it writes the spec to
`<project>/.deep-rulith/measure/<name>.json` and runs `eng.measure_pinned` with `spec_id`
`self-<name>`. The first run copies the spec to `<kit home>/specs/self-<name>.json`, where it never
changes; later edits of the project copy are ignored. The `self-` prefix stays on every receipt, so the
owner can review such specs afterwards and tell them from the owner's own.

## Closing a Case

Declare a goal leaf under the Case root with its acceptance, propose with `add_axiom` that the
exploration is completed when the pinned test passed (`exit_code 0`) at the final generation and
tree digest, then close the Case. The Board certifies completion only from that test receipt.
