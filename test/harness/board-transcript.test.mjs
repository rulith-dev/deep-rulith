import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, plan, rewriteSession, FULL_FIRST, FULL_HEAD, DELTA_HEAD, DELTA_NONE } from '../../harness/web/board-transcript.mjs';
import { projectToolCall } from '../../harness/tool-history.mjs';

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

test('old calls read as Get, Set and Execute; other content is untouched', () => {
  const session = fakeSession([]);
  const blocks = [
    { type: 'reasoning', text: 'QueryBoard then ReadArtifact' },
    { type: 'text', text: 'ApplyBatch is in this saved reply.' },
    { type: 'tool-call', id: 'q', name: 'QueryBoard', input: { include: ['nodes'] } },
    { type: 'tool-call', id: 's', name: 'ApplyBatch', input: { operations: [{ op: 'assert_fact', value: 'ApplyAction' }] } },
    { type: 'tool-call', id: 'e', name: 'ApplyAction', input: { action: 'QueryBoard', args: { ref: 'ReadArtifact' } } },
    { type: 'tool-call', id: 'a0', name: 'ReadArtifact', input: { ref: 'exact/ref', maxBytes: 1024 } },
    { type: 'tool-call', id: 'a1', name: 'ReadArtifact', input: { ref: 'exact/ref', offset: 0, maxBytes: 1024 } },
    { type: 'tool-call', id: 'a2', name: 'ReadArtifact', input: { ref: 'exact/ref', offset: 1024 } },
    { type: 'tool-call', id: 'new', name: 'Get', input: { artifact: { ref: 'new/ref' } } },
    { type: 'tool-call', id: 'unknown', name: 'other', input: {} },
  ];
  session.append('user/message', { message: { role: 'user', content: [{ type: 'text', text: 'ReadArtifact' }] } });
  session.append('assistant/message', { turn: 2, step: 3, message: { role: 'assistant', content: blocks } });
  session.append('tool/result', { message: { role: 'tool', toolCallId: 'a2', content: [{ type: 'text', text: raw({ artifact: { text: 'ApplyBatch' } }) }] } });
  const projected = blocks.map(projectToolCall);
  assert.deepEqual(projected.slice(0, 2), blocks.slice(0, 2));
  assert.deepEqual(projected.slice(2, 5), blocks.slice(2, 5).map((block, index) => ({ ...block, name: ['Get', 'Set', 'Execute'][index] })));
  assert.deepEqual(projected.slice(5, 8), [
    { type: 'tool-call', id: 'a0', name: 'Get', input: { artifact: { ref: 'exact/ref' } } },
    { type: 'tool-call', id: 'a1', name: 'Get', input: { artifact: { ref: 'exact/ref', offset: 0 } } },
    { type: 'tool-call', id: 'a2', name: 'Get', input: { artifact: { ref: 'exact/ref', offset: 1024 } } },
  ]);
  assert.deepEqual(projected.slice(8), blocks.slice(8));
});

test('a historical accepted ApplyBatch resets the Set reminder when replayed', () => {
  const session = fakeSession([]);
  for (let index = 0; index < 7; index++) {
    session.append('assistant/message', { message: { role: 'assistant', content: [
      { type: 'tool-call', id: `c${index}`, name: index === 6 ? 'ApplyBatch' : 'QueryBoard', input: {} },
    ] } });
    session.append('tool/result', { message: { role: 'tool', toolCallId: `c${index}`, content: [{ type: 'text', text: raw(answer([])) }] } });
  }
  rewriteSession(session);
  const last = session.deriveEventMessage(session.eventAt(session.surface.nodes.at(-1)));
  assert.ok(!last.content[0].text.includes('Note:'));
  assert.equal(rewriteSession(session), 0);
});

test('the latest result shows the whole Board with + and -, earlier results only their changes', () => {
  const session = fakeSession([raw(answer(['a', 'b'])), raw(answer(['a', 'c']), true), raw(answer(['a', 'c', 'd'], { result: { ok: 1 } }))]);
  assert.equal(rewriteSession(session), 3);
  const [first, second, third] = session.visible();
  // The first Board has nothing before it: every line is new, so history keeps it whole.
  assert.deepEqual(first.split('\n').slice(1), [DELTA_HEAD, '+ position.writes: "open"', '+ facts: {"label":"a"}', '+ facts: {"label":"b"}', '+ operations: []']);
  // A refusal keeps its own text (the dsh error prefix and the answer without the Board) and its change.
  assert.deepEqual(second.split('\n'), ['Error: {"accepted":true}', DELTA_HEAD, '+ facts: {"label":"c"}', '- facts: {"label":"b"}']);
  assert.deepEqual(third.split('\n'), ['{"accepted":true,"result":{"ok":1}}', FULL_HEAD,
    '= position.writes: "open"', '= facts: {"label":"a"}', '= facts: {"label":"c"}', '+ facts: {"label":"d"}', '= operations: []']);
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

// 10-09：Get 的动作行带 description 与 inputSchema，其他结果不带。这是同一个动作的两种渲染，不是板的变化：比较时不看它，
// 显示时照原样。
test('an action row that differs only by description or inputSchema is unchanged; the latest view still shows them', () => {
  const ship = { action: 'ship', status: 'ready' };
  const withActions = (actions, extra = {}) => ({ accepted: true, ...extra, view: { position: { writes: 'open' }, actions }, operations: [] });
  const items = [
    raw(withActions([ship])),
    raw(withActions([{ ...ship, description: 'Ship it', inputSchema: { type: 'object' } }])),
    raw(withActions([ship])),
    raw(withActions([{ ...ship, description: 'Ship it', inputSchema: { type: 'object' } }])),
  ].map(classify);
  const texts = plan(items);
  assert.equal(texts[1].split('\n')[1], DELTA_NONE);
  assert.equal(texts[2].split('\n')[1], DELTA_NONE);
  assert.deepEqual(texts[3].split('\n').slice(1), [FULL_HEAD, '= position.writes: "open"',
    '= actions: {"action":"ship","status":"ready","description":"Ship it","inputSchema":{"type":"object"}}', '= operations: []']);
  // A real change of the action is still a change.
  const changed = plan([raw(withActions([ship])), raw(withActions([{ ...ship, status: 'blocked', inputSchema: {} }]))].map(classify));
  assert.ok(changed[1].split('\n').includes('- actions: {"action":"ship","status":"ready"}'));
});

test('results rewritten before 10-09 (old headers, two-space unchanged lines) are read and moved to the new layout', () => {
  const oldFull = ['{"accepted":true}', 'Board now (whole Board; + added, - removed since your previous Board):',
    '  position.writes: "open"', '+ facts: {"label":"a"}', '  operations: []'].join('\n');
  const oldDelta = ['{"accepted":true}', 'Board changes at this step (+ added, - removed; the latest result shows the whole Board):',
    '+ position.writes: "open"', '+ operations: []'].join('\n');
  const items = [classify(oldDelta), classify(oldFull)];
  assert.deepEqual(items.map((item) => item.kind), ['delta', 'full']);
  const texts = plan(items);
  assert.equal(texts[0].split('\n')[1], DELTA_HEAD);
  assert.deepEqual(texts[1].split('\n').slice(1), [FULL_HEAD, '= position.writes: "open"', '+ facts: {"label":"a"}', '= operations: []']);
});

// rulith/v4（A 包）：视图按目标改名（goals.directory、goalNodes、taskStatus 以 goal 为键、position.newGoals），
// Get 另带 observation。转录逐键摊平，不认任何段名，所以照样工作；observation 留在第一行。
test('a rulith/v4 answer is laid out the same way: goal directory, goal nodes and taskStatus by goal', () => {
  const v4 = (status, extra = {}) => ({ accepted: true, ...extra,
    view: { position: { writes: 'open', newGoals: 'open' }, goals: { directory: [{ goal: 'g-1', label: 'tests pass', status }], total: 1 },
      goalNodes: [{ goal: 'g-1', met: status === 'completed' }], taskStatus: [{ goal: 'g-1', certified: status === 'completed' }] },
    operations: [] });
  const texts = plan([raw(v4('running', { observation: { consistency: 'committed' } })), raw(v4('completed', { result: { goals: [] } }))].map(classify));
  assert.equal(texts[0].split('\n')[0], '{"accepted":true,"observation":{"consistency":"committed"}}');
  assert.ok(texts[0].split('\n').includes('+ goals.directory: {"goal":"g-1","label":"tests pass","status":"running"}'));
  assert.deepEqual(texts[1].split('\n').slice(1), [FULL_HEAD, '= position.writes: "open"', '= position.newGoals: "open"',
    '+ goals.directory: {"goal":"g-1","label":"tests pass","status":"completed"}', '- goals.directory: {"goal":"g-1","label":"tests pass","status":"running"}',
    '= goals.total: 1', '+ goalNodes: {"goal":"g-1","met":true}', '- goalNodes: {"goal":"g-1","met":false}',
    '+ taskStatus: {"goal":"g-1","certified":true}', '- taskStatus: {"goal":"g-1","certified":false}', '= operations: []']);
});

test('a very long line that is gone is shown by a short identity, and history still replays', () => {
  const big = 'x'.repeat(5000);
  const first = { ...answer(['a']), operations: [{ tool: 'Execute', result: { teaching: big } }] };
  const second = { ...answer(['a']), operations: [{ tool: 'Execute', state: 'done' }] };
  const texts = plan([raw(first), raw(second)].map(classify));
  const gone = texts[1].split('\n').filter((line) => line.startsWith('- operations:'));
  assert.equal(gone.length, 1);
  assert.match(gone[0], /^- operations: #[0-9a-f]{16} \(\d+ characters\)$/);
  assert.ok(!texts[1].includes(big));
  // The rewritten texts replay to the same result: a second pass over them changes nothing.
  const again = plan(texts.map((text, index) => classify(texts[index] ?? text)));
  assert.ok(again.every((text) => text === null));
});
