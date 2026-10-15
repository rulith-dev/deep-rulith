import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RulithMcp, TOOLS, NAMESPACE, surfaceAccepted } from '../../harness/rulith-mcp.mjs';
import { createHash } from 'node:crypto';
import { ADDENDUM } from '../../harness/rulith-gate.mjs';
import { ADDENDUM as WEB_ADDENDUM, CHILD_ADDENDUM } from '../../harness/web/rulith-web-gate.mjs';

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

test('the bridge speaks rulith/v4 with exactly the three tools', () => {
  assert.equal(NAMESPACE, 'rulith/v4');
  assert.deepEqual([...TOOLS], ['Get', 'Set', 'Execute']);
  const listed = (names) => ({ tools: names.map((name) => ({ name })) });
  assert.equal(surfaceAccepted(listed(TOOLS)), true);
  assert.equal(surfaceAccepted(listed(['QueryBoard', 'ApplyBatch', 'ApplyAction', 'ReadArtifact'])), false);
  assert.equal(surfaceAccepted(listed([...TOOLS, 'ReadArtifact'])), false);
  assert.equal(surfaceAccepted(listed([...TOOLS, 'OpenCase'])), false);
  assert.equal(surfaceAccepted(listed(['Get', 'Get', 'Set'])), false);
  assert.equal(surfaceAccepted({ ...listed(TOOLS), nextCursor: 'more' }), false);
});

test('a Gateway that reports its identity only under rulith/v3 is refused at initialize', async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', _meta: { 'rulith/v3': { agentId: 'agent-1', focusedRoots: [] } } } }),
      { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 's-1' } });
  };
  await assert.rejects(new RulithMcp({ url: 'http://127.0.0.1:9/mcp', token: 't', fetchImpl }).initialize(), /handshake refused/);
});

test('model-visible text speaks of goals: no Case, OpenCase, CloseCase or case_id', () => {
  const persona = read('harness/runtime-persona.txt');
  assert.match(persona, /Inside Set, assert_fact/);
  // D-1012h: the Board View paragraph left the persona; the Get description teaches reading a current view.
  assert.doesNotMatch(persona, /Every Board tool result carries the Board View|Every answer from the authority also shows operations/);
  for (const text of [persona, ADDENDUM])
    assert.doesNotMatch(text, /\bCases?\b|OpenCase|CloseCase|case_id|case_open|case_datum|rulith\.exploration\.completed|taskStatus shows the root|QueryBoard|ApplyBatch|ApplyAction|ReadArtifact/);
  // The completion guidance of v3 (a goal leaf plus a rule deriving completion) is gone; the Board completes goals.
  assert.doesNotMatch(ADDENDUM, /goal leaf|goal_node|subgoal_of/);
  // D-1012h: certification is taught once (persona and the Set description); the addendum no longer repeats it.
  assert.doesNotMatch(ADDENDUM, /completes the goal by itself/);
  assert.match(persona, /A goal the Board certifies ends as completed by itself; end a goal you will not pursue with end_goal and a reason\./);
});

// D-1015c (owner 2026-10-15): the read-only web tools stay native. Only the first sentence changed and one sentence
// follows it; the rest of the addendum is byte-identical to the one before (its SHA-256 is pinned below).
test('the addendum names the native web tools; everything after its first two sentences is unchanged', () => {
  const web = 'Web results leave nothing on the Board: when one is evidence for a result, record it on the Board with its URL as the source.';
  const headless = `Your tools are Rulith's three and the read-only tools web_search and web_fetch. ${web}`;
  const main = `Your tools are Rulith's three, delegation tools, and the read-only tools web_search and web_fetch. ${web}`;
  assert.ok(ADDENDUM.startsWith(`${headless} Writing, running commands and measuring are Actions`));
  assert.equal(WEB_ADDENDUM, main + ADDENDUM.slice(headless.length));
  assert.equal(CHILD_ADDENDUM, ADDENDUM, 'web children use the headless addendum');
  assert.equal(createHash('sha256').update(ADDENDUM.slice(headless.length)).digest('hex'),
    'f0b9733dbd59b4916c73681fe6d3df8ea1be845e4f8866192280f6630b23d7b5');
  const inventory = read('harness/model-visible.md');
  assert.ok(inventory.includes(ADDENDUM));
  assert.ok(inventory.includes("Your tools are Rulith's three, delegation tools, and the read-only tools web_search and web_fetch."));
});

test('goal guidance declares an outcome without a generic test-to-completion rule', () => {
  const examples = [...ADDENDUM.matchAll(/for example (\{.*?\})\. /g)].map((match) => JSON.parse(match[1]));
  assert.equal(examples.length, 1);
  assert.equal(examples[0].op, 'declare_goal');
  assert.deepEqual(Object.keys(examples[0]).sort(), ['desired', 'label', 'op']);
  assert.doesNotMatch(ADDENDUM, /"op":"add_axiom"/);
  assert.match(ADDENDUM, /user's actual acceptance criteria/);
});

test('every research.ledger word the instructions name matches the 0.4.0 package', () => {
  const program = JSON.parse(read('research-ledger/program.json'));
  const signature = new Map(program.vocabulary.defines.map((word) => [word.id, word.args.join(', ')]));
  for (const word of program.vocabulary.defines) assert.ok(!word.args.includes('case_id'), word.id);
  assert.equal(signature.get('research.ledger.cites'), 'goal, from_goal');
  const named = [...ADDENDUM.matchAll(/(research\.ledger\.[a-z_]+)\(([a-z_, ]+)\)/g)];
  assert.ok(named.length >= 4);
  for (const [, id, args] of named) assert.equal(signature.get(id), args, id);
  const inventory = read('harness/model-visible.md');
  for (const word of program.vocabulary.defines) assert.ok(inventory.includes(`${word.id}(${word.args.join(',')})`), word.id);
  const labels = read('research-ledger/method.txt');
  for (const rule of program.rules) assert.ok(labels.includes(rule.label), rule.label);
});
