import test from 'node:test';
import assert from 'node:assert/strict';
import { stripPriorReasoning } from '../../harness/web/thinking-history.mjs';

// Enough of a dsh session for the rewrite: an event log, the model-visible surface and dsh's replace records.
function fakeSession() {
  const log = [];
  const surface = { nodes: [] };
  const append = (type, data, opts = { surfaceOp: 'append' }) => {
    const event = { type, seq: log.length, data, ...opts };
    log.push(event);
    if (opts.surfaceOp?.op === 'replace') surface.nodes[surface.nodes.indexOf(opts.surfaceOp.startSeq)] = event.seq;
    else surface.nodes.push(event.seq);
    return event;
  };
  const user = (text) => append('user/message', { role: 'user', content: [{ type: 'text', text }] });
  const assistant = (...content) => append('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content } });
  const tool = (text) => append('tool/result', { message: { role: 'tool', toolCallId: 'c', content: [{ type: 'text', text }] } });
  const derive = (event) => (event?.type === 'user/message' ? event.data : event?.data?.message);
  return { log, surface, append, user, assistant, tool, eventAt: (seq) => log[seq], deriveEventMessage: derive,
    visible: () => surface.nodes.map((seq) => derive(log[seq])) };
}

const think = (text) => ({ type: 'reasoning', text });
const say = (text) => ({ type: 'text', text });
const call = (id) => ({ type: 'tool-call', id, name: 'QueryBoard', input: {} });

test('reasoning before the last user message is dropped; the current turn keeps it', () => {
  const session = fakeSession();
  session.user('first');
  session.assistant(think('plan A'), call('c1'));
  session.tool('{}');
  session.assistant(think('done A'), say('A is done'));
  session.user('second');
  session.assistant(think('plan B'), call('c2'));
  session.tool('{}');
  assert.equal(stripPriorReasoning(session), 2);
  const [, a1, , a2, , b1] = session.visible();
  assert.deepEqual(a1.content, [call('c1')]);
  assert.deepEqual(a2.content, [say('A is done')]);
  assert.deepEqual(b1.content, [think('plan B'), call('c2')], 'the current turn keeps its reasoning');
  // The originals stay in the log for the person's transcript; a second pass changes nothing.
  assert.equal(session.log.length, 9);
  assert.equal(stripPriorReasoning(session), 0);
});

test('a reply that was only reasoning keeps an empty text block; no user message means nothing to drop', () => {
  const session = fakeSession();
  session.assistant(think('alone'));
  assert.equal(stripPriorReasoning(session), 0);
  session.user('now');
  assert.equal(stripPriorReasoning(session), 1);
  assert.deepEqual(session.visible()[0].content, [say('')]);
});

test('each new user message drops only the reasoning of the turn before it', () => {
  const session = fakeSession();
  session.user('one');
  session.assistant(think('t1'), say('r1'));
  session.user('two');
  assert.equal(stripPriorReasoning(session), 1);
  session.assistant(think('t2'), say('r2'));
  assert.equal(stripPriorReasoning(session), 0, 'still the current turn');
  session.user('three');
  assert.equal(stripPriorReasoning(session), 1);
  assert.deepEqual(session.visible().map((m) => m.content.map((b) => b.type).join('+')), ['text', 'text', 'text', 'text', 'text']);
});
