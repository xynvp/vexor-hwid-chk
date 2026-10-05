// Real release executable -> HTTPS production Worker -> production D1 validation.
// Reads credentials from the protected local profile; never outputs passwords/tokens/identifiers.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const credentials = JSON.parse(readFileSync(join(process.env.LOCALAPPDATA,'vexor','staff-credentials.json'),'utf8'));
const endpoint = JSON.parse(readFileSync('production.json','utf8')).endpoint;
const clients = [], children = [], started = new Set(), timeout = ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,deadline=25000) { const start=Date.now(); let error; while(Date.now()-start<deadline) { try { const r=await fn(); if(r) return r; } catch(e) { error=e; } await timeout(250); } throw new Error(`Timed out: ${label}${error ? ' '+error.message : ''}`); }
async function wd(base,path,method='GET',body) { const r=await fetch(base+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)}); const data=await r.json(); if(!r.ok || data.value?.error) throw new Error(data.value?.message || 'WebDriver failed'); return data.value; }
const execute=(c,script,args=[])=>wd(c.base,`/session/${c.id}/execute/sync`,'POST',{script,args});
async function open(name,port) {
 if(!started.has(port)) { children.push(spawn(join(homedir(),'.cargo/bin/tauri-driver.exe'),['--port',String(port),'--native-port',String(port+1),'--native-driver',resolve('.tools/edgedriver/msedgedriver.exe')],{windowsHide:true,stdio:'ignore'})); started.add(port); }
 const base=`http://127.0.0.1:${port}`; await until(()=>wd(base,'/status'),'driver ready');
 const s=await wd(base,'/session','POST',{capabilities:{alwaysMatch:{'tauri:options':{application:resolve(`dist/${name}.exe`)}}}}); const c={base,id:s.sessionId}; clients.push(c);
 await until(()=>execute(c,`return Boolean(document.querySelector('#start, #login'))`),'release UI ready'); return c;
}
async function element(c,sel) { const v=await wd(c.base,`/session/${c.id}/element`,'POST',{using:'css selector',value:sel}); return v['element-6066-11e4-a52e-4f735466cecf']; }
async function fill(c,sel,value) { const id=await element(c,sel); await wd(c.base,`/session/${c.id}/element/${id}/clear`,'POST',{}); await wd(c.base,`/session/${c.id}/element/${id}/value`,'POST',{text:value}); }
async function click(c,sel) { const id=await element(c,sel); await wd(c.base,`/session/${c.id}/element/${id}/click`,'POST',{}); }
async function shot(c,name) { await timeout(220); writeFileSync(`test-data/production-${name}.png`,Buffer.from(await wd(c.base,`/session/${c.id}/screenshot`),'base64')); }
async function close(c) { await wd(c.base,`/session/${c.id}`,'DELETE'); clients.splice(clients.indexOf(c),1); }
async function native(c,command,payload={}) { return wd(c.base,`/session/${c.id}/execute/async`,'POST',{script:`const done=arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(v=>done({ok:true,value:v})).catch(e=>done({ok:false,failure:e}));`,args:[command,payload]}); }
async function admin_api(c,method,path,payload) { const r=await native(c,'admin_request',{method,path,payload}); assert.equal(r.ok,true,`Production API ${path}`); return r.value; }
async function layout(c,label) {
 const r=await execute(c,`const app=document.querySelector('#app');return {width:innerWidth,height:innerHeight,horizontal:document.documentElement.scrollWidth>innerWidth || app.scrollWidth>app.clientWidth,vertical:app.scrollHeight>app.clientHeight,font:getComputedStyle(document.querySelector('button')).fontFamily,background:getComputedStyle(document.body).backgroundColor};`);
 assert.equal(r.horizontal,false,label+' horizontal overflow'); console.log(label+' layout: '+JSON.stringify(r)); return r;
}
try {
 mkdirSync('test-data',{recursive:true});
 const health=await fetch(endpoint+'/health'); assert.equal(health.status,200); assert.equal((await health.json()).status,'ok');
 const denied=await fetch(endpoint+'/api/admin/sessions'); assert.equal(denied.status,401);
 const admin=await open('hwid-admin',4444); const info=await native(admin,'app_info'); assert.equal(info.value.endpoint,endpoint); assert.equal(info.value.development,false);
 assert.equal(await execute(admin,`return Boolean(document.querySelector('#server'))`),false);
 await shot(admin,'login'); await layout(admin,'Admin login');
 await fill(admin,'#username',credentials.username); await fill(admin,'#password',credentials.password); await click(admin,'#login button');
 await until(()=>execute(admin,`return Boolean(document.querySelector('#new'))`),'production sign in');
 await shot(admin,'sessions');
 // The same release UI must support maximize/restore, clipboard and no horizontal overflow.
 await click(admin,'#window-maximize'); await until(()=>execute(admin,`return document.querySelector('#window-maximize').getAttribute('aria-label')==='Restore'`),'admin maximized'); await layout(admin,'Admin maximized'); await shot(admin,'maximized');
 await click(admin,'#window-maximize'); await until(()=>execute(admin,`return document.querySelector('#window-maximize').getAttribute('aria-label')==='Maximize'`),'admin restored');
 const outcomes=[];
 for(const match of [true,false]) {
  await click(admin,'#new'); for(const [name,value] of Object.entries({vexor_username:'production-check',vexor_uid:'25404',license_key:'VXP-0000-1111-2222-3333-4444-5555-6666-7777-8888-F8B3',old_hwid_preview:'a18c88219d41ab…44a921',note:'Production release validation — '+(match?'match':'mismatch')})) await fill(admin,'#'+name,value);
  await click(admin,'#create button'); await until(()=>execute(admin,`return Boolean(document.querySelector('.detail-title'))`),'production session created');
  const code=await execute(admin,`return document.querySelector('.detail-title h1').textContent`);
  await click(admin,'.detail-title [data-copy]'); await until(()=>execute(admin,`return Boolean(document.querySelector('.toast'))`),'copy feedback');
  const checker=await open('hwid-chk',4446); const checker_info=await native(checker,'app_info'); assert.equal(checker_info.value.endpoint,endpoint); assert.equal(checker_info.value.development,false);
  await shot(checker,'checker-initial'); await layout(checker,'Checker initial');
  await fill(checker,'#code',code); await click(checker,'#start button'); await until(()=>execute(checker,`return document.body.textContent.includes('Connected')`),'production checker connected');
  await until(()=>execute(admin,`return Boolean(document.querySelector('#reset') && !document.querySelector('#reset').disabled)`),'production admin sees checker online');
  let sessions=(await admin_api(admin,'GET','/api/admin/sessions')).sessions, s=sessions.find(s=>s.code===code); assert.ok(s.online); assert.match(s.current_hwid,/^[a-f0-9]{64}$/);
  await shot(checker,'checker-active'); const checker_layout=await layout(checker,'Checker connected'); assert.equal(checker_layout.vertical,false,'Checker must fit fixed window without scrollbar');
  await click(admin,'#reset'); await shot(admin,'reset-sheet'); await click(admin,'dialog #yes'); await until(()=>execute(admin,`return Boolean(document.querySelector('#claimed'))`),'production reset marked');
  const reset=(await admin_api(admin,'GET',`/api/admin/sessions/${s.id}`)).session; assert.equal(reset.status,'reset_marked'); assert.equal(reset.expected_hwid,reset.current_hwid);
  await until(async()=>{ const current=(await admin_api(admin,'GET',`/api/admin/sessions/${s.id}`)).session; return current.last_seen_at>reset.last_seen_at && current.online; },'heartbeat after reset');
  await fill(admin,'#claimed',match?reset.expected_hwid_preview:'71a2b419fa821a…91cc22'); await click(admin,'#claim button');
  await until(()=>execute(admin,`return Boolean(document.querySelector('.result'))`),'production comparison result');
  await until(()=>execute(checker,`return document.body.textContent.includes('${match?'Verification completed':'Verification failed'}')`),'checker receives production final result');
  const result=await admin_api(admin,'GET',`/api/admin/sessions/${s.id}`); assert.equal(result.session.status,match?'completed':'mismatch');
  for(const event of ['session_created','checker_connected','reset_marked',match?'claim_verified':'claim_mismatch','session_completed']) assert.ok(result.events.some(e=>e.event_type===event),'Audit event '+event);
  assert.equal(result.session.checker_token_hash,undefined); await shot(admin,match?'verified':'mismatch'); await shot(checker,match?'checker-completed':'checker-failed');
  outcomes.push({session_id:s.id,status:result.session.status,heartbeat_after_reset:true,audit_events:result.events.length});
  await close(checker); await click(admin,'#back'); await until(()=>execute(admin,`return Boolean(document.querySelector('#new'))`),'sessions returned');
  console.log('Production release workflow passed: '+(match?'MATCH':'MISMATCH'));
 }
 await click(admin,'#nav-history'); await until(()=>execute(admin,`return document.body.textContent.includes('Verification History') && document.querySelectorAll('.session-row').length>=2`),'history view'); await shot(admin,'history');
 await click(admin,'#nav-settings'); await shot(admin,'settings');
 await click(admin,'#logout'); await until(()=>execute(admin,`return Boolean(document.querySelector('#login'))`),'production logout');
 const secretDenied=await native(admin,'checker_start'); assert.equal(secretDenied.ok,false);
 writeFileSync('test-data/production-result.json',JSON.stringify({timestamp:new Date().toISOString(),endpoint,release_executables:true,health:'passed',admin_authentication:'passed',checker_native_collection:true,match:'passed',mismatch:'passed',window_maximize_restore:'passed',horizontal_overflow:false,checker_vertical_overflow:false,history:'passed',logout:'passed',outcomes},null,2));
 console.log('Production E2E passed with final release executables.');
} finally { for(const c of [...clients]) { try { await close(c); } catch {} } for(const c of children) c.kill(); }
