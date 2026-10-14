import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { contextEnv, contextLines, REVIEWER_REQUEST_RESERVED_KEYS, reviewerEnv, reviewerRequestExtra, writeReviewerEnv }
  from '../../harness/web/launcher-settings.mjs';
import { COMPACTION_RATIO, COMPACTION_HEADROOM_TOKENS, COMPACTION_SUMMARY_MAX_TOKENS, RELIEF_MARGIN, RELIEF_RATIO, compactionLine,
  contextLinesFor } from '../../harness/web/context-relief.mjs';

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

test('dsh compacts at compactionRatio x window once headroom no longer binds; a smaller window moves relief before the real line', () => {
  // dsh: min(window x thresholdRatio, window - request maxTokens - headroomTokens).
  assert.equal(compactionLine(262144, 0.8, 32768, 65536), 163840, 'the old default headroom bound at about 160K');
  assert.equal(compactionLine(262144, 0.8, 32768, COMPACTION_HEADROOM_TOKENS), Math.floor(0.8 * 262144));
  const launched = JSON.parse(contextEnv(contextLines({})).RULITH_DSH_COMPACTION);
  assert.deepEqual(contextLinesFor({ contextWindow: 262144, maxTokens: 32768, compaction: launched }), { relief: 183500, compaction: 209715 });
  // 131072: dsh compacts at 131072 - 32768 - 16384 = 81920, below 0.7 x 131072 = 91750; relief moves one step before it.
  assert.deepEqual(contextLinesFor({ contextWindow: 131072, maxTokens: 32768, compaction: launched }), { relief: 81920 - RELIEF_MARGIN, compaction: 81920 });
  // The route's own output cap counts: with a smaller one dsh compacts at 0.8 x window, and relief stays one step before it.
  assert.deepEqual(contextLinesFor({ contextWindow: 131072, maxTokens: 8192, compaction: launched }), { relief: 104857 - RELIEF_MARGIN, compaction: 104857 });
  // Without the launcher dsh keeps its own defaults (0.8, headroom 65536).
  assert.deepEqual(contextLinesFor({ contextWindow: 262144, maxTokens: 32768 }), { relief: 143840, compaction: 163840 });
  assert.equal(RELIEF_MARGIN, 20000);
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
  assert.match(runtime, /installBoardTranscript\(ctx, \{ reliefRatio: config\.reliefRatio, compaction: config\.compaction \}\)/);
  assert.match(overlay, /\n {8}compaction: !!js JSON\.parse\(process\.env\.RULITH_DSH_COMPACTION \|\| '\{\}'\)\n/);
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
    assert.deepEqual(interpolate({}, runtime).compaction, {});
    assert.deepEqual(interpolate({}, compaction), {});
    Object.assign(process.env, contextEnv({ reliefRatio: 0.65, compactionRatio: 0.85 }));
    const want = { thresholdRatio: 0.85, headroomTokens: COMPACTION_HEADROOM_TOKENS, maxTokens: COMPACTION_SUMMARY_MAX_TOKENS };
    assert.equal(interpolate({}, runtime).reliefRatio, 0.65);
    assert.deepEqual(interpolate({}, runtime).compaction, want, 'rulith-runtime reads the same compaction config as dsh');
    assert.deepEqual(interpolate({}, compaction), want);
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

test('reviewerThinking and reviewerRequestExtra become the reviewer request extra; anything else is refused', () => {
  assert.equal(reviewerRequestExtra({}), undefined, 'absent: send nothing');
  assert.equal(reviewerRequestExtra({ reviewerThinking: false }), '{"chat_template_kwargs":{"enable_thinking":false}}');
  assert.equal(reviewerRequestExtra({ reviewerThinking: true }), '{"chat_template_kwargs":{"enable_thinking":true}}');
  for (const level of ['low', 'medium', 'high']) {
    assert.deepEqual(JSON.parse(reviewerRequestExtra({ reviewerThinking: level })),
      { chat_template_kwargs: { enable_thinking: true }, reasoning_effort: level });
  }
  for (const bad of ['max', 'true', 'High', 1, 0, null, {}, []]) {
    assert.throws(() => reviewerRequestExtra({ reviewerThinking: bad }),
      /reviewerThinking in the settings must be false, true, "low", "medium" or "high"/, JSON.stringify(bad));
  }
  // The raw object is written as it is and takes precedence over reviewerThinking.
  const raw = { chat_template_kwargs: { enable_thinking: true, thinking_budget: 4096 } };
  assert.equal(reviewerRequestExtra({ reviewerThinking: false, reviewerRequestExtra: raw }), JSON.stringify(raw));
  assert.equal(reviewerRequestExtra({ reviewerRequestExtra: {} }), '{}');
  for (const bad of [null, [], 'text', 42, true]) {
    assert.throws(() => reviewerRequestExtra({ reviewerRequestExtra: bad }), /reviewerRequestExtra in the settings must be a JSON object/);
  }
  assert.deepEqual(REVIEWER_REQUEST_RESERVED_KEYS, ['model', 'messages', 'max_tokens', 'temperature', 'stream', 'tools', 'tool_choice', 'n']);
  for (const key of REVIEWER_REQUEST_RESERVED_KEYS) {
    assert.throws(() => reviewerRequestExtra({ reviewerRequestExtra: { [key]: 1, chat_template_kwargs: {} } }),
      { message: `Deep Rulith: reviewerRequestExtra in the settings may not set ${key}; the Worker controls it` });
  }
  assert.throws(() => reviewerRequestExtra({ reviewerRequestExtra: { stream: true, n: 2 } }), /may not set stream, n; the Worker controls them/);
});

test('the request extra is written beside the other reviewer keys and removed when the settings no longer have it', () => {
  const home = temp();
  fs.mkdirSync(path.join(home, 'instances', 'on'), { recursive: true });
  const file = path.join(home, 'instances', 'on', 'local.json');
  fs.writeFileSync(file, JSON.stringify({ worker: { enabled: true, env: { RULITH_TOOLS_FILE: 'tools.json' } } }));
  const route = { baseURL: 'http://127.0.0.1:8091/v1', modelId: 'qwen', key: 'k' };
  const thinking = reviewerEnv({ ...route, extra: reviewerRequestExtra({ reviewerThinking: 'high' }) });
  assert.equal(writeReviewerEnv(home, thinking), 1);
  const env = () => JSON.parse(fs.readFileSync(file, 'utf8')).worker.env;
  assert.equal(env().RULITH_REVIEWER_REQUEST_EXTRA, '{"chat_template_kwargs":{"enable_thinking":true},"reasoning_effort":"high"}');
  assert.equal(env().RULITH_REVIEWER_MODEL, 'qwen');
  assert.equal(writeReviewerEnv(home, thinking), 0, 'already written: nothing to do');
  const off = reviewerEnv({ ...route, extra: reviewerRequestExtra({ reviewerThinking: false }) });
  assert.equal(writeReviewerEnv(home, off), 1);
  assert.equal(env().RULITH_REVIEWER_REQUEST_EXTRA, '{"chat_template_kwargs":{"enable_thinking":false}}');
  const absent = reviewerEnv({ ...route, extra: reviewerRequestExtra({}) });
  assert.equal(writeReviewerEnv(home, absent), 1);
  assert.equal(Object.hasOwn(env(), 'RULITH_REVIEWER_REQUEST_EXTRA'), false, 'neither setting: the key is removed');
  assert.equal(env().RULITH_TOOLS_FILE, 'tools.json');
  assert.equal(writeReviewerEnv(home, absent), 0, 'already absent: nothing to do');
  fs.rmSync(home, { recursive: true, force: true });
});

test('the launcher refuses to start on an invalid reviewerThinking or a reviewerRequestExtra with a key the Worker controls', () => {
  for (const [settings, message] of [
    [{ reviewerThinking: 'max' }, /reviewerThinking in the settings must be false, true, "low", "medium" or "high" \(got "max"\)/],
    [{ reviewerRequestExtra: ['x'] }, /reviewerRequestExtra in the settings must be a JSON object/],
    [{ reviewerThinking: true, reviewerRequestExtra: { max_tokens: 9 } }, /reviewerRequestExtra in the settings may not set max_tokens/],
  ]) {
    const refused = launch(settings);
    assert.notEqual(refused.run.status, 0);
    assert.match(refused.run.stderr, message);
    assert.equal(refused.started, null, 'dsh is not started');
  }
  for (const settings of [{ reviewerThinking: 'low' }, { reviewerRequestExtra: { chat_template_kwargs: { enable_thinking: true } } }]) {
    const ok = launch(settings);
    assert.equal(ok.run.status, 0, ok.run.stderr);
  }
});

test('the launcher passes the context lines to dsh, and refuses to start when relief is not below compaction', () => {
  const ok = launch({ reliefRatio: 0.65, compactionRatio: 0.85, localContextWindow: 262144 });
  assert.equal(ok.run.status, 0, ok.run.stderr);
  assert.equal(ok.started.env.RULITH_DSH_RELIEF_RATIO, '0.65');
  assert.equal(JSON.parse(ok.started.env.RULITH_DSH_COMPACTION).thresholdRatio, 0.85);
  // A small local window is not refused: the relief line is moved before dsh's real compaction line at run time.
  const defaults = launch({ localContextWindow: 131072 });
  assert.equal(defaults.run.status, 0, defaults.run.stderr);
  assert.equal(defaults.started.env.RULITH_DSH_RELIEF_RATIO, '0.7');
  assert.equal(JSON.parse(defaults.started.env.RULITH_DSH_COMPACTION).thresholdRatio, 0.8);
  const refused = launch({ reliefRatio: 0.9 });
  assert.notEqual(refused.run.status, 0);
  assert.match(refused.run.stderr, /reliefRatio \(0\.9\) must be below compactionRatio \(0\.8\)/);
  assert.equal(refused.started, null, 'dsh is not started');
});

test("the platform reviewer's route in each enabled Worker's worker.env drops the old 300 s timeout", () => {
  const home = temp();
  const instance = (name, local) => {
    fs.mkdirSync(path.join(home, 'instances', name), { recursive: true });
    if (local) fs.writeFileSync(path.join(home, 'instances', name, 'local.json'), JSON.stringify(local));
  };
  instance('on', { worker: { enabled: true, env: { RULITH_TOOLS_FILE: 'tools.json', RULITH_REVIEWER_MAX_TOKENS: '8000', RULITH_REVIEWER_TIMEOUT_MS: '300000' } }, agent: { env: { RULITH_TOKEN: 't' } } });
  instance('off', { worker: { enabled: false, env: {} } });
  instance('empty', null);
  const want = reviewerEnv({ baseURL: 'http://127.0.0.1:8091/v1', modelId: 'qwen', key: 'k' });
  assert.deepEqual(want, { RULITH_REVIEWER_URL: 'http://127.0.0.1:8091/v1/chat/completions', RULITH_REVIEWER_MODEL: 'qwen',
    RULITH_REVIEWER_KEY: 'k', RULITH_REVIEWER_MAX_TOKENS: '16000', RULITH_REVIEWER_TIMEOUT_MS: undefined,
    RULITH_REVIEWER_REQUEST_EXTRA: undefined });
  assert.equal(writeReviewerEnv(home, want), 1);
  const on = JSON.parse(fs.readFileSync(path.join(home, 'instances', 'on', 'local.json'), 'utf8'));
  assert.deepEqual(on.worker.env, { RULITH_TOOLS_FILE: 'tools.json', RULITH_REVIEWER_URL: want.RULITH_REVIEWER_URL,
    RULITH_REVIEWER_MODEL: 'qwen', RULITH_REVIEWER_KEY: 'k', RULITH_REVIEWER_MAX_TOKENS: '16000' });
  assert.deepEqual(on.agent, { env: { RULITH_TOKEN: 't' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'instances', 'off', 'local.json'), 'utf8')).worker.env, {});
  assert.equal(writeReviewerEnv(home, want), 0, 'already written: nothing to do');
  fs.rmSync(home, { recursive: true, force: true });
});

test('reviewerRoutes send instances of matching Agents to another reviewer route', async () => {
  const { reviewerRoutes } = await import('../../harness/web/launcher-settings.mjs');
  assert.deepEqual(reviewerRoutes({}), []);
  assert.throws(() => reviewerRoutes({ reviewerRoutes: [{ agentPrefix: 'x' }] }), /agentPrefix, provider and model/);
  assert.deepEqual(reviewerRoutes({ reviewerRoutes: [{ agentPrefix: 'bench-h-', provider: 'p', model: 'm', reviewerThinking: true }] }),
    [{ agentPrefix: 'bench-h-', provider: 'p', model: 'm', extra: JSON.stringify({ chat_template_kwargs: { enable_thinking: true } }) }]);
  const home = temp();
  for (const [id, name] of [['inst-a', 'bench-h-one'], ['inst-b', 'bench-q-two']]) {
    fs.mkdirSync(path.join(home, 'instances', id), { recursive: true });
    fs.writeFileSync(path.join(home, 'instances', id, 'local.json'), JSON.stringify({ worker: { enabled: true, env: {} } }));
  }
  fs.writeFileSync(path.join(home, 'registry.json'), JSON.stringify({ instances: [{ id: 'inst-a', name: 'bench-h-one', agentName: 'bench-h-one' }, { id: 'inst-b', name: 'bench-q-two', agentName: 'bench-q-two' }] }));
  const def = reviewerEnv({ baseURL: 'http://local/v1', modelId: 'qwen', key: 'k1' });
  const alt = reviewerEnv({ baseURL: 'https://api.example/v1', modelId: 'ds', key: 'k2' });
  assert.equal(writeReviewerEnv(home, def, [{ agentPrefix: 'bench-h-', env: alt }]), 2);
  const read = (id) => JSON.parse(fs.readFileSync(path.join(home, 'instances', id, 'local.json'), 'utf8')).worker.env;
  assert.equal(read('inst-a').RULITH_REVIEWER_MODEL, 'ds');
  assert.equal(read('inst-b').RULITH_REVIEWER_MODEL, 'qwen');
});
