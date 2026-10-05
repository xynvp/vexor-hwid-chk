import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { password_hash, hwid_preview, sha256, normalize_preview } from '../src/crypto';
import { mask_license_key } from '../../shared/license';

const secret = 'test-only-secret-not-used-in-production-' + 'x'.repeat(32);
const license_key = 'VXP-0000-1111-2222-3333-4444-5555-6666-7777-8888-F8B3';
const legacy_id = crypto.randomUUID();
const sample = {
  machine_guid: 'fcbd67b7-ae2a-4ddb-9a39-b30c3ace98bb', volume_serial: '2354351557', computer_name: 'XYZ',
  windows_install_date: 1790914320, windows_product: 'Windows 11 Pro', windows_version: '24H2', windows_build: '26100.1', checker_version: '1.0.0'
};
const expected = '3f0b27d50a814b411912e3428d9b5f48315352ffdf04cc8349cd571f1a52e873';
const expected_preview = '3f0b27d50a814b…52e873';
let mf: Miniflare, db: Awaited<ReturnType<Miniflare['getD1Database']>>, admin: string;
const directory = mkdtempSync(join(tmpdir(), 'hwid-d1-tests-'));
let webhook_payloads: string[] = [];
function instance(production = false, persist = directory) {
  return new Miniflare({ ...convertV4MiniflareOptions({ name: 'hwid-test', modules: true, scriptPath: resolve('generated/worker.js'), compatibilityDate: '2026-08-01',
    d1Databases: { DB: 'hwid-db' }, d1Persist: persist,
    bindings: { ENVIRONMENT: production ? 'production' : 'development', HWID_FINGERPRINT_SECRET: secret, DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/test-only' },
    outboundService: async request => { webhook_payloads.push(await request.text()); return new Response('unavailable', { status: 503 }); }
  }), resourcePersistencePath: persist });
}
async function call(path: string, method = 'GET', payload?: unknown, token?: string, extra: Record<string,string> = {}) {
  const response = await mf.dispatchFetch('http://localhost'+path, { method, headers: { 'content-type':'application/json', ...(token ? { authorization: 'Bearer '+token } : {}), ...extra }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  return { status: response.status, data: await response.json() as any, response };
}
async function create() {
  const response = await call('/api/admin/sessions','POST',{vexor_username:'xynr',vexor_uid:'25404',license_key,old_hwid_preview:'a18c88219d41ab…44a921',note:'Support test'},admin);
  expect(response.status).toBe(201); return response.data.session;
}
async function connect(s: any, identity = sample) {
  const response = await call('/api/checker/connect','POST',{code:s.code,identity});
  expect(response.status).toBe(200); return response.data.token as string;
}
async function detail(id: string) { return (await call(`/api/admin/sessions/${id}`,'GET',undefined,admin)).data; }
async function reset(id: string) { return call(`/api/admin/sessions/${id}/reset`,'POST',{confirmed:true},admin); }
async function claim(id: string, value: string) { return call(`/api/admin/sessions/${id}/claim`,'POST',{claimed_hwid_preview:value},admin); }
async function wait_for(predicate: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(r=>setTimeout(r,20)); }
  throw new Error('Timed out waiting for async task.');
}
beforeAll(async () => {
  mf = instance(); db = await mf.getD1Database('DB');
  for (const file of readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort()) {
    if (file === '0003_full_license_key.sql') {
      // Exercise the upgrade with an existing session, audit event and queued notification.
      const time = Math.floor(Date.now()/1000);
      await db.prepare('INSERT INTO admins (id,username,password_hash,created_at) VALUES (?,?,?,?)').bind('legacy-admin','legacy','unused',time).run();
      await db.prepare("INSERT INTO verification_sessions (id,code,status,vexor_username,vexor_uid,license_suffix,old_hwid_preview,note,created_at,expires_at,created_by_admin_id) VALUES (?,?,'active',?,?,?,?,?,?,?,?)")
        .bind(legacy_id,'VXH-LEGACY01','legacy-user','25404','F8B3','a18c88219d41ab…44a921','Preserve this note',time,time+900,'legacy-admin').run();
      await db.prepare('INSERT INTO verification_events (id,session_id,server_timestamp,event_type,metadata) VALUES (?,?,?,?,?)').bind('legacy-event',legacy_id,time,'session_created','{}').run();
      await db.prepare('INSERT INTO webhook_outbox (id,session_id,payload,available_at) VALUES (?,?,?,?)').bind('legacy-webhook',legacy_id,'{"content":"****-F8B3"}',time+3600).run();
    }
    // D1 exec accepts SQL statements across lines; migration triggers require full SQL parsing.
    const sql = readFileSync(join('migrations',file),'utf8');
    const statements = sql.split(/;\s*(?:\r?\n|$)/).filter(v=>v.trim()).map(v=>v.trim()+';');
    for (const statement of statements) await db.prepare(statement).run();
  }
  await db.prepare('INSERT INTO admins (id,username,password_hash,created_at) VALUES (?,?,?,?)').bind('test-admin','support',await password_hash('correct-test-password'),Math.floor(Date.now()/1000)).run();
});
beforeEach(async () => {
  await db.prepare('DELETE FROM rate_limits').run();
  const result = await call('/api/admin/login','POST',{username:'support',password:'correct-test-password'});
  expect(result.status).toBe(200); admin = result.data.token;
});
afterAll(async () => { await mf?.dispose(); });

describe('real Worker and D1 integration', () => {
  it('stores the entire license key and returns it to authenticated staff',async()=>{
    const s = await create();
    expect(s.license_key).toBe(license_key);
    expect(s.license_suffix).toBeUndefined();
    const row = await db.prepare('SELECT license_key FROM verification_sessions WHERE id = ?').bind(s.id).first();
    expect(row?.license_key).toBe(license_key);
    expect((await detail(s.id)).session.license_key).toBe(license_key);
    const list = await call('/api/admin/sessions','GET',undefined,admin);
    expect(list.data.sessions.find((session:any)=>session.id===s.id).license_key).toBe(license_key);
    const checker = await call('/api/checker/connect','POST',{code:s.code,identity:sample});
    expect(checker.status).toBe(200);
    expect(JSON.stringify(checker.data)).not.toContain(license_key);
  });
  it('accepts pasted full keys and rejects suffixes, truncated keys and malformed keys',async()=>{
    const payload = {vexor_username:'key-validation',vexor_uid:'25404',old_hwid_preview:'a18c88219d41ab…44a921'};
    const pasted = await call('/api/admin/sessions','POST',{...payload,license_key:`  ${license_key.toLowerCase()}\n`},admin);
    expect(pasted.status).toBe(201);
    expect(pasted.data.session.license_key).toBe(license_key.toLowerCase());
    for (const key of [undefined, null, 123, '', 'F8B3', 'VXP-****-****-F8B3', license_key.slice(0,-5), license_key+'-1234', license_key.replace('0000','G000'), license_key.replace('0000','00 0'), license_key.replace('VXP','ABC')]) {
      expect((await call('/api/admin/sessions','POST',{...payload,license_key:key},admin)).status).toBe(400);
    }
    expect((await call('/api/admin/sessions','POST',{...payload,license_suffix:'F8B3'},admin)).status).toBe(400);
  });
  it('migrates suffix-only sessions without losing history or breaking verification',async()=>{
    const d = await detail(legacy_id);
    expect(d.session.license_key).toBe('F8B3');
    expect(d.session.license_suffix).toBeUndefined();
    expect(d.session.note).toBe('Preserve this note');
    expect(d.events.some((event:any)=>event.id==='legacy-event')).toBe(true);
    expect(mask_license_key(d.session.license_key)).toBe('****-F8B3');
    expect((await db.prepare('SELECT payload FROM webhook_outbox WHERE id = ?').bind('legacy-webhook').first())?.payload).toBe('{"content":"****-F8B3"}');
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    await connect(d.session);
    expect((await reset(legacy_id)).status).toBe(200);
    expect((await claim(legacy_id,expected_preview)).data.result).toBe('MATCH');
    await expect(db.prepare("UPDATE verification_events SET event_type = 'tampered' WHERE id = 'legacy-event'").run()).rejects.toThrow();
  });
  it('masks license keys in every Discord notification and the durable outbox',async()=>{
    expect(mask_license_key(license_key)).toBe('VXP-****-****-F8B3');
    const s = await create(); await connect(s); await reset(s.id); await claim(s.id,expected_preview);
    const rows = await db.prepare('SELECT payload FROM webhook_outbox WHERE session_id = ?').bind(s.id).all<{payload:string}>();
    expect(rows.results).toHaveLength(3);
    for (const row of rows.results) {
      expect(row.payload).not.toContain(license_key);
      expect(JSON.parse(row.payload).embeds[0].fields.find((field:any)=>field.name==='Key').value).toBe('VXP-****-****-F8B3');
    }
    const expiring = await create();
    await db.prepare('UPDATE verification_sessions SET expires_at = 1 WHERE id = ?').bind(expiring.id).run();
    await detail(expiring.id);
    const expired = await db.prepare('SELECT payload FROM webhook_outbox WHERE session_id = ?').bind(expiring.id).first<{payload:string}>();
    expect(expired?.payload).toContain('VXP-****-****-F8B3');
    expect(webhook_payloads.join('')).not.toContain(license_key);
  });
  it('matches the exact Vexor vector in crypto and in the server',async()=>{
    expect(await sha256(sample.machine_guid+sample.volume_serial+sample.computer_name)).toBe(expected);
    expect(hwid_preview(expected)).toBe(expected_preview);
    const s = await create(); await connect(s);
    const result = await detail(s.id);
    expect(result.session.current_hwid).toBe(expected);
    expect(result.session.current_hwid_preview).toBe(expected_preview);
    expect(result.session.machine_guid_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.session.machine_guid_fingerprint).not.toBe(await sha256(sample.machine_guid));
  });
  it('rejects invalid and expired codes with the same public error',async()=>{
    const bad = await call('/api/checker/connect','POST',{code:'VXH-INVALID1',identity:sample});
    const s = await create(); await db.prepare('UPDATE verification_sessions SET expires_at = ? WHERE id = ?').bind(1,s.id).run();
    const expired = await call('/api/checker/connect','POST',{code:s.code,identity:sample});
    expect(bad.status).toBe(400); expect(expired.status).toBe(400);
    expect(bad.data.error).toBe('code_unavailable'); expect(expired.data.error).toBe('code_unavailable');
    const d = await detail(s.id); expect(d.session.status).toBe('expired'); expect(d.events.filter((e:any)=>e.event_type==='session_expired')).toHaveLength(1);
  });
  it('authenticates admins, rejects checker tokens on admin routes and supports logout',async()=>{
    expect((await call('/api/admin/login','POST',{username:'support',password:'wrong'})).status).toBe(401);
    expect((await call('/api/admin/login','POST',{username:'missing',password:'wrong'})).data.error).toBe('invalid_credentials');
    expect((await call('/api/admin/sessions')).status).toBe(401);
    const s = await create(), token = await connect(s);
    expect((await call('/api/admin/sessions','GET',undefined,token)).status).toBe(401);
    expect((await call('/api/checker/heartbeat','POST',{identity:sample},admin)).status).toBe(401);
    await call('/api/admin/logout','POST',{},admin);
    expect((await call('/api/admin/sessions','GET',undefined,admin)).status).toBe(401);
  });
  it('rejects expired admin sessions',async()=>{
    await db.prepare('UPDATE admin_sessions SET expires_at = 1 WHERE token_hash = ?').bind(await sha256(admin)).run();
    expect((await call('/api/admin/sessions','GET',undefined,admin)).status).toBe(401);
  });
  it('keeps a code single-use and resumes using the opaque token',async()=>{
    const s = await create(), token = await connect(s);
    expect((await call('/api/checker/connect','POST',{code:s.code,identity:sample})).status).toBe(400);
    await db.prepare('UPDATE verification_sessions SET last_seen_at = ? WHERE id = ?').bind(Math.floor(Date.now()/1000)-20,s.id).run();
    const d = await detail(s.id); expect(d.session.online).toBe(false);
    expect((await call('/api/checker/heartbeat','POST',{identity:sample},token)).status).toBe(200);
    const reconnected = await detail(s.id); expect(reconnected.session.online).toBe(true);
    expect(reconnected.events.map((e:any)=>e.event_type)).toContain('checker_disconnected');
    expect(reconnected.events.map((e:any)=>e.event_type)).toContain('checker_reconnected');
  });
  it('does not add an audit event or session row for every heartbeat',async()=>{
    const count_events = (events: any[]) => events.filter(e=>e.event_type !== 'webhook_delivery_failed').length;
    const s = await create(), token = await connect(s), before = count_events((await detail(s.id)).events);
    for(let i=0;i<6;i++) expect((await call('/api/checker/heartbeat','POST',{identity:sample},token)).status).toBe(200);
    expect(count_events((await detail(s.id)).events)).toBe(before);
    const count = await db.prepare('SELECT COUNT(*) AS count FROM verification_sessions WHERE id = ?').bind(s.id).first();
    expect(count?.count).toBe(1);
  });
  it('requires confirmation and a live checker to mark reset',async()=>{
    const s = await create(); expect((await reset(s.id)).status).toBe(409);
    await connect(s);
    expect((await call(`/api/admin/sessions/${s.id}/reset`,'POST',{confirmed:false},admin)).status).toBe(400);
    const r = await reset(s.id); expect(r.status).toBe(200);
    expect(r.data.session.expected_hwid).toBe(expected); expect(r.data.session.status).toBe('reset_marked');
    expect((await reset(s.id)).status).toBe(409);
  });
  it('normalizes harmless paste formatting and verifies matching previews',async()=>{
    expect(normalize_preview(' 3f0b27d50a814b...52e873 \n')).toBe(expected_preview);
    const s=await create(), token=await connect(s); await reset(s.id);
    const r=await claim(s.id,' 3f0b27d50a814b...52e873\n');
    expect(r.data.result).toBe('MATCH'); expect(r.data.session.status).toBe('completed');
    expect(r.data.session.completed_at).toBeGreaterThan(0);
    expect((await call('/api/checker/heartbeat','POST',{identity:sample},token)).data.status).toBe('completed');
    expect((await claim(s.id,expected_preview)).status).toBe(409);
  });
  it('records mismatch and reports failed verification to the checker',async()=>{
    const s=await create(), token=await connect(s); await reset(s.id);
    const r=await claim(s.id,'71a2b419fa821a…91cc22');
    expect(r.data.result).toBe('MISMATCH'); expect(r.data.session.status).toBe('mismatch');
    expect((await call('/api/checker/heartbeat','POST',{identity:sample},token)).data.status).toBe('mismatch');
    expect((await detail(s.id)).events.map((e:any)=>e.event_type)).toContain('claim_mismatch');
  });
  it('audits changed identity during reset and always compares with the original snapshot',async()=>{
    const s=await create(), token=await connect(s); await reset(s.id);
    await call('/api/checker/heartbeat','POST',{identity:{...sample,computer_name:'OTHER'}},token);
    const d=await detail(s.id); expect(d.session.identity_changed_after_reset).toBe(1); expect(d.session.computer_name_changed).toBe(1);
    expect(d.session.expected_hwid).toBe(expected); expect(d.session.current_hwid).not.toBe(expected);
    const event=d.events.find((e:any)=>e.event_type==='identity_changed'); expect(JSON.parse(event.metadata).components).toEqual(['computer_name']);
    const result=await claim(s.id,d.session.current_hwid_preview); expect(result.data.result).toBe('MISMATCH');
  });
  it('detects all component changes and does not normalize machine case',async()=>{
    const s=await create(), token=await connect(s);
    await call('/api/checker/heartbeat','POST',{identity:{...sample,machine_guid:sample.machine_guid.toUpperCase(),volume_serial:'0',computer_name:'xyz'}},token);
    const d=await detail(s.id);
    expect(d.session.machine_guid_changed).toBe(1); expect(d.session.volume_serial_changed).toBe(1); expect(d.session.computer_name_changed).toBe(1);
    expect(d.session.current_hwid).not.toBe(expected);
  });
  it('handles expiration and cancellation of connected sessions',async()=>{
    const s=await create(), token=await connect(s);
    await db.prepare('UPDATE verification_sessions SET expires_at = 1 WHERE id = ?').bind(s.id).run();
    expect((await call('/api/checker/heartbeat','POST',{identity:sample},token)).data.status).toBe('expired');
    const other=await create(), other_token=await connect(other);
    expect((await call(`/api/admin/sessions/${other.id}/cancel`,'POST',{confirmed:true},admin)).data.session.status).toBe('cancelled');
    expect((await call('/api/checker/heartbeat','POST',{identity:sample},other_token)).data.status).toBe('cancelled');
  });
  it('retires checker tokens after the final status grace period',async()=>{
    const s=await create(), token=await connect(s); await reset(s.id); await claim(s.id,expected_preview);
    await db.prepare('UPDATE verification_sessions SET completed_at = ? WHERE id = ?').bind(Math.floor(Date.now()/1000)-301,s.id).run();
    const response=await call('/api/checker/heartbeat','POST',{identity:sample},token);
    expect(response.status).toBe(410); expect(response.data.error).toBe('checker_session_expired');
  });
  it('validates schemas, bounds bodies, enforces CORS and rate limits',async()=>{
    // Keep this short burst inside one real fixed-minute rate-limit window.
    // A legitimate window rollover must not be mistaken for a failed limiter.
    const remaining = 60000 - Date.now() % 60000;
    if (remaining < 5000) await new Promise(resolve => setTimeout(resolve, remaining + 100));
    const s=await create();
    expect((await call('/api/checker/connect','POST',{code:s.code,identity:{...sample,volume_serial:'4294967296'}})).status).toBe(400);
    expect((await call('/api/checker/connect','POST',{code:s.code,identity:sample,admin_id:'test-admin'})).status).toBe(400);
    expect((await call('/api/checker/connect','POST',{code:s.code,identity:{...sample,computer_name:'x'.repeat(9000)}})).status).toBe(413);
    expect((await call('/api/admin/sessions','GET',undefined,admin,{origin:'https://evil.example'})).status).toBe(403);
    for(let i=0;i<10;i++) await call('/api/checker/connect','POST',{code:'VXH-INVALID1',identity:sample});
    expect((await call('/api/checker/connect','POST',{code:s.code,identity:sample})).status).toBe(429);
  });
  it('never persists raw components or includes them in notifications',async()=>{
    const s=await create(); await connect(s);
    const state=await db.prepare('SELECT * FROM verification_sessions WHERE id = ?').bind(s.id).first();
    const events=await db.prepare('SELECT * FROM verification_events WHERE session_id = ?').bind(s.id).all();
    const outbox=await db.prepare('SELECT * FROM webhook_outbox WHERE session_id = ?').bind(s.id).all();
    const serialized=JSON.stringify([state,events,outbox]);
    for(const raw of [sample.machine_guid,sample.volume_serial,sample.computer_name]) expect(serialized).not.toContain(raw);
    const d=await detail(s.id); expect(d.session.checker_token_hash).toBeUndefined();
    await expect(db.prepare("UPDATE verification_events SET event_type = 'tampered' WHERE session_id = ?").bind(s.id).run()).rejects.toThrow();
    await expect(db.prepare('DELETE FROM verification_events WHERE session_id = ?').bind(s.id).run()).rejects.toThrow();
  });
  it('retries webhook failure without breaking verification',async()=>{
    const s=await create(); await connect(s); await reset(s.id);
    const result=await claim(s.id,expected_preview); expect(result.data.result).toBe('MATCH');
    await wait_for(async()=> !!(await db.prepare("SELECT id FROM verification_events WHERE session_id = ? AND event_type = 'webhook_delivery_failed'").bind(s.id).first()));
    const rows=await db.prepare('SELECT * FROM webhook_outbox WHERE session_id = ?').bind(s.id).all();
    expect(rows.results.length).toBeGreaterThanOrEqual(3);
    expect(webhook_payloads.length).toBeGreaterThan(0);
    for(const raw of [sample.machine_guid,sample.volume_serial,sample.computer_name]) expect(webhook_payloads.join('')).not.toContain(raw);
  });
  it('serializes concurrent reset requests without duplicate audit events',async()=>{
    const s=await create(); await connect(s);
    const results=await Promise.all([reset(s.id),reset(s.id)]);
    expect(results.filter(r=>r.status===200)).toHaveLength(1); expect(results.filter(r=>r.status===409)).toHaveLength(1);
    expect((await detail(s.id)).events.filter((e:any)=>e.event_type==='reset_marked')).toHaveLength(1);
  });
  it('persists sessions, tokens, snapshots and audit history across a database runtime restart',async()=>{
    const s=await create(), token=await connect(s); await reset(s.id);
    const before=(await detail(s.id)).events.map((e:any)=>e.id);
    await mf.dispose(); mf=instance(); db=await mf.getD1Database('DB');
    const d=await detail(s.id); expect(d.session.expected_hwid).toBe(expected);
    for(const id of before) expect(d.events.map((e:any)=>e.id)).toContain(id);
    expect((await call('/api/checker/heartbeat','POST',{identity:sample},token)).status).toBe(200);
    expect((await claim(s.id,expected_preview)).data.result).toBe('MATCH');
  });
  it('rejects plain HTTP in production',async()=>{
    const prod=instance(true,mkdtempSync(join(tmpdir(),'hwid-prod-test-')));
    try { const r=await prod.dispatchFetch('http://localhost/health'); expect(r.status).toBe(400); expect(await r.json()).toMatchObject({error:'https_required'}); }
    finally { await prod.dispose(); }
  });
});
