import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runtimeDirectory } from './runtime-kit.mjs';

const read = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const runInstaller = (node, argv, options) => {
  // Older Runtime CLIs do not know this subcommand. Refuse before invoking one, so a
  // default manager command can never be mistaken for successful kit installation.
  if (!fs.existsSync(path.resolve(path.dirname(argv[0]), '../kits/general/installer.mjs')))
    return { status: 2 };
  return spawnSync(node, argv, options);
};

// Refresh each paired Agent that already has an engineering kit home. The Runtime installer
// overwrites the legacy adapters at the same adapters/engineering-work paths and merges its
// manifest. It owns Worker env/timeouts; settings.json and pinned specs stay in their old home.
// This runs before the manager/Workers start; it neither pairs nor starts anything.
export function refreshGeneralKits(managerHome, { env = process.env, run = runInstaller, readJson = read } = {}) {
  const rows = (readJson(path.join(managerHome, 'registry.json'))?.instances ?? [])
    .filter(row => row.mode === 'local_agent' && !row.signedOutAt);
  let count = 0;
  for (const row of rows) {
    const worker = readJson(path.join(row.directory, 'local.json'))?.worker?.env;
    if (!worker?.ENG_KIT_HOME || !worker.RULITH_WORKER_ROOT || !worker.RULITH_TOOLS_FILE) continue;
    const entry = path.join(runtimeDirectory(env), 'local', 'rulith-local.mjs');
    const result = run(process.execPath, [entry, 'kit', 'install', 'general', '--agent', row.agentName,
      '--kit-home', worker.ENG_KIT_HOME, '--manager-home', managerHome],
    { env, encoding: 'utf8', stdio: 'pipe', windowsHide: true });
    // No child output: installation failures must not accidentally log instance data.
    if (result.error || result.status !== 0)
      throw new Error('Deep Rulith: general kit installation failed; use a Runtime with kits/general (RULITH_RUNTIME_DIR).');
    count++;
  }
  return count;
}
