// One serial HTTP MCP client. No SDK, transport retries, or header logging.
export const PROTOCOL = '2025-11-25';
export const TOOLS = Object.freeze(['OpenCase','ApplyBatch','ApplyAction','CloseCase','QueryBoard','ReadArtifact']);
export const name = 'rulith-mcp';
export const inject = ['tools'];
export class RulithMcp {
  constructor({ url, token, fetchImpl = fetch, identity = () => {} }) {
    const endpoint = new URL(url);
    if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('MCP endpoint refused');
    if (!token) throw new Error('Agent token required');
    this.url = url; this.token = token; this.fetch = fetchImpl; this.identity = identity;
    this.queue = Promise.resolve(); this.session = ''; this.agentId = ''; this.nextId = 0; this.closed = false;
  }
  serial(action) {
    const next = this.queue.then(() => { if (this.closed) throw new Error('MCP connection closed'); return action(); });
    this.queue = next.catch(() => {}); return next;
  }
  async request(method, params, { notification = false } = {}) {
    if (this.closed) throw new Error('MCP connection closed');
    const id = ++this.nextId;
    const headers = { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL };
    if (this.session) headers['mcp-session-id'] = this.session;
    let response;
    this.requestAbort = new AbortController();
    try { response = await this.fetch(this.url, { method: 'POST', headers, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(55000),this.requestAbort.signal]), body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }) }); }
    catch { this.closed = true; throw new Error('MCP transport failed'); }
    if (response.status === 409) { this.closed = true; throw new Error('connection_replaced'); }
    if (!response.ok) { this.closed = true; throw new Error('MCP request refused'); }
    if (method === 'initialize') this.session = response.headers.get('mcp-session-id') ?? '';
    if (notification && (response.status === 202 || response.status === 204)) return;
    let message;
    try {
      if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = ''; let count = 0;
        try {
          while (!message) {
            const { value, done } = await reader.read(); if (done) break;
            pending += decoder.decode(value, { stream: true }); pending = pending.replaceAll('\r\n','\n'); count += value.length;
            if (count > 4 * 1024 * 1024) throw new Error();
            let end;
            while ((end = pending.indexOf('\n\n')) >= 0) {
              const event = pending.slice(0,end); pending = pending.slice(end+2);
              const data = event.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
              if (!data) continue;
              const item = JSON.parse(data);
              if (item.id === id) { message = item; break; }
              if (item.method === 'notifications/connection_replaced' || item.params?.reason === 'connection_replaced') { this.closed = true; throw new Error('connection_replaced'); }
            }
          }
        } finally { await reader.cancel(); }
      } else message = await response.json();
    } catch (e) { this.closed = true; throw new Error(e.message === 'connection_replaced' ? e.message : 'MCP response unreadable'); }
    if (message?.error) {
      const replaced = message.error.data?.reason === 'connection_replaced' || message.error.data?.code === 'connection_replaced' || message.error.message === 'connection_replaced';
      this.closed = true; throw new Error(replaced ? 'connection_replaced' : 'MCP request refused');
    }
    if (message?.id !== id || !message.result) { this.closed = true; throw new Error('MCP response unreadable'); }
    const meta = message.result._meta?.['rulith/v2'] ?? message.result._meta?.['rulith/v3'];
    if (meta?.agentId) {
      if (typeof meta.agentId !== 'string' || !meta.agentId.trim()) { this.closed = true; throw new Error('MCP response unreadable'); }
      if (this.agentId && this.agentId !== meta.agentId) { this.closed = true; throw new Error('MCP identity changed'); }
      this.agentId = meta.agentId; this.identity(this.agentId);
    }
    return message.result;
  }
  initialize() {
    return this.serial(async () => {
      const result = await this.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'rulith-dsh', version: '0.11.0' } });
      if (result.protocolVersion !== PROTOCOL || !this.session || !this.agentId) { this.closed = true; throw new Error('MCP handshake refused'); }
      await this.request('notifications/initialized', {}, { notification: true });
      return this.agentId;
    });
  }
  list() { return this.serial(() => this.request('tools/list', {})); }
  call(name, args) {
    return this.serial(async () => {
      if (!TOOLS.includes(name)) throw new Error('tool refused');
      const result = await this.request('tools/call', { name, arguments: args });
      // Host metadata never becomes model content. Keep the authority's result verbatim.
      const { _meta, ...modelResult } = result;
      return modelResult;
    });
  }
  close() { this.closed = true; this.requestAbort?.abort(); }
}
export async function apply(ctx) {
  const bridge = process.env.RULITH_DSH_PROXY === 'ipc' ? ipcBridge() : new RulithMcp({ url: process.env.RULITH_DSH_MCP_URL ?? 'https://api.rulith.ai/mcp', token: process.env.RULITH_TOKEN,
    identity(agentId) { process.send?.({ protocol: 'rulith-dsh', type: 'identity', agentId }); } });
  ctx.effect(() => () => bridge.close());
  await bridge.initialize();
  const listed = await bridge.list();
  if (listed.nextCursor || listed.tools?.length !== 6 || new Set(listed.tools.map(t => t.name)).size !== 6 || !TOOLS.every(t => listed.tools.some(x => x.name === t))) throw new Error('MCP tool surface refused');
  for (const tool of listed.tools) {
    const dispose = ctx.tools.register({ name: tool.name, description: tool.description ?? '', parameters: tool.inputSchema,
      output: { schema: {}, render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }]; } },
      async execute(args) {
        const result = await bridge.call(tool.name, args);
        if (result.isError) throw new Error(JSON.stringify(result));
        return result;
      },
    });
    ctx.effect(() => dispose);
  }
  // Readiness is a real Cordis service, so gate/runner wait for tool registration.
  ctx.provide('rulithBridge', bridge);
}
function ipcBridge() {
  let id = 0; const pending = new Map();
  const receive = message => {
    if (message?.protocol !== 'rulith-dsh-rpc' || !pending.has(message.id)) return;
    const waiter = pending.get(message.id); pending.delete(message.id); clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error)); else waiter.resolve(message.result);
  };
  process.on('message', receive);
  const rpc = (method, args) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('MCP transport failed')); }, 58000);
    pending.set(key, { resolve, reject, timer });
    process.send({ protocol: 'rulith-dsh-rpc', id: key, method, args });
  });
  return {
    initialize: () => rpc('identity', {}), list: () => rpc('list', {}), call: (name,args) => rpc('call', { name,args }),
    close() { process.off('message', receive); for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('MCP connection closed')); } pending.clear(); },
  };
}
