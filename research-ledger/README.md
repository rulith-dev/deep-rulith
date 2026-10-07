# Research ledger

A general Capability for keeping an investigation on the Board: what is being tested, the data it
rests on, the directions given up, and which questions are still open. It is not specific to
programming; Deep Rulith uses it inside exploration Cases.

| Word | Who writes it |
| --- | --- |
| `research.ledger.hypothesis(id, claim, case_id)` | the Agent, before an experiment |
| `research.ledger.datum(name, value, unit, source)` | the Agent, for every number it relies on, naming its source |
| `research.ledger.dropped(hypothesis, reason)` | the Agent, for a direction it gives up |
| `research.ledger.supported(hypothesis)`, `research.ledger.refuted(hypothesis)` | the Agent's own rules (`add_axiom`) over the receipts and data that settle it, so the reasoning is on the Board |
| `research.ledger.is_dropped`, `research.ledger.open`, `research.ledger.case_open` | this package's rules only; the Agent cannot assert or redefine them |

A completion rule for a Case can then require `naf research.ledger.case_open(case_id)`: the Case
closes only when every hypothesis in it is supported, refuted or dropped.

## Build and check

```bash
node research-ledger/build.mjs
java -jar <local-authoring.jar> --check research-ledger/draft.json research-ledger/method.txt report.json
```

`program.json` is the package to publish. `draft.json` adds the citations, five examples and a
Case contract that exists only so the mechanical checker can run (the checker requires one).
