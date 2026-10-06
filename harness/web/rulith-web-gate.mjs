// Rulith edition of dsh: every agent sees only Rulith's six tools and the approved Runtime persona plus addendum.
import fs from 'node:fs';
import { TOOLS } from '../rulith-mcp.mjs';
import { ADDENDUM } from '../rulith-gate.mjs';

export const name = 'rulith-web-gate';
export const inject = ['tools', 'agents', 'systemPrompt'];

export function apply(ctx, config = {}) {
  if (!config.persona) throw new Error('approved persona required');
  const persona = fs.readFileSync(config.persona, 'utf8');
  // complete: no other prompt section may add unapproved model text.
  ctx.systemPrompt.section({ name: 'rulith:persona', order: 0, text: `${persona}\n\n${ADDENDUM}`, interpolate: false, complete: true });
  ctx.on('agent/created', ({ agent }) => { agent.ctx.tools.restrict({ allow: [...TOOLS] }); });
}
