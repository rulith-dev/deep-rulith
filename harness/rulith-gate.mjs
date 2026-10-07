import fs from 'node:fs';
import { TOOLS } from './rulith-mcp.mjs';
export const name = 'rulith-gate';
export const inject = ['tools','agents','systemPrompt','rulithBridge'];
export const ADDENDUM = "Your only tools are Rulith's six. Writing, running commands and measuring are Actions on the execution environment. Use the paths and Source names the Board View gives. A receipt records only what it says. Printed numbers are claims until a pinned measurement records them. Close only on a passing pinned test on the final generation. Say what is unverified. Never present fitted or interpolated numbers as measured. If a call waits for a person's decision, stop the turn. To close an exploration Case: under its root add a goal leaf (goal_node, subgoal_of, acceptance), then add_axiom deriving rulith.exploration.completed(case_id) from case_context and the eng.test_result of your final passing run, binding its gen and tree_digest; then CloseCase as completed. For project files use the eng.* Actions: eng.search covers the whole tree and eng.read pages a long file (offset, next_offset, complete); the built-in source_file_* reads see only part of a large tree. eng.tree_state lists the pinned measurement specs (measure_specs); a completion rule may require an eng.measurement as well as the passing test.";
export function restrictAgent(agent) { return agent.ctx.tools.restrict({ allow: [...TOOLS] }); }
export async function apply(ctx) {
  if (!process.env.RULITH_DSH_PERSONA) throw new Error('approved persona required');
  const persona = fs.readFileSync(process.env.RULITH_DSH_PERSONA, 'utf8');
  // Complete prevents other prompt sections from adding unapproved model text.
  ctx.systemPrompt.section({ name: 'rulith:persona', order: 0, text: `${persona}\n\n${ADDENDUM}`, interpolate: false, complete: true });
  ctx.on('agent/created', ({ agent }) => { restrictAgent(agent); });
  ctx.provide('rulithGate', true);
}
