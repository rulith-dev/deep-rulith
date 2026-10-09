// Deep Rulith launcher. Reads this computer's settings file (paths only), takes the model from Rulith's own model settings
// (the manager home the owner set up), and starts dsh's web profile "rulith" with the Deep Rulith overlay.
// The model key travels only in the child's environment; it is never printed or written anywhere.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
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
const profilePatch = path.join(s.dshHome, 'profiles', profile, 'cordis.patch.yml');

// 模型路线 rulith-model 写在 profile 自己的补丁层（cordis.patch.yml），不写在 overlay 里。原因有二：
// 一、dsh 的补丁按条目整段替换 config，overlay 排在最后，若由它设定 llm-pi-ai，人在模型页添加的提供商重启后就被整段覆盖；
// 二、模型页每次写入都校验全部提供商，读不懂 `!!js` 表达式，overlay 里的表达式会让添加任何提供商都失败。
// 所以每次启动只更新 rulith-model 这一条路线（取自 Rulith 的模型设置），人加的其他提供商原样保留；
// 默认模型只在人没有选过别的提供商时才指向 rulith-model。写入的只有模型名与地址，不是机密；密钥仍只经环境变量传入。
function writeModelRoute() {
  if (!fs.existsSync(profilePatch)) return;
  const YAML = createRequire(s.dshBin)('yaml'); // dsh 模型页写这个文件用的同一个库，注释与其他条目原样保留
  const doc = YAML.parseDocument(fs.readFileSync(profilePatch, 'utf8'));
  if (doc.errors.length > 0) throw new Error(`Deep Rulith: ${profilePatch} is not valid YAML; fix it and restart`);
  if (!YAML.isSeq(doc.contents)) doc.contents = doc.createNode([]);
  const rows = doc.contents;
  const row = (id) => rows.items.find((item) => YAML.isMap(item) && item.get('id') === id && !item.has('insert'));
  const route = {
    api: 'openai-completions', apiKeyEnv: 'RULITH_MODEL_KEY', baseURL: env.RULITH_DSH_MODEL_BASE,
    compat: { thinkingFormat: 'deepseek' }, models: [{ id: env.RULITH_DSH_MODEL, contextWindow: 1000000 }],
  };
  let llm = row('llm-pi-ai');
  if (!llm) { llm = doc.createNode({ id: 'llm-pi-ai' }); rows.add(llm); }
  if (!YAML.isMap(llm.get('config'))) llm.set('config', doc.createNode({}));
  if (!YAML.isMap(llm.getIn(['config', 'providers']))) llm.setIn(['config', 'providers'], doc.createNode({}));
  llm.setIn(['config', 'providers', 'rulith-model'], doc.createNode(route));
  const chosen = row('agent-default-model');
  if (!chosen) rows.add(doc.createNode({ id: 'agent-default-model', config: { provider: 'rulith-model', model: env.RULITH_DSH_MODEL } }));
  else if (chosen.getIn(['config', 'provider']) === 'rulith-model') chosen.setIn(['config', 'model'], env.RULITH_DSH_MODEL);
  const text = doc.toString();
  fs.writeFileSync(`${profilePatch}.tmp`, text);
  fs.renameSync(`${profilePatch}.tmp`, profilePatch);
}

// 席位（C1，D-1008h）：设置里的 seats 各生成一个 dsh Agent 预设 `rulith-seat-<名>`；选这个预设的对话坐在该席位上，
// 宿主据此在 initialize 声明席位。默认预设 `rulith` 是 main。席位须先由人在 Console 的 Agent 设置里添加，否则会话被拒。
// 预设不带任何插件，也不加模型可见文字；角色由人在对话里交代。每次启动重写这个文件，没有 seats 就不传它。
const seats = Array.isArray(s.seats) ? s.seats : [];
for (const seat of seats) {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(seat?.name ?? '') || seat.name === 'main') throw new Error(`Deep Rulith: seat name refused: ${JSON.stringify(seat?.name)}`);
}
const seatsPatch = path.join(s.dshHome, 'deep-rulith-seats.patch.yml');
if (seats.length > 0) {
  fs.mkdirSync(s.dshHome, { recursive: true });
  fs.writeFileSync(seatsPatch, ['# Written by the Deep Rulith launcher on every start from the seats in its settings; edits are overwritten.', '- insert:',
    ...seats.flatMap((seat, index) => [
      `    - id: ${JSON.stringify(`preset-rulith-seat-${seat.name}`)}`,
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      `        id: ${JSON.stringify(`rulith-seat-${seat.name}`)}`,
      `        name: ${JSON.stringify(String(seat.label ?? seat.name).slice(0, 60))}`,
      `        description: ${JSON.stringify(`Rulith seat ${seat.name}`)}`,
      `        order: ${index + 1}`,
      '        plugins: []',
    ]), ''].join('\n'));
}
const seatArgs = seats.length > 0 ? ['--patch', seatsPatch] : [];

// --init creates the profile once from dsh's shipped web template (launcher flags must precede app flags such as --port),
// then puts the browser plugin into the profile's node_modules (a copy; no links).
const init = process.argv[3] === '--init';
if (!init) writeModelRoute();
const args = init
  ? [s.dshBin, '--profile', profile, '--from-default-profile', 'web', '--patch', overlay, ...seatArgs, '--dump-config']
  : [s.dshBin, '--profile', profile, '--patch', overlay, ...seatArgs, ...(s.webPort ? ['--port', String(s.webPort)] : []), ...process.argv.slice(3)];
const child = spawn(process.execPath, args, { cwd: s.cwd, env, stdio: init ? ['ignore', 'ignore', 'inherit'] : 'inherit' });
child.on('exit', (code) => {
  if (init && code === 0) {
    const target = path.join(s.dshHome, 'profiles', profile, 'node_modules', 'rulith-dsh-ui');
    fs.cpSync(fileURLToPath(new URL('./rulith-dsh-ui', import.meta.url)), target, { recursive: true });
    writeModelRoute();
    console.log(`Deep Rulith profile "${profile}" created in ${s.dshHome}.`);
  }
  process.exit(code ?? 0);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
