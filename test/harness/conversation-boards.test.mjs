import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import fs from 'node:fs';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { conversationKey, depthOf, toolsOf, DELEGATION_TOOLS } from '../../harness/subagents.mjs';
import { RulithMcp, TOOLS } from '../../harness/rulith-mcp.mjs';
import { ConversationBoards } from '../../harness/web/conversation-boards.mjs';
import { ShadowReviewer } from '../../harness/web/shadow-reviewer.mjs';
import { apply, cachedBoard } from '../../harness/web/rulith-runtime.mjs';

const agent = (id, header = {}, options = {}) => ({ session: { id, header }, options });
const main = agent('parent');
const child = agent('child', { parentSession: 'parent', origin: 'subagent', delegationDepth: 1 });
const fork = agent('fork', { parentSession: 'parent', isSeeded: true });

test('conversation keys survive restart; delegated children share the parent, user forks own a new Board', () => {
  assert.equal(conversationKey(main), 'dsh:parent');
  assert.equal(conversationKey(agent('parent')), conversationKey(main));
  assert.equal(conversationKey(child), conversationKey(main));
  assert.equal(conversationKey(agent('cold-child', { parentSession: 'parent', delegationDepth: 1 })), 'dsh:parent');
  assert.equal(conversationKey(agent('origin-child', { parentSession: 'parent', origin: 'subagent' })), 'dsh:parent');
  assert.equal(conversationKey(agent('option-child', { parentSession: 'parent' }, { subagentDepth: 1 })), 'dsh:parent');
  assert.equal(conversationKey(fork), 'dsh:fork');
  assert.equal(conversationKey(agent('fork-child', { parentSession: 'fork', origin: 'subagent', delegationDepth: 1 })), 'dsh:fork');
  assert.equal(depthOf(fork), 0);
  assert.deepEqual(toolsOf(fork), [...TOOLS, ...DELEGATION_TOOLS]);
  for (const invalid of [undefined, '', 'space id', 'trailing\n', 'non-ascii-中', 'a'.repeat(197)]) {
    assert.throws(() => conversationKey(agent(invalid)), /session id refused/);
  }
  assert.throws(() => conversationKey(agent('orphan', { origin: 'subagent' })), /session id refused/);
});

function fixture(t, options = {}) {
  const requests = [], bridges = [], delays = [];
  let transport = options.transport;
  const connect = async (key) => {
    const bridge = new RulithMcp({ url: 'http://127.0.0.1:9/mcp', token: 'fixture', conversationKey: key,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        requests.push({ ...body, headers: init.headers, bridge });
        await transport?.(body, key, bridge);
        const headers = { 'content-type': 'application/json', 'mcp-session-id': `mcp-${bridges.indexOf(bridge)}` };
        if (body.method === 'notifications/initialized') return new Response(null, { status: 202, headers });
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {
          protocolVersion: '2025-11-25', tools: TOOLS.map((name) => ({ name })),
          content: [{ type: 'text', text: JSON.stringify({ accepted: true, view: { goals: [key ?? 'default'] }, operations: [] }) }],
          _meta: { 'rulith/v4': { agentId: 'fixture', focusedGoals: [key ?? 'default'] } },
        } }), { headers });
      } });
    bridges.push(bridge);
    try { await bridge.initialize(); const listed = await bridge.list(); return { bridge, listed }; }
    catch (error) { bridge.close(); throw error; }
  };
  const boards = new ConversationBoards({ connect, shadow: () => new ShadowReviewer({ enabled: false }),
    wait: async (ms, signal) => { assert.equal(signal.aborted, false); delays.push(ms); }, ...options });
  t.after(() => boards.close());
  return { boards, requests, bridges, delays, transport: (fn) => { transport = fn; } };
}

test('two conversations lazily open distinct bridges and channels; one pending call does not block the other', async (t) => {
  const f = fixture(t);
  f.boards.observe(main); f.boards.observe(child); f.boards.observe(fork);
  assert.equal(f.boards.size, 0);
  const a = f.boards.holder(main), b = f.boards.holder(fork);
  assert.equal(f.bridges.length, 0);
  assert.equal(f.boards.holder(child), a);
  assert.notEqual(a.channel, b.channel);
  assert.notEqual(a.channel.shadow, b.channel.shadow);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  f.transport(async (body, key) => { if (body.method === 'tools/call' && key === 'dsh:parent') await gate; });
  const pending = a.channel.call('Get', {});
  t.after(release);
  await setImmediate();
  await b.channel.call('Get', {});
  assert.equal(a.channel.latestBoard, null);
  assert.deepEqual(b.channel.latestBoard.view.goals, ['dsh:fork']);
  release(); await pending;
  assert.deepEqual(a.bridge.focusedGoals, ['dsh:parent']);
  assert.deepEqual(b.bridge.focusedGoals, ['dsh:fork']);
  assert.deepEqual(a.channel.latestBoard.view.goals, ['dsh:parent']);
  assert.equal(f.bridges.length, 2);
  for (const key of ['dsh:parent', 'dsh:fork']) {
    const calls = f.requests.filter((r) => r.headers['X-Rulith-Conversation'] === key);
    assert.deepEqual(calls.map((r) => r.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    assert.ok(calls.slice(1).every((r) => r.headers['mcp-session-id']));
  }
  assert.deepEqual(cachedBoard({ agentName: 'fixture', boards: f.boards }),
    { available: true, agentName: 'fixture', liveConversations: 2 });
});

test('header is immutable and validated; absent key preserves legacy MCP requests', async (t) => {
  for (const key of ['', 'a b', 'trailing\n', '\x7f', '中', 'a'.repeat(201), 7]) {
    assert.throws(() => new RulithMcp({ url: 'http://localhost/mcp', token: 't', conversationKey: key }), /conversation key refused/);
  }
  const f = fixture(t, { enabled: false });
  const a = f.boards.holder(main);
  assert.equal(f.boards.holder(fork), a); assert.equal(f.boards.holder(child), a);
  await a.channel.call('Get', {});
  assert.equal(f.bridges.length, 1);
  assert.ok(f.requests.every((r) => !Object.hasOwn(r.headers, 'X-Rulith-Conversation')));
  assert.throws(() => { a.bridge.conversationKey = 'changed'; }, TypeError);
  f.boards.disposeSession(main.session); f.boards.disposeSession(child.session); f.boards.disposeSession(fork.session);
  assert.equal(a.bridge.closed, false, 'legacy connection lives until Agent detach');
});

test('patient reconnect retains the key and channel state; a write with unknown outcome is never replayed', async (t) => {
  const f = fixture(t);
  const a = f.boards.holder(main);
  await a.channel.call('Get', {});
  const channel = a.channel;
  let failed = false;
  f.transport((body) => { if (body.method === 'initialize' && !failed) { failed = true; throw new Error('offline'); } });
  a.bridge.close();
  await a.channel.call('Get', {});
  assert.deepEqual(f.delays, [2000]);
  assert.equal(a.channel, channel);
  assert.equal(f.bridges.length, 3);
  assert.ok(f.requests.every((r) => r.headers['X-Rulith-Conversation'] === 'dsh:parent'));
  const writeCount = () => f.requests.filter((r) => r.method === 'tools/call' && r.params.name === 'Set').length;
  f.transport((body) => { if (body.method === 'tools/call' && body.params.name === 'Set') throw new Error('offline'); });
  await assert.rejects(f.boards.request(a, 'Set', { operations: [] }), /outcome is unknown/);
  assert.equal(writeCount(), 1);
  await a.channel.call('Get', {});
  assert.equal(writeCount(), 1);
});

test('a failed Get retries on the same conversation; initial connection attempts are shared', async (t) => {
  const f = fixture(t);
  const a = f.boards.holder(main);
  await Promise.all([f.boards.liveBridge(a), f.boards.liveBridge(a)]);
  assert.equal(f.bridges.length, 1);
  let failed = false;
  f.transport((body) => { if (body.method === 'tools/call' && !failed) { failed = true; throw new Error('offline'); } });
  await a.channel.call('Get', {});
  assert.equal(f.bridges.length, 2);
  assert.ok(f.bridges.every((b) => b.conversationKey === 'dsh:parent'));
});

test('session disposal keeps a parent Board while its child lives, then closes and recreates it with the same key', async (t) => {
  const f = fixture(t);
  f.boards.observe(main); f.boards.observe(child);
  const a = f.boards.holder(child);
  await a.channel.call('Get', {});
  f.boards.disposeSession(main.session);
  assert.equal(a.bridge.closed, false);
  f.boards.disposeSession(child.session);
  assert.equal(f.boards.size, 0); assert.equal(a.bridge.closed, true);
  assert.equal(a.channel.closed, true); assert.equal(a.channel.shadow.stopped, true);
  const reopened = f.boards.holder(agent('parent'));
  assert.notEqual(reopened, a);
  await reopened.channel.call('Get', {});
  assert.equal(reopened.bridge.conversationKey, 'dsh:parent');
});

test('disposal during an unfinished connection closes its late bridge and cannot resurrect the holder', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, { transport: async (body) => { if (body.method === 'initialize') await gate; } });
  t.after(release);
  const a = f.boards.holder(main);
  const opening = f.boards.liveBridge(a);
  f.boards.disposeSession(main.session);
  release();
  await assert.rejects(opening, /Agent detached/);
  assert.equal(f.boards.size, 0); assert.ok(f.bridges.every((b) => b.closed));
});

test('a conversation waiting to reconnect cannot block another; disposal cancels its backoff', async (t) => {
  let waiting;
  const started = new Promise((resolve) => { waiting = resolve; });
  const f = fixture(t, { wait: (_ms, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }); waiting();
  }) });
  const a = f.boards.holder(main), b = f.boards.holder(fork);
  await a.channel.call('Get', {});
  a.bridge.close();
  f.transport((body, key) => { if (key === 'dsh:parent' && body.method === 'initialize') throw new Error('offline'); });
  const reconnect = assert.rejects(a.channel.call('Get', {}), /abort/i);
  await started;
  await b.channel.call('Get', {});
  assert.deepEqual(b.channel.latestBoard.view.goals, ['dsh:fork']);
  f.boards.disposeSession(main.session);
  await reconnect;
  assert.equal(f.boards.size, 1);
});

test('runtime routes registered tools by conversation, publishes only aggregate status, and disposes on dsh events', async (t) => {
  // All I/O is mocked: no manager, credentials, socket, status file or Gateway is accessed.
  const previousFlag = process.env.RULITH_DSH_CONVERSATION_BOARDS;
  process.env.RULITH_DSH_CONVERSATION_BOARDS = '1';
  t.after(() => {
    if (previousFlag === undefined) delete process.env.RULITH_DSH_CONVERSATION_BOARDS;
    else process.env.RULITH_DSH_CONVERSATION_BOARDS = previousFlag;
  });
  const requests = [], statuses = [], definitions = [], effects = [], listeners = new Map();
  let server;
  t.mock.method(net, 'connect', (_options, callback) => {
    const socket = new EventEmitter(); socket.destroy = () => {};
    queueMicrotask(callback); return socket;
  });
  t.mock.method(fs, 'readFileSync', (file) => {
    if (String(file).endsWith('fixture-key.txt')) return 'fixture-manager-key';
    if (String(file).endsWith('registry.json')) return JSON.stringify({ instances: [
      { id: 'instance', mode: 'local_agent', agentName: 'fixture', directory: 'fixture-instance' },
    ] });
    if (String(file).endsWith('local.json')) return JSON.stringify({ agent: { env: { RULITH_TOKEN: 'fixture-token' } } });
    throw new Error('fixture file absent');
  });
  t.mock.method(fs, 'writeFileSync', (_file, value) => statuses.push(JSON.parse(value)));
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body); requests.push({ ...body, headers: init.headers });
    const headers = { 'content-type': 'application/json', 'mcp-session-id': 'fixture-mcp-session' };
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202, headers });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {
      protocolVersion: '2025-11-25', tools: TOOLS.map((name) => ({ name, description: `fixture ${name}`, inputSchema: { type: 'object' } })),
      content: [{ type: 'text', text: JSON.stringify({ accepted: true, view: {}, operations: [] }) }],
      _meta: { 'rulith/v4': { agentId: 'fixture' } },
    } }), { headers });
  });
  const ctx = {
    on(event, fn) { const handlers = listeners.get(event) ?? []; handlers.push(fn); listeners.set(event, handlers); },
    effect(fn) { effects.push(fn()); },
    tools: { register(def) { definitions.push(def); return () => {}; } },
    webServer: { register(route) { server = route; return () => {}; } },
  };
  t.after(() => { for (const dispose of effects.reverse()) dispose?.(); });
  await apply(ctx, { managerHome: 'fixture-manager', runtimeEntry: 'fixture-runtime', keyFile: 'fixture-key.txt',
    conversationBoards: true, shadow: { enabled: false } });
  assert.deepEqual(definitions.map((d) => [d.name, d.description]), TOOLS.map((name) => [name, `fixture ${name}`]));
  assert.deepEqual(requests.map((r) => r.method), ['initialize', 'notifications/initialized', 'tools/list']);
  assert.ok(requests.every((r) => r.headers['X-Rulith-Conversation'] === undefined), 'attachment only discovers tools');
  const emit = (event, value) => { for (const fn of listeners.get(event) ?? []) fn(value); };
  emit('agent/created', { agent: main }); emit('agent/created', { agent: child }); emit('agent/created', { agent: fork });
  const get = definitions.find((d) => d.name === 'Get');
  for (const agent of [main, child, fork]) await get.execute({}, { agent });
  assert.deepEqual(requests.filter((r) => r.method === 'tools/call').map((r) => r.headers['X-Rulith-Conversation']),
    ['dsh:parent', 'dsh:parent', 'dsh:fork']);
  assert.equal(requests.filter((r) => r.method === 'initialize').length, 3, 'discovery plus two conversations');
  assert.equal(statuses.at(-1).liveConversations, 2);
  let panel;
  await server.handler({ method: 'GET', url: '/rulith/api/board', headers: { host: 'localhost', 'x-deep-rulith': '1' } },
    { writeHead() {}, end(body) { panel = JSON.parse(body); } });
  assert.deepEqual(panel, { ok: true, available: true, agentName: 'fixture', liveConversations: 2 });
  emit('session/disposed', main.session); assert.equal(statuses.at(-1).liveConversations, 2);
  emit('session/disposed', child.session); assert.equal(statuses.at(-1).liveConversations, 1);
  emit('session/disposed', fork.session); assert.equal(statuses.at(-1).liveConversations, 0);
  assert.doesNotMatch(JSON.stringify(statuses), /dsh:|fixture-token|fixture-manager-key|fixture-mcp-session/);
});
