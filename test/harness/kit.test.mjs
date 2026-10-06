import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RulithMcp, PROTOCOL, TOOLS, apply as applyBridge } from '../../harness/rulith-mcp.mjs';
import { restrictAgent, apply as applyGate, ADDENDUM } from '../../harness/rulith-gate.mjs';
import { parseArgs, dshArgv, Budget, CAPS, startRole } from '../../harness/rulith-dsh-role.mjs';
import { sleep } from '../../engineering-work/lib.mjs';

const scratch=fileURLToPath(new URL('../../.scratch/',import.meta.url)); fs.mkdirSync(scratch,{recursive:true});
const response=(result,id,status=200,extra={})=>new Response(status===202?null:JSON.stringify({jsonrpc:'2.0',id,result}),{status,headers:{'content-type':'application/json','mcp-session-id':'session',...extra}});
test('MCP pins protocol, serializes calls, strips host metadata, and never retries',async()=>{
  const calls=[]; let live=0; let max=0;
  const client=new RulithMcp({url:'https://example.invalid/mcp',token:'secret',fetchImpl:async(_url,options)=>{
    const body=JSON.parse(options.body); calls.push({body,headers:options.headers}); live++; max=Math.max(max,live); await sleep(10); live--;
    if(body.method==='initialize')return response({protocolVersion:PROTOCOL,_meta:{'rulith/v2':{agentId:'agent'}}},body.id);
    if(body.method==='notifications/initialized')return response(undefined,undefined,202);
    return response({content:[{type:'text',text:'authority'}],_meta:{'rulith/v2':{agentId:'agent'}}},body.id);
  }});
  assert.equal(await client.initialize(),'agent');
  const results=await Promise.all([client.call('QueryBoard',{}),client.call('OpenCase',{})]);
  assert.equal(max,1); assert.equal(calls[0].body.params.protocolVersion,PROTOCOL);
  assert.equal(calls[2].headers['mcp-protocol-version'],PROTOCOL); assert.equal(calls[2].headers['mcp-session-id'],'session');
  assert.ok(results.every(r=>r._meta===undefined));
  await assert.rejects(client.call('shell',{}),/tool refused/); assert.equal(calls.length,4);
});
test('connection_replaced permanently closes MCP, including queued calls',async()=>{
  let count=0;
  const client=new RulithMcp({url:'https://example.invalid/mcp',token:'do-not-log',fetchImpl:async()=>{count++;return new Response('{"reason":"connection_replaced"}',{status:409});}});
  await assert.rejects(client.initialize(),/^Error: connection_replaced$/);
  await assert.rejects(client.call('QueryBoard',{}),/closed/); assert.equal(count,1);
});
test('protocol mismatch fails closed without downgrade',async()=>{
  let count=0;
  const client=new RulithMcp({url:'https://example.invalid/mcp',token:'secret',fetchImpl:async(_url,opt)=>{count++;return response({protocolVersion:'2026-07-28',_meta:{'rulith/v2':{agentId:'agent'}}},JSON.parse(opt.body).id);}});
  await assert.rejects(client.initialize(),/handshake refused/); assert.equal(count,1);
});
test('HTTP SSE matching response preserves operations and consumes notifications',async()=>{
  const client=new RulithMcp({url:'https://example.invalid/mcp',token:'secret',fetchImpl:async(_url,opt)=>{
    const req=JSON.parse(opt.body);
    return new Response('event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',method:'notifications/progress',params:{}})+'\n\n'+'event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',id:req.id,result:{content:[],operations:[{state:'running'}]}})+'\n\n',{headers:{'content-type':'text/event-stream'}});
  }});
  const result=await client.call('QueryBoard',{}); assert.deepEqual(result.operations,[{state:'running'}]);
});
test('gate restricts inherited globals through agent context before work',async()=>{
  const calls=[]; const scoped={tools:{restrict:filter=>{calls.push(filter);return ()=>{};}}};
  restrictAgent({ctx:scoped}); assert.deepEqual(calls[0].allow,[...TOOLS]);
  const dir=fs.mkdtempSync(path.join(scratch,'persona-')); const persona=path.join(dir,'persona.txt'); fs.writeFileSync(persona,'approved');
  const previous=process.env.RULITH_DSH_PERSONA; process.env.RULITH_DSH_PERSONA=persona;
  let handler; let section;
  try { await applyGate({systemPrompt:{section:value=>{section=value;}},on:(type,cb)=>{assert.equal(type,'agent/created');handler=cb;},provide:(key,value)=>{assert.equal(key,'rulithGate');assert.equal(value,true);}}); handler({agent:{ctx:scoped}}); assert.equal(section.complete,true); assert.equal(section.interpolate,false); assert.equal(section.text,`approved\n\n${ADDENDUM}`); }
  finally { if(previous===undefined)delete process.env.RULITH_DSH_PERSONA;else process.env.RULITH_DSH_PERSONA=previous; fs.rmSync(dir,{recursive:true,force:true}); }
});
test('IPC plugin publishes exactly six global tools with proper dsh schemas and renderer',async()=>{
  const previousProxy=process.env.RULITH_DSH_PROXY; const previousSend=process.send;
  process.env.RULITH_DSH_PROXY='ipc';
  const definitions=[];const effects=[];let published;
  process.send=message=>{
    const result=message.method==='identity'?'agent':message.method==='list'?{tools:TOOLS.map(name=>({name,description:'authority',inputSchema:{type:'object'}}))}:{content:[{type:'text',text:'authority result'}]};
    queueMicrotask(()=>process.emit('message',{protocol:'rulith-dsh-rpc',id:message.id,result}));
  };
  try {
    await applyBridge({effect:effect=>effects.push(effect()),tools:{register:definition=>{definitions.push(definition);return()=>{};}},provide:(key,value)=>{assert.equal(key,'rulithBridge');published=value;}});
    assert.deepEqual(definitions.map(d=>d.name),[...TOOLS]);assert.ok(definitions.every(d=>d.parameters.type==='object'&&d.input===undefined));
    const result=await definitions[0].execute({});assert.equal(result.content[0].text,'authority result');assert.equal(definitions[0].output.render({},result)[0].text,JSON.stringify(result));
    assert.ok(published);
  } finally {
    for(const dispose of effects.reverse())dispose();process.send=previousSend;
    if(previousProxy===undefined)delete process.env.RULITH_DSH_PROXY;else process.env.RULITH_DSH_PROXY=previousProxy;
  }
});
test('wrapper removes appended serve and sends only headless argv',()=>{
  const absolute=fileURLToPath(new URL('../../',import.meta.url));
  const options=parseArgs(['--dsh-entry',path.join(absolute,'dsh.js'),'--dsh-home',path.join(absolute,'home'),'--cwd',path.join(absolute,'cwd'),'--persona',path.join(absolute,'persona'),'--task','--serve','--serve']);
  assert.equal(options.task,'--serve'); const argv=dshArgv(options,'--serve','sess');
  assert.ok(!argv.includes('--serve')); assert.ok(argv.includes('--json')); assert.deepEqual(argv.slice(-2),['--session-id','sess']);
  assert.throws(()=>parseArgs(['--web']),/refused/); assert.throws(()=>parseArgs(['--serve']),/paths required/);
});
test('wrapper cap boundaries, aggregate prompt tokens and unknown usage',()=>{
  assert.deepEqual(CAPS,{steps:150,wallMs:5400000,promptTokens:25000000});
  let now=0; const cap=new Budget({steps:2,wallMs:100,promptTokens:10},()=>now);
  assert.equal(cap.event({type:'status',phase:'step_start'}),null);
  assert.equal(cap.event({type:'status',phase:'step_end',usage:{inputTokens:4}}),null);
  assert.equal(cap.event({type:'status',phase:'step_start'}),null);
  assert.equal(cap.event({type:'status',phase:'step_end',usage:{inputTokens:6}}),'prompt token cap');
  now=100; assert.equal(cap.event({}),'wall time cap');
  const missing=new Budget(); assert.equal(missing.event({type:'status',phase:'step_end'}),'prompt usage missing');
  const steps=new Budget({steps:1,wallMs:10000,promptTokens:100}); steps.event({type:'status',phase:'step_start'}); assert.equal(steps.event({type:'status',phase:'step_end',usage:{inputTokens:1}}),'step cap');
  const cached=new Budget({steps:150,wallMs:10000,promptTokens:100});assert.equal(cached.event({type:'status',phase:'step_end',usage:{inputTokens:1,cacheReadTokens:99}}),'prompt token cap');
  const retries=new Budget({steps:150,wallMs:10000,promptTokens:100});assert.equal(retries.event({type:'status',phase:'step_end',usage:{inputTokens:1,outputTokens:5,totalTokens:105}}),'prompt token cap');
});
function fakeFixture(t,source) {
  const dir=fs.mkdtempSync(path.join(scratch,'dsh-test-')); const home=path.join(dir,'home'); const cwd=path.join(dir,'cwd'); fs.mkdirSync(home);fs.mkdirSync(cwd);
  const entry=path.join(dir,'fake-dsh.mjs');const persona=path.join(dir,'persona.txt');fs.writeFileSync(entry,source);fs.writeFileSync(persona,'approved');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return {dir,home,cwd,options:{'dsh-entry':entry,'dsh-home':home,cwd,persona},env:{...process.env,RULITH_SERVE_PORT:'0',RULITH_SERVE_KEY:'private-test-key',RULITH_MODEL:'test-model',RULITH_MODEL_URL:'http://127.0.0.1:9/v1'},client:{initialize:async()=> 'agent',list:async()=>({tools:TOOLS.map(name=>({name}))}),call:async()=>({}),close(){} }};
}
test('fake dsh receives isolated cwd/home, disabled telemetry, task stdin and resumed session',async t=>{
  const f=fakeFixture(t,"import fs from 'node:fs'; let task=''; for await(const b of process.stdin)task+=b; fs.writeFileSync('invocation.json',JSON.stringify({argv:process.argv.slice(2),task,cwd:process.cwd(),home:process.env.DSH_HOME,telemetry:process.env.DSH_TELEMETRY_MODE,token:process.env.RULITH_TOKEN})); console.log(JSON.stringify({type:'session',sessionId:'persisted'})); console.log(JSON.stringify({type:'status',phase:'step_start'})); console.log(JSON.stringify({type:'status',phase:'step_end',usage:{inputTokens:3}})); process.disconnect();");
  const trace=[]; const role=await startRole(f.options,{client:f.client,env:f.env,emit:(type,data)=>trace.push({type,...data})}); t.after(()=>role.stop());
  assert.equal(trace[0].agentId,'agent'); await role.run('task --serve','conversation'); await role.run('followup','conversation');
  const invocation=JSON.parse(fs.readFileSync(path.join(f.cwd,'invocation.json'))); assert.equal(invocation.task,'followup');assert.equal(invocation.home,f.home);assert.equal(invocation.cwd,f.cwd);assert.equal(invocation.telemetry,'DISABLED');assert.equal(invocation.token,undefined);assert.ok(invocation.argv.includes('--session-id'));assert.equal(role.sessions.get('conversation').budget.promptTokens,6);
  await role.stop();
});
test('fake dsh is killed at caps and the session cannot resume',async t=>{
  const f=fakeFixture(t,"for await(const b of process.stdin){} console.log(JSON.stringify({type:'status',phase:'step_start'})); console.log(JSON.stringify({type:'status',phase:'step_end',usage:{inputTokens:100}})); setInterval(()=>{},1000)");
  const role=await startRole(f.options,{client:f.client,env:f.env,caps:{steps:150,wallMs:5000,promptTokens:100},emit(){},terminate:async pid=>{try{process.kill(pid);}catch{}}}); t.after(()=>role.stop());
  await role.run('task','same'); await assert.rejects(role.run('followup','same'),/token cap/); await role.stop();
});
test('manager request IDs are deduplicated and caps persist across role restarts',async t=>{
  const f=fakeFixture(t,"for await(const b of process.stdin){} console.log(JSON.stringify({type:'session',sessionId:'saved'})); console.log(JSON.stringify({type:'status',phase:'step_start'})); console.log(JSON.stringify({type:'status',phase:'step_end',usage:{inputTokens:2}})); setTimeout(()=>process.disconnect(),50)");
  let role=await startRole(f.options,{client:f.client,env:f.env,emit(){}});t.after(()=>role.stop());
  const port=role.server.address().port;
  const send=body=>fetch(`http://127.0.0.1:${port}/task`,{method:'POST',headers:{'content-type':'application/json','x-rulith-serve':'private-test-key'},body:JSON.stringify(body)});
  const request={text:'manager task',sessionKey:'same',requestId:'test-request-id-1234'};
  const first=await send(request);assert.equal(first.status,202);const receipt=await first.json();
  const again=await send(request);assert.equal(again.status,202);assert.deepEqual(await again.json(),receipt);
  const changed=await send({...request,text:'different'});assert.equal(changed.status,409);
  for(let i=0;i<30&&!role.sessions.get('same')?.id;i++)await sleep(25);
  await sleep(150);await role.stop();
  role=await startRole(f.options,{client:f.client,env:f.env,emit(){}});assert.equal(role.sessions.get('same').id,'saved');assert.equal(role.sessions.get('same').budget.promptTokens,2);await role.stop();
});
test('IPC stop terminates active dsh and reload drains the current task',async t=>{
  const f=fakeFixture(t,"for await(const b of process.stdin){} setInterval(()=>{},1000)");
  const role=await startRole(f.options,{client:f.client,env:f.env,emit(){},terminate:async pid=>{try{process.kill(pid);}catch{}}}); t.after(()=>role.stop());
  const running=role.run('task'); await sleep(150); await role.control({protocol:'wrong',operation:'stop'});assert.equal(role.server.listening,true);
  await role.control({protocol:'rulith-local-control',operation:'reload'});assert.equal(role.server.listening,true);
  await role.control({protocol:'rulith-local-control',operation:'stop'}); await running; assert.equal(role.server.listening,false);
});
test('overlay disabled ids exist in pinned dsh base sources; runner depends on gate',{skip:!process.env.DSH_REFERENCE_DIR&&'set DSH_REFERENCE_DIR to a deepseek-harness checkout'},()=>{
  const source=process.env.DSH_REFERENCE_DIR;
  const base=fs.readFileSync(path.join(source,'packages/bundle/base/cordis.patch.yml'),'utf8');
  const overlay=fs.readFileSync(new URL('../../harness/rulith.cordis.yml',import.meta.url),'utf8');
  const ids=[...overlay.matchAll(/^- id: ([^\r\n]+)\r?\n  disabled: true/gm)].map(m=>m[1]); assert.ok(ids.length>50);
  for(const id of ids) assert.match(base,new RegExp(`^    - id: ${id}$`,'m'),id);
  assert.equal(new Set(ids).size,ids.length);assert.match(overlay,/inject: \[headlessStartup, rulithGate\]/);assert.match(overlay,/compression: none/);assert.match(overlay,/maxParallelToolCalls: 1/);
});
test('model-visible inventory contains every manifest id, primary predicate and fixed verdict',()=>{
  const inventory=fs.readFileSync(new URL('../../harness/model-visible.md',import.meta.url),'utf8');
  const manifest=JSON.parse(fs.readFileSync(new URL('../../engineering-work/worker-tools.json',import.meta.url)));
  for(const [id,tool]of Object.entries(manifest.tools)){assert.ok(inventory.includes(id));for(const mapping of tool.returns)assert.ok(inventory.includes(mapping.predicate));}
  const adapter=fs.readFileSync(new URL('../../engineering-work/adapter.mjs',import.meta.url),'utf8');
  const messages=adapter.match(/const messages = \[(.*?)\];/)[1];for(const m of messages.matchAll(/'([^']+)'/g))assert.ok(inventory.includes(m[1]),m[1]);
  assert.ok(inventory.includes(ADDENDUM));
});
