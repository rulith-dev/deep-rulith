import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, clearFirst, identity, plan, rewriteSession, KEEP_RESULTS, CLEAR_FIRST_LINE, FULL_HEAD, DELTA_HEAD } from '../../harness/web/board-transcript.mjs';

// 2026-10-14 旧结果减负：比最近 KEEP_RESULTS 份工具结果更早的 Rulith 结果，长结果行压成紧凑 JSON，长的 `+` 行只显示短身份。
// 这里用一段合成历史检查：只改显示、不改比较；最新一份整块板原样；第二遍不变；逐步改写与一次改写结果相同。

const raw = (answer, isError = false) =>
  (isError ? 'Error: ' : '') + JSON.stringify({ isError, content: [{ type: 'text', text: JSON.stringify(answer) }] });

// 一步 Execute 的回答：结果行很长（命令输出），板上加一条事实、位置变化，操作栏换上一条带整份结果的长行。每第 4 步是一次拒绝。
const refused = (i) => i % 4 === 3;
function stepAnswer(i) {
  return {
    accepted: !refused(i), tool: 'Execute', requestExecuted: !refused(i),
    ...(refused(i) ? { errorCode: 'precondition_failed', teaching: `teaching ${i} `.repeat(300) } : {}),
    result: { action: 'eng.run_command', ok: !refused(i), status: refused(i) ? 'refused' : 'done', output: `output ${i} `.repeat(400) },
    view: {
      position: { writes: 'open', step: i },
      facts: Array.from({ length: 3 + i }, (_, k) => ({ label: `fact ${k}` })),
      actions: [{ action: 'eng.run_command', status: 'ready', description: 'Run a command', inputSchema: { type: 'object', note: 'n'.repeat(2500) } }],
    },
    operations: [{ tool: 'Execute', step: i, result: { output: `operation ${i} `.repeat(400) } }],
  };
}
const history = (n) => Array.from({ length: n }, (_, i) => raw(stepAnswer(i), refused(i)));
const rowsOf = (text) => text.split('\n').slice(2).filter((line) => /^[=+-] /.test(line));
const SHORT = /^[^:]*: #[0-9a-f]{16} \(\d+ characters\)$/;

// Enough of a dsh session for the rewrite (same shape as board-transcript.test.mjs).
function fakeSession(texts = []) {
  const log = [];
  const surface = { nodes: [] };
  const append = (type, data, opts = {}) => {
    const event = { type, seq: log.length, data, ...opts };
    log.push(event);
    if (opts.surfaceOp?.op === 'replace') surface.nodes[surface.nodes.indexOf(opts.surfaceOp.startSeq)] = event.seq;
    else surface.nodes.push(event.seq);
    return event;
  };
  const addResult = (text) => append('tool/result', { message: { role: 'tool', toolCallId: `c${log.length}`, content: [{ type: 'text', text }] } }, { surfaceOp: 'append' });
  for (const text of texts) addResult(text);
  return { log, surface, append, addResult, eventAt: (seq) => log[seq], deriveEventMessage: (event) => event.data.message,
    visible: () => surface.nodes.map((seq) => log[seq].data.message.content[0].text) };
}

test('results older than the most recent six are relieved; the six recent and the latest view are shown as they were', () => {
  const texts = plan(history(10).map(classify));
  const plain = plan(history(10).map(classify), { keepResults: Infinity });
  const old = 10 - 1 - KEEP_RESULTS; // items 0..3 have six or more results after them
  for (let i = 0; i < 10; i++) {
    const [first] = texts[i].split('\n');
    const isError = first.startsWith('Error: ');
    assert.equal(isError, refused(i));
    const rest = JSON.parse(isError ? first.slice('Error: '.length) : first);
    if (i <= old) {
      // A compact JSON that still parses: the outcome fields stay, the long output and teaching are gone.
      assert.ok(first.length <= CLEAR_FIRST_LINE);
      assert.equal(rest.accepted, !refused(i));
      assert.equal(rest.tool, 'Execute');
      assert.equal(rest.requestExecuted, !refused(i));
      assert.deepEqual(rest.result, { action: 'eng.run_command', ok: !refused(i), status: refused(i) ? 'refused' : 'done' });
      if (refused(i)) assert.equal(rest.errorCode, 'precondition_failed');
      assert.ok(!('teaching' in rest) && !('output' in rest.result));
      assert.match(rest.cleared, /^\d+ characters of this earlier result were cleared to save context; the Board holds the state$/);
      // The new long operations line is shown by its short identity, like the gone one.
      const added = rowsOf(texts[i]).filter((line) => line.startsWith('+ operations:'));
      assert.equal(added.length, 1);
      assert.match(added[0].slice(2), SHORT);
      assert.ok(rowsOf(texts[i]).every((line) => line.length <= 2002));
    } else {
      assert.equal(texts[i], plain[i]);
      assert.ok(rest.result.output.startsWith(`output ${i}`));
    }
  }
  // The latest whole view keeps complete raw lines.
  const latest = texts[9].split('\n');
  assert.equal(latest[1], FULL_HEAD);
  assert.ok(latest.some((line) => line.startsWith('+ operations: {"tool":"Execute","step":9')));
  assert.ok(latest.some((line) => line.includes('"inputSchema"')));
});

test('relief changes what is shown, never what changed: every step marks the same identities as without relief', () => {
  const items = () => history(30).map(classify);
  const relieved = plan(items());
  const plain = plan(items(), { keepResults: Infinity });
  const marks = (text) => rowsOf(text).map((line) => `${line[0]} ${identity(line.slice(2))}`);
  relieved.forEach((text, i) => assert.deepEqual(marks(text), marks(plain[i]), `step ${i}`));
  assert.equal(relieved.at(-1), plain.at(-1));
  // Rebuilding from the rewritten texts gives the same marks again (identities are what the marks compare).
  const replayed = plan(relieved.map(classify));
  assert.ok(replayed.every((text) => text === null));
  const total = (texts) => texts.reduce((n, text) => n + text.length, 0);
  assert.ok(total(relieved) < total(plain) / 2);
});

test('a second pass changes nothing, and rewriting step by step ends where one pass over the whole history does', () => {
  const texts = history(14);
  const stepwise = fakeSession();
  for (const text of texts) { stepwise.addResult(text); rewriteSession(stepwise); }
  const once = fakeSession(texts);
  rewriteSession(once);
  assert.deepEqual(stepwise.visible(), once.visible());
  assert.equal(rewriteSession(stepwise), 0);
  assert.equal(rewriteSession(once), 0);
  // The original results stay in the log for the person's transcript.
  assert.deepEqual(stepwise.log.filter((event) => !event.surfaceOp?.op).slice(0, 14).map((event) => event.data.message.content[0].text), texts);
});

test('tool results without a Board count toward the six', () => {
  const board = raw(stepAnswer(0));
  const artifact = raw({ accepted: true, artifact: { text: 'x' } });
  const firstLine = (between) => {
    const session = fakeSession([board, ...Array(between).fill(artifact), raw(stepAnswer(1))]);
    rewriteSession(session);
    return session.visible()[0].split('\n')[0];
  };
  // With four Get-artifact reads and one Board result after it, five results are newer: still recent.
  assert.ok(firstLine(4).includes('output 0'));
  // With five reads, six results are newer: the first one is relieved, though only one Board result follows it.
  assert.ok(firstLine(5).includes('"cleared"'));
});

test('a short, unreadable or already cleared result line is left as it is', () => {
  assert.equal(clearFirst('{"accepted":true}'), '{"accepted":true}');
  const unreadable = `{"accepted":true,${'x'.repeat(2000)}`;
  assert.equal(clearFirst(unreadable), unreadable);
  const long = JSON.stringify({ accepted: false, errorCode: 'e', result: { status: { detail: 'd'.repeat(300) }, action: 'a' }, teaching: 't'.repeat(2000) });
  const cleared = clearFirst(`Error: ${long}`);
  assert.ok(cleared.startsWith('Error: {'));
  // A kept field must be short: a long status is cleared with the rest.
  assert.deepEqual(JSON.parse(cleared.slice('Error: '.length)), { accepted: false, errorCode: 'e', result: { action: 'a' },
    cleared: `${long.length} characters of this earlier result were cleared to save context; the Board holds the state` });
  assert.equal(clearFirst(cleared), cleared);
  const padded = JSON.stringify({ accepted: true, cleared: 'earlier', pad: 'p'.repeat(2000) });
  assert.equal(clearFirst(padded), padded);
});

test('relief touches only Rulith results: other tool results and the assistant messages stay as they were', () => {
  const session = fakeSession();
  const call = { type: 'tool-call', id: 'w', name: 'Execute', arguments: JSON.stringify({ action: 'eng.write_file', args: { text: 'w'.repeat(6000) } }) };
  const assistant = session.append('assistant/message', { message: { role: 'assistant', content: [{ type: 'reasoning', text: 'r' }, call] } }, { surfaceOp: 'append' });
  session.addResult('plain text '.repeat(500));
  for (const text of history(8)) session.addResult(text);
  rewriteSession(session);
  assert.equal(session.surface.nodes[0], assistant.seq);
  assert.equal(session.log.filter((event) => event.type === 'assistant/message').length, 1);
  assert.equal(session.visible()[1], 'plain text '.repeat(500));
  assert.ok(session.visible()[2].includes('"cleared"'));
  assert.equal(session.visible()[2].split('\n')[1], DELTA_HEAD);
});
