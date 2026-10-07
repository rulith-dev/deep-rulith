// Builds the research-ledger Capability: a general vocabulary for keeping an investigation on the Board (what is
// being tested, the data it rests on, which questions are still open) and three domain rules that decide openness.
// Conclusions (supported / refuted) are the Agent's own rules over recorded receipts and data, so its reasoning is on
// the Board; what counts as "open" belongs to this package and cannot be redefined by the Agent.
//
//   node research-ledger/build.mjs            writes program.json and draft.json (program + examples + citations)
//   java -jar local-authoring.jar --check research-ledger/draft.json research-ledger/method.txt report.json
import fs from 'node:fs';

const at = (name) => new URL(`./${name}`, import.meta.url);
const method = fs.readFileSync(at('method.txt'), 'utf8');
const cite = (ruleId, quote) => {
  const start = method.indexOf(quote);
  if (start < 0) throw new Error(`quote not in method.txt: ${quote}`);
  return { ruleId, quote, locator: { kind: 'character-range', start, end: start + quote.length } };
};

// Every visible ledger row is derived from the Case's own root and context, so a read of that Case's root shows it
// (a read by root follows the root's evidence forward; facts that are not on that path are left out of the page).
const caseOf = [
  { predicate: 'root', args: { node: '?r' } },
  { predicate: 'case_context', args: { root: '?r', case_type: '?t', case_id: '?k' } },
];
const program = {
  // Published as research_ledger_2 (a Board that once had research_ledger 0.1.0 refused any other content under that
  // name while Rulith emitted every Release as Kernel version 1). Since the 2026-10-07 Gateway the version follows the
  // content, so new versions of research_ledger_2 upgrade in place.
  id: 'research_ledger_2',
  title: 'Research ledger',
  summary: 'Keeps an investigation on the Board: hypotheses with their Case, the data they rest on, dropped directions, and which hypotheses are still open. Each Case shows its ledger as research.ledger.item and research.ledger.case_datum rows.',
  vocabulary: {
    defines: [
      { id: 'research.ledger.hypothesis', as: 'hypothesis', args: ['id', 'claim', 'case_id'] },
      { id: 'research.ledger.datum', as: 'datum', args: ['name', 'value', 'unit', 'source', 'case_id'] },
      { id: 'research.ledger.supported', as: 'supported', args: ['hypothesis'] },
      { id: 'research.ledger.refuted', as: 'refuted', args: ['hypothesis'] },
      { id: 'research.ledger.dropped', as: 'dropped', args: ['hypothesis', 'reason'] },
      { id: 'research.ledger.is_dropped', as: 'is_dropped', args: ['hypothesis'] },
      { id: 'research.ledger.item', as: 'item', args: ['case_id', 'hypothesis', 'claim', 'state'] },
      { id: 'research.ledger.case_datum', as: 'case_datum', args: ['case_id', 'name', 'value', 'unit', 'source'] },
      { id: 'research.ledger.case_open', as: 'case_open', args: ['case_id'] },
      { id: 'research.ledger.cites', as: 'cites', args: ['case_id', 'from_case_id'] },
    ],
    imports: [{ id: 'root', as: 'root' }, { id: 'case_context', as: 'case_context' }],
  },
  // Owned by this package: the Agent cannot assert or redefine them.
  pins: ['is_dropped', 'item', 'case_datum', 'case_open'],
  rules: [
    { id: 'ledger_dropped_with_reason', label: 'A hypothesis dropped with a reason is dropped.',
      when: [{ predicate: 'dropped', args: { hypothesis: '?h', reason: '?x' } }],
      then: [{ predicate: 'is_dropped', args: { hypothesis: '?h' } }] },
    { id: 'ledger_item_open', label: 'A hypothesis stays open until it is supported, refuted or dropped.',
      when: [...caseOf, { predicate: 'hypothesis', args: { id: '?h', claim: '?c', case_id: '?k' } },
        { predicate: 'supported', args: { hypothesis: '?h' }, naf: true },
        { predicate: 'refuted', args: { hypothesis: '?h' }, naf: true },
        { predicate: 'is_dropped', args: { hypothesis: '?h' }, naf: true }],
      then: [{ predicate: 'item', args: { case_id: '?k', hypothesis: '?h', claim: '?c', state: 'open' } }] },
    { id: 'ledger_item_supported', label: 'A hypothesis a rule derives as supported is shown as supported.',
      when: [...caseOf, { predicate: 'hypothesis', args: { id: '?h', claim: '?c', case_id: '?k' } },
        { predicate: 'supported', args: { hypothesis: '?h' } }],
      then: [{ predicate: 'item', args: { case_id: '?k', hypothesis: '?h', claim: '?c', state: 'supported' } }] },
    { id: 'ledger_item_refuted', label: 'A hypothesis a rule derives as refuted is shown as refuted.',
      when: [...caseOf, { predicate: 'hypothesis', args: { id: '?h', claim: '?c', case_id: '?k' } },
        { predicate: 'refuted', args: { hypothesis: '?h' } }],
      then: [{ predicate: 'item', args: { case_id: '?k', hypothesis: '?h', claim: '?c', state: 'refuted' } }] },
    { id: 'ledger_item_dropped', label: 'A dropped hypothesis is shown as dropped.',
      when: [...caseOf, { predicate: 'hypothesis', args: { id: '?h', claim: '?c', case_id: '?k' } },
        { predicate: 'is_dropped', args: { hypothesis: '?h' } }],
      then: [{ predicate: 'item', args: { case_id: '?k', hypothesis: '?h', claim: '?c', state: 'dropped' } }] },
    { id: 'ledger_case_with_open_hypothesis', label: 'A Case with an open hypothesis still has an open question.',
      when: [{ predicate: 'item', args: { case_id: '?k', hypothesis: '?h', claim: '?c', state: 'open' } }],
      then: [{ predicate: 'case_open', args: { case_id: '?k' } }] },
    { id: 'ledger_case_data', label: 'Each datum recorded for a Case is shown with that Case.',
      when: [...caseOf, { predicate: 'datum', args: { name: '?n', value: '?v', unit: '?u', source: '?s', case_id: '?k' } }],
      then: [{ predicate: 'case_datum', args: { case_id: '?k', name: '?n', value: '?v', unit: '?u', source: '?s' } }] },
    // D-1008c (O5c): a later Case uses an earlier Case's data by citing it, instead of recording the numbers again.
    // The datum facts stay on the Board after the earlier Case closes; the citing Case shows them as its own rows, and
    // each such row's evidence names the cites fact, so the dependency stays on the Board.
    { id: 'ledger_cited_case_data', label: 'Data of a cited Case is shown with the citing Case.',
      when: [...caseOf, { predicate: 'cites', args: { case_id: '?k', from_case_id: '?f' } },
        { predicate: 'datum', args: { name: '?n', value: '?v', unit: '?u', source: '?s', case_id: '?f' } }],
      then: [{ predicate: 'case_datum', args: { case_id: '?k', name: '?n', value: '?v', unit: '?u', source: '?s' } }] },
  ],
  acceptance: [],
  actions: [],
};

const CTX = (k = 'case-1', r = 'root-1') => [{ predicate: 'root', args: { node: r } },
  { predicate: 'case_context', args: { root: r, case_type: 'exploration', case_id: k } }];
const H = (id, k = 'case-1') => ({ predicate: 'research.ledger.hypothesis', args: { id, claim: `claim ${id}`, case_id: k } });
const ITEM = (h, state, k = 'case-1') => ({ predicate: 'research.ledger.item', args: { case_id: k, hypothesis: h, claim: `claim ${h}`, state } });
// The mechanical checker needs a Case contract with an acceptance bridge to its root (it refuses a certified /1
// contract without one). Both exist only in the draft; the published program.json keeps acceptance empty.
const checkProgram = { ...program,
  vocabulary: { ...program.vocabulary, imports: [...program.vocabulary.imports, { id: 'acceptance', as: 'acceptance' }, { id: 'acceptance_met', as: 'acceptance_met' }] },
  acceptance: [{ id: 'check_only_bridge', label: 'Check-only bridge from the checker contract to its root.',
  when: [{ predicate: 'acceptance', args: { node: '?node', test: '?k' } }, { predicate: 'case_open', args: { case_id: '?k' } }],
  then: [{ predicate: 'acceptance_met', args: { node: '?node' } }] }] };
const draft = {
  program: checkProgram,
  // The checker needs one Case contract; this one exists only so the rules and examples can be checked. The
  // published package is program.json alone: the ledger is used inside other Case Types (for example exploration).
  caseContracts: [{ format: 'rulith-case-contract/1', caseType: 'research_ledger_check', title: 'Research ledger mechanical check',
    businessKey: { predicate: 'research.ledger.hypothesis', arguments: ['case_id'] },
    opening: { predicate: 'research.ledger.hypothesis', keyArguments: ['case_id'] },
    acceptance: { predicate: 'research.ledger.case_open', keyArguments: ['case_id'], minimumGroundingFloor: 'attested' },
    terminal: { cardinality: 'once_per_case', disposition: 'completed', requiresCertified: true } }],
  citations: [
    cite('ledger_dropped_with_reason', 'A hypothesis dropped with a reason is dropped.'),
    cite('ledger_item_open', 'A hypothesis stays open until it is supported, refuted or dropped.'),
    cite('ledger_item_supported', 'A hypothesis a rule derives as supported is shown as supported.'),
    cite('ledger_item_refuted', 'A hypothesis a rule derives as refuted is shown as refuted.'),
    cite('ledger_item_dropped', 'A dropped hypothesis is shown as dropped.'),
    cite('ledger_case_with_open_hypothesis', 'A Case with an open hypothesis still has an open question.'),
    cite('ledger_case_data', 'Each datum recorded for a Case is shown with that Case.'),
    cite('ledger_cited_case_data', 'Data of a cited Case is shown with the citing Case.'),
  ],
  examples: [
    { label: 'an undecided hypothesis is open and keeps its Case open', facts: [...CTX(), H('h1')],
      expect: [ITEM('h1', 'open'), { predicate: 'research.ledger.case_open', args: { case_id: 'case-1' } }], forbid: [] },
    { label: 'a supported hypothesis is shown as supported and closes its question', facts: [...CTX(), H('h1'), { predicate: 'research.ledger.supported', args: { hypothesis: 'h1' } }],
      expect: [ITEM('h1', 'supported')], forbid: [ITEM('h1', 'open'), { predicate: 'research.ledger.case_open', args: { case_id: 'case-1' } }] },
    { label: 'a refuted hypothesis is shown as refuted', facts: [...CTX(), H('h1'), { predicate: 'research.ledger.refuted', args: { hypothesis: 'h1' } }],
      expect: [ITEM('h1', 'refuted')], forbid: [ITEM('h1', 'open')] },
    { label: 'a dropped hypothesis is shown as dropped', facts: [...CTX(), H('h1'), { predicate: 'research.ledger.dropped', args: { hypothesis: 'h1', reason: 'superseded' } }],
      expect: [ITEM('h1', 'dropped'), { predicate: 'research.ledger.is_dropped', args: { hypothesis: 'h1' } }], forbid: [ITEM('h1', 'open')] },
    { label: 'one open hypothesis keeps only its own Case open',
      facts: [...CTX('case-1', 'root-1'), ...CTX('case-2', 'root-2'), H('h1', 'case-1'), H('h2', 'case-2'), { predicate: 'research.ledger.refuted', args: { hypothesis: 'h2' } }],
      expect: [{ predicate: 'research.ledger.case_open', args: { case_id: 'case-1' } }], forbid: [{ predicate: 'research.ledger.case_open', args: { case_id: 'case-2' } }] },
    { label: 'a datum is shown with its Case', facts: [...CTX(), { predicate: 'research.ledger.datum', args: { name: 'gate_up_ms', value: '41.2', unit: 'ms', source: 'tmp/qk/base.json', case_id: 'case-1' } }],
      expect: [{ predicate: 'research.ledger.case_datum', args: { case_id: 'case-1', name: 'gate_up_ms', value: '41.2', unit: 'ms', source: 'tmp/qk/base.json' } }], forbid: [] },
    { label: 'data of a cited Case is shown with the citing Case',
      facts: [...CTX('case-2', 'root-2'), { predicate: 'research.ledger.cites', args: { case_id: 'case-2', from_case_id: 'case-1' } },
        { predicate: 'research.ledger.datum', args: { name: 'prefill_tok_s', value: '812', unit: 'tok/s', source: 'logs/pinned-prefill.json', case_id: 'case-1' } }],
      expect: [{ predicate: 'research.ledger.case_datum', args: { case_id: 'case-2', name: 'prefill_tok_s', value: '812', unit: 'tok/s', source: 'logs/pinned-prefill.json' } }], forbid: [] },
    { label: 'nothing is shown for a Case without its context', facts: [H('h1', 'case-9')],
      expect: [], forbid: [ITEM('h1', 'open', 'case-9')] },
  ],
  questions: [],
  notes: 'supported and refuted are not owned by this package on purpose: an Agent decides a hypothesis with its own rule over the receipts and data that settle it, so its reasoning is recorded on the Board. item, case_datum, case_open and is_dropped are owned here, so an Agent cannot redefine when a question is open. Every shown row is derived from the Case root and context so that a read of that root includes it.',
};

fs.writeFileSync(at('program.json'), JSON.stringify(program, null, 2) + '\n');
fs.writeFileSync(at('draft.json'), JSON.stringify(draft, null, 2) + '\n');
console.log('wrote research-ledger/program.json and draft.json');
