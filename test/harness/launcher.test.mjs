import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { COMPACTION_RATIO, COMPACTION_HEADROOM_TOKENS, COMPACTION_SUMMARY_MAX_TOKENS, compactionLine, contextEnv, contextLines,
  reviewerEnv, writeReviewerEnv } from '../../harness/web/launcher-settings.mjs';
import { RELIEF_RATIO } from '../../harness/web/board-transcript.mjs';

// 启动器的配置管道：deep-rulith.json 的 reliefRatio／compactionRatio → 检查 → 环境变量 → rulith-web.cordis.yml
// （rulith-runtime 的减负线、dsh compaction-basic 的压缩配置）；以及写进 Worker 的审查路线（含 300 s 的超时）。

const web = fileURLToPath(new URL('../../harness/web/', import.meta.url));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deep-rulith-launcher-'));

test('the context lines default to relief at 0.7 and compaction at 0.8 of the window, and relief must come first', () => {
  assert.deepEqual(contextLines({}), { reliefRatio: RELIEF_RATIO, compactionRatio: COMPACTION_RATIO });
  assert.deepEqual([RELIEF_RATIO, COMPACTION_RATIO], [0.7, 0.8]);
  assert.deepEqual(contextLines({ reliefRatio: 0.6, compactionRatio: 0.75 }), { reliefRatio: 0.6, compactionRatio: 0.75 });
  assert.throws(() => contextLines({ reliefRatio: 0.8 }), /reliefRatio \(0\.8\) must be below compactionRatio \(0\.8\)/);
  assert.throws(() => contextLines({ reliefRatio: 0.7, compactionRatio: 0.65 }), /must be below compactionRatio/);
  for (const bad of [0, 1, -0.5, '0.7', Number.NaN]) assert.throws(() => contextLines({ reliefRatio: bad }), /must be a number between 0 and 1/);
  assert.throws(() => contextLines({ compactionRatio: 1.2 }), /compactionRatio in the settings must be a number between 0 and 1/);
});

test('dsh compacts at compactionRatio x window once headroom no longer binds; a small known window is checked against the real line', () => {
  // dsh: min(window x thresholdRatio, window - request maxTokens - headroomTokens).
  assert.equal(compactionLine(262144, 0.8, 32768, 65536), 163840, 'the old default headroom bound at about 160K');
  assert.equal(compactionLine(262144, 0.8, 32768), Math.floor(0.8 * 262144));
  assert.equal(COMPACTION_HEADROOM_TOKENS, 16384);
  assert.deepEqual(contextLines({}, { window: 262144, maxTokens: 32768 }), { reliefRatio: 0.7, compactionRatio: 0.8 });
  // 131072: dsh would compact at 131072 - 32768 - 16384 = 81920, below 0.7 x 131072 = 91750.
  assert.throws(() => contextLines({}, { window: 131072, maxTokens: 32768 }), /dsh compacts at 81920 tokens, which is not above the relief line 91750/);
  assert.deepEqual(contextLines({ reliefRatio: 0.6 }, { window: 131072, maxTokens: 32768 }), { reliefRatio: 0.6, compactionRatio: 0.8 });
});

test('the lines reach dsh through the environment the overlay reads', () => {
  const env = contextEnv({ reliefRatio: 0.65, compactionRatio: 0.85 });
  assert.equal(env.RULITH_DSH_RELIEF_RATIO, '0.65');
  assert.deepEqual(JSON.parse(env.RULITH_DSH_COMPACTION), { thresholdRatio: 0.85, headroomTokens: COMPACTION_HEADROOM_TOKENS,
    maxTokens: COMPACTION_SUMMARY_MAX_TOKENS });
  const overlay = fs.readFileSync(path.join(web, 'rulith-web.cordis.yml'), 'utf8');
  // Quoted: unquoted, the `: ` inside the expression makes YAML read a mapping.
  assert.match(overlay, /\n {8}reliefRatio: !!js 'process\.env\.RULITH_DSH_RELIEF_RATIO \? Number\(process\.env\.RULITH_DSH_RELIEF_RATIO\) : undefined'\n/);
  assert.match(overlay, /- id: compaction-basic\n {16}name: '@deepseek-ai\/dsh-compaction-basic'\n {16}config: !!js JSON\.parse\(process\.env\.RULITH_DSH_COMPACTION \|\| '\{\}'\)\n/);
  const runtime = fs.readFileSync(path.join(web, 'rulith-runtime.mjs'), 'utf8');
  assert.match(runtime, /installBoardTranscript\(ctx, \{ reliefRatio: config\.reliefRatio \}\)/);
});

// Installed-dsh contract: the overlay read in dsh's entry-list YAML dialect and its `!!js` values evaluated by the
// installed loader's interpolate(), as at entry activation.
test('installed dsh: the overlay evaluates the relief ratio and the compaction config from the environment', {
  skip: !process.env.DSH_MODULES_DIR && 'set DSH_MODULES_DIR to the installed dsh node_modules',
}, async () => {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const yaml = createRequire(path.join(process.env.DSH_MODULES_DIR, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'))('js-yaml');
  const { interpolate } = await import(pathToFileURL(path.join(process.env.DSH_MODULES_DIR, '@deepseek-ai', 'cordis-plugin-loader', 'lib', 'index.js')));
  // dsh-app-boot's entryListSchema: JSON_SCHEMA plus the `!!js` scalar.
  const js = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: (data) => typeof data === 'string', construct: (data) => ({ __jsExpr: data }) });
  const rows = yaml.load(fs.readFileSync(path.join(web, 'rulith-web.cordis.yml'), 'utf8'), { schema: yaml.JSON_SCHEMA.extend(js) }).find((row) => row.insert).insert;
  const runtime = rows.find((row) => row.id === 'rulith-runtime').config;
  const compaction = rows.find((row) => row.id === 'preset-rulith').config.plugins[0].config.find((row) => row.id === 'compaction-basic').config;
  const saved = { relief: process.env.RULITH_DSH_RELIEF_RATIO, compaction: process.env.RULITH_DSH_COMPACTION };
  try {
    delete process.env.RULITH_DSH_RELIEF_RATIO; delete process.env.RULITH_DSH_COMPACTION;
    assert.equal(interpolate({}, runtime).reliefRatio, undefined, 'without the launcher: the defaults');
    assert.deepEqual(interpolate({}, compaction), {});
    Object.assign(process.env, contextEnv({ reliefRatio: 0.65, compactionRatio: 0.85 }));
    assert.equal(interpolate({}, runtime).reliefRatio, 0.65);
    assert.deepEqual(interpolate({}, compaction), { thresholdRatio: 0.85, headroomTokens: COMPACTION_HEADROOM_TOKENS, maxTokens: COMPACTION_SUMMARY_MAX_TOKENS });
  } finally {
    for (const [key, value] of [['RULITH_DSH_RELIEF_RATIO', saved.relief], ['RULITH_DSH_COMPACTION', saved.compaction]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

// The launcher itself, with a stand-in for dsh that records the environment it was started with.
function launch(settings) {
  const dir = temp();
  const out = path.join(dir, 'dsh-env.json');
  const fakeDsh = path.join(dir, 'fake-dsh.mjs');
  fs.writeFileSync(fakeDsh, `import fs from 'node:fs';\nconst pick = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('RULITH_DSH_')));\nfs.writeFileSync(process.env.FAKE_DSH_OUT, JSON.stringify({ argv: process.argv.slice(2), env: pick }));\n`);
  const s = { dshBin: fakeDsh, dshHome: path.join(dir, 'dsh-home'), cwd: dir, managerHome: path.join(dir, 'manager-home'),
    keyFile: path.join(dir, 'key.txt'), runtimeEntry: path.join(dir, 'runtime.mjs'), persona: path.join(dir, 'persona.txt'), ...settings };
  fs.mkdirSync(s.managerHome, { recursive: true });
  const file = path.join(dir, 'deep-rulith.json');
  fs.writeFileSync(file, JSON.stringify(s));
  const run = spawnSync(process.execPath, [path.join(web, 'start-deep-rulith.mjs'), file], { env: { ...process.env, FAKE_DSH_OUT: out }, encoding: 'utf8', timeout: 30_000 });
  const started = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { run, started };
}

test('the launcher passes the context lines to dsh, and refuses to start when relief is not below compaction', () => {
  const ok = launch({ reliefRatio: 0.65, compactionRatio: 0.85, localContextWindow: 262144 });
  assert.equal(ok.run.status, 0, ok.run.stderr);
  assert.equal(ok.started.env.RULITH_DSH_RELIEF_RATIO, '0.65');
  assert.equal(JSON.parse(ok.started.env.RULITH_DSH_COMPACTION).thresholdRatio, 0.85);
  const defaults = launch({});
  assert.equal(defaults.started.env.RULITH_DSH_RELIEF_RATIO, '0.7');
  assert.equal(JSON.parse(defaults.started.env.RULITH_DSH_COMPACTION).thresholdRatio, 0.8);
  const refused = launch({ reliefRatio: 0.9 });
  assert.notEqual(refused.run.status, 0);
  assert.match(refused.run.stderr, /reliefRatio \(0\.9\) must be below compactionRatio \(0\.8\)/);
  assert.equal(refused.started, null, 'dsh is not started');
});

test("the platform reviewer's route in each enabled Worker's worker.env includes the 300 s timeout", () => {
  const home = temp();
  const instance = (name, local) => {
    fs.mkdirSync(path.join(home, 'instances', name), { recursive: true });
    if (local) fs.writeFileSync(path.join(home, 'instances', name, 'local.json'), JSON.stringify(local));
  };
  instance('on', { worker: { enabled: true, env: { RULITH_TOOLS_FILE: 'tools.json', RULITH_REVIEWER_MAX_TOKENS: '8000' } }, agent: { env: { RULITH_TOKEN: 't' } } });
  instance('off', { worker: { enabled: false, env: {} } });
  instance('empty', null);
  const want = reviewerEnv({ baseURL: 'http://127.0.0.1:8091/v1', modelId: 'qwen', key: 'k' });
  assert.deepEqual(want, { RULITH_REVIEWER_URL: 'http://127.0.0.1:8091/v1/chat/completions', RULITH_REVIEWER_MODEL: 'qwen',
    RULITH_REVIEWER_KEY: 'k', RULITH_REVIEWER_MAX_TOKENS: '16000', RULITH_REVIEWER_TIMEOUT_MS: '300000' });
  assert.equal(writeReviewerEnv(home, want), 1);
  const on = JSON.parse(fs.readFileSync(path.join(home, 'instances', 'on', 'local.json'), 'utf8'));
  assert.deepEqual(on.worker.env, { RULITH_TOOLS_FILE: 'tools.json', ...want });
  assert.deepEqual(on.agent, { env: { RULITH_TOKEN: 't' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'instances', 'off', 'local.json'), 'utf8')).worker.env, {});
  assert.equal(writeReviewerEnv(home, want), 0, 'already written: nothing to do');
  fs.rmSync(home, { recursive: true, force: true });
});
