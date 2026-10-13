// Children see Rulith's three tools; the main agent also delegates. Both use the approved persona.
import fs from 'node:fs';
import { ADDENDUM as HEADLESS_ADDENDUM } from '../rulith-gate.mjs';
import { installSubagentAdmission } from '../subagents.mjs';

export const name = 'rulith-web-gate';
export const inject = ['tools', 'agents', 'systemPrompt'];
export const ADDENDUM = HEADLESS_ADDENDUM.replace("Your only tools are Rulith's three.", "Your tools are Rulith's three plus delegation tools.");
export const CHILD_ADDENDUM = HEADLESS_ADDENDUM;

export function installGate(ctx, persona) {
  ctx.systemPrompt.section({ name: 'rulith:persona', order: 0, text: `${persona}\n\n${ADDENDUM}`, interpolate: false, complete: true });
  return installSubagentAdmission(ctx, (agent, depth) => {
    if (depth) agent.ctx.systemPrompt.section({ name: 'rulith:persona', order: 0,
      text: `${persona}\n\n${CHILD_ADDENDUM}`, interpolate: false, complete: true });
  });
}

export function apply(ctx, config = {}) {
  if (!config.persona) throw new Error('approved persona required');
  const persona = fs.readFileSync(config.persona, 'utf8');
  // complete: no other prompt section may add unapproved model text.
  installGate(ctx, persona);
}
