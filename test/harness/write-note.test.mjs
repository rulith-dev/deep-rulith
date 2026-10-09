import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, plan, WRITE_NOTE_AFTER, writeNote } from '../../harness/web/board-transcript.mjs';

const raw = (answer) => JSON.stringify({ isError: false, content: [{ type: 'text', text: JSON.stringify(answer) }] });
const board = (accepted = true) => ({ accepted, view: { position: { writes: 'open' } }, operations: [] });
const item = (tool, accepted = true) => Object.assign(classify(raw(board(accepted))), { tool });

test('after enough calls without an accepted ApplyBatch, only the latest result carries the reminder', () => {
  const items = [item('ApplyBatch'), ...Array.from({ length: WRITE_NOTE_AFTER }, () => item('ApplyAction'))];
  const texts = plan(items);
  assert.ok(texts.at(-1).endsWith(writeNote(WRITE_NOTE_AFTER)));
  assert.ok(texts.slice(0, -1).every((text) => !text.includes('Note:')));
});

test('an accepted ApplyBatch resets the count; a refused one does not', () => {
  const quiet = [...Array.from({ length: WRITE_NOTE_AFTER - 1 }, () => item('QueryBoard')), item('ApplyBatch')];
  assert.ok(!plan(quiet).at(-1).includes('Note:'));
  const refused = [...Array.from({ length: WRITE_NOTE_AFTER - 1 }, () => item('QueryBoard')), item('ApplyBatch', false)];
  assert.ok(plan(refused).at(-1).includes(writeNote(WRITE_NOTE_AFTER)));
});

test('a result that carried the reminder is demoted without it and replays the same Board', () => {
  const items = [item('ApplyBatch'), ...Array.from({ length: WRITE_NOTE_AFTER }, () => item('ApplyAction'))];
  const first = plan(items);
  const carried = classify(first.at(-1));
  const next = plan([...items.slice(0, -1).map((it, i) => (first[i] === null ? it : Object.assign(classify(first[i]), { tool: it.tool }))),
    Object.assign(carried, { tool: 'ApplyAction' }), item('ApplyBatch')]);
  assert.ok(!next.at(-2).includes('Note:'));
  assert.ok(!next.at(-1).includes('Note:'));
});
