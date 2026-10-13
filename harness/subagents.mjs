// Admission is on dsh's Agent creation boundary, before either driver can run a child.
// It also covers cold resume; the scope effect releases a reservation on rollback or disposal.
import { TOOLS } from './rulith-mcp.mjs';

export const DELEGATION_TOOLS = Object.freeze(['subagent', 'subagent_fork', 'send_message', 'interrupt_agent']);
export const MAX_CHILDREN = 4;
export const depthOf = (agent) => Math.max(agent?.session?.header?.delegationDepth ?? 0, agent?.options?.subagentDepth ?? 0,
  agent?.session?.header?.parentSession ? 1 : 0);
export const handOf = (agent) => depthOf(agent) ? agent.session.id : 'main';
export const toolsOf = (agent) => depthOf(agent) ? [...TOOLS] : [...TOOLS, ...DELEGATION_TOOLS];

export function installSubagentAdmission(ctx, configure) {
  const children = new Set();
  ctx.on('agent/created', ({ agent }) => {
    const depth = depthOf(agent);
    if (depth > 1) throw new Error('Rulith delegation is limited to depth 1.');
    if (depth && !children.has(agent)) {
      if (children.size >= MAX_CHILDREN) throw new Error('Rulith allows at most 4 active children.');
      children.add(agent);
      agent.ctx.effect(() => () => children.delete(agent));
    }
    agent.ctx.tools.restrict({ allow: toolsOf(agent) });
    configure?.(agent, depth);
  });
  return children;
}
