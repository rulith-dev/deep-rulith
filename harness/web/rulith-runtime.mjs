// Deep Rulith, host half. It keeps the owner's Rulith Runtime manager running beside dsh: sign-in, Agent pairing and the
// local Worker stay exactly the Runtime's own, reached only through the manager's local API. It gives dsh's agents
// Rulith's six MCP tools for the selected Agent, and serves the browser half's account entry and Rulith panel under
// /rulith/api on dsh's own server (same origin). Nothing here executes model-authored work: execution happens only in
// the Runtime's Worker, through Rulith Actions.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { RulithMcp, TOOLS } from '../rulith-mcp.mjs';
import { installBoardTranscript } from './board-transcript.mjs';
import { installThinkingHistory } from './thinking-history.mjs';

export const name = 'rulith-runtime';
export const inject = ['tools', 'webServer'];

const listening = (port) => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
});
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** The Agent this dsh speaks for: the chosen instance, or the only paired local Agent in the manager home. */
export function selectedAgent(home, agentName) {
  const registry = readJson(path.join(home, 'registry.json'));
  const rows = (registry?.instances ?? []).filter((row) => row.mode === 'local_agent' && !row.signedOutAt
    && (!agentName || row.agentName === agentName));
  if (rows.length !== 1) return null;
  const local = readJson(path.join(rows[0].directory, 'local.json'));
  const token = local?.agent?.env?.RULITH_TOKEN;
  return token ? { instanceId: rows[0].id, agentId: rows[0].agentId, agentName: rows[0].agentName, token } : null;
}

const UNRESOLVED = new Set(['running', 'waiting_for_decision', 'needs_person']);
const parsed = (result) => { try { return JSON.parse((result.content ?? []).map((part) => part.text ?? '').join('')); } catch { return null; } };
/** This call's own unresolved entry on a strip: the one entry of its tool that is still open (the execution slot holds one). */
const openEntryOf = (strip, tool) => {
  const open = (Array.isArray(strip) ? strip : []).filter((e) => e && e.tool === tool && UNRESOLVED.has(e.state));
  return open.length === 1 ? open[0] : undefined;
};
/**
 * A write the authority holds past its bound comes back `running`; the Worker keeps executing. Instead of handing the
 * model `running` (and the model spending steps re-reading the Board), wait here and read the strip until this call's
 * own entry settles, then answer with that read: it carries the outcome in full the first time it is shown. Waiting
 * for a person's decision is not waited on. The wait ends at RULITH_DSH_WAIT_SECONDS if set (0 or unset: until settled).
 */
export async function awaitOutcome(bridge, tool, result, { pollMs = 2_000, waitSeconds = Number(process.env.RULITH_DSH_WAIT_SECONDS || 0) } = {}) {
  const first = parsed(result);
  const own = openEntryOf(first?.operations, tool);
  if (!own || own.state !== 'running') return result;
  const deadline = waitSeconds > 0 ? Date.now() + waitSeconds * 1000 : Infinity;
  let last = result;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const look = await bridge.call('QueryBoard', {});
    if (look.isError) return last;
    last = look;
    const strip = parsed(look)?.operations;
    const entry = (Array.isArray(strip) ? strip : []).find((e) => e && e.tool === own.tool && e.label === own.label && e.at === own.at);
    if (!entry || entry.state !== 'running') return look;
  }
  return last;
}

export async function apply(ctx, config = {}) {
  const home = config.managerHome;
  const port = Number(config.managerPort ?? 7790);
  if (!home || !config.runtimeEntry || !config.keyFile) throw new Error('rulith-runtime needs managerHome, runtimeEntry and keyFile');
  const key = fs.readFileSync(config.keyFile, 'utf8').trim();
  const consoleUrl = config.consoleUrl || 'https://console.rulith.ai';
  const stateDir = process.env.DSH_HOME ?? home;
  const selectionFile = path.join(stateDir, 'rulith-selected.json');
  const statusFile = path.join(stateDir, 'rulith-runtime-status.json');
  const chosenName = () => readJson(selectionFile)?.agentName || config.agentName || undefined;
  // 模型看到的 Rulith 结果：最新一份整块板（+／- 标出变化），更早的只留变化（D-1008e，见 board-transcript.mjs）。
  installBoardTranscript(ctx);
  // 之前轮次的思考不再发回模型，当前这一轮保留（通用做法；见 thinking-history.mjs）。
  installThinkingHistory(ctx);

  // 1. The Runtime manager: start it unless one already serves this port; stop only the one started here.
  let child = null;
  if (!(await listening(port))) {
    child = spawn(process.execPath, [config.runtimeEntry], {
      env: { ...process.env, RULITH_MANAGER_HOME: home, RULITH_MANAGER_PORT: String(port), RULITH_MANAGER_KEY: key },
      stdio: 'ignore', windowsHide: true,
    });
  }
  ctx.effect(() => () => {
    if (!child?.pid) return;
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {});
    else try { process.kill(-child.pid); } catch { child.kill(); }
  });
  const manager = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, body === undefined
      ? { headers: { 'x-rulith-manager': key } }
      : { method: 'POST', headers: { 'x-rulith-manager': key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const reply = await response.json().catch(() => ({}));
    if (!response.ok || reply.ok === false) throw new Error(reply.teaching || `Rulith answered ${response.status}`);
    return reply;
  };

  // 2. The six tools follow the selected Agent. They are registered once per Agent credential and stay registered while
  //    the connection behind them is replaced. The bridge never retries: any transport failure closes its MCP
  //    connection, whoever made the call (the panel's reads share it). A model mid-turn must not see its tools vanish
  //    over that (2026-10-06: a read failing during a network blip closed the connection, the tools were unregistered
  //    and re-registered, the model got "unknown tool" and gave up its turn).
  let current = null;
  let status = { state: 'starting' };
  const report = (state, detail = {}) => {
    status = { state, at: new Date().toISOString(), ...detail };
    try { fs.writeFileSync(statusFile, JSON.stringify(status, null, 2)); } catch {}
  };
  const drop = () => {
    if (!current) return;
    for (const dispose of current.disposers) dispose();
    current.bridge.close();
    for (const bridge of current.seats.values()) bridge.close();
    current = null;
  };
  const connect = async (token, seat = 'main') => {
    const bridge = new RulithMcp({ url: config.mcpUrl || 'https://api.rulith.ai/mcp', token, seat, identity() {} });
    await bridge.initialize();
    const listed = await bridge.list();
    if (listed.nextCursor || listed.tools?.length !== 6 || !TOOLS.every((t) => listed.tools.some((x) => x.name === t)))
      throw new Error('MCP tool surface refused');
    return { bridge, listed };
  };
  // The live connection for the current credential and one seat: a closed one is replaced (one attempt at a time per seat).
  // 席位（C1，D-1008h）：每个席位一条独立的 MCP 会话（Gateway 按席位各给一条会话线与执行槽）；main 是缺省。
  const reconnecting = new Map();
  const liveBridge = async (seat = 'main') => {
    if (!current) throw new Error('Rulith is not attached: choose an Agent with the Deep Rulith entry.');
    const holder = current;
    const existing = seat === 'main' ? holder.bridge : holder.seats.get(seat);
    if (existing && !existing.closed) return existing;
    if (!reconnecting.has(seat)) reconnecting.set(seat, connect(holder.token, seat).then(({ bridge }) => {
      if (seat === 'main') {
        holder.bridge = bridge;
        report('attached', { agentName: holder.agentName, tools: [...TOOLS], reconnectedAt: new Date().toISOString() });
      } else holder.seats.set(seat, bridge);
      return bridge;
    }).finally(() => { reconnecting.delete(seat); }));
    return reconnecting.get(seat);
  };
  // A conversation's seat is its dsh agent preset: `rulith-seat-<name>` is the seat <name>; every other preset is main.
  const seatOf = (exec) => {
    let preset;
    try { preset = ctx.get('sessionProjections')?.stateOf?.(exec?.agent?.session, 'agentPreset'); } catch { preset = undefined; }
    return /^rulith-seat-([a-z][a-z0-9_-]{0,31})$/.exec(typeof preset === 'string' ? preset : '')?.[1] ?? 'main';
  };
  const TRANSIENT = /^(MCP transport failed|MCP request refused|MCP response unreadable|MCP connection closed|connection_replaced)$/;
  const READS = new Set(['QueryBoard', 'ReadArtifact']);
  const invoke = async (name, args, seat = 'main') => {
    // Reaching Rulith fails before anything is sent: that error is reported as it is.
    const bridge = await liveBridge(seat);
    try { return await bridge.call(name, args); }
    catch (error) {
      if (!TRANSIENT.test(String(error?.message ?? ''))) throw error;
      // A read changes nothing, so it is asked once more on a fresh connection. A write's outcome is unknown: it is
      // never repeated here, and the model is told how to learn it.
      if (READS.has(name)) return (await liveBridge(seat)).call(name, args);
      throw new Error('The connection to Rulith was interrupted during this call; its outcome is unknown. Do not repeat it: QueryBoard shows its outcome in the operations strip.');
    }
  };
  const attach = async (agent) => {
    const { bridge, listed } = await connect(agent.token);
    const disposers = listed.tools.map((tool) => ctx.tools.register({
      name: tool.name, description: tool.description ?? '', parameters: tool.inputSchema,
      output: { schema: {}, render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }]; } },
      async execute(args, exec) {
        const seat = seatOf(exec);
        const call = (name, input) => invoke(name, input, seat);
        const result = await call(tool.name, args);
        if (result.isError) throw new Error(JSON.stringify(result));
        return awaitOutcome({ call }, tool.name, result);
      },
    }));
    current = { token: agent.token, agentName: agent.agentName, bridge, seats: new Map(), disposers };
  };
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try {
      const agent = selectedAgent(home, chosenName());
      if (!agent) { drop(); report('no_agent', { hint: 'Sign in with the Deep Rulith entry and choose an Agent' }); }
      else if (agent.token !== current?.token) {
        drop(); await attach(agent); report('attached', { agentName: agent.agentName, tools: [...TOOLS] });
      } else if (current.bridge.closed) {
        // Same credential: replace the connection, keep the tools.
        try { await liveBridge(); } catch (error) { report('reconnecting', { error: String(error?.message ?? error).slice(0, 300) }); }
      }
    } catch (error) { drop(); report('failed', { error: String(error?.message ?? error).slice(0, 300) }); } finally { busy = false; }
  };
  const timer = setInterval(tick, 3000);
  ctx.effect(() => () => { clearInterval(timer); drop(); });

  // 3. The browser half's API: same origin only (the custom header cannot be sent cross-origin without a preflight,
  //    which this route never grants). Answers carry no token, key or secret.
  const summary = (state) => {
    const chosen = chosenName();
    const instances = (state.instances ?? []).filter((row) => row.mode === 'local_agent' && !row.signedOutAt);
    return {
      signedIn: state.device?.state === 'linked',
      deviceState: state.device?.state ?? 'unknown',
      account: state.device?.account?.name ?? '',
      origin: state.device?.origin || consoleUrl,
      teaching: state.device?.teaching ?? '',
      agents: (state.device?.agents ?? []).map((agent) => {
        const instance = instances.find((row) => row.agentId === agent.id);
        // Worker Connections of this Agent that can be reconnected (Runtime 0.12.5 and later): only names and ids.
        const reconnectable = (Array.isArray(agent.reconnectable) ? agent.reconnectable : [])
          .map((row) => ({ connectionId: String(row.connectionId), name: String(row.displayName || row.name), createdAt: String(row.createdAt ?? '') }));
        return { id: agent.id, name: agent.name, instanceId: instance?.id ?? '', paired: !!instance?.paired, reconnectable,
          worker: instance?.workerSetting ? { enabled: !!instance.workerSetting.enabled, state: instance.workerSetting.state ?? '',
            failure: instance.workerSetting.failure ?? '' } : null };
      }),
      selected: current?.agentName ?? chosen ?? '',
      tools: status,
      model: state.modelDefaults ? { name: state.modelDefaults.name ?? '', url: state.modelDefaults.url ?? '',
        configured: !!state.modelDefaults.configured } : null,
    };
  };
  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve, reject) => {
    let text = ''; req.on('data', (chunk) => { text += chunk; if (text.length > 65536) req.destroy(); });
    req.on('end', () => { try { resolve(text ? JSON.parse(text) : {}); } catch (error) { reject(error); } }); req.on('error', reject);
  });
  // reconnectConnectionId: an existing Worker Connection of this Agent the person chose to reconnect (PSC SYS-CONN-01,
  // D-1007b); absent means a new Connection.
  const setUp = async (agentId, reconnectConnectionId) => {
    let state = await manager('/manager/state');
    let instance = (state.instances ?? []).find((row) => row.agentId === agentId && row.mode === 'local_agent' && !row.signedOutAt);
    if (!instance) {
      const agent = (state.device?.agents ?? []).find((row) => row.id === agentId);
      if (!agent) throw new Error('This Agent is not in the signed-in account');
      const created = await manager('/manager/instances/create', { name: agent.name, mode: 'local_agent',
        setupTarget: { origin: state.device.origin, accountId: state.device.account.id, agentId } });
      instance = created.instance ?? (created.instances ?? []).find((row) => row.agentId === agentId) ?? created;
    }
    if (!instance.paired) {
      await manager('/manager/instances/pair', { instanceId: instance.id, agentId,
        ...(reconnectConnectionId ? { reconnectConnectionId } : {}) });
      // Pairing often completes inside the pair call; poll only while it is still in progress.
      for (let i = 0; i < 20; i++) {
        state = await manager('/manager/state');
        if ((state.instances ?? []).some((row) => row.id === instance.id && row.paired)) break;
        try { await manager('/manager/instances/pair/poll', { instanceId: instance.id }); } catch { /* re-read the state above */ }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    return instance.id;
  };
  const board = async () => {
    if (!current) return { available: false, tools: status };
    const result = await invoke('QueryBoard', {});
    const text = (result.content ?? []).map((part) => part.text ?? '').join('');
    let view; try { view = JSON.parse(text); } catch { return { available: true, raw: text.slice(0, 4000) }; }
    return { available: true, agentName: current.agentName, view };
  };
  // The selected Agent's local Worker as its own Trace shows it: availability, lease and its latest steps. Read from the
  // instance's event stream through the manager (the address carries the instance key and stays in this process);
  // what reaches the page is shortened text, without keys or result bodies.
  let traceLink = null;
  const shortTool = (id) => String(id ?? '').replace(/^worker_[a-z0-9]+_/, '').replace(/_\d+$/, '').replace(/_[0-9a-f]{12}$/, '')
    .replace(/^eng_/, 'eng.');
  const traceRow = (event) => {
    const at = event.at ?? event.t ?? null;
    const row = (level, text) => ({ at, level, text: String(text).slice(0, 240) });
    switch (event.type) {
      case 'lease': return event.state === 'active' ? row('ok', `租约有效（第 ${event.workerGeneration} 代）`)
        : event.state === 'generation-advanced' ? null : row('warn', `租约：${event.state}${event.errorCode ? `（${event.errorCode}）` : ''}`);
      case 'availability': return row(event.state === 'online' ? 'ok' : 'warn', event.state === 'online' ? '在线' : `不在线（${event.state}）`);
      case 'claimed': return row('info', `领取 ${shortTool(event.id)}`);
      case 'tool-timing': return row(event.outcome === 'returned' ? 'info' : 'warn', `${shortTool(event.tool)} ${event.outcome === 'returned' ? '执行完' : event.outcome}，${((event.durationMs ?? 0) / 1000).toFixed(1)} 秒`);
      case 'reported': if (event.undeliverable) return row('error', event.landed
          ? `${shortTool(event.id)} 的结果送不出（${event.undeliverable}），已转给你处理：在上面“需要处理”里打开 Console 对账`
          : `${shortTool(event.id)} 的结果送不出（${event.undeliverable}），服务没有接住这条报告：在 Console 里处理这次调用`);
        return event.landed === false
        ? row('error', `${shortTool(event.id)} 的结果没有送达（${event.reason ?? '未知'}）：这次调用会一直挂起，需要在 Console 里处理`)
        : row(event.ok === false ? 'warn' : 'ok', `${shortTool(event.id)} ${event.ok === false ? '失败' : '已回报'}`);
      case 'log': return event.stderr ? row('warn', event.line ?? '') : null;
      case 'error': return row('warn', event.note ?? '');
      default: return null;
    }
  };
  // Where each Source this Agent may use is bound, as Console locked it: the same read-only list the Worker loads at
  // start (GET <work>/sources with its own Connection credentials). Only names, types and locations reach the page.
  let sourcesCache = null;
  const boundSources = async (instanceId) => {
    if (sourcesCache?.instanceId === instanceId && Date.now() - sourcesCache.at < 60_000) return sourcesCache.rows;
    const row = (readJson(path.join(home, 'registry.json'))?.instances ?? []).find((entry) => entry.id === instanceId);
    const env = row ? readJson(path.join(row.directory, 'local.json'))?.worker?.env ?? {} : {};
    if (!env.RULITH_WORK_URL || !env.RULITH_CONNECTION || !env.RULITH_CONNECTION_KEY) return [];
    const response = await fetch(`${env.RULITH_WORK_URL}/sources`, { signal: AbortSignal.timeout(10_000),
      headers: { 'x-rulith-connection': env.RULITH_CONNECTION, 'x-rulith-connection-key': env.RULITH_CONNECTION_KEY } });
    if (!response.ok) return sourcesCache?.rows ?? [];
    const rows = ((await response.json()).sources ?? []).filter((source) => typeof source?.name === 'string')
      .map((source) => ({ name: source.name, type: String(source.type ?? ''), location: String(source.access ?? '') }));
    sourcesCache = { instanceId, at: Date.now(), rows };
    return rows;
  };
  const workerTrace = async () => {
    const agent = selectedAgent(home, chosenName());
    if (!agent) return { available: false };
    const sources = await boundSources(agent.instanceId).catch(() => []);
    if (traceLink?.instanceId !== agent.instanceId)
      traceLink = { instanceId: agent.instanceId, url: new URL((await manager('/manager/instances/open', { instanceId: agent.instanceId, page: '/' })).url) };
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 1500);
    let text = '';
    try {
      const response = await fetch(`${traceLink.url.origin}/events?k=${encodeURIComponent(traceLink.url.searchParams.get('k') ?? '')}&history=paged`, { signal: abort.signal });
      if (!response.ok) throw new Error(`the Worker trace answered ${response.status}`);
      const reader = response.body.getReader(); const decoder = new TextDecoder();
      for (;;) { const { value, done } = await reader.read(); if (done) break; text += decoder.decode(value, { stream: true }); }
    } catch (error) {
      if (error.name !== 'AbortError') { traceLink = null; throw error; }
    } finally { clearTimeout(timer); }
    const events = text.split('\n\n').filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => { try { return JSON.parse(chunk.slice(6)); } catch { return null; } })
      .filter((event) => event?.src === 'worker');
    const rows = events.map(traceRow).filter(Boolean);
    const lastAvailability = [...events].reverse().find((event) => event.type === 'availability');
    return { available: true, agentName: agent.agentName, state: lastAvailability?.state ?? 'unknown', sources,
      stuck: rows.some((row) => row.level === 'error'), events: rows.slice(-30).reverse() };
  };
  // What needs a person for the selected Agent, from the local manager's Health read (Runtime 0.12.6+): one line each, with
  // the place to fix it. Read on a slow poll; the manager itself reads the service only when asked.
  const health = async () => {
    const agent = selectedAgent(home, chosenName());
    if (!agent) return { available: false };
    let reply;
    try { reply = await manager('/manager/health'); } catch (error) { return { available: true, unsupported: true, note: String(error.message ?? error).slice(0, 200) }; }
    const all = reply.health ?? {};
    const row = (all.agents ?? []).find((entry) => entry.agentId === agent.agentId);
    const items = [];
    if (all.device && all.device.signedIn === false) items.push({ text: '这台电脑没有登录 Rulith：在左下角重新登录', fix: 'signin' });
    if (row) {
      if (row.pendingCall?.needsPerson) items.push({ text: `一次调用需要你处理：${row.pendingCall.label || row.pendingCall.tool}`, url: row.console?.runtime });
      if (row.program?.state === 'rejected') items.push({ text: `程序更新被拒：${row.program.refusal?.message || row.program.refusal?.errorCode || ''}`, url: row.console?.configuration });
      for (const source of row.sources ?? []) if (source.state !== 'ready') items.push({ text: `Source ${source.name} 未就绪（${source.state}）`,
        url: row.console?.runtime, source: source.name });
      if (row.key && row.key.state !== 'active') items.push({ text: `本机的 Agent 密钥已失效（${row.key.state}）：打开本机 Rulith 修复`, fix: 'workbench' });
      const here = (row.connections ?? []).filter((connection) => connection.registeredHere && connection.state === 'active');
      if (!here.length) items.push({ text: '这台电脑没有接上本机执行的连接：打开本机 Rulith 修复', fix: 'workbench' });
    }
    return { available: true, gatewayState: all.gatewayState ?? 'unavailable', items };
  };
  // D-1008d ②: "choose a folder and start". The selected Agent's local instance proposes the folder for a file Source
  // through its own setup route (the same no-credential proposal the Runtime wizard sends); the person then confirms it
  // once in the Agent's Runtime page in Console, which binds the Source and pins the tools this computer reported.
  const proposeFolder = async (body) => {
    const agent = selectedAgent(home, chosenName());
    if (!agent) throw new Error('Choose an Agent first');
    const source = String(body.source ?? '').trim(), folder = String(body.path ?? '').trim();
    if (!source || !folder) throw new Error('Name the Source and the folder');
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error('That folder does not exist on this computer');
    const open = new URL((await manager('/manager/instances/open', { instanceId: agent.instanceId, page: '/' })).url);
    const response = await fetch(`${open.origin}/setup/resources`, { method: 'POST', signal: AbortSignal.timeout(30_000),
      headers: { 'x-rulith-local': open.searchParams.get('k') ?? '', 'content-type': 'application/json' },
      body: JSON.stringify({ resources: [{ name: source, access: folder }], services: [] }) });
    const reply = await response.json().catch(() => ({}));
    if (!response.ok || reply.ok === false) throw new Error(reply.teaching || `The local Rulith answered ${response.status}`);
    const all = (await manager('/manager/health').catch(() => ({}))).health ?? {};
    const row = (all.agents ?? []).find((entry) => entry.agentId === agent.agentId);
    return { proposed: true, url: row?.console?.runtime ?? '' };
  };
  const routes = {
    'POST /rulith/api/folder': proposeFolder,
    'GET /rulith/api/health': health,
    'GET /rulith/api/state': async () => summary(await manager('/manager/state')),
    'GET /rulith/api/worker': workerTrace,
    'POST /rulith/api/signin': async () => {
      const reply = await manager('/manager/device/start', { consoleUrl, name: os.hostname() });
      return { url: reply.device?.consoleUrl ?? '' };
    },
    'POST /rulith/api/signin/poll': async () => { await manager('/manager/device/poll', {}); return summary(await manager('/manager/state')); },
    'POST /rulith/api/signout': async () => { await manager('/manager/device/signout', {}); drop(); return summary(await manager('/manager/state')); },
    'POST /rulith/api/select': async (body) => {
      const state = await manager('/manager/state');
      const agent = (state.device?.agents ?? []).find((row) => row.id === String(body.agentId ?? ''));
      if (!agent) throw new Error('Choose an Agent of the signed-in account');
      // Reconnecting an existing Connection or creating a new one is the person's explicit choice (D-1007b): an Agent
      // that offers Connections to reconnect is not set up until the request says which.
      const offered = (Array.isArray(agent.reconnectable) ? agent.reconnectable : []).map((row) => String(row.connectionId));
      const reconnect = typeof body.reconnectConnectionId === 'string' ? body.reconnectConnectionId : '';
      const instance = (state.instances ?? []).find((row) => row.agentId === agent.id && row.mode === 'local_agent' && !row.signedOutAt);
      if (!instance?.paired && offered.length && !reconnect && body.newConnection !== true)
        throw new Error('Choose whether to reconnect one of this Agent\'s existing connections or to create a new one');
      if (reconnect && !offered.includes(reconnect)) throw new Error('That connection cannot be reconnected now; refresh and choose again');
      await setUp(agent.id, reconnect);
      fs.writeFileSync(selectionFile, JSON.stringify({ agentName: agent.name }));
      await tick();
      return summary(await manager('/manager/state'));
    },
    'POST /rulith/api/worker': async (body) => {
      await manager('/manager/instances/worker-setting', { instanceId: String(body.instanceId ?? ''), enabled: body.enabled === true });
      return summary(await manager('/manager/state'));
    },
    'GET /rulith/api/board': board,
    // The workbench address carries the manager key: handed out only on this guarded same-origin request.
    'POST /rulith/api/workbench': async () => ({ url: `http://127.0.0.1:${port}/?k=${key}` }),
  };
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/rulith/api',
    async handler(req, res) {
      // A custom header keeps cross-site pages out (they cannot send it without a preflight dsh does not grant); the Host
      // check keeps out a rebinding name that resolves to this computer.
      const loopbackHost = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(req.headers.host ?? '');
      if (req.headers['x-deep-rulith'] !== '1' || !loopbackHost) return send(res, 403, { ok: false, teaching: 'Same-origin Deep Rulith requests only.' });
      const route = routes[`${req.method} ${(req.url ?? '').split('?')[0]}`];
      if (!route) return send(res, 404, { ok: false, teaching: 'No such Deep Rulith route.' });
      try { send(res, 200, { ok: true, ...(await route(req.method === 'POST' ? await readBody(req) : {})) }); }
      catch (error) { send(res, 200, { ok: false, teaching: String(error?.message ?? error).slice(0, 400) }); }
    },
  }));
  await tick();
}
