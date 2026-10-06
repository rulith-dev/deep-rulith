import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// The Rulith Runtime that runs these tools: RULITH_RUNTIME_DIR (a checkout) or the installed `rulith` package.
const runtimeDir=process.env.RULITH_RUNTIME_DIR??path.dirname(createRequire(import.meta.url).resolve('rulith/package.json'));
import { context, fenced, classify, tree, sha, fileDigest, execute, sleep, killTree } from '../../engineering-work/lib.mjs';
import { perform } from '../../engineering-work/adapter.mjs';
// Read and execute only the Worker's pure declaration/mapping functions. Importing
// the whole module would pull in the optional installed MCP SDK (not needed here).
const workerSource=fs.readFileSync(path.join(runtimeDir,'worker','rulith-worker.mjs'),'utf8').replaceAll('\r\n','\n');
function pureWorkerFunction(name) {
  const start=workerSource.indexOf(`function ${name}(`); assert.ok(start>=0,name);
  const end=workerSource.indexOf('\n}',start); assert.ok(end>=0,name);
  return workerSource.slice(start,end+2);
}
const constant=name=>workerSource.match(new RegExp(`const ${name} = (.*)`))[0];
const {assertParamTable,assertReturnRows,resultFactsFromRows}=new Function(
  [constant('PARAM_TYPE_TOKENS'),constant('PARAM_NAME_PATTERN'),constant('RETURN_PREDICATE'),constant('MAX_RETURN_ROWS'),pureWorkerFunction('assertParamTable'),pureWorkerFunction('assertReturnRow'),pureWorkerFunction('assertReturnRows'),pureWorkerFunction('resultFactsFromRows'),'return {assertParamTable,assertReturnRows,resultFactsFromRows}'].join('\n')
)();

const workspace = fileURLToPath(new URL('../../',import.meta.url));
const scratch = path.join(workspace,'.scratch'); fs.mkdirSync(scratch,{recursive:true});
async function treeKillAvailable(t) {
  if (process.platform !== 'win32') return true;
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
  try { await killTree(child.pid); return true; }
  catch { try { child.kill(); } catch {} t.skip('Windows sandbox denies taskkill /T /F; real tree kill cannot be exercised'); return false; }
}
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(scratch,'eng-test-')); const root=path.join(dir,'root'); const home=path.join(dir,'pins');
  fs.mkdirSync(root); fs.mkdirSync(path.join(home,'specs'),{recursive:true});
  fs.writeFileSync(path.join(home,'specs','test.json'),JSON.stringify({command:['node','test.mjs'],output_dirs:['build','out']}));
  fs.writeFileSync(path.join(root,'test.mjs'),'process.exit(0)');
  const env={...process.env,RULITH_SOURCE_TYPE:'file',RULITH_SOURCE_ACCESS:root,ENG_KIT_HOME:home}; const ctx=context(env);
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return {dir,root,home,env,ctx,call:(tool,args)=>perform(tool,args,env)};
}
test('requires governed file Source and owner pin directory outside it',t=>{
  const f=fixture(t); assert.throws(()=>context({...f.env,RULITH_SOURCE_TYPE:'http'}),/Source required/);
  assert.throws(()=>context({...f.env,ENG_KIT_HOME:f.root}),/pin directory refused/);
  assert.throws(()=>context({...f.env,RULITH_SOURCE_ACCESS:'.'}),/Source required/);
});
test('real paths and absent descendants cannot escape through traversal or links',t=>{
  const f=fixture(t); const outside=path.join(f.dir,'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside,path.join(f.root,'escape'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>fenced(f.ctx.root,'../outside'),/path refused/);
  assert.throws(()=>fenced(f.ctx.root,'escape/new/file.txt'),/path refused/);
  assert.throws(()=>tree(f.ctx),/path refused/);
  assert.equal(fenced(f.ctx.root,'new.txt'),path.join(f.root,'new.txt'));
});
test('command classifier refuses destructive and outside-root commands',t=>{
  const f=fixture(t);
  for(const command of [['rm','a'],['cmd','/c','del a'],['git','push'],['npm','install','-g','thing'],['Stop-Service','thing'],['net','stop','thing'],['sc','stop','thing'],['node','--eval','1'],['git','config','--global','x','y'],['node','a.mjs','--out='+f.home],['node','a.mjs','../pins/file'],['echo','x;rm'],[process.execPath,'x']]) assert.throws(()=>classify(f.ctx,command),/refused/);
  assert.equal(classify(f.ctx,['node','test.mjs']).cwd,f.root);
  assert.throws(()=>classify(f.ctx,['node','test.mjs'],'../pins'),/path refused/);
});
test('write and literal patch confirm read-back and enforce digest and byte limit',async t=>{
  const f=fixture(t);
  const a=await f.call('write_file',{path:'a.txt',text:'hello',expect_digest:sha('')});
  assert.equal(a.rows[0].readback_digest,sha(fs.readFileSync(path.join(f.root,'a.txt'))));
  assert.equal(a.rows[0].from_gen,0); assert.equal(a.rows[0].to_gen,1);
  const b=await f.call('patch_file',{path:'a.txt',old_text:'hello',text:'world',expect_digest:sha('hello')}); assert.equal(b.rows[0].digest,sha('world'));
  await assert.rejects(f.call('write_file',{path:'a.txt',text:'x',expect_digest:sha('wrong')}),/digest changed/);
  await assert.rejects(f.call('write_file',{path:'b',text:'汉'.repeat(6000),expect_digest:sha('')}),/16 KiB/);
  await assert.rejects(f.call('patch_file',{path:'a.txt',old_text:'absent',text:'x',expect_digest:sha('world')}),/match once/);
});
test('tree digest is deterministic, skips pinned output dirs, and never calls git',t=>{
  const f=fixture(t); const first=tree(f.ctx).digest;
  fs.mkdirSync(path.join(f.root,'build')); fs.writeFileSync(path.join(f.root,'build','a'),'output');
  fs.mkdirSync(path.join(f.root,'.git')); fs.writeFileSync(path.join(f.root,'.git','config'),'arbitrary hooks');
  assert.equal(tree(f.ctx).digest,first);
  fs.writeFileSync(path.join(f.root,'b'),'b'); fs.writeFileSync(path.join(f.root,'a'),'a'); const second=tree(f.ctx).digest;
  fs.unlinkSync(path.join(f.root,'a')); fs.writeFileSync(path.join(f.root,'a'),'a'); assert.equal(tree(f.ctx).digest,second);
  const walker=fs.readFileSync(new URL('../../engineering-work/lib.mjs',import.meta.url),'utf8'); assert.doesNotMatch(walker,/spawn\(['"]git|execFile\(['"]git/);
});
test('generation tracks actual changes; passing test is invalidated and its edge replayed',async t=>{
  const f=fixture(t); const pass=await f.call('test',{}); assert.equal(pass.rows[0].gen,0); assert.equal(pass.rows[0].from_gen,-1);
  const edit=await f.call('write_file',{path:'a',text:'a',expect_digest:sha('')}); assert.equal(edit.rows[0].from_gen,0);
  const read=await f.call('read',{path:'a'}); assert.ok(read.rows.some(r=>r.from_gen===pass.rows[0].gen));
  const next=await f.call('test',{}); assert.equal(next.rows[0].gen,1); assert.ok(next.rows.every(r=>r.from_gen!==1));
  const same=await f.call('write_file',{path:'a',text:'a',expect_digest:sha('a')}); assert.ok(same.rows.every(r=>r.from_gen!==1));
  assert.equal((await f.call('tree_state',{})).rows[0].gen,1);
  await assert.rejects(f.call('test',{command:['echo','fake']}),/no arguments/);
});
test('a changing test stamps its final generation, a free run cannot emit test_result',async t=>{
  const f=fixture(t); fs.writeFileSync(path.join(f.root,'test.mjs'),"import fs from 'node:fs'; fs.writeFileSync('test-output.txt','yes')");
  const pass=await f.call('test',{}); assert.equal(pass.rows[0].gen,1); assert.equal(pass.rows[0].tree_digest,tree(f.ctx).digest); assert.ok(pass.rows.every(r=>r.from_gen!==1));
  const run=await f.call('run',{command:['node','test.mjs'],cwd:'.'}); assert.equal(run.rows[0].exit_code,0); assert.equal(run.rows[0].gen,undefined); assert.equal(run.rows[0].value_milli,undefined);
});
test('read, list and literal search produce observations with bounded text',async t=>{
  const f=fixture(t); fs.writeFileSync(path.join(f.root,'a.txt'),'needle\n'+'x'.repeat(10000));
  const read=await f.call('read',{path:'a.txt'}); assert.ok(Buffer.byteLength(read.head)<=1024); assert.ok(Buffer.byteLength(read.tail)<=1024);
  assert.ok((await f.call('list',{path:'.'})).rows.some(r=>r.path==='a.txt'));
  assert.equal((await f.call('search',{path:'.',query:'needle'})).rows[0].line,1);
  assert.equal((await f.call('read',{path:'a.txt',offset:2000})).rows[0].offset,2000);
  await assert.rejects(f.call('read',{path:'a.txt',offset:-1}),/offset refused/);
});
test('pinned measurements map integer milli-values, units, repeats and digests',async t=>{
  const f=fixture(t); fs.mkdirSync(path.join(f.root,'build'));
  const filename=process.platform==='win32'?'node.exe':'node'; const binary=path.join(f.root,'build',filename);
  fs.copyFileSync(process.execPath,binary); fs.chmodSync(binary,0o755);
  fs.writeFileSync(path.join(f.root,'measure.mjs'),'console.log(JSON.stringify({value_milli:1200}))');
  fs.writeFileSync(path.join(f.root,'config'),'pinned');fs.writeFileSync(path.join(f.root,'build','candidate'),'candidate');
  const spec={command:[`./build/${filename}`,'measure.mjs'],binary:`build/${filename}`,candidate_binary:'build/candidate',workload:'measure.mjs',config:'config',binary_digest:fileDigest(binary),workload_digest:fileDigest(path.join(f.root,'measure.mjs')),config_digest:sha('pinned'),parser:{kind:'json_integer_milli',field:'value_milli'},unit:'ms',repeats:2,output_dirs:['build']};
  fs.writeFileSync(path.join(f.home,'specs','measure.json'),JSON.stringify(spec));
  const result=await f.call('measure_pinned',{spec_id:'measure'});assert.deepEqual(result.rows.map(r=>r.value_milli),[1200,1200]);assert.deepEqual(result.rows.map(r=>r.repeat),[1,2]);assert.ok(result.rows.every(r=>r.binary_digest===spec.binary_digest&&r.unit==='ms'&&r.candidate_digest===sha('candidate')));
  const tool=JSON.parse(fs.readFileSync(new URL('../../engineering-work/worker-tools.json',import.meta.url))).tools['eng.measure_pinned@1'];assert.equal(resultFactsFromRows(tool,result.rows).filter(f=>f.predicate==='eng.measurement').length,2);
});
test('run records output hashes and changes but printed numbers remain text',async t=>{
  const f=fixture(t); fs.writeFileSync(path.join(f.root,'run.mjs'),"import fs from 'node:fs'; fs.writeFileSync('changed','x'); console.log('value_milli=9000'); console.error('err')");
  const run=await f.call('run',{command:['node','run.mjs'],cwd:'.'});
  assert.equal(run.rows[0].stdout_digest,sha('value_milli=9000\n')); assert.match(run.head,/9000/); assert.equal(run.rows[0].value_milli,undefined); assert.match(run.rows[0].changed_files,/changed/); assert.equal(run.rows[0].to_gen,1);
});
test('deadline kills child and grandchild process tree',async t=>{
  if (!await treeKillAvailable(t)) return;
  const f=fixture(t);
  fs.writeFileSync(path.join(f.root,'grandchild.mjs'),"import fs from 'node:fs'; fs.writeFileSync('grandchild.pid',String(process.pid)); setInterval(()=>fs.appendFileSync('heart','x'),50)");
  fs.writeFileSync(path.join(f.root,'child.mjs'),"import {spawn} from 'node:child_process'; spawn(process.execPath,['grandchild.mjs'],{stdio:'inherit'}); setInterval(()=>{},1000)");
  fs.writeFileSync(path.join(f.root,'parent.mjs'),"import {spawn} from 'node:child_process'; spawn(process.execPath,['child.mjs'],{stdio:'inherit'}); setInterval(()=>{},1000)");
  const r=await execute(['node','parent.mjs'],f.root,{deadlineMs:1200}); assert.equal(r.timed_out,true); assert.ok(r.duration_ms<8000);
  const bytes=fs.statSync(path.join(f.root,'heart')).size; await sleep(300); assert.equal(fs.statSync(path.join(f.root,'heart')).size,bytes);
});
test('job survives adapter exit, blocks other tools, then poll and stop kill descendants',async t=>{
  if (!await treeKillAvailable(t)) return;
  const f=fixture(t);
  fs.writeFileSync(path.join(f.root,'job-child.mjs'),"import fs from 'node:fs'; setInterval(()=>fs.appendFileSync('job-heart','x'),50)");
  fs.writeFileSync(path.join(f.root,'job.mjs'),"import {spawn} from 'node:child_process'; spawn(process.execPath,['job-child.mjs'],{stdio:'inherit'}); setInterval(()=>{},1000)");
  const adapter=fileURLToPath(new URL('../../engineering-work/job_start.mjs',import.meta.url));
  const receipt=JSON.parse(execFileSync(process.execPath,[adapter,JSON.stringify({command:['node','job.mjs'],cwd:'.'})],{env:f.env,encoding:'utf8'}));
  const id=receipt.rows[0].job_id;
  t.after(async()=>{ try { await f.call('job_stop',{job_id:id}); } catch {} });
  // 监督进程与两层 node 的启动在负载下要几百毫秒到数秒：等到心跳文件出现为止（上限 15 秒），不按固定时长猜。
  for(let i=0;i<300&&!fs.existsSync(path.join(f.root,'job-heart'));i++) await sleep(50);
  assert.ok(fs.statSync(path.join(f.root,'job-heart')).size>0);
  for(const name of ['list','read','search','tree_state','write_file','run','test','measure_pinned','job_start']) await assert.rejects(f.call(name,{}),/job live/);
  const poll=await f.call('job_poll',{job_id:id,wait_s:0}); assert.equal(poll.rows[0].status,'running');
  const stop=await f.call('job_stop',{job_id:id}); assert.equal(stop.rows[0].status,'stopped');
  const bytes=fs.statSync(path.join(f.root,'job-heart')).size; await sleep(200); assert.equal(fs.statSync(path.join(f.root,'job-heart')).size,bytes);
});
test('measurement refuses a changed binary digest before execution',async t=>{
  const f=fixture(t); const binary=path.join(f.root,'measure.exe'); fs.writeFileSync(binary,'changed');
  fs.writeFileSync(path.join(f.root,'candidate'),'candidate'); fs.writeFileSync(path.join(f.root,'workload'),'workload'); fs.writeFileSync(path.join(f.root,'config'),'config');
  const spec={command:['./measure.exe'],binary:'measure.exe',candidate_binary:'candidate',workload:'workload',config:'config',binary_digest:sha('original'),workload_digest:sha('workload'),config_digest:sha('config'),parser:{kind:'json_integer_milli',field:'value_milli'},unit:'ms',repeats:2,output_dirs:[]};
  fs.writeFileSync(path.join(f.home,'specs','measure.json'),JSON.stringify(spec));
  await assert.rejects(f.call('measure_pinned',{spec_id:'measure'}),/binary digest changed/);
  fs.writeFileSync(path.join(f.home,'specs','measure.json'),JSON.stringify({...spec,command:['node','test.mjs']})); await assert.rejects(f.call('measure_pinned',{spec_id:'measure'}),/spec refused|ENOENT/);
});
test('manifest matches Worker scalar mapping',t=>{
  const manifest=JSON.parse(fs.readFileSync(new URL('../../engineering-work/worker-tools.json',import.meta.url)));
  assert.equal(Object.keys(manifest.tools).length,12);
  for(const [id,tool]of Object.entries(manifest.tools)){assert.match(id,/@[1-9][0-9]*$/);assertParamTable(tool.params,id);assertReturnRows(tool.returns,id);}
  for(const [id,tool]of Object.entries(manifest.tools)) { assert.equal(tool.adapter,'run'); assert.deepEqual(tool.sourceTypes,['file']); assert.ok(tool.returns.length<=32); assert.ok(tool.returns.every(r=>Object.keys(r.args).length<=32)); assert.ok(fs.existsSync(path.join(workspace,'engineering-work',`${id.slice(4,-2)}.mjs`))); }
});
test('real Worker maps changing and no-change receipts without fabricating numeric facts',async t=>{
  const f=fixture(t); const manifest=JSON.parse(fs.readFileSync(new URL('../../engineering-work/worker-tools.json',import.meta.url)));
  for(const [tool,args]of [['tree_state',{}],['write_file',{path:'a',text:'abc',expect_digest:sha('')}],['read',{path:'a'}],['search',{path:'.',query:'abc'}],['list',{path:'.'}],['run',{command:['node','test.mjs'],cwd:'.'}],['test',{}]]) {
    const result=await f.call(tool,args); const facts=resultFactsFromRows(manifest.tools[`eng.${tool}@1`],result.rows);
    assert.equal(facts.length,result.rows.length*2);
    assert.ok(facts.every(f=>f.predicate!=='eng.measurement'));
  }
});
test('finite detached job survives its adapter, then finishes through poll',async t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.root,'job.mjs'),"import fs from 'node:fs'; setTimeout(()=>{fs.writeFileSync('job-output','done');},500)");
  const adapter=fileURLToPath(new URL('../../engineering-work/job_start.mjs',import.meta.url));
  const receipt=JSON.parse(execFileSync(process.execPath,[adapter,JSON.stringify({command:['node','job.mjs'],cwd:'.'})],{env:f.env,encoding:'utf8'}));
  const id=receipt.rows[0].job_id;
  await assert.rejects(f.call('tree_state',{}),/job live/);
  const done=await f.call('job_poll',{job_id:id,wait_s:2}); assert.equal(done.rows[0].status,'done'); assert.equal(done.rows[0].exit_code,0); assert.equal(fs.readFileSync(path.join(f.root,'job-output'),'utf8'),'done');
  const facts=resultFactsFromRows(JSON.parse(fs.readFileSync(new URL('../../engineering-work/worker-tools.json',import.meta.url))).tools['eng.job_poll@1'],done.rows);assert.ok(facts.some(f=>f.predicate==='eng.tree_step'&&f.args.from_gen===0));
});
test('a command line string is split into argv without a shell',async t=>{
  const f=fixture(t);
  const ok=await f.call('run',{command:'node test.mjs',cwd:'.'}); assert.ok(ok.rows.length>0);
  for (const bad of ['node test.mjs | more','node test.mjs && echo x','node "unclosed','node $(whoami)','node test.mjs > out.txt']) await assert.rejects(f.call('run',{command:bad,cwd:'.'}),/command refused/);
});
test('owner settings relax the classifier: outside paths, installs, deletes and the shell', async t => {
  const f = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'model.txt'), 'weights');
  fs.writeFileSync(path.join(f.root, 'cat.mjs'), "import fs from 'node:fs'; console.log(fs.readFileSync(process.argv[2], 'utf8'))");
  const settingsFile = path.join(f.home, 'settings.json');
  await assert.rejects(f.call('run', { command: `node cat.mjs ${path.join(outside, 'model.txt')}`, cwd: '.' }), /path refused/);
  await assert.rejects(f.call('run', { command: 'npm install left-pad', cwd: '.' }), /command refused/);
  await assert.rejects(f.call('run', { command: 'node cat.mjs cat.mjs | more', cwd: '.' }), /command refused/);
  fs.writeFileSync(settingsFile, JSON.stringify({ allowedPaths: [outside], allow: ['install'], shell: true }));
  const read = await f.call('run', { command: `node cat.mjs "${path.join(outside, 'model.txt')}"`, cwd: '.' });
  assert.equal(read.rows[0].exit_code, 0, 'outside read: ' + JSON.stringify(read).slice(0, 400));
  const redirected = await f.call('run', { command: 'node cat.mjs cat.mjs > copy.txt', cwd: '.' });
  assert.equal(redirected.rows[0].exit_code, 0, 'redirect: ' + JSON.stringify(redirected).slice(0, 400));
  assert.match(fs.readFileSync(path.join(f.root, 'copy.txt'), 'utf8'), /readFileSync/);
  for (const always of ['git push origin main', 'npm install -g left-pad', 'taskkill /IM node.exe', 'node -e 1'])
    await assert.rejects(f.call('run', { command: always, cwd: '.' }), /command refused/);
  fs.writeFileSync(settingsFile, JSON.stringify({ allow: ['everything'] }));
  await assert.rejects(f.call('run', { command: 'node cat.mjs cat.mjs', cwd: '.' }), /settings refused/);
});
