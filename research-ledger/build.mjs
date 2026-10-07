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

const program = {
  id: 'research_ledger',
  title: 'Research ledger',
  summary: 'Keeps an investigation on the Board: hypotheses with their Case, the data they rest on, dropped directions, and which hypotheses are still open.',
  vocabulary: {
    defines: [
      { id: 'research.ledger.hypothesis', as: 'hypothesis', args: ['id', 'claim', 'case_id'] },
      { id: 'research.ledger.datum', as: 'datum', args: ['name', 'value', 'unit', 'source'] },
      { id: 'research.ledger.supported', as: 'supported', args: ['hypothesis'] },
      { id: 'research.ledger.refuted', as: 'refuted', args: ['hypothesis'] },
      { id: 'research.ledger.dropped', as: 'dropped', args: ['hypothesis', 'reason'] },
      { id: 'research.ledger.is_dropped', as: 'is_dropped', args: ['hypothesis'] },
      { id: 'research.ledger.open', as: 'open', args: ['hypothesis'] },
      { id: 'research.ledger.case_open', as: 'case_open', args: ['case_id'] },
    ],
    imports: [],
  },
  // Owned by this package: the Agent cannot assert or redefine them.
  pins: ['is_dropped', 'open', 'case_open'],
  rules: [
    { id: 'dropped_with_reason', label: 'A hypothesis dropped with a reason is dropped.',
      when: [{ predicate: 'dropped', args: { hypothesis: '?h', reason: '?r' } }],
      then: [{ predicate: 'is_dropped', args: { hypothesis: '?h' } }] },
    { id: 'open_until_decided', label: 'A hypothesis stays open until it is supported, refuted or dropped.',
      when: [
        { predicate: 'hypothesis', args: { id: '?h', claim: '?c', case_id: '?k' } },
        { predicate: 'supported', args: { hypothesis: '?h' }, naf: true },
        { predicate: 'refuted', args: { hypothesis: '?h' }, naf: true },
        { predicate: 'is_dropped', args: { hypothesis: '?h' }, naf: true },
      ],
      then: [{ predicate: 'open', args: { hypothesis: '?h' } }] },
    { id: 'case_with_open_hypothesis', label: 'A Case with an open hypothesis still has an open question.',
      when: [
        { predicate: 'hypothesis', args: { id: '?h', claim: '?c', case_id: '?k' } },
        { predicate: 'open', args: { hypothesis: '?h' } },
      ],
      then: [{ predicate: 'case_open', args: { case_id: '?k' } }] },
  ],
  acceptance: [],
  actions: [],
};

const H = (id, k = 'case-1') => ({ predicate: 'research.ledger.hypothesis', args: { id, claim: `claim ${id}`, case_id: k } });
const draft = {

  program,
  // The checker needs one Case contract; this one exists only so the rules and examples can be checked. The
  // published package is program.json alone: the ledger is used inside other Case Types (for example exploration).
  caseContracts: [{ format: 'rulith-case-contract/1', caseType: 'research_ledger_check', title: 'Research ledger mechanical check',
    businessKey: { predicate: 'research.ledger.hypothesis', arguments: ['case_id'] },
    opening: { predicate: 'research.ledger.hypothesis', keyArguments: ['case_id'] },
    acceptance: { predicate: 'research.ledger.case_open', keyArguments: ['case_id'], minimumGroundingFloor: 'attested' },
    terminal: { cardinality: 'once_per_case', disposition: 'completed', requiresCertified: true } }],
  citations: [
    cite('dropped_with_reason', 'A hypothesis dropped with a reason is dropped.'),
    cite('open_until_decided', 'A hypothesis stays open until it is supported, refuted or dropped.'),
    cite('case_with_open_hypothesis', 'A Case with an open hypothesis still has an open question.'),
  ],
  examples: [
    { label: 'an undecided hypothesis keeps its Case open', facts: [H('h1')],
      expect: [{ predicate: 'research.ledger.open', args: { hypothesis: 'h1' } }, { predicate: 'research.ledger.case_open', args: { case_id: 'case-1' } }], forbid: [] },
    { label: 'a supported hypothesis is no longer open', facts: [H('h1'), { predicate: 'research.ledger.supported', args: { hypothesis: 'h1' } }],
      expect: [], forbid: [{ predicate: 'research.ledger.open', args: { hypothesis: 'h1' } }, { predicate: 'research.ledger.case_open', args: { case_id: 'case-1' } }] },
    { label: 'a refuted hypothesis is no longer open', facts: [H('h1'), { predicate: 'research.ledger.refuted', args: { hypothesis: 'h1' } }],
      expect: [], forbid: [{ predicate: 'research.ledger.open', args: { hypothesis: 'h1' } }] },
    { label: 'a dropped hypothesis is no longer open', facts: [H('h1'), { predicate: 'research.ledger.dropped', args: { hypothesis: 'h1', reason: 'superseded' } }],
      expect: [{ predicate: 'research.ledger.is_dropped', args: { hypothesis: 'h1' } }], forbid: [{ predicate: 'research.ledger.open', args: { hypothesis: 'h1' } }] },
    { label: 'one open hypothesis keeps only its own Case open',
      facts: [H('h1', 'case-1'), H('h2', 'case-2'), { predicate: 'research.ledger.refuted', args: { hypothesis: 'h2' } }],
      expect: [{ predicate: 'research.ledger.case_open', args: { case_id: 'case-1' } }], forbid: [{ predicate: 'research.ledger.case_open', args: { case_id: 'case-2' } }] },
  ],
  questions: [],
  notes: 'supported and refuted are not owned by this package on purpose: an Agent decides a hypothesis with its own rule over the receipts and data that settle it, so its reasoning is recorded on the Board. open, case_open and is_dropped are owned here, so an Agent cannot redefine when a question is open.',
};

fs.writeFileSync(at('program.json'), JSON.stringify(program, null, 2) + '\n');
fs.writeFileSync(at('draft.json'), JSON.stringify(draft, null, 2) + '\n');
console.log('wrote research-ledger/program.json and draft.json');
