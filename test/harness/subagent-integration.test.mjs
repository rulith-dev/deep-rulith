// Optional installed-dsh contract check. Providers and tool plugins are loaded, never an app or model server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DELEGATION_TOOLS } from '../../harness/subagents.mjs';

test('installed dsh spawn/fork tools preserve route, depth and filter on both scheduling paths', {
  skip: !process.env.DSH_MODULES_DIR && 'set DSH_MODULES_DIR to the installed dsh node_modules',
}, async () => {
  const root = path.join(process.env.DSH_MODULES_DIR, '@deepseek-ai');
  const load = (pkg) => import(pathToFileURL(path.join(root, pkg, 'lib/index.js')));
  const [spawn, fork, delegation, control] = await Promise.all([
    load('dsh-subagent-spawn-in-process'), load('dsh-subagent-fork-in-process'), load('dsh-tool-subagent'), load('dsh-tool-subagent-control'),
  ]);
  const YAML = createRequire(path.join(root, 'dsh-base/package.json'))('yaml');
  const headless = YAML.parse(fs.readFileSync(new URL('../../harness/rulith.cordis.yml', import.meta.url), 'utf8'), { logLevel: 'silent' });
  const disabled = headless.filter((entry) => entry.id?.includes('subagent'));
  assert.equal(disabled.length, 7);
  for (const entry of disabled) {
    assert.equal(entry.disabled, true); assert.equal(entry.config, undefined);
  }
  for (const file of ['harness/web/rulith-web.cordis.yml']) {
    const entries = YAML.parse(fs.readFileSync(new URL('../../' + file, import.meta.url), 'utf8'), { logLevel: 'silent' });
    const row = (id) => entries.find((entry) => entry.id === id);
    assert.deepEqual(row('subagent').config, { maxDepth: 1, maxActiveSubagents: 4 });
    for (const id of ['subagent', 'subagent-spawn-in-process', 'subagent-fork-in-process', 'tool-subagent', 'tool-subagent-fork', 'tool-subagent-control'])
      assert.equal(row(id).disabled, false, 'an existing disabled profile must be re-enabled');
    for (const id of ['tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-web', 'tool-plugin-manager', 'tool-jobs', 'tool-subagent-list-agents'])
      assert.equal(row(id).disabled, true);
    const providers = new Map(), definitions = [], requests = [];
    const ctx = { get() {}, on() {}, sessionProjections: { register() {} },
      tools: { register(def) { definitions.push(def); return () => {}; } },
      systemPrompt: { section() {}, getSectionOrder: () => 1 },
      subagents: { registerProvider: (p) => providers.set(p.name, p), getProvider: (name) => providers.get(name), resolveMaxDepth: (depth) => depth,
        async startContinuable(spec) { requests.push(['continuable', spec.request]); return { childId: 'child' }; },
        async start(provider, request) { requests.push([provider, request]); return { id: 'child',
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'closing text' }] }), dispose() {} }; },
      },
    };
    spawn.apply(ctx, { providerName: 'spawn' }); fork.apply(ctx, { providerName: 'fork' });
    assert.equal(providers.get('spawn').inheritsParentContext, false); assert.equal(providers.get('fork').inheritsParentContext, true);
    assert.equal(typeof providers.get('fork').prepareContinuable, 'function');
    for (const id of ['tool-subagent', 'tool-subagent-fork']) delegation.apply(ctx, row(id).config);
    control.apply(ctx);
    assert.deepEqual(definitions.map((d) => d.name), [...DELEGATION_TOOLS]);
    const agent = { options: { provider: 'chosen', model: 'chosen-model' }, session: { header: { id: 'main' }, requestHeader() {} } };
    const exec = { agent, signal: new AbortController().signal };
    const doc = fs.readFileSync(new URL('../../harness/model-visible.md', import.meta.url), 'utf8');
    assert.ok(doc.includes(JSON.stringify(definitions.map(({ name, description, parameters }) => ({ name, description, parameters })), null, 2)));
    for (const def of definitions.slice(0, 2)) {
      assert.equal(def.parameters.provider, undefined, 'model route cannot be overridden');
      assert.equal((await def.execute({ description: 'task', prompt: 'work' }, exec)).kind, 'continuable');
      assert.equal((await def.execute({ description: 'task', prompt: 'work', run_in_background: false }, exec)).kind, 'foreground');
    }
    for (const [, request] of requests) {
      assert.equal(request.maxDepth, 1); assert.deepEqual(request.toolFilter, { allow: ['Get', 'Set', 'Execute'] });
      assert.equal(request.agentOptions, undefined, 'dsh provider inherits the main route');
    }
  }
});
