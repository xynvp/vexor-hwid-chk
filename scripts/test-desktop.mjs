// Drives the real Windows executables through Tauri's official WebDriver bridge.
// Uses real native Windows collection, Rust HTTP, the Worker and a real local D1.
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { randomBytes, randomUUID, pbkdf2Sync } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import assert from 'node:assert/strict';

const driver_binary = process.env.TAURI_DRIVER || join(homedir(),'.cargo','bin','tauri-driver.exe');
const native_driver = process.env.MSEDGEDRIVER || resolve('.tools/edgedriver/msedgedriver.exe');
if (!existsSync(driver_binary) || !existsSync(native_driver)) throw new Error('Install tauri-driver and set MSEDGEDRIVER to a matching Microsoft Edge driver. See readme.md.');
const directory = mkdtempSync(join(tmpdir(),'hwid-desktop-tests-'));
const release_smoke = process.argv.includes('--release-smoke');
const local_secret = randomBytes(32).toString('hex');
const license_key = 'VXP-0000-1111-2222-3333-4444-5555-6666-7777-8888-F8B3';
function backend_instance(port = 0) { return new Miniflare({ ...convertV4MiniflareOptions({ name:'hwid-desktop-test', host:'127.0.0.1', port, modules:true,
  scriptPath:resolve('worker/generated/worker.js'), compatibilityDate:'2026-08-01', d1Databases:{DB:'hwid-db'},
  bindings:{ ENVIRONMENT:'development', HWID_FINGERPRINT_SECRET:local_secret }
}),resourcePersistencePath:directory }); }
let mf = backend_instance();
const children = [], clients = [];
const started_drivers = new Set();
const timeout = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn, label, deadline = 20000) {
  const started=Date.now(); let last;
  while(Date.now()-started<deadline) { try { const value=await fn(); if(value) return value; } catch(error) { last=error; } await timeout(200); }
  throw new Error(`Timed out: ${label}${last ? ': '+last.message : ''}`);
}
async function webdriver(base,path,method='GET',body) {
  const response=await fetch(base+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  const data=await response.json();
  if(!response.ok || data.value?.error) throw new Error(data.value?.message || 'WebDriver request failed');
  return data.value;
}
async function open_app(name,port) {
  if (!started_drivers.has(port)) {
    const child=spawn(driver_binary,['--port',String(port),'--native-port',String(port+1),'--native-driver',native_driver],{windowsHide:true,stdio:'ignore'});
    children.push(child); started_drivers.add(port);
  }
  const base=`http://127.0.0.1:${port}`;
  await until(()=>webdriver(base,'/status'),'WebDriver ready');
  const application = release_smoke ? resolve(`dist/${name}.exe`) : resolve(`target/debug/${name}.exe`);
  const session=await webdriver(base,'/session','POST',{capabilities:{alwaysMatch:{'tauri:options':{application}}}});
  const client={base,id:session.sessionId}; clients.push(client);
  await until(()=>execute(client,`return Boolean(document.querySelector('#start, #login'))`),`${name} frontend ready`);
  await execute(client,`const d=document.querySelector('.dev-config'); if(d) d.open=true; return true;`);
  return client;
}
const execute=(client,script,args=[])=>webdriver(client.base,`/session/${client.id}/execute/sync`,'POST',{script,args});
async function element(client,selector) {
  const result=await webdriver(client.base,`/session/${client.id}/element`,'POST',{using:'css selector',value:selector});
  return result['element-6066-11e4-a52e-4f735466cecf'];
}
async function fill(client,selector,value) {
  if(selector === '#server') await execute(client,`const d=document.querySelector('.dev-config'); if(d) d.open=true; return true;`);
  const id=await element(client,selector);
  await webdriver(client.base,`/session/${client.id}/element/${id}/clear`,'POST',{});
  await webdriver(client.base,`/session/${client.id}/element/${id}/value`,'POST',{text:value});
}
async function click(client,selector) { const id=await element(client,selector); await webdriver(client.base,`/session/${client.id}/element/${id}/click`,'POST',{}); }
async function screenshot(client,name) { const data=await webdriver(client.base,`/session/${client.id}/screenshot`); writeFileSync(`test-data/${name}.png`,Buffer.from(data,'base64')); }
async function close(client) { await webdriver(client.base,`/session/${client.id}`,'DELETE'); clients.splice(clients.indexOf(client),1); }
try {
  if (release_smoke) {
    mkdirSync('test-data',{recursive:true});
    for (const [name,port] of [['hwid-chk',4444],['hwid-admin',4446]]) {
      const client = await open_app(name,port);
      await screenshot(client,`${name}-release`);
      const endpointRejected = await webdriver(client.base,`/session/${client.id}/execute/async`,'POST',{script: "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke('set_endpoint', {endpoint:'http://127.0.0.1:8787'}).then(() => done('unexpected')).catch(error => done(error.message));",args:[]});
      assert.match(endpointRejected,/HTTPS origin/,'Release rejects localhost HTTP');
      const command = name === 'hwid-chk' ? 'admin_request' : 'checker_start';
      const denied = await webdriver(client.base,`/session/${client.id}/execute/async`,'POST',{script:`const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke('${command}', {}).then(() => done('unexpected')).catch(error => done(String(error)));`,args:[]});
      assert.match(denied,/not found/i,'Each binary must register only its own commands');
      await close(client);
      console.log(`Release smoke passed: ${name} launches, enforces HTTPS and isolates commands.`);
    }
  } else {
  const backend=(await mf.ready).origin;
  let db=await mf.getD1Database('DB');
  for(const file of readdirSync('worker/migrations').filter(v=>v.endsWith('.sql')).sort()) {
    for(const sql of readFileSync(`worker/migrations/${file}`,'utf8').split(/;\s*(?:\r?\n|$)/).filter(v=>v.trim())) await db.prepare(sql+';').run();
  }
  const password=randomBytes(24).toString('hex'),salt=randomBytes(16).toString('hex');
  const hash=`pbkdf2-sha256$100000$${salt}$${pbkdf2Sync(password,salt,100000,32,'sha256').toString('hex')}`;
  await db.prepare('INSERT INTO admins (id,username,password_hash,created_at) VALUES (?,?,?,?)').bind(randomUUID(),'desktop-test',hash,Math.floor(Date.now()/1000)).run();
  const admin=await open_app('hwid-admin',4444);
  await fill(admin,'#server',backend); await fill(admin,'#username','desktop-test'); await fill(admin,'#password',password); await click(admin,'#login button');
  await until(()=>execute(admin,`return Boolean(document.querySelector('#new'))`),'admin authenticated');
  mkdirSync('test-data',{recursive:true});
  for(const match of [true,false]) {
    await click(admin,'#new');
    assert.equal(await execute(admin,`return document.querySelector('label[for="license_key"]').textContent`),'License key');
    await fill(admin,'#license_key','F8B3');
    assert.equal(await execute(admin,`return document.querySelector('#license_key').checkValidity()`),false,'Suffix-only input must be rejected');
    for(const [field,value] of Object.entries({vexor_username:'xynr',vexor_uid:'25404',license_key,old_hwid_preview:'a18c88219d41ab…44a921',note:'Automated desktop workflow'})) await fill(admin,`#${field}`,value);
    assert.equal(await execute(admin,`return document.querySelector('#license_key').checkValidity()`),true,'Full key must be accepted');
    await click(admin,'#create button');
    const s=await until(async()=> {
      const result=await db.prepare("SELECT * FROM verification_sessions WHERE status = 'active' AND first_connected_at IS NULL ORDER BY created_at DESC LIMIT 1").first();
      return result || false;
    },'session created');
    assert.equal(s.license_key,license_key,'D1 stores the complete key');
    await until(()=>execute(admin,`return Boolean(document.querySelector('#detail [data-copy="${license_key}"]'))`),'full license key copy control');
    assert.equal(await execute(admin,`return document.querySelector('#detail [data-copy="${license_key}"]').previousElementSibling.textContent`),license_key,'Detail displays the complete key');
    await click(admin,`#detail [data-copy="${license_key}"]`);
    await until(()=>execute(admin,`return document.querySelector('.toast')?.textContent === 'Copied to clipboard'`),'license key clipboard copy');
    // Read through Windows to avoid a browser clipboard-read permission prompt.
    const clipboard = execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-Clipboard -Raw'],{encoding:'utf8',windowsHide:true}).trim();
    assert.equal(clipboard,license_key,'Clipboard contains the complete key');
    assert.equal(await execute(admin,`const app=document.querySelector('#app'); return app.scrollWidth > app.clientWidth;`),false,'Full key detail has no horizontal overflow');
    if (match) await screenshot(admin,'admin-license-key');
    const checker=await open_app('hwid-chk',4446);
    await fill(checker,'#server',backend); await fill(checker,'#code',s.code); await click(checker,'#start button');
    await until(()=>execute(checker,`return document.body.textContent.includes('Connected')`),'checker connected');
    if (match) {
      await mf.dispose();
      await until(()=>execute(checker,`return document.body.textContent.includes('Reconnecting')`),'automatic reconnect state');
      await timeout(13000);
      mf = backend_instance(Number(new URL(backend).port));
      await mf.ready; db = await mf.getD1Database('DB');
      await until(()=>execute(checker,`return document.body.textContent.includes('Connected')`),'automatic reconnect success',40000);
      const reconnected = await db.prepare("SELECT id FROM verification_events WHERE session_id = ? AND event_type = 'checker_reconnected'").bind(s.id).first();
      assert.ok(reconnected, 'Reconnect must be audited after the backend restarts');
      console.log('Real desktop reconnect and backend persistence passed.');
    }
    await until(()=>execute(admin,`return Boolean(document.querySelector('#reset') && !document.querySelector('#reset').disabled)`),'live admin status');
    await click(admin,'#reset'); await click(admin,'dialog #yes');
    await until(()=>execute(admin,`return Boolean(document.querySelector('#claimed'))`),'reset marked');
    const reset=await db.prepare('SELECT * FROM verification_sessions WHERE id = ?').bind(s.id).first();
    assert.equal(reset.status,'reset_marked'); assert.match(reset.expected_hwid,/^[a-f0-9]{64}$/);
    assert.equal(reset.expected_hwid_preview,reset.current_hwid_preview);
    await until(async()=> {
      const current=await db.prepare('SELECT last_seen_at FROM verification_sessions WHERE id = ?').bind(s.id).first();
      return current.last_seen_at>reset.last_seen_at;
    },'native background heartbeat');
    if(match) { await screenshot(checker,'checker-active'); await screenshot(admin,'admin-reset'); }
    await fill(admin,'#claimed',match?reset.expected_hwid_preview:'71a2b419fa821a…91cc22'); await click(admin,'#claim button');
    await until(()=>execute(admin,`return document.body.textContent.includes('${match?'Verified':'HWID mismatch'}')`),'claim result');
    await until(()=>execute(checker,`return document.body.textContent.includes('${match?'Verification completed':'Verification failed'}')`),'checker final result');
    const final=await db.prepare('SELECT status FROM verification_sessions WHERE id = ?').bind(s.id).first();
    assert.equal(final.status,match?'completed':'mismatch');
    await screenshot(admin,match?'admin-verified':'admin-mismatch');
    await close(checker);
    await click(admin,'#back');
    await until(()=>execute(admin,`return Boolean(document.querySelector('#new'))`),'dashboard returned');
    await until(()=>execute(admin,`return Boolean(document.querySelector('.session-meta')?.textContent.includes('VXP-****-****-F8B3'))`),'masked key in session list');
    assert.equal(await execute(admin,`return document.querySelector('#sessions').textContent.includes('${license_key}')`),false,'Session list masks the key');
    console.log(`Real desktop workflow passed: ${match?'MATCH':'MISMATCH'}`);
  }
  // Verify the native checker handles retired/expired authorization as terminal.
  await click(admin,'#new');
  for (const [field,value] of Object.entries({vexor_username:'expiry-test',vexor_uid:'25404',license_key:'VXP-0000-1111-2222-3333-4444-5555-6666-7777-8888-F8B3',old_hwid_preview:'a18c88219d41ab…44a921'})) await fill(admin,`#${field}`,value);
  await click(admin,'#create button');
  const expiring = await until(async()=>await db.prepare("SELECT * FROM verification_sessions WHERE status = 'active' AND first_connected_at IS NULL LIMIT 1").first(),'expiry test session');
  const expired_checker = await open_app('hwid-chk',4446);
  await fill(expired_checker,'#server',backend); await fill(expired_checker,'#code',expiring.code); await click(expired_checker,'#start button');
  await until(()=>execute(expired_checker,`return document.body.textContent.includes('Connected')`),'expiry checker connected');
  await db.prepare("UPDATE verification_sessions SET status = 'expired', completed_at = ?, expires_at = 1 WHERE id = ?").bind(Math.floor(Date.now()/1000)-301,expiring.id).run();
  await until(()=>execute(expired_checker,`return document.body.textContent.includes('Verification expired')`),'native checker expiration');
  await close(expired_checker); await click(admin,'#back');
  console.log('Real checker expiration passed.');
  // Exercise the frontend's own expiration timer as well as server expiration.
  await until(()=>execute(admin,`return Boolean(document.querySelector('[data-open]'))`),'dashboard list loaded');
  await click(admin,'[data-open]');
  await until(()=>execute(admin,`return Boolean(document.querySelector('#detail .section'))`),'detail loaded for expiration test');
  await execute(admin,`window.__test_date_now = Date.now; Date.now = () => window.__test_date_now() + 1900000; return true;`);
  await until(()=>execute(admin,`return Boolean(document.querySelector('#login'))`),'client timer expires admin');
  await execute(admin,`Date.now = window.__test_date_now; return true;`);
  await fill(admin,'#server',backend); await fill(admin,'#username','desktop-test'); await fill(admin,'#password',password); await click(admin,'#login button');
  await until(()=>execute(admin,`return Boolean(document.querySelector('#new'))`),'admin signs in after client expiration');
  // Expire the live admin token in D1, then confirm that a fresh login can change
  // the endpoint and authenticate without a stale token blocking the UI.
  await db.prepare('UPDATE admin_sessions SET expires_at = 1').run();
  await until(()=>execute(admin,`return Boolean(document.querySelector('#login'))`),'expired admin returns to sign in');
  await fill(admin,'#server',backend); await fill(admin,'#username','desktop-test'); await fill(admin,'#password',password); await click(admin,'#login button');
  await until(()=>execute(admin,`return Boolean(document.querySelector('#new'))`),'admin signs in after expiration');
  await click(admin,'#logout');
  await until(()=>execute(admin,`return Boolean(document.querySelector('#login'))`),'admin sign out');
  const remaining = await db.prepare('SELECT COUNT(*) AS count FROM admin_sessions WHERE expires_at > ?').bind(Math.floor(Date.now()/1000)).first();
  assert.equal(remaining.count,0,'Sign out must revoke the server token');
  console.log('Real admin expiration, sign in and logout passed.');
  writeFileSync('test-data/desktop-result.json',JSON.stringify({timestamp:new Date().toISOString(),native_windows_collection:true,real_tauri_apps:true,worker_and_d1:true,reconnect:'passed',backend_restart:'passed',checker_expired:'passed',admin_reauthentication:'passed',match:'passed',mismatch:'passed'},null,2));
  }
} finally {
  for(const client of [...clients]) { try { await close(client); } catch {} }
  for(const child of children) child.kill();
  await mf.dispose();
}
