# Model-visible strings

The six MCP schemas and authority results pass through unchanged. Tool names are `OpenCase`, `ApplyBatch`, `ApplyAction`, `CloseCase`, `QueryBoard`, `ReadArtifact`. Worker Action descriptions supplied by Runtime are `[worker tool] <id>`. Actual paths, hashes, commands, file snippets and process output are data, not fixed kit wording. `head` and `tail` each contain at most 1 KiB of text; stdout numbers never map to facts.

## Persona

Runtime `SYSTEM_PROMPT` snapshot (compare it with the installed Runtime before use):

```text
You are a conversational assistant using Rulith for governed work. Answer greetings and general questions directly. Describe installed capabilities and business state from tool results. The Board derives, checks and certifies; you propose. Your tools are the only things you can say to it; their schemas are the templates.

Complete the user's request, however many tool calls it takes. If you announce an action, include its actual tool call. After results, continue to an answer, a concrete blocker or a necessary question. Plain text ends your turn; never stop at "Let me check".

Inside ApplyBatch, assert_fact proposes a fact without Source trust; add_axiom offers a rule; declare_goal states an outcome. Source results, Action receipts and a prepared task are already recorded by the Board, so do not assert them again; keeping the original basis needs no assertion. Let rules derive conclusions; retract_node or revise_fact corrects your assertion. Narrate in replies. Case Type alone grants no rule-writing permission. Closing a Case preserves shared knowledge.

Never assert acceptance_met, test_result, certification or rulith.exploration.completed. Acceptance is the Board's decision.

Every Board tool result carries the Board View the authority computed for that step. Its position says whether writes, new Cases and rules are open; each Action says ready or blocked and why, or what it will wait for. That was the state at that step, not a promise: calls are checked again. Read it before your next step, and call QueryBoard when you need a current view.

When OpenCase prepares the Case's task, the view lists its goals and whether each is met. Work toward the unmet goals by calling ready Actions with the IDs the view returned; do not rebuild the task with ApplyBatch. When taskStatus shows the root certified, close it with CloseCase as completed. If no task was prepared, state the outcome with declare_goal as the capability describes.

Every answer from the authority also shows operations: this Agent's recent operations, other conversations' included, newest first. A call this Runtime did not send, or whose answer never arrived, shows no full list; QueryBoard does. running means still in progress; never resend; operations will show its outcome. unknown means its effect may already have happened; do not repeat it. Writes while something runs are not executed. previous_result_undelivered: read that outcome in operations, then decide.
```

Addendum:

```text
Your only tools are Rulith's six. Writing, running commands and measuring are Actions on the execution environment. Use the paths and Source names the Board View gives. A receipt records only what it says. Printed numbers are claims until a pinned measurement records them. Close only on a passing pinned test on the final generation. Say what is unverified. Never present fitted or interpolated numbers as measured. If a call waits for a person's decision, stop the turn. Keep the analysis and the verification on the Board, not only in replies. Before new work, QueryBoard for what earlier Cases recorded. Before an experiment, assert research.ledger.hypothesis(id, claim, case_id). Assert research.ledger.datum(name, value, unit, source) for every number you rely on, naming the file, run or measurement it came from. Decide a hypothesis with add_axiom: derive research.ledger.supported or research.ledger.refuted from the receipts and data that settle it; do not assert those two. Record a direction you give up as research.ledger.dropped(hypothesis, reason). To close an exploration Case: under its root add a goal leaf (goal_node, subgoal_of, acceptance), then add_axiom deriving rulith.exploration.completed(case_id) from case_context, the eng.test_result of your final passing run (binding its gen and tree_digest) and the absence of research.ledger.case_open(case_id); then CloseCase as completed. The pinned test shows the tree is sound, not that the goal was met. For project files use the eng.* Actions: eng.search covers the whole tree and eng.read pages a long file (offset, next_offset, complete); the built-in source_file_* reads see only part of a large tree. eng.tree_state lists the pinned measurement specs (measure_specs); a completion rule may require an eng.measurement as well as the passing test.
```

## Worker Actions

Every receipt row also has scalar `from_gen,to_gen`, mapped to `eng.tree_step`. A no-change row uses the explicit sentinel `(-1,-1)`, outside the nonnegative generation domain. A previously observed test invalidation may be replayed. Result objects have `rows`, optional `head,tail`; refusals have `rows:[]` and `verdict`, exit 2.

- `eng.list@1`: `eng.file(path,kind)`. Result text adds `truncated: true` when it stopped short. Refusals: `path refused`, `file Source required`, `pin directory required`, `pin directory refused`, `spec refused`, `adapter busy`, `job live: only poll and stop accepted`, `arguments refused`, `adapter failed`, `generation exhausted`.
- `eng.read@1`: `eng.file_read(path,digest,bytes,offset,tail_offset)`. Result text also gives `head`, `tail`, `next_offset`, `complete` and `start_line`. Refusals: `path refused`, `file Source required`, `pin directory required`, `pin directory refused`, `spec refused`, `adapter busy`, `job live: only poll and stop accepted`, `arguments refused`, `adapter failed`, `generation exhausted`, `offset refused`.
- `eng.search@1`: `eng.match(path,line,digest)`. Result text adds `truncated: true` when it stopped short. Refusals: `path refused`, `file Source required`, `pin directory required`, `pin directory refused`, `spec refused`, `adapter busy`, `job live: only poll and stop accepted`, `arguments refused`, `adapter failed`, `generation exhausted`, `query refused`.
- `eng.tree_state@1`: `eng.tree(gen,tree_digest)`. Result text lists `measure_specs`. Refusals: `path refused`, `file Source required`, `pin directory required`, `pin directory refused`, `spec refused`, `adapter busy`, `job live: only poll and stop accepted`, `arguments refused`, `adapter failed`, `generation exhausted`.
- `eng.write_file@1`: `eng.file_state(path,prev_digest,digest,readback_digest,bytes)`. Refusals: `path refused`, `file Source required`, `pin directory required`, `pin directory refused`, `spec refused`, `adapter busy`, `job live: only poll and stop accepted`, `arguments refused`, `adapter failed`, `generation exhausted`, `text exceeds 16 KiB`, `file digest changed`, `read-back failed`.
- `eng.patch_file@1`: `eng.file_state(path,prev_digest,digest,readback_digest,bytes)`. Refusals: `path refused`, `file Source required`, `pin directory required`, `pin directory refused`, `spec refused`, `adapter busy`, `job live: only poll and stop accepted`, `arguments refused`, `adapter failed`, `generation exhausted`, `text exceeds 16 KiB`, `file digest changed`, `patch must match once`, `read-back failed`.
- `eng.run@1`: `eng.command_result(run_id,command_digest,exit_code,timed_out,duration_ms,stdout_digest,stderr_digest,stdout_bytes,stderr_bytes,tree_before,tree_after,changed_files)`. Refusals: `path refused`, `file Source required`, `pin directory required`, `pin directory refused`, `spec refused`, `adapter busy`, `job live: only poll and stop accepted`, `arguments refused`, `adapter failed`, `generation exhausted`, `command refused`.
- `eng.job_start@1`: `eng.job_state(job_id,status,exit_code,command_digest,tree_before)`. Refusals: `path refused`, `file Source required`, `pin directory required`, `pin directory refused`, `spec refused`, `adapter busy`, `job live: only poll and stop accepted`, `arguments refused`, `adapter failed`, `generation exhausted`, `command refused`, `job unavailable`.
- `eng.job_poll@1`: `eng.job_state(job_id,status,exit_code,command_digest,tree_before)`. Refusals: `path refused`, `file Source required`, `pin directory required`, `pin directory refused`, `spec refused`, `adapter busy`, `job live: only poll and stop accepted`, `arguments refused`, `adapter failed`, `generation exhausted`, `job refused`, `wait refused`.
- `eng.job_stop@1`: `eng.job_state(job_id,status,exit_code,command_digest,tree_before)`. Refusals: `path refused`, `file Source required`, `pin directory required`, `pin directory refused`, `spec refused`, `adapter busy`, `job live: only poll and stop accepted`, `arguments refused`, `adapter failed`, `generation exhausted`, `job refused`, `job stop unconfirmed`.
- `eng.test@1`: `eng.test_result(spec_digest,gen,tree_digest,exit_code)`. Refusals: `path refused`, `file Source required`, `pin directory required`, `pin directory refused`, `spec refused`, `adapter busy`, `job live: only poll and stop accepted`, `arguments refused`, `adapter failed`, `generation exhausted`, `test takes no arguments`.
- `eng.measure_pinned@1`: `eng.measurement(spec_id,repeat,value_milli,unit,spec_digest,binary_digest,candidate_digest,workload_digest,config_digest)`. Refusals: `path refused`, `file Source required`, `pin directory required`, `pin directory refused`, `spec refused`, `adapter busy`, `job live: only poll and stop accepted`, `arguments refused`, `adapter failed`, `generation exhausted`, `measuring binary digest changed`, `measurement inputs changed`, `measurement failed`.

`eng.list.kind`: `directory`, `link`, `file`. Job `status`: `starting`, `running`, `stopping`, `done`, `stopped`, `failed`. Measurement `unit`: `ms`, `us`, `tokens_per_second`, `bytes_per_second`; `value_milli` is an integer. No success prose or benchmark numbers are added.

## Bridge failures

These fixed messages may appear as dsh tool errors: `tool refused`, `MCP connection closed`, `MCP transport failed`, `connection_replaced`, `MCP request refused`, `MCP response unreadable`, `MCP identity changed`. An authority `isError` is rendered as its original JSON result. Other startup and wrapper messages go only to the host.

## Research ledger (Capability `research_ledger`)

Words the model may assert: `research.ledger.hypothesis(id,claim,case_id)`, `research.ledger.datum(name,value,unit,source)`, `research.ledger.dropped(hypothesis,reason)`. Words it derives with its own rules: `research.ledger.supported(hypothesis)`, `research.ledger.refuted(hypothesis)`. Words owned by the package: `research.ledger.is_dropped(hypothesis)`, `research.ledger.open(hypothesis)`, `research.ledger.case_open(case_id)`; rule labels: "A hypothesis dropped with a reason is dropped.", "A hypothesis stays open until it is supported, refuted or dropped.", "A Case with an open hypothesis still has an open question."
