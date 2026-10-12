import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ShadowReviewer, ShadowTriggers, SHADOW_SYSTEM, deliveryNote, fingerprintOf, reviewContext, parseReply,
  reviewWithModel, reviewLog } from '../../harness/web/shadow-reviewer.mjs';
import { classify, plan } from '../../harness/web/board-transcript.mjs';
import { RulithMcp } from '../../harness/rulith-mcp.mjs';

const fact = (nodeId, extra = {}) => ({ nodeId, label: `criterion(node=${nodeId}, test=actual outcome)`, createdBy: 'agent', derived: false, ...extra });
const view = (...facts) => ({ facts, goalNodes: [{ nodeId: 'goal-1', desired: 'the actual outcome' }] });
const result = (answer) => ({ content: [{ type: 'text', text: JSON.stringify(answer) }] });
const beat = (extra = {}) => ({ tool: 'Set', seat: 'main', session: 'conversation-1', focusedGoals: ['goal-1'], route: { provider: 'chosen-provider', model: 'chosen-model' }, ...extra });
const immediate = () => new Promise((resolve) => setImmediate(resolve));
const settle = async (reviewer) => { while (reviewer.running) await reviewer.running; };
function fixture(overrides = {}) {
  const records = []; const updates = []; const writes = []; const messages = []; const visible = [];
  let snapshot = view(fact('a'));
  const reviewer = new ShadowReviewer({
    readBoard: async () => ({ views: [snapshot] }), chat: async (...args) => { messages.push(args); return { text: '' }; },
    write: async (args) => { writes.push(args); return result({ accepted: true }); },
    log: { record: async (row) => records.push({ ...row }), update: async (id, fields) => updates.push({ id, ...fields }) },
    visible: (line) => visible.push(line), ...overrides,
  });
  return { reviewer, records, updates, writes, messages, visible, snapshot: (next) => { snapshot = next; } };
}

test('fingerprint uses a set of node IDs, detects equal-size replacement, ignores row order', () => {
  assert.equal(fingerprintOf([view(fact('a'), fact('b'))]), fingerprintOf([view(fact('b'), fact('a')), view(fact('a'))]));
  assert.notEqual(fingerprintOf([view(fact('a'))]), fingerprintOf([view(fact('b'))]));
});

test('accepted Set triggers; refused Set and ordinary Get do not; Execute waits for its result', () => {
  const triggers = new ShadowTriggers();
  assert.equal(triggers.observe('Set', result({ accepted: true }), beat()).length, 1);
  assert.equal(triggers.observe('Set', result({ accepted: false }), beat()).length, 0);
  assert.equal(triggers.observe('Get', result({ accepted: true }), beat()).length, 0);
  assert.equal(triggers.observe('Execute', result({ accepted: true, result: {} }), beat()).length, 1);
  const operation = { tool: 'Execute', seat: 'main', label: 'work', at: 't', state: 'running' };
  assert.equal(triggers.observe('Execute', result({ state: 'running', operations: [operation] }), beat()).length, 0);
  assert.equal(triggers.observe('Get', result({ operations: [{ ...operation, state: 'done', seat: 'other' }] }), beat()).length, 0);
  assert.equal(triggers.observe('Get', result({ operations: [{ ...operation, state: 'done' }] }), beat({ session: 'other-session' })).length, 0);
  const completed = result({ operations: [{ ...operation, state: 'done' }] });
  assert.equal(triggers.observe('Get', completed, beat())[0].tool, 'Execute');
  assert.equal(triggers.observe('Get', completed, beat()).length, 0, 'delayed outcome reviewed once');
});

test('unchanged snapshots skip; a changed snapshot reviews again even at the same size', async () => {
  const f = fixture(); f.reviewer.beat(beat());
  assert.equal(f.messages.length, 0, 'review starts after the main tool result returns');
  await settle(f.reviewer);
  f.reviewer.beat(beat()); await settle(f.reviewer); assert.equal(f.records.length, 1);
  f.snapshot(view(fact('b'))); f.reviewer.beat(beat({ tool: 'Execute' })); await settle(f.reviewer);
  assert.equal(f.records.length, 2); assert.equal(f.records[1].deltaSize, 1); assert.equal(f.records[1].triggerTool, 'Execute');
});

test('a Get returned while waiting for Set cannot turn a refused or still-running Set into an accepted beat', () => {
  const entry = { tool: 'Set', seat: 'main', label: 'Set', at: 'one', state: 'running' };
  const original = beat({ origin: { operations: [entry] } });
  for (const state of ['running', 'refused', 'failed', 'needs_person']) {
    const triggers = new ShadowTriggers();
    assert.equal(triggers.observe('Set', result({ accepted: true, operations: [{ ...entry, state }] }), original).length, 0);
  }
  const triggers = new ShadowTriggers();
  assert.equal(triggers.observe('Set', result({ accepted: true, operations: [{ ...entry, state: 'done' }] }), original).length, 1);
});

test('a held Set only triggers when its accepted outcome later arrives; a refused outcome never triggers', () => {
  for (const state of ['done', 'refused']) {
    const triggers = new ShadowTriggers();
    const entry = { tool: 'Set', seat: 'main', label: 'Set', at: 'one', state: 'running' };
    assert.equal(triggers.observe('Set', result({ operations: [entry] }), beat({ origin: { operations: [entry] } })).length, 0);
    const delivered = result({ accepted: true, operations: [{ ...entry, state }] });
    assert.equal(triggers.observe('Get', delivered, beat()).length, state === 'done' ? 1 : 0);
    assert.equal(triggers.observe('Get', delivered, beat()).length, 0);
  }
});

test('a refused tool result can deliver the eventual Execute outcome without triggering its own refused Set', () => {
  const triggers = new ShadowTriggers();
  const entry = { tool: 'Execute', seat: 'main', label: 'work', at: 'one', state: 'running' };
  triggers.observe('Execute', result({ state: 'running', operations: [entry] }), beat());
  const refusal = { ...result({ accepted: false, operations: [{ ...entry, state: 'done' }] }), isError: true };
  assert.deepEqual(triggers.observe('Set', refusal, beat()).map((next) => next.tool), ['Execute']);
});

test('one review in flight; later beats coalesce into a single next review', async () => {
  let finish; let calls = 0;
  const f = fixture({ chat: async () => { calls++; if (calls === 1) await new Promise((resolve) => { finish = resolve; }); return { text: '' }; } });
  f.reviewer.beat(beat()); await immediate(); assert.equal(calls, 1);
  f.snapshot(view(fact('b'))); f.reviewer.beat(beat()); f.reviewer.beat(beat()); f.reviewer.beat(beat({ tool: 'Execute' }));
  assert.equal(calls, 1); finish(); await settle(f.reviewer);
  assert.equal(calls, 2); assert.equal(f.records.at(-1).triggerTool, 'Execute');
});

test('context has full Board, new model facts, prior suggestions; excludes derived/tool/suggestion facts from delta', () => {
  const board = view(fact('old'), fact('new'), fact('derived', { derived: true }), fact('receipt', { createdBy: 'tool' }),
    fact('sug', { label: 'suggestion(id=sug, node=goal-1, advice=previous advice)' }));
  const assembled = reviewContext([board], new Set(['old', 'goal-1']), [{ node: 'goal-1', advice: 'previous refused write' }]);
  assert.deepEqual(assembled.delta.map((row) => row.nodeId), ['new']);
  assert.match(assembled.user, /^\[BOARD\]/); assert.match(assembled.user, /NEW MODEL FACTS/);
  assert.match(assembled.user, /PRIOR SUGGESTIONS/); assert.match(assembled.user, /previous refused write/);
  assert.match(assembled.user, /receipt/); assert.match(assembled.user, /derived/);
  assert.equal(reviewContext([board], null).delta.length, 0, 'first snapshot has no previous review');
});

test('parser accepts exactly one suggestion or empty; rejects wrappers, arrays, prose and malformed replies', () => {
  assert.equal(parseReply(' \n'), null);
  assert.deepEqual(parseReply('{"node":"goal-1","advice":"Check the actual criterion."}'), { node: 'goal-1', advice: 'Check the actual criterion.' });
  for (const text of ['PASS', 'null', '{}', '[]', '[{"node":"n","advice":"a"}]', '```json\n{}\n```',
    '{"node":"n","advice":"a","tool":"Set"}', '{"node":"n","advice":""}', '{"node":"n","advice":"a\\nb"}', '{'])
    assert.throws(() => parseReply(text), /malformed/);
});

test('malformed or unanchored reply is visibly logged as error and writes nothing', async () => {
  for (const text of ['broken JSON', '{"node":"invented","advice":"Check this."}']) {
    const f = fixture({ chat: async () => ({ text }) }); f.reviewer.beat(beat()); await settle(f.reviewer);
    assert.equal(f.writes.length, 0); assert.equal(f.records[0].result, 'error'); assert.match(f.visible[0], /malformed/);
    assert.deepEqual(f.reviewer.takeNotes('conversation-1'), []);
  }
});

test('suggestion writes only assert_fact and is delivered once to its originating model; next Set reference is observed', async () => {
  const finding = { node: 'goal-1', advice: 'Check the actual outcome criterion.' };
  const f = fixture({ chat: async () => ({ text: JSON.stringify(finding), usage: { inputTokens: 22, outputTokens: 9 } }) });
  f.reviewer.beat(beat()); await settle(f.reviewer);
  assert.equal(f.writes.length, 1);
  const [op] = f.writes[0].operations;
  assert.equal(op.op, 'assert_fact'); assert.equal(op.predicate, 'suggestion');
  assert.deepEqual(op.args, { id: op.id, ...finding }); assert.match(op.id, /^shadow_/);
  assert.equal(f.records[0].inputTokens, 22); assert.equal(f.records[0].outputTokens, 9);
  assert.deepEqual(f.reviewer.takeNotes('another-session'), []);
  assert.deepEqual(f.reviewer.takeNotes('conversation-1'), [deliveryNote(finding)]);
  assert.deepEqual(f.reviewer.takeNotes('conversation-1'), []);
  f.reviewer.observeSet('another-session', { operations: [] });
  f.reviewer.observeSet('conversation-1', { operations: [{ op: 'retract_node', nodeId: 'goal-1' }] });
  f.reviewer.observeSet('conversation-1', {});
  assert.equal(f.updates.filter((row) => row.nextSetReferencedNode === true).length, 1);
});

test('missing seat and refused or uncertain writes retain advisory delivery, without retry', async () => {
  const text = '{"node":"goal-1","advice":"Check the actual criterion."}';
  for (const override of [
    { readBoard: async () => ({ views: [view(fact('a'))], writeUnavailable: 'seat shadow unavailable' }) },
    { write: async () => result({ accepted: false, teaching: 'Board draining' }) },
    { write: async () => { throw new Error('MCP transport failed'); } },
    { write: async () => result({ state: 'running' }) },
  ]) {
    const f = fixture({ chat: async () => ({ text }), ...override }); f.reviewer.beat(beat()); await settle(f.reviewer);
    assert.equal(f.records[0].result, 'write_refused'); assert.match(f.visible.at(-1), /write_refused/);
    assert.equal(f.reviewer.takeNotes('conversation-1').length, 1);
    f.reviewer.beat(beat()); await settle(f.reviewer); assert.equal(f.records.length, 1);
  }
});

test('disabled and detached reviewers make no further calls or deliver notes', async () => {
  const disabled = fixture({ enabled: false }); disabled.reviewer.beat(beat()); assert.equal(disabled.messages.length, 0);
  let finish;
  const f = fixture({ chat: async () => { await new Promise((resolve) => { finish = resolve; }); return { text: '{"node":"goal-1","advice":"Check it."}' }; } });
  f.reviewer.beat(beat()); await immediate(); f.reviewer.close(); finish(); await settle(f.reviewer);
  assert.equal(f.writes.length, 0); assert.deepEqual(f.reviewer.takeNotes('conversation-1'), []);
});

test('model request contains only shadow system and Board input, follows the chosen model route and records usage', async () => {
  let request;
  const llm = { async *stream(input) {
    request = input;
    yield { type: 'text-delta', index: 0, text: '{"node":"goal-1",' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"node":"goal-1","advice":"Check it."}' } };
    yield { type: 'reasoning-delta', index: 1, text: 'private shadow reasoning' };
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  const user = reviewContext([view(fact('a'))], null).user;
  const reply = await reviewWithModel(llm, beat().route, user, new AbortController().signal);
  assert.equal(request.provider, 'chosen-provider'); assert.equal(request.model, 'chosen-model');
  assert.equal(request.system, SHADOW_SYSTEM); assert.deepEqual(request.tools, []);
  assert.deepEqual(request.messages, [{ role: 'user', content: [{ type: 'text', text: user }] }]);
  assert.equal(reply.usage.inputTokens, 20); assert.deepEqual(parseReply(reply.text), { node: 'goal-1', advice: 'Check it.' });
  assert.doesNotMatch(JSON.stringify(request), /private shadow reasoning|main reasoning/);
});

test('model truncation, error and incomplete stream are errors rather than empty passes', async () => {
  for (const reason of ['max-tokens', 'error', 'tool-calls', null]) {
    const llm = { async *stream() { if (reason) yield { type: 'finish', reason: { kind: reason } }; } };
    await assert.rejects(reviewWithModel(llm, beat().route, '[BOARD]', new AbortController().signal), /shadow model/);
  }
});

test('usage reported before a model error is retained in the review log', async () => {
  const llm = { async *stream() {
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } };
    yield { type: 'finish', reason: { kind: 'error' } };
  } };
  const f = fixture({ chat: (route, user, signal) => reviewWithModel(llm, route, user, signal) });
  f.reviewer.beat(beat()); await settle(f.reviewer);
  assert.equal(f.records[0].result, 'error'); assert.equal(f.records[0].inputTokens, 12); assert.equal(f.records[0].outputTokens, 3);
});

test('documented shadow prompt matches the shipped prompt exactly', async () => {
  const doc = await fs.readFile(new URL('../../harness/model-visible.md', import.meta.url), 'utf8');
  assert.ok(doc.includes('```text\n' + SHADOW_SYSTEM + '\n```'));
});

test('shadow MCP session declares seat only at initialize; focus stays Host-only', async () => {
  const seen = [];
  const bridge = new RulithMcp({ url: 'http://127.0.0.1:9/mcp', token: 'fixture-only', seat: 'shadow', fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); seen.push(body);
    const headers = { 'content-type': 'application/json', 'mcp-session-id': 'shadow-session' };
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202, headers });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25',
      content: [], _meta: { 'rulith/v4': { agentId: 'fixture-agent', focusedGoals: ['goal-1'] } } } }), { headers });
  } });
  await bridge.initialize(); const answer = await bridge.call('Set', { operations: [] });
  assert.deepEqual(seen[0].params.capabilities.experimental['rulith/v4'], { heldCalls: 1, seat: 'shadow' });
  assert.equal(seen.at(-1).params.arguments.seat, undefined); assert.equal(answer._meta, undefined);
  assert.deepEqual(bridge.focusedGoals, ['goal-1']); bridge.close();
});

test('advisory note survives Board transcript rewriting and aging exactly once', () => {
  const note = deliveryNote({ node: 'goal-1', advice: 'Check the actual criterion.' });
  const raw = JSON.stringify(result({ accepted: true, view: view(fact('a')), operations: [] }));
  const items = [classify(raw + '\n' + note), classify(raw)];
  const rewritten = plan(items);
  assert.equal(rewritten.join('\n').split(note).length - 1, 1);
  assert.match(rewritten[0], /Board view changes/); assert.ok(rewritten[0].endsWith(note));
  assert.deepEqual(plan(rewritten.map(classify)), [null, null], 'already rewritten results stay unchanged');
});

test('review log retains one row per review and later updates delivery and next Set reference', async (t) => {
  const scratch = new URL('../../.scratch/', import.meta.url); await fs.mkdir(scratch, { recursive: true });
  const directory = await fs.mkdtemp(path.join(fileURLToPath(scratch), 'shadow-log-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const log = reviewLog(directory); await log.record({ reviewId: 'one', result: 'suggestion', nextSetReferencedNode: null });
  await log.record({ reviewId: 'two', result: 'pass' });
  await log.update('one', { nextSetReferencedNode: false, noteDeliveredAt: 'later' });
  const rows = (await fs.readFile(log.file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2); assert.equal(rows[0].nextSetReferencedNode, false); assert.equal(rows[0].noteDeliveredAt, 'later');
});
