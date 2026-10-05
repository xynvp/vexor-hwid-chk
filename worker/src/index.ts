import { constant_equal, hmac, password_verify, random_code, random_token, sha256 } from './crypto';
import { ApiError, body, identity, object, preview, string } from './validation';
import { active, deliver_webhooks, get_session, heartbeat, maintenance, mutate, notification, now, online, public_session, settle } from './session_service';
import type { Env, Session } from './types';
import { license_key_length, license_key_pattern } from '../../shared/license';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'strict-transport-security': 'max-age=31536000' } });
}
async function rate_limit(env: Env, scope: string, key: string, limit: number): Promise<void> {
  const bucket = await hmac(env.HWID_FINGERPRINT_SECRET, 'rate_limit', scope + ':' + key), window = Math.floor(now() / 60) * 60;
  const row = await env.DB.prepare('INSERT INTO rate_limits (key,window_at,hits) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET hits = CASE WHEN window_at = excluded.window_at THEN hits + 1 ELSE 1 END, window_at = excluded.window_at RETURNING hits').bind(bucket, window).first<{ hits: number }>();
  if (!row || row.hits > limit) throw new ApiError(429, 'rate_limited');
}
function bearer(req: Request): string {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.get('authorization') || '');
  if (!match) throw new ApiError(401, 'unauthorized');
  return match[1];
}
async function authenticate(env: Env, req: Request) {
  const hash = await sha256(bearer(req));
  const auth = await env.DB.prepare('SELECT a.id,a.username FROM admin_sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ? AND s.expires_at > ? AND a.enabled = 1').bind(hash, now()).first<{ id: string; username: string }>();
  if (!auth) throw new ApiError(401, 'unauthorized');
  await rate_limit(env, 'admin', auth.id, 180);
  return { ...auth, hash };
}
function checker_response(s: Session) {
  return { status: s.status, current_hwid_preview: s.current_hwid_preview, expected_hwid_preview: s.expected_hwid_preview,
    identity_changed_after_reset: !!s.identity_changed_after_reset, expires_at: s.expires_at, server_timestamp: now() };
}
async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const path = new URL(req.url).pathname;
  const ip = req.headers.get('cf-connecting-ip') || 'local';
  if (path === '/health' && req.method === 'GET') return json({ status: 'ok' });
  if (path === '/api/admin/login' && req.method === 'POST') {
    await rate_limit(env, 'login_ip', ip, 5);
    const data = object(await body(req), ['username','password']);
    const username = string(data.username, 1, 64, /^[a-z0-9_.-]+$/), password = string(data.password, 1, 256);
    await rate_limit(env, 'login_username', username, 10);
    const admin = await env.DB.prepare('SELECT id,password_hash,enabled FROM admins WHERE username = ?').bind(username).first<{ id: string; password_hash: string; enabled: number }>();
    const dummy = 'pbkdf2-sha256$100000$00000000000000000000000000000000$' + '0'.repeat(64);
    const valid = await password_verify(password, admin?.password_hash || dummy);
    if (!valid || !admin?.enabled) throw new ApiError(401, 'invalid_credentials');
    const token = random_token(), expires_at = now() + 1800;
    await env.DB.prepare('INSERT INTO admin_sessions (token_hash,admin_id,created_at,expires_at) VALUES (?,?,?,?)').bind(await sha256(token), admin.id, now(), expires_at).run();
    return json({ token, expires_at, username });
  }
  if (path.startsWith('/api/admin/')) {
    const auth = await authenticate(env, req);
    if (path === '/api/admin/logout' && req.method === 'POST') {
      await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(auth.hash).run();
      return json({ status: 'logged_out' });
    }
    if (path === '/api/admin/sessions' && req.method === 'GET') {
      const rows = await env.DB.prepare('SELECT * FROM verification_sessions ORDER BY created_at DESC, id DESC LIMIT 200').all<Session>();
      const sessions = [];
      for (const s of rows.results) sessions.push(public_session(await settle(env, s)));
      ctx.waitUntil(deliver_webhooks(env));
      return json({ sessions, server_timestamp: now(), limit: 200 });
    }
    if (path === '/api/admin/sessions' && req.method === 'POST') {
      const v = object(await body(req), ['vexor_username','vexor_uid','license_key','old_hwid_preview','note']);
      const time = now(), id = crypto.randomUUID();
      const values = { vexor_username: string(v.vexor_username, 1, 64), vexor_uid: string(v.vexor_uid, 1, 32, /^[0-9]+$/),
        license_key: string(typeof v.license_key === 'string' ? v.license_key.trim() : v.license_key, license_key_length, license_key_length, new RegExp(`^${license_key_pattern}$`)), old_hwid_preview: preview(v.old_hwid_preview), note: string(typeof v.note === 'string' ? v.note.replace(/\r?\n/g, ' ') : v.note ?? '', 0, 1000) };
      for (let attempt = 0; attempt < 4; attempt++) {
        const code = random_code();
        try {
          await env.DB.batch([
            env.DB.prepare("INSERT INTO verification_sessions (id,code,status,vexor_username,vexor_uid,license_key,old_hwid_preview,note,created_at,expires_at,created_by_admin_id) VALUES (?,?,'active',?,?,?,?,?,?,?,?)")
              .bind(id, code, values.vexor_username, values.vexor_uid, values.license_key, values.old_hwid_preview, values.note, time, time + 900, auth.id),
            env.DB.prepare('INSERT INTO verification_events (id,session_id,server_timestamp,event_type,metadata) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(), id, time, 'session_created', JSON.stringify({ admin_id: auth.id }))
          ]);
          return json({ session: public_session(await get_session(env, id)) }, 201);
        } catch (error) {
          if (!String(error).includes('UNIQUE constraint failed: verification_sessions.code')) throw error;
        }
      }
      throw new ApiError(503, 'try_again');
    }
    const match = /^\/api\/admin\/sessions\/([a-f0-9-]{36})(?:\/(reset|claim|cancel))?$/.exec(path);
    if (!match) throw new ApiError(404, 'not_found');
    const s = await settle(env, await get_session(env, match[1]));
    if (!match[2] && req.method === 'GET') {
      const events = await env.DB.prepare('SELECT id,server_timestamp,event_type,metadata FROM verification_events WHERE session_id = ? ORDER BY server_timestamp, rowid').bind(s.id).all();
      return json({ session: public_session(s), events: events.results });
    }
    if (req.method !== 'POST') throw new ApiError(405, 'method_not_allowed');
    if (!active(s)) throw new ApiError(409, 'session_not_active');
    const v = object(await body(req), match[2] === 'claim' ? ['claimed_hwid_preview'] : ['confirmed']);
    if (match[2] === 'reset') {
      if (v.confirmed !== true) throw new ApiError(400, 'confirmation_required');
      if (s.status !== 'active' || !s.current_hwid || !online(s)) throw new ApiError(409, 'checker_must_be_online');
      const fields = { expected_hwid: s.current_hwid, expected_hwid_preview: s.current_hwid_preview, reset_at: now(), status: 'reset_marked' };
      const updated = await mutate(env, s, fields, [{ type: 'reset_marked', metadata: { admin_id: auth.id, expected_hwid_preview: s.current_hwid_preview } }], notification({ ...s, ...fields }, 'HWID RESET MARKED', 'RESET IN PROGRESS'));
      ctx.waitUntil(deliver_webhooks(env));
      return json({ session: public_session(updated) });
    }
    if (match[2] === 'claim') {
      if (s.status !== 'reset_marked' || !s.expected_hwid_preview) throw new ApiError(409, 'reset_not_marked');
      if (!online(s)) throw new ApiError(409, 'checker_must_be_online');
      const claimed = preview(v.claimed_hwid_preview), matched = constant_equal(s.expected_hwid_preview, claimed);
      const fields = { claimed_hwid_preview: claimed, status: matched ? 'completed' : 'mismatch', verified_at: now(), completed_at: now() };
      const result = matched ? 'MATCH' : 'MISMATCH';
      const updated = await mutate(env, s, fields, [
        { type: matched ? 'claim_verified' : 'claim_mismatch', metadata: { admin_id: auth.id, expected: s.expected_hwid_preview, claimed, identity_changed_after_reset: !!s.identity_changed_after_reset } },
        { type: 'session_completed', metadata: { result } }
      ], notification({ ...s, ...fields }, matched ? 'HWID RESET VERIFIED' : 'HWID RESET MISMATCH', result));
      ctx.waitUntil(deliver_webhooks(env));
      return json({ session: public_session(updated), result });
    }
    if (match[2] === 'cancel') {
      if (v.confirmed !== true) throw new ApiError(400, 'confirmation_required');
      return json({ session: public_session(await mutate(env, s, { status: 'cancelled', completed_at: now(), checker_online: 0 }, [{ type: 'session_cancelled', metadata: { admin_id: auth.id } }])) });
    }
    throw new ApiError(404, 'not_found');
  }
  if (path === '/api/checker/connect' && req.method === 'POST') {
    await rate_limit(env, 'connect', ip, 10);
    const v = object(await body(req), ['code','identity']), code = string(v.code, 8, 20, /^VXH-[A-Z0-9]{6,12}$/);
    const found = await env.DB.prepare('SELECT * FROM verification_sessions WHERE code = ?').bind(code).first<Session>();
    if (!found) throw new ApiError(400, 'code_unavailable');
    const s = await settle(env, found);
    if (!active(s) || s.checker_token_hash) throw new ApiError(400, 'code_unavailable');
    const token = random_token();
    const updated = await heartbeat(env, s, identity(v.identity), await sha256(token));
    if (!active(updated)) throw new ApiError(400, 'code_unavailable');
    ctx.waitUntil(deliver_webhooks(env));
    return json({ token, ...checker_response(updated) });
  }
  if (path === '/api/checker/heartbeat' && req.method === 'POST') {
    const hash = await sha256(bearer(req));
    const found = await env.DB.prepare('SELECT * FROM verification_sessions WHERE checker_token_hash = ?').bind(hash).first<Session>();
    if (!found) { await rate_limit(env, 'invalid_checker_token', ip, 10); throw new ApiError(401, 'unauthorized'); }
    await rate_limit(env, 'heartbeat', hash, 30);
    const s = await settle(env, found);
    // Allow a short final-status delivery window, then retire checker authorization.
    if (!active(s) && s.completed_at !== null && now() > s.completed_at + 300) throw new ApiError(410, 'checker_session_expired');
    if (!active(s)) return json(checker_response(s));
    const v = object(await body(req), ['identity']);
    return json(checker_response(await heartbeat(env, s, identity(v.identity))));
  }
  throw new ApiError(404, 'not_found');
}
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const request_id = crypto.randomUUID();
    const origin = req.headers.get('origin');
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
    let response: Response;
    try {
      if (new URL(req.url).protocol !== 'https:' && env.ENVIRONMENT !== 'development') throw new ApiError(400, 'https_required');
      if (!env.HWID_FINGERPRINT_SECRET || env.HWID_FINGERPRINT_SECRET.length < 32) throw new ApiError(503, 'service_unavailable');
      if (origin && !allowed.includes(origin)) throw new ApiError(403, 'origin_not_allowed');
      if (req.method === 'OPTIONS') response = new Response(null, { status: 204 });
      else response = await route(req, env, ctx);
    } catch (error) {
      const known = error instanceof ApiError;
      // Never log request bodies, authorization, raw components, webhook URLs or passwords.
      const path = new URL(req.url).pathname;
      const api_group = path.startsWith('/api/admin/') ? 'admin' : path.startsWith('/api/checker/') ? 'checker' : 'other';
      console.error(JSON.stringify({ request_id, api_group, error_class: error instanceof Error ? error.name : 'unknown', event: known ? error.code : 'internal_error', status: known ? error.status : 500 }));
      response = json({ error: known ? error.code : 'internal_error', request_id }, known ? error.status : 500);
    }
    response.headers.set('x-request-id', request_id);
    if (response.status === 429) response.headers.set('retry-after', '60');
    if (origin && allowed.includes(origin)) {
      response.headers.set('access-control-allow-origin', origin);
      response.headers.set('vary', 'Origin');
      response.headers.set('access-control-allow-methods', 'GET,POST,OPTIONS');
      response.headers.set('access-control-allow-headers', 'authorization,content-type');
    }
    return response;
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) { ctx.waitUntil(maintenance(env)); }
} satisfies ExportedHandler<Env>;
