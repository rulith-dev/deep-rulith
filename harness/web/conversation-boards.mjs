// Host-only Board ownership. Tool registration and Agent selection remain launcher-wide.
import { setTimeout as delay } from 'node:timers/promises';
import { BoardChannel } from '../board-channel.mjs';
import { conversationKey } from '../subagents.mjs';

const TRANSIENT = /^(MCP transport failed|MCP request refused|MCP response unreadable|MCP connection closed|connection_replaced)$/;

export class ConversationBoards {
  constructor({ enabled = true, connect, shadow, toolKinds, report = () => {},
    patienceMs = Number(process.env.RULITH_DSH_RECONNECT_PATIENCE_MS ?? 180000),
    wait = (ms, signal) => delay(ms, undefined, { signal }) }) {
    Object.assign(this, { enabled, connect, shadow, toolKinds, report, patienceMs, wait });
    this.holders = new Map(); this.sessions = new Map(); this.closed = false;
  }
  get size() { return this.holders.size; }
  observe(agent) {
    if (this.closed) throw new Error('Rulith Agent detached');
    const key = this.enabled ? conversationKey(agent) : undefined;
    if (agent?.session?.id) this.sessions.set(agent.session.id, key);
    return key;
  }
  holder(agent) {
    const key = this.observe(agent);
    let holder = this.holders.get(key);
    if (holder) return holder;
    holder = { key, bridge: null, connecting: null, stop: new AbortController() };
    holder.channel = new BoardChannel({ shadow: this.shadow(), toolKinds: this.toolKinds,
      focusedGoals: () => holder.bridge?.focusedGoals ?? [],
      invoke: (name, args) => this.request(holder, name, args) });
    this.holders.set(key, holder);
    this.report('attached');
    return holder;
  }
  live(holder) { return !this.closed && this.holders.get(holder.key) === holder; }
  async connectPatiently(holder) {
    const until = Date.now() + this.patienceMs;
    for (let retryMs = 2000; ; retryMs = Math.min(retryMs * 2, 30000)) {
      if (!this.live(holder)) throw new Error('Rulith Agent detached');
      try {
        const { bridge } = await this.connect(holder.key, holder.stop.signal);
        if (!this.live(holder)) { bridge.close(); throw new Error('Rulith Agent detached'); }
        holder.bridge = bridge;
        this.report('attached');
        return bridge;
      } catch (error) {
        if (!TRANSIENT.test(String(error?.message ?? '')) || !this.live(holder) || Date.now() + retryMs > until) throw error;
        this.report('reconnecting', { reason: String(error.message), retryInMs: retryMs });
        await this.wait(retryMs, holder.stop.signal);
      }
    }
  }
  async liveBridge(holder) {
    if (!this.live(holder)) throw new Error('Rulith Agent detached');
    if (holder.bridge && !holder.bridge.closed) return holder.bridge;
    if (!holder.connecting) holder.connecting = this.connectPatiently(holder).finally(() => { holder.connecting = null; });
    return holder.connecting;
  }
  async request(holder, name, args) {
    const bridge = await this.liveBridge(holder);
    try { return await bridge.call(name, args); }
    catch (error) {
      if (!TRANSIENT.test(String(error?.message ?? ''))) throw error;
      if (name === 'Get') return (await this.liveBridge(holder)).call(name, args);
      throw new Error('The connection to Rulith was interrupted during this call; its outcome is unknown. Do not repeat it: Get shows its outcome in the operations strip.');
    }
  }
  disposeSession(session) {
    if (!this.sessions.has(session.id)) return;
    const key = this.sessions.get(session.id);
    this.sessions.delete(session.id);
    if (!this.enabled) return; // The legacy default Board lives for the Agent attachment.
    if (![...this.sessions.values()].includes(key)) this.drop(key);
  }
  drop(key) {
    const holder = this.holders.get(key);
    if (!holder) return;
    this.holders.delete(key);
    holder.stop.abort(); holder.channel.close(); holder.bridge?.close();
    this.report('attached');
  }
  close() {
    this.closed = true;
    for (const key of this.holders.keys()) this.drop(key);
    this.sessions.clear();
  }
}
