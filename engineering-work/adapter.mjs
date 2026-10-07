import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { settings, context, fenced, tree, changed, sha, fileDigest, clip, textLimit, classify, execute, locked, readJson, save, pin, refuse, sleep, resultText } from './lib.mjs';
const ROW_BYTES = 1800;

export async function perform(tool, args = {}, env = process.env) {
  const ctx = context(env);
  return locked(ctx, async () => {
    let job = readJson(ctx.jobFile, {});
    if (['starting', 'running', 'stopping'].includes(job.status) && !['job_poll', 'job_stop'].includes(tool)) refuse('job live: only poll and stop accepted');
    const before = tree(ctx);
    const state = readJson(ctx.stateFile, { gen: 0, digest: before.digest });
    let rows = []; let text = {}; let more = false;
    const file = () => fenced(ctx.root, args.path);
    switch (tool) {
      case 'list': {
        const target = file();
        const entries = fs.readdirSync(target, { withFileTypes: true }); more = entries.length > 128;
        rows = entries.sort((a,b) => a.name.localeCompare(b.name)).slice(0, 128).map(e => {
          const name = path.relative(ctx.root, path.join(target, e.name)).replaceAll('\\', '/');
          fenced(ctx.root, name);
          return { path: name, kind: e.isDirectory() ? 'directory' : e.isSymbolicLink() ? 'link' : 'file' };
        }); break;
      }
      case 'read': {
        const target = file(); const size = fs.statSync(target).size; const fd = fs.openSync(target,'r');
        const offset = args.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) { fs.closeSync(fd); refuse('offset refused'); }
        const span = args.offset === undefined ? size : Math.min(2048,size-offset);
        const head = Buffer.alloc(Math.min(1024,span)); const tailOffset = offset + Math.max(0,span-1024); const tail = Buffer.alloc(Math.min(1024,span));
        try { fs.readSync(fd,head,0,head.length,offset); fs.readSync(fd,tail,0,tail.length,tailOffset); } finally { fs.closeSync(fd); }
        rows = [{ path: path.relative(ctx.root, target).replaceAll('\\', '/'), digest: fileDigest(target), bytes: size, offset, tail_offset: tailOffset }];
        text = { head: clip(head), tail: span > 1024 ? clip(tail,true) : '' }; break;
      }
      case 'search': {
        if (typeof args.query !== 'string' || !args.query || Buffer.byteLength(args.query) > 1024) refuse('query refused');
        const prefix = path.relative(ctx.root, file()).replaceAll('\\','/');
        for (const name of Object.keys(before.files)) {
          if (rows.length === 128) { more = true; break; }
          if (name.endsWith('/') || (prefix && name !== prefix && !name.startsWith(`${prefix}/`))) continue;
          const target = fenced(ctx.root, name);
          if (fs.lstatSync(target).isSymbolicLink() || fs.statSync(target).size > 1024 * 1024) continue;
          const lines = fs.readFileSync(target, 'utf8').split('\n');
          lines.forEach((line, i) => { if (line.includes(args.query) && rows.length < 128) rows.push({ path: name, line: i + 1, digest: sha(line) }); });
        } break;
      }
      case 'tree_state': rows = [{ gen: state.gen, tree_digest: before.digest }]; break;
      case 'write_file':
      case 'patch_file': {
        const target = file(); const content = textLimit(args.text);
        const original = fs.existsSync(target) ? fs.readFileSync(target) : Buffer.alloc(0);
        if (typeof args.expect_digest !== 'string' || args.expect_digest !== sha(original)) refuse('file digest changed');
        let output = content;
        if (tool === 'patch_file') {
          const old = textLimit(args.old_text);
          if (Buffer.byteLength(old) + Buffer.byteLength(content) > 16384) refuse('text exceeds 16 KiB');
          const source = original.toString('utf8');
          if (!old || source.indexOf(old) < 0 || source.indexOf(old) !== source.lastIndexOf(old)) refuse('patch must match once');
          output = source.replace(old, content);
        }
        // Do not create missing parent directories implicitly.
        fenced(ctx.root, path.dirname(target));
        fs.writeFileSync(fenced(ctx.root, args.path), output);
        const readback = fs.readFileSync(fenced(ctx.root, args.path));
        if (!readback.equals(Buffer.from(output))) refuse('read-back failed');
        rows = [{ path: path.relative(ctx.root, target).replaceAll('\\','/'), prev_digest: sha(original), digest: sha(readback), readback_digest: sha(readback), bytes: readback.length }]; break;
      }
      case 'run': {
        const command = classify(ctx, args.command, args.cwd);
        const result = await execute(command.command, command.cwd, { deadlineMs: settings(ctx.home).runSeconds * 1000, shell: command.shell, line: command.line });
        rows = [commandRow(result, args.command, before.digest)]; text = resultText(result); break;
      }
      case 'job_start': {
        const command = classify(ctx, args.command, args.cwd);
        job = { id: randomUUID(), status: 'starting', root: ctx.root, home: ctx.home, command: command.command, line: command.line, shell: command.shell, cwd: command.cwd, before: before.digest, pid: 0, supervisor_pid: 0, exit_code: -1 };
        save(ctx.jobFile, job);
        const child = spawn(process.execPath, [fileURLToPath(new URL('./supervisor.mjs', import.meta.url)), ctx.jobFile, job.id], { detached: true, windowsHide: true, stdio: 'ignore' });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref();
        const limit = Date.now() + 5000;
        do { await sleep(25); job = readJson(ctx.jobFile); } while (job.status === 'starting' && Date.now() < limit);
        if (job.status === 'starting') refuse('job unavailable');
        rows = [jobRow(job)]; break;
      }
      case 'job_poll':
      case 'job_stop': {
        if (!job.id || args.job_id !== job.id) refuse('job refused');
        if (tool === 'job_stop' && ['starting','running','stopping'].includes(job.status)) fs.writeFileSync(`${ctx.jobFile}.stop`, job.id, { mode: 0o600 });
        const wait = tool === 'job_stop' ? 5000 : (args.wait_s ?? 0) * 1000;
        if (!Number.isInteger(wait) || wait < 0 || wait > settings(ctx.home).pollSeconds * 1000) refuse('wait refused');
        const until = Date.now() + wait;
        while (['starting','running','stopping'].includes(job.status) && Date.now() < until) { await sleep(Math.min(100, Math.max(1,until-Date.now()))); job = readJson(ctx.jobFile); }
        if (tool === 'job_stop' && ['starting','running','stopping'].includes(job.status)) refuse('job stop unconfirmed');
        rows = [jobRow(job)];
        if (job.result) text = resultText(job.result);
        break;
      }
      case 'test': {
        if (Object.keys(args).length) refuse('test takes no arguments');
        const pinned = pin(ctx, 'test');
        const command = pinnedCommand(ctx, pinned.spec);
        const result = await execute(command.command, command.cwd, { deadlineMs: settings(ctx.home).runSeconds * 1000, shell: command.shell, line: command.line });
        rows = [{ spec_digest: pinned.digest, gen: state.gen, tree_digest: '', exit_code: result.exit_code }];
        text = resultText(result); break;
      }
      case 'measure_pinned': {
        if (Object.keys(args).some(k => k !== 'spec_id')) refuse('spec refused');
        const pinned = pin(ctx, args.spec_id); const spec = pinned.spec;
        const command = pinnedCommand(ctx, spec);
        if (!['ms','us','tokens_per_second','bytes_per_second'].includes(spec.unit) || !Number.isInteger(spec.repeats) || spec.repeats < 1 || spec.repeats > 16 || !['json_integer_milli'].includes(spec.parser?.kind) || !/^[a-zA-Z0-9_]+$/.test(spec.parser?.field)) refuse('spec refused');
        for (const key of ['binary_digest', 'workload_digest', 'config_digest']) if (!/^[a-f0-9]{64}$/.test(spec[key])) refuse('spec refused');
        const binary = fenced(ctx.root, spec.binary); const candidate = fenced(ctx.root, spec.candidate_binary);
        // A pin on an unrelated file must never accredit another program's numbers.
        const executable = path.resolve(command.cwd, command.command[0]);
        if (fs.realpathSync(executable) !== fs.realpathSync(binary)) refuse('spec refused');
        command.command = [binary, ...command.command.slice(1)];
        for (let repeat = 1; repeat <= spec.repeats; repeat++) {
          const currentBinary = fenced(ctx.root, spec.binary);
          if (fileDigest(currentBinary) !== spec.binary_digest) refuse('measuring binary digest changed');
          command.command[0] = currentBinary;
          if (pin(ctx,args.spec_id).digest !== pinned.digest) refuse('spec refused');
          if (fileDigest(fenced(ctx.root, spec.workload)) !== spec.workload_digest || fileDigest(fenced(ctx.root, spec.config)) !== spec.config_digest) refuse('measurement inputs changed');
          const candidateDigest = fileDigest(fenced(ctx.root,spec.candidate_binary));
          const result = await execute(command.command, command.cwd, { deadlineMs: Math.floor(settings(ctx.home).runSeconds * 1000 / spec.repeats) });
          if (result.exit_code !== 0 || result.timed_out || result.stdout.bytes > 1024 || fileDigest(fenced(ctx.root,spec.binary)) !== spec.binary_digest || fileDigest(fenced(ctx.root,spec.candidate_binary)) !== candidateDigest || fileDigest(fenced(ctx.root, spec.workload)) !== spec.workload_digest || fileDigest(fenced(ctx.root, spec.config)) !== spec.config_digest) refuse('measurement failed');
          let parsed; try { parsed = JSON.parse(result.stdout.head); } catch { refuse('measurement failed'); }
          const value = parsed[spec.parser.field];
          if (!Number.isSafeInteger(value) || value < 0) refuse('measurement failed');
          rows.push({ spec_id: args.spec_id, repeat, value_milli: value, unit: spec.unit, spec_digest: pinned.digest, binary_digest: spec.binary_digest, candidate_digest: candidateDigest, workload_digest: spec.workload_digest, config_digest: spec.config_digest });
        } break;
      }
      default: refuse('tool refused');
    }
    const after = tree(ctx);
    if (tool === 'run') { rows[0].tree_after = after.digest; rows[0].changed_files = JSON.stringify(changed(before, after)); }
    const mutated = state.digest !== after.digest;
    const gen = state.gen + (mutated ? 1 : 0);
    if (!Number.isSafeInteger(gen)) refuse('generation exhausted');
    const step = mutated ? { from_gen: state.gen, to_gen: gen } : { from_gen: -1, to_gen: -1 };
    // Replay the genuine first edge after the latest passing test. If an adapter
    // finished but its Worker receipt was lost, a later read still invalidates it.
    let invalidation = state.invalidation;
    if (mutated && state.test_gen === state.gen) invalidation = step;
    const edges = invalidation && invalidation.from_gen !== step.from_gen ? [invalidation,step] : [step];
    if (tool === 'tree_state') rows[0] = { gen, tree_digest: after.digest };
    if (tool === 'test') { rows[0].tree_digest = after.digest; rows[0].gen = gen; }
    const testGen = tool === 'test' && rows[0].exit_code === 0 ? gen : state.test_gen;
    save(ctx.stateFile, { gen, digest: after.digest, ...(testGen === undefined ? {} : { test_gen: testGen }), ...(invalidation ? { invalidation } : {}) });
    let out = rows.flatMap(row => edges.map(edge => ({ ...row, ...edge })));
    // A receipt carries every row twice (the result text and its facts) inside the Worker's inline budget
    // (8 KiB on rulith.ai). Listing and search keep at most ROW_BYTES of rows and say when they stopped short.
    if (tool === 'list' || tool === 'search')
      while (out.length > edges.length && Buffer.byteLength(JSON.stringify(out)) > ROW_BYTES) { out = out.slice(0, out.length - edges.length); more = true; }
    return { rows: out, ...text, ...(more ? { truncated: true } : {}) };
  });
}
function pinnedCommand(ctx, spec) {
  // Owner-pinned executable may be an absolute toolchain path outside the Source.
  if (!Array.isArray(spec.command) || !spec.command.length || spec.command.some(x => typeof x !== 'string' || !x || x.includes('\0'))) refuse('spec refused');
  // A pinned spec may ask for the system shell (for example `npm test` on Windows, which is a .cmd script).
  return { command: spec.command, cwd: fenced(ctx.root, spec.cwd ?? '.'), shell: spec.shell === true, line: spec.command.join(' ') };
}
function commandRow(r, command, before) {
  return { run_id: randomUUID(), command_digest: sha(JSON.stringify(command)), exit_code: r.exit_code, timed_out: r.timed_out, duration_ms: r.duration_ms, stdout_digest: r.stdout.digest, stderr_digest: r.stderr.digest, stdout_bytes: r.stdout.bytes, stderr_bytes: r.stderr.bytes, tree_before: before, tree_after: '', changed_files: '' };
}
function jobRow(j) { return { job_id: j.id, status: j.status, exit_code: j.exit_code, command_digest: sha(JSON.stringify(j.command)), tree_before: j.before }; }
export async function main(tool) {
  try {
    const args = JSON.parse(process.argv[2] ?? '{}');
    if (!args || Array.isArray(args) || typeof args !== 'object') refuse('arguments refused');
    process.stdout.write(JSON.stringify(await perform(tool, args)));
  } catch (error) {
    // Never echo paths, arbitrary exception messages, commands, or spec contents.
    const messages = ['path refused','file Source required','pin directory required','pin directory refused','spec refused','query refused','offset refused','command refused','adapter busy','job live: only poll and stop accepted','text exceeds 16 KiB','file digest changed','patch must match once','read-back failed','job unavailable','job refused','wait refused','job stop unconfirmed','test takes no arguments','measuring binary digest changed','measurement inputs changed','measurement failed','tool refused','arguments refused','generation exhausted'];
    process.stdout.write(JSON.stringify({ rows: [], verdict: messages.includes(error.message) ? error.message : 'adapter failed' }));
    process.exitCode = 2;
  }
}
