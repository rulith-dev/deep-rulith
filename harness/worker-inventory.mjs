// Generate the Worker Actions inventory from the shipped kit, without loading adapters.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generalKit } from './runtime-kit.mjs';

const words = source => [...source.matchAll(/'([^']+)'/g)].map(m => m[1]);
export function workerInventory(kit = generalKit()) {
  const manifest = JSON.parse(fs.readFileSync(path.join(kit, 'worker-tools.json'), 'utf8'));
  const source = fs.readFileSync(path.join(kit, 'adapter.mjs'), 'utf8');
  const messages = source.match(/const messages = \[\.\.\.\(\[(.*?)\]\.includes\(tool\) \? \[(.*?)\] : \[\]\),(.*?)\];/);
  if (!messages) throw new Error('General kit refusal format changed; review the inventory generator.');
  const common = [...words(messages[3]), 'adapter failed', 'path not found', 'path is a directory', 'path not readable'];
  const acceptance = words(source.match(/\(\[(.*?)\]\.includes\(error.message\)/)[1]);
  const rows = Object.entries(manifest.tools).map(([id, tool]) => {
    const entry = fs.readFileSync(path.join(kit, path.basename(tool.entry)), 'utf8');
    const action = entry.match(/main\('([^']+)'\)/)?.[1];
    if (!action) throw new Error(`Unknown adapter entry for ${id}`);
    const predicates = tool.returns.map(r => `\`${r.predicate}(${Object.keys(r.args).join(',')})\``).join(', ') || 'no Board facts';
    return `- \`${id}\` (${tool.kind}): ${predicates}.`;
  });
  const refusals = [...new Set([...common, ...words(messages[2]), ...acceptance, 'acceptance file changed: <project-relative path>'])];
  return `## Worker Actions\n\nGenerated from Runtime \`kits/general/worker-tools.json\` and its adapters by \`node harness/worker-inventory.mjs\`. The Runtime installer replaces the legacy adapters at \`adapters/engineering-work/\`; the original twelve \`eng.*@1\` contracts remain compatible.\n\nReceipt rows map to the predicates below. Mutating tools also report \`eng.tree_step(from_gen,to_gen)\`; a no-change row uses \`(-1,-1)\`. Reads work during a job without recording a generation step. Acceptance discovery and web calls skip the Source lock and tree walk. Refusals return \`rows:[]\`, \`verdict\`, exit 2 and the verdict on stderr. A spec refusal can also say \`spec refused: <reason>\` in fixed words.\n\n${rows.join('\n')}\n\nFixed adapter refusal vocabulary (each applies only to the relevant operation): ${refusals.map(s => `\`${s}\``).join(', ')}.\n\n\`eng.read\` pages text with \`offset,next_offset,complete,start_line\`; v2 additionally records the full file digest. \`eng.list\` reports \`entries\`; list/search/glob may say \`truncated\`; search reports \`unreadable_files\`. \`eng.tree_state.measure_specs\` includes owner-pinned and self-pinned measurements. \`eng.read_image\` returns a \`rulith.artifacts\` envelope (no inline bytes or facts). Web receipts digest the complete fetched bytes or scrubbed search text.\n\n\`eng.acceptance\` discovers \`.rulith/acceptance/<check>.json\` and records \`eng.check_spec(check,spec_digest,files)\`; invalid specs appear only in text \`errors\`. \`eng.test@2\` takes one \`check\`, verifies its pinned dependencies before and after running, and stamps the final tree generation. The v2 package derives \`eng.check_passed(check,spec_digest)\` only for a passing check on the current tree. The model proposes these atoms as child goals; the person signs them in Console, freezing the leaves. The Board certifies the root when all signed criteria hold. The model never writes the root outcome rule. A root without a signed contract or user acceptance waits with \`awaiting:"acceptance"\`. Legacy \`eng.test@1\` still uses \`<kit home>/specs/test.json\`.\n\n\`eng.list.kind\`: \`directory\`, \`link\`, \`file\`. Job \`status\`: \`starting\`, \`running\`, \`stopping\`, \`done\`, \`stopped\`, \`failed\`. Measurement \`unit\`: \`ms\`, \`us\`, \`tokens_per_second\`, \`bytes_per_second\`; \`value_milli\` is an integer. No success prose or benchmark numbers are added.\n\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = new URL('./model-visible.md', import.meta.url);
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace(/## Worker Actions\r?\n[^]*?(?=## Bridge failures)/, workerInventory()));
}
