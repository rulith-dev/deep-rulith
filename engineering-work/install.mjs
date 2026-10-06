// Installs the engineering tools on one Agent's Worker in a Rulith Runtime manager home (0.12.0 or later):
// copies the adapters into that Worker's root, merges the eng.* tools into its own tool manifest, and sets the Worker
// environment. It edits only that Agent's files; turn the Agent's Worker off and on afterwards so it reloads.
//
//   node engineering-work/install.mjs --manager-home <dir> --agent <name> --kit-home <dir>
//
// The kit home (outside the project) holds specs/test.json, optional measurement specs and settings.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settings } from './lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) =>
  value.startsWith('--') ? [...pairs, [value.slice(2), all[i + 1]]] : pairs, []));
const fail = (message) => { console.error(message); process.exit(2); };
if (!args['manager-home'] || !args.agent || !args['kit-home'])
  fail('usage: node engineering-work/install.mjs --manager-home <dir> --agent <name> --kit-home <dir>');

const kitHome = path.resolve(args['kit-home']);
if (!fs.existsSync(path.join(kitHome, 'specs', 'test.json'))) fail(`${kitHome}/specs/test.json is missing (see pinned-test.example.json)`);
// The Worker's own run limit must outlast the longest wait the tools themselves allow.
const limits = (() => { try { return settings(kitHome); } catch { fail(`${kitHome}/settings.json is not valid`); } })();
const runTimeout = Math.max(limits.runSeconds, limits.pollSeconds) + 60;

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const registry = readJson(path.join(args['manager-home'], 'registry.json'));
const rows = (registry.instances ?? []).filter((row) => row.mode === 'local_agent' && !row.signedOutAt && row.agentName === args.agent);
if (rows.length !== 1) fail(`expected one paired Agent named "${args.agent}" in this manager home, found ${rows.length}`);
const localFile = path.join(rows[0].directory, 'local.json');
const local = readJson(localFile);
const env = local.worker?.env ?? {};
if (!env.RULITH_WORKER_ROOT || !env.RULITH_TOOLS_FILE) fail('this Agent has no Worker configured yet; pair it and enable its Worker once first');

// 1. Adapters: this folder's .mjs files, into <worker root>/adapters/engineering-work/.
const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(env.RULITH_WORKER_ROOT, 'adapters', 'engineering-work');
fs.mkdirSync(target, { recursive: true });
for (const name of fs.readdirSync(here).filter((n) => n.endsWith('.mjs') && n !== 'install.mjs'))
  fs.copyFileSync(path.join(here, name), path.join(target, name));

// 2. Tools: the eng.* entries replace any earlier eng.* entries; the Agent's other tools stay.
const ours = readJson(path.join(here, 'worker-tools.json'));
const manifest = fs.existsSync(env.RULITH_TOOLS_FILE) ? readJson(env.RULITH_TOOLS_FILE) : { format: ours.format, tools: {} };
for (const id of Object.keys(manifest.tools ?? {})) if (id.startsWith('eng.')) delete manifest.tools[id];
manifest.tools = { ...manifest.tools, ...ours.tools };
const writeAtomic = (file, value) => { fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n'); fs.renameSync(`${file}.tmp`, file); };
writeAtomic(env.RULITH_TOOLS_FILE, manifest);

// 3. Environment: the kit home, the built-in read tools (Console uses them to bind the Source) and the run limit.
local.worker.env = { ...env, ENG_KIT_HOME: kitHome, RULITH_WORKSPACE_TOOLS: 'read', RULITH_WORKER_RUN_TIMEOUT_SECONDS: String(runTimeout) };
writeAtomic(localFile, local);

console.log(`Installed ${Object.keys(ours.tools).length} engineering tools for "${args.agent}" (Worker run limit ${runTimeout} s).`);
console.log('Turn this Agent\'s Worker off and on so it reloads, then bind Source "lab" and pin the eng.* tools in Console.');
