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
export async function awaitOutcome(bridge, tool, result, { pollMs = 10_000, waitSeconds = Number(process.env.RULITH_DSH_WAIT_SECONDS || 0) } = {}) {
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

  // 2. The six tools follow the selected Agent: registered once its token exists, replaced when it changes,
  //    re-attached after the authority closed this connection (for example another client replaced it).
  let current = null;
  let status = { state: 'starting' };
  const report = (state, detail = {}) => {
    status = { state, at: new Date().toISOString(), ...detail };
    try { fs.writeFileSync(statusFile, JSON.stringify(status, null, 2)); } catch {}
  };
  const drop = () => { if (!current) return; for (const dispose of current.disposers) dispose(); current.bridge.close(); current = null; };
  const attach = async (agent) => {
    const bridge = new RulithMcp({ url: config.mcpUrl || 'https://api.rulith.ai/mcp', token: agent.token, identity() {} });
    await bridge.initialize();
    const listed = await bridge.list();
    if (listed.nextCursor || listed.tools?.length !== 6 || !TOOLS.every((t) => listed.tools.some((x) => x.name === t)))
      throw new Error('MCP tool surface refused');
    const disposers = listed.tools.map((tool) => ctx.tools.register({
      name: tool.name, description: tool.description ?? '', parameters: tool.inputSchema,
      output: { schema: {}, render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }]; } },
      async execute(args) {
        const result = await bridge.call(tool.name, args);
        if (result.isError) throw new Error(JSON.stringify(result));
        return awaitOutcome(bridge, tool.name, result);
      },
    }));
    current = { token: agent.token, agentName: agent.agentName, bridge, disposers };
  };
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try {
      const agent = selectedAgent(home, chosenName());
      if (!agent) { drop(); report('no_agent', { hint: 'Sign in with the Deep Rulith entry and choose an Agent' }); }
      else if (agent.token !== current?.token || current?.bridge.closed) {
        drop(); await attach(agent); report('attached', { agentName: agent.agentName, tools: [...TOOLS] });
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
        return { id: agent.id, name: agent.name, instanceId: instance?.id ?? '', paired: !!instance?.paired,
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
  const setUp = async (agentId) => {
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
      await manager('/manager/instances/pair', { instanceId: instance.id, agentId });
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
    const result = await current.bridge.call('QueryBoard', {});
    const text = (result.content ?? []).map((part) => part.text ?? '').join('');
    let view; try { view = JSON.parse(text); } catch { return { available: true, raw: text.slice(0, 4000) }; }
    return { available: true, agentName: current.agentName, view };
  };
  const routes = {
    'GET /rulith/api/state': async () => summary(await manager('/manager/state')),
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
      await setUp(agent.id);
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
