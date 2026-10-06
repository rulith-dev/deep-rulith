// Deep Rulith launcher. Reads this computer's settings file (paths only), takes the model from Rulith's own model settings
// (the manager home the owner set up), and starts dsh's web profile "rulith" with the Deep Rulith overlay.
// The model key travels only in the child's environment; it is never printed or written anywhere.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const settingsFile = process.env.DEEP_RULITH_SETTINGS || process.argv[2];
if (!settingsFile) throw new Error('usage: node start-deep-rulith.mjs <deep-rulith.json> [dsh web flags]');
const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
// The model settings live in a Rulith manager home: this one's, or another the settings name (modelHome).
const modelFile = path.join(s.modelHome ?? s.managerHome, 'model-defaults.json');
const defaults = fs.existsSync(modelFile) ? JSON.parse(fs.readFileSync(modelFile, 'utf8')).defaults ?? [] : [];
const model = defaults.find((row) => row.key && row.url && row.name) ?? null;
const base = model ? model.url.replace(/\/+$/, '') : '';
const env = {
  ...process.env,
  DSH_HOME: s.dshHome, DSH_TELEMETRY_MODE: 'DISABLED', DSH_TELEMETRY_DISABLED: '1',
  RULITH_DSH_MANAGER_HOME: s.managerHome, RULITH_DSH_MANAGER_PORT: String(s.managerPort ?? 7790), RULITH_DSH_KEY_FILE: s.keyFile,
  RULITH_DSH_RUNTIME_ENTRY: s.runtimeEntry, RULITH_DSH_PERSONA: s.persona,
  ...(s.consoleUrl ? { RULITH_DSH_CONSOLE_URL: s.consoleUrl } : {}), ...(s.mcpUrl ? { RULITH_DSH_MCP_URL: s.mcpUrl } : {}), ...(s.agentName ? { RULITH_DSH_AGENT: s.agentName } : {}),
  RULITH_DSH_MODEL: model?.name ?? 'unset', RULITH_DSH_MODEL_BASE: base || 'http://127.0.0.1:9/unset',
  RULITH_MODEL_KEY: model?.key ?? '',
};
if (!model) console.error('Deep Rulith: no model is set in Rulith yet; set it under 更多设置 (Rulith workbench) and restart.');
const overlay = fileURLToPath(new URL('./rulith-web.cordis.yml', import.meta.url));
const profile = s.profile ?? 'rulith';
// --init creates the profile once from dsh's shipped web template (launcher flags must precede app flags such as --port),
// then puts the browser plugin into the profile's node_modules (a copy; no links).
const init = process.argv[3] === '--init';
const args = init
  ? [s.dshBin, '--profile', profile, '--from-default-profile', 'web', '--patch', overlay, '--dump-config']
  : [s.dshBin, '--profile', profile, '--patch', overlay, ...(s.webPort ? ['--port', String(s.webPort)] : []), ...process.argv.slice(3)];
const child = spawn(process.execPath, args, { cwd: s.cwd, env, stdio: init ? ['ignore', 'ignore', 'inherit'] : 'inherit' });
child.on('exit', (code) => {
  if (init && code === 0) {
    const target = path.join(s.dshHome, 'profiles', profile, 'node_modules', 'rulith-dsh-ui');
    fs.cpSync(fileURLToPath(new URL('./rulith-dsh-ui', import.meta.url)), target, { recursive: true });
    console.log(`Deep Rulith profile "${profile}" created in ${s.dshHome}.`);
  }
  process.exit(code ?? 0);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
