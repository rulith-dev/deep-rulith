import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { installProjectContext, projectLine, readSourceBindings, reconcileProjectContext, resolveProject } from '../../harness/web/project-source.mjs';

const windowsSources = [
  { name: 'lab', type: 'file', location: 'D:\\Work\\strixllama' },
  { name: 'rulith-java', type: 'file', location: 'D:\\Work\\rulith-java' },
];

test('project resolution: exact, nested, Windows case/separators, and no match', () => {
  for (const cwd of ['D:\\Work\\rulith-java', 'D:/Work/rulith-java/src/main', 'd:/WORK/RULITH-JAVA/', 'D:\\Work\\rulith-java\\src/../test'])
    assert.deepEqual(resolveProject(cwd, windowsSources, 'win32'), { name: 'rulith-java', directory: 'D:\\Work\\rulith-java' });
  for (const cwd of ['D:/Work/rulith-java-other', 'D:/Work', 'E:/Work/rulith-java', '', undefined])
    assert.equal(resolveProject(cwd, windowsSources, 'win32'), null);
  assert.equal(resolveProject('D:/Work/strixllama', windowsSources, 'win32').name, 'lab');
});

test('deepest approved file directory wins; roots, UNC, POSIX case and non-file Sources', () => {
  const sources = [{ name: 'parent', type: 'file', location: 'D:/Work' }, ...windowsSources,
    { name: 'database', type: 'db', location: 'D:/Work/rulith-java/src' },
    { name: 'relative', type: 'file', location: 'rulith-java/src' }];
  assert.equal(resolveProject('D:/Work/rulith-java/src', sources, 'win32').name, 'rulith-java');
  assert.equal(resolveProject('D:/Work/x', [{ name: 'drive', type: 'file', location: 'D:/' }], 'win32').name, 'drive');
  assert.equal(resolveProject('//SERVER/share/project/src', [{ name: 'unc', type: 'file', location: '\\\\server\\share\\project\\' }], 'win32').name, 'unc');
  const posix = [{ name: 'java', type: 'file', location: '/work/Java/' }];
  assert.equal(resolveProject('/work/Java/src', posix, 'linux').name, 'java');
  assert.equal(resolveProject('/work/java/src', posix, 'linux'), null);
  assert.equal(resolveProject('/work/Java-other', posix, 'linux'), null);
});

test('both model lines and their documentation keep the exact project wording', () => {
  assert.equal(projectLine('D:/Work/rulith-java', { name: 'rulith-java', directory: 'D:\\Work\\rulith-java' }),
    'This conversation\'s project is Source "rulith-java" (D:\\Work\\rulith-java). Use source "rulith-java" for project files unless the user names another approved project.');
  assert.equal(projectLine('D:/Work/other', null),
    'This workspace (D:/Work/other) is not an approved Rulith project; project file Actions cannot reach it until a person adds it in Console.');
  const doc = fs.readFileSync(new URL('../../harness/model-visible.md', import.meta.url), 'utf8');
  assert.ok(doc.includes(projectLine('<directory>', { name: '<name>', directory: '<directory>' })));
  assert.ok(doc.includes(projectLine('<directory>', null)));
});

// Identified messages, step admission and surface replacement are the dsh interfaces used by the host.
function session(cwd) {
  const log = [], surface = { nodes: [] };
  return { header: { cwd }, log, surface, eventAt: (seq) => log[seq],
    append(type, data, opts = { surfaceOp: 'append' }) {
      const seq = log.length; log.push({ seq, type, data, ...opts });
      if (opts.surfaceOp?.op === 'replace') surface.nodes[surface.nodes.indexOf(opts.surfaceOp.startSeq)] = seq;
      else surface.nodes.push(seq);
    },
    texts() { return surface.nodes.flatMap((seq) => (log[seq].data.content ?? []).map((block) => block.text ?? '')); },
  };
}
const user = (text) => ({ id: text, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
function contextHarness(read) {
  let beforeStep;
  installProjectContext({ on(name, handler) { assert.equal(name, 'agent/pre-step'); beforeStep = handler; } }, read);
  return async (s, step, messages = []) => {
    const decision = await beforeStep({ agent: { session: s }, step }, async () => ({ kind: 'enter', messages }));
    for (const message of decision.messages) s.append('user/message', message);
    return decision;
  };
}
const work = process.platform === 'win32' ? 'D:/Work' : '/work';
const sources = [{ name: 'lab', type: 'file', location: work + '/strixllama' },
  { name: 'rulith-java', type: 'file', location: work + '/rulith-java' }];
const projectTexts = (s) => s.texts().filter((text) => text.startsWith('This conversation\'s project') || text.startsWith('This workspace'));

test('one correct project line per turn context across tool steps, turns, resume and independent conversations', async () => {
  const run = contextHarness(async () => sources);
  const java = session(work + '/rulith-java/src'), lab = session(work + '/strixllama');
  for (const s of [java, lab]) {
    await run(s, 1, [user('first turn')]);
    await run(s, 2);
    await run(s, 3);
    await run(s, 1, [user('second turn')]);
    await contextHarness(async () => sources)(s, 2); // A fresh hook resumes the retained surface.
    assert.equal(projectTexts(s).length, 1);
    assert.equal(s.log.filter((e) => e.data.source?.kind === 'rulith-project').length, 1);
  }
  assert.deepEqual(projectTexts(java), [projectLine(java.header.cwd, { name: 'rulith-java', directory: sources[1].location })]);
  assert.deepEqual(projectTexts(lab), [projectLine(lab.header.cwd, { name: 'lab', directory: sources[0].location })]);
});

test('no match emits the unapproved-workspace line; a changed Source replaces the context', async () => {
  let bindings = [];
  const run = contextHarness(async () => bindings), s = session(work + '/rulith-java');
  await run(s, 1, [user('work')]);
  assert.deepEqual(projectTexts(s), [projectLine(s.header.cwd, null)]);
  bindings = sources;
  await run(s, 1, [user('now approved')]);
  assert.deepEqual(projectTexts(s), [projectLine(s.header.cwd, { name: 'rulith-java', directory: sources[1].location })]);
  assert.equal(s.log[1].data.content[0].text, projectLine(s.header.cwd, null), 'the original is still in the log');
  bindings = [];
  await run(s, 2);
  assert.deepEqual(projectTexts(s), [projectLine(s.header.cwd, null)]);
});

test('unreadable Sources clear stale context, emit no project line and log visibly without error secrets', async (t) => {
  const errors = []; t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  const s = session(work + '/rulith-java');
  await contextHarness(async () => sources)(s, 1, [user('work')]);
  const unavailable = contextHarness(async () => { throw new Error('private fetch detail'); });
  await unavailable(s, 1, [user('next turn')]);
  assert.deepEqual(projectTexts(s), []);
  const fresh = session(work + '/rulith-java');
  await unavailable(fresh, 1, [user('work')]);
  assert.deepEqual(projectTexts(fresh), []);
  assert.equal(errors.length, 2);
  assert.ok(errors.every((line) => line.includes('[rulith project]') && line.includes('Sources cannot be read')));
  assert.ok(errors.every((line) => !line.includes('private fetch detail')));
  await contextHarness(async () => sources)(s, 2);
  assert.equal(projectTexts(s).length, 1, 'read recovery reuses the cleared context');
});

test('compaction restores context, duplicate retained copies are cleared, and empty/rejected steps add nothing', async () => {
  const s = session(work + '/rulith-java'), run = contextHarness(async () => sources);
  await run(s, 1);
  assert.equal(s.log.length, 0, 'no incoming turn');
  await run(s, 1, [user('work')]);
  const message = s.log[1].data;
  s.surface.nodes = []; // Compaction removed the entire old surface span.
  await run(s, 2);
  assert.equal(projectTexts(s).length, 1);
  s.append('user/message', message);
  reconcileProjectContext(s, message.content[0].text);
  assert.equal(projectTexts(s).length, 1);
  let handler, reads = 0;
  installProjectContext({ on(_name, cb) { handler = cb; } }, async () => { reads++; return sources; });
  assert.deepEqual(await handler({ agent: { session: s }, step: 1 }, async () => ({ kind: 'reject' })), { kind: 'reject' });
  assert.equal(reads, 0);
});

test('Source reader reuses the existing Worker channel and projects only binding metadata (mock fetch, no network)', async () => {
  const env = { RULITH_WORK_URL: 'https://example.invalid/work', RULITH_CONNECTION: 'fixture-id', RULITH_CONNECTION_KEY: 'fixture-key' };
  const seen = [];
  const rows = await readSourceBindings(env, async (url, init) => {
    seen.push({ url, init });
    return { ok: true, json: async () => ({ sources: [{ name: 'rulith-java', type: 'file', access: 'D:/Work/rulith-java', private: 'excluded' }] }) };
  });
  assert.deepEqual(rows, [{ name: 'rulith-java', type: 'file', location: 'D:/Work/rulith-java' }]);
  assert.equal(seen[0].url, env.RULITH_WORK_URL + '/sources');
  assert.deepEqual(seen[0].init.headers, { 'x-rulith-connection': 'fixture-id', 'x-rulith-connection-key': 'fixture-key' });
  assert.equal(seen[0].init.redirect, 'error');
  await assert.rejects(readSourceBindings({}, () => { throw new Error('must not fetch'); }), /not configured/);
  await assert.rejects(readSourceBindings(env, async () => ({ ok: false, status: 403 })), /answered 403/);
  await assert.rejects(readSourceBindings(env, async () => ({ ok: true, json: async () => ({}) })), /unreadable/);
  assert.deepEqual(await readSourceBindings(env, async () => ({ ok: true, json: async () => ({ sources: [] }) })), []);
});

test('Board panel renders this session project beside Worker and hides another workspace response', () => {
  let plugin, column;
  const cwd = work + '/rulith-java';
  let values, index;
  const React = { createElement: (tag, props, ...children) => ({ tag, props, children }),
    useState: (initial) => [index < values.length ? values[index++] : initial, () => {}], useEffect() {}, useCallback: (fn) => fn };
  vm.runInNewContext(fs.readFileSync(new URL('../../harness/web/rulith-dsh-ui/lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => React); } } }, setTimeout() {},
  });
  plugin.apply({ effect() {}, inject() {}, sidebarRight: { mounted: { subscribe() {} } },
    slots: { inject(_name, fn) { if (fn.constructor.name !== 'GeneratorFunction') fn(); },
      register(opts, component) { if (opts.name === 'sidebar.right.pane.tab') column = component; } } });
  const render = (workspace) => {
    index = 0;
    values = [{ ok: true, workspace, project: { name: 'rulith-java' } },
      { ok: true, available: true, view: {} }, { ok: true, available: true, state: 'online' }, null];
    return column({ sessionId: 'java-conversation', useSessions: (selector) => selector({ byId: { 'java-conversation': { cwd } } }) });
  };
  const workerBlock = render(cwd).children.find((node) => node?.children?.[0]?.children?.[0]?.children?.[0] === '本机执行（Worker）');
  assert.equal(workerBlock.children[0].children[1].children[0], 'rulith-java');
  const stale = render(work + '/strixllama').children.find((node) => node?.children?.[0]?.children?.[0]?.children?.[0] === '本机执行（Worker）');
  assert.equal(stale.children[0].children[1], null);
});
