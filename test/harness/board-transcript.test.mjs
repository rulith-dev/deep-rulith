import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, plan, rewriteSession, FULL_FIRST, FULL_HEAD, DELTA_HEAD, DELTA_NONE } from '../../harness/web/board-transcript.mjs';

// A Rulith tool result as dsh stores it: the MCP result serialized, with dsh's `Error: ` prefix for refusals.
const raw = (answer, isError = false) =>
  (isError ? 'Error: ' : '') + JSON.stringify({ isError, content: [{ type: 'text', text: JSON.stringify(answer) }] });
const answer = (facts, extra = {}) => ({
  accepted: true, ...extra,
  view: { position: { writes: 'open' }, facts: facts.map((label) => ({ label })) },
  operations: [],
});

// Enough of a dsh session for the rewrite: an event log, the model-visible surface and dsh's replace records.
function fakeSession(texts) {
  const log = [];
  const surface = { nodes: [] };
  const append = (type, data, opts = {}) => {
    const event = { type, seq: log.length, data, ...opts };
    log.push(event);
    if (opts.surfaceOp?.op === 'replace') surface.nodes[surface.nodes.indexOf(opts.surfaceOp.startSeq)] = event.seq;
    else surface.nodes.push(event.seq);
    return event;
  };
  for (const text of texts) append('tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: `c${log.length}`, isError: text.startsWith('Error: '), content: [{ type: 'text', text }] } }, { surfaceOp: 'append' });
  return { log, surface, append, eventAt: (seq) => log[seq], deriveEventMessage: (event) => event.data.message,
    visible: () => surface.nodes.map((seq) => log[seq].data.message.content[0].text) };
}

test('the latest result shows the whole Board with + and -, earlier results only their changes', () => {
  const session = fakeSession([raw(answer(['a', 'b'])), raw(answer(['a', 'c']), true), raw(answer(['a', 'c', 'd'], { result: { ok: 1 } }))]);
  assert.equal(rewriteSession(session), 3);
  const [first, second, third] = session.visible();
  // The first Board has nothing before it: every line is new, so history keeps it whole.
  assert.deepEqual(first.split('\n').slice(1), [DELTA_HEAD, '+ position.writes: "open"', '+ facts: {"label":"a"}', '+ facts: {"label":"b"}', '+ operations: []']);
  // A refusal keeps its own text (the dsh error prefix and the answer without the Board) and its change.
  assert.deepEqual(second.split('\n'), ['Error: {"accepted":true}', DELTA_HEAD, '+ facts: {"label":"c"}', '- facts: {"label":"b"}']);
  assert.deepEqual(third.split('\n'), ['{"accepted":true,"result":{"ok":1}}', FULL_HEAD,
    '  position.writes: "open"', '  facts: {"label":"a"}', '  facts: {"label":"c"}', '+ facts: {"label":"d"}', '  operations: []']);
  // The original results stay in the log for the person's transcript.
  assert.equal(session.log.length, 6);
});

test('each step only demotes the previous latest result; a second pass changes nothing', () => {
  const session = fakeSession([raw(answer(['a']))]);
  rewriteSession(session);
  assert.equal(session.visible()[0].split('\n')[1], FULL_FIRST);
  session.append('tool/result', { message: { role: 'tool', content: [{ type: 'text', text: raw(answer(['a'])) }] } }, { surfaceOp: 'append' });
  assert.equal(rewriteSession(session), 2); // the new result, and the one before it becomes its changes
  assert.deepEqual(session.visible()[1].split('\n').slice(1, 2), [FULL_HEAD]);
  assert.equal(rewriteSession(session), 0);
});

test('a step that changed nothing says so, and history replays to the latest Board', () => {
  const items = [raw(answer(['a'])), raw(answer(['a'])), raw(answer(['b'])), raw(answer(['b', 'b']))].map(classify);
  const texts = plan(items);
  assert.equal(texts[1].split('\n')[1], DELTA_NONE);
  const replayed = new Map();
  for (const text of texts.slice(0, -1)) for (const line of text.split('\n').slice(2)) {
    const key = line.slice(2);
    if (line[0] === '+') replayed.set(key, (replayed.get(key) ?? 0) + 1);
    if (line[0] === '-') replayed.set(key, replayed.get(key) - 1);
  }
  assert.equal(replayed.get('facts: {"label":"b"}'), 1);
  assert.equal(replayed.get('facts: {"label":"a"}'), 0);
  // The duplicate line counts as one more, not as unchanged.
  assert.ok(texts[3].split('\n').includes('+ facts: {"label":"b"}'));
});

test('results without a Board and unreadable text are left alone', () => {
  assert.equal(classify('Error: The connection to Rulith was interrupted during this call; its outcome is unknown.'), null);
  assert.equal(classify(raw({ accepted: true, artifact: { text: 'x' } })), null);
  const session = fakeSession(['plain text', raw({ accepted: true })]);
  assert.equal(rewriteSession(session), 0);
});
