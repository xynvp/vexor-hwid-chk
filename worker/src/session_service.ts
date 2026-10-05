import { constant_equal, hmac, hwid_preview, sha256 } from './crypto';
import { ApiError } from './validation';
import type { Env, Identity, Session } from './types';
import { mask_license_key } from '../../shared/license';
export const active = (s: Session) => s.status === 'active' || s.status === 'reset_marked';
export const now = () => Math.floor(Date.now() / 1000);
export const online = (s: Session, time = now()) => !!s.checker_online && s.last_seen_at !== null && time - s.last_seen_at < 12;
export async function get_session(env: Env, id: string): Promise<Session> {
  const s = await env.DB.prepare('SELECT * FROM verification_sessions WHERE id = ?').bind(id).first<Session>();
  if (!s) throw new ApiError(404, 'session_not_found');
  return s;
}
export function public_session(s: Session) {
  const { checker_token_hash, mutation_id, ...safe } = s;
  return { ...safe, online: online(s), server_timestamp: now() };
}
type Event = { type: string; metadata?: Record<string, unknown> };
export function notification(s: Session, title: string, result?: string): string {
  const fields = [
    { name: 'Session', value: s.code },
    { name: 'User', value: `${s.vexor_username} (${s.vexor_uid})` },
    { name: 'Key', value: mask_license_key(s.license_key) },
    { name: 'Old HWID', value: s.old_hwid_preview },
    { name: 'Monitored HWID', value: s.current_hwid_preview || 'Awaiting checker' }
  ];
  if (s.expected_hwid_preview) fields.push({ name: 'Expected', value: s.expected_hwid_preview });
  if (s.claimed_hwid_preview) fields.push({ name: 'Claimed', value: s.claimed_hwid_preview });
  fields.push({ name: 'Result', value: result || s.status });
  if (s.identity_changed_after_reset) fields.push({ name: 'Continuity warning', value: 'The monitored identity changed after reset was marked.' });
  return JSON.stringify({ allowed_mentions: { parse: [] }, embeds: [{ title,
    description: result === 'MISMATCH' ? 'The HWID that claimed the license does not match the PC monitored during the reset.' : undefined,
    color: result === 'MATCH' ? 0x43b581 : result === 'MISMATCH' ? 0xed4245 : 0x8b8b93,
    fields, timestamp: new Date(now() * 1000).toISOString() }] });
}
// A D1 batch is transactional. The revision and mutation id guard both state and
// append-only events against concurrent heartbeats, resets and claim submissions.
export async function mutate(env: Env, s: Session, fields: Record<string, string | number | null>, events: Event[], webhook?: string): Promise<Session> {
  const time = now(), mutation_id = crypto.randomUUID();
  const keys = Object.keys(fields);
  const statements = [env.DB.prepare(`UPDATE verification_sessions SET ${keys.map(k => `${k} = ?`).join(', ')}, revision = revision + 1, mutation_id = ? WHERE id = ? AND revision = ?`)
    .bind(...Object.values(fields), mutation_id, s.id, s.revision)];
  for (const event of events) statements.push(env.DB.prepare('INSERT INTO verification_events (id,session_id,server_timestamp,event_type,metadata) SELECT ?,id,?,?,? FROM verification_sessions WHERE id = ? AND mutation_id = ?')
    .bind(crypto.randomUUID(), time, event.type, JSON.stringify(event.metadata || {}), s.id, mutation_id));
  if (webhook && env.DISCORD_WEBHOOK_URL) statements.push(env.DB.prepare('INSERT INTO webhook_outbox (id,session_id,payload,available_at) SELECT ?,id,?,? FROM verification_sessions WHERE id = ? AND mutation_id = ?')
    .bind(crypto.randomUUID(), webhook, time, s.id, mutation_id));
  const result = await env.DB.batch(statements);
  if (result[0].meta.changes !== 1) throw new ApiError(409, 'session_changed_retry');
  return { ...s, ...fields, revision: s.revision + 1, mutation_id } as Session;
}
export async function settle(env: Env, initial: Session): Promise<Session> {
  let s = initial;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!active(s)) return s;
    const time = now();
    try {
      if (s.expires_at <= time) return await mutate(env, s, { status: 'expired', completed_at: time, checker_online: 0 }, [{ type: 'session_expired' }], notification({ ...s, status: 'expired' }, 'HWID SESSION EXPIRED'));
      if (s.checker_online && !online(s, time)) return await mutate(env, s, { checker_online: 0 }, [{ type: 'checker_disconnected' }]);
      return s;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error;
      s = await get_session(env, s.id);
    }
  }
  throw new ApiError(409, 'session_changed_retry');
}
export async function derive_identity(env: Env, value: Identity) {
  const [hwid, machine, volume, computer] = await Promise.all([
    sha256(value.machine_guid + value.volume_serial + value.computer_name),
    hmac(env.HWID_FINGERPRINT_SECRET, 'machine_guid', value.machine_guid),
    hmac(env.HWID_FINGERPRINT_SECRET, 'volume_serial', value.volume_serial),
    hmac(env.HWID_FINGERPRINT_SECRET, 'computer_name', value.computer_name)
  ]);
  // Raw components are never returned, logged, persisted or placed in the outbox.
  return { current_hwid: hwid, current_hwid_preview: hwid_preview(hwid), machine_guid_fingerprint: machine,
    volume_serial_fingerprint: volume, computer_name_fingerprint: computer,
    windows_install_date: value.windows_install_date, windows_product: value.windows_product,
    windows_version: value.windows_version, windows_build: value.windows_build, checker_version: value.checker_version };
}
export async function heartbeat(env: Env, initial: Session, value: Identity, connecting_token_hash?: string): Promise<Session> {
  const derived = await derive_identity(env, value);
  let s = initial;
  for (let attempt = 0; attempt < 4; attempt++) {
    s = await settle(env, s);
    if (!active(s)) return s;
    if (connecting_token_hash && s.checker_token_hash) throw new ApiError(409, 'code_unavailable');
    const first = !s.first_connected_at, time = now();
    const events: Event[] = [];
    if (first) events.push({ type: 'checker_connected' });
    else if (!online(s, time)) events.push({ type: 'checker_reconnected' });
    const changes = ['machine_guid','volume_serial','computer_name'].filter(key => {
      const field = `${key}_fingerprint` as keyof typeof derived;
      return s[field as keyof Session] && !constant_equal(String(s[field as keyof Session]), String(derived[field]));
    });
    const fields: Record<string, string | number | null> = { ...derived, last_seen_at: time, checker_online: 1 };
    if (first) fields.first_connected_at = time;
    if (connecting_token_hash) fields.checker_token_hash = connecting_token_hash;
    if (changes.length) {
      for (const key of changes) fields[`${key}_changed`] = 1;
      if (s.reset_at) fields.identity_changed_after_reset = 1;
      events.push({ type: 'identity_changed', metadata: { components: changes, after_reset: !!s.reset_at,
        previous_hwid_preview: s.current_hwid_preview, current_hwid_preview: derived.current_hwid_preview } });
    }
    try { return await mutate(env, s, fields, events, first ? notification({ ...s, ...derived }, 'HWID RESET SESSION STARTED', 'MONITORING') : undefined); }
    catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error;
      s = await get_session(env, s.id);
    }
  }
  throw new ApiError(409, 'session_changed_retry');
}
export async function deliver_webhooks(env: Env): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL) return;
  let url: URL;
  try { url = new URL(env.DISCORD_WEBHOOK_URL); }
  catch { console.error(JSON.stringify({ event: 'webhook_configuration_invalid' })); return; }
  if (url.protocol !== 'https:' || !['discord.com','discordapp.com'].includes(url.hostname) || !url.pathname.startsWith('/api/webhooks/')) {
    console.error(JSON.stringify({ event: 'webhook_configuration_invalid' })); return;
  }
  const time = now();
  const rows = await env.DB.prepare('SELECT * FROM webhook_outbox WHERE delivered_at IS NULL AND failed_at IS NULL AND available_at <= ? AND lease_until <= ? LIMIT 10')
    .bind(time, time).all<{ id: string; session_id: string; payload: string; attempts: number }>();
  for (const row of rows.results) {
    const lease = await env.DB.prepare('UPDATE webhook_outbox SET lease_until = ? WHERE id = ? AND lease_until <= ? AND delivered_at IS NULL AND failed_at IS NULL').bind(time + 30, row.id, time).run();
    if (lease.meta.changes !== 1) continue;
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: row.payload, signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('delivery_failed');
      await env.DB.prepare('UPDATE webhook_outbox SET delivered_at = ?, lease_until = 0 WHERE id = ?').bind(now(), row.id).run();
    } catch {
      console.error(JSON.stringify({ event: 'webhook_delivery_failed', outbox_id: row.id, attempt: row.attempts + 1 }));
      const exhausted = row.attempts >= 4;
      await env.DB.batch([
        env.DB.prepare('UPDATE webhook_outbox SET attempts = attempts + 1, available_at = ?, lease_until = 0, failed_at = ? WHERE id = ?').bind(now() + Math.min(3600, 30 * 2 ** row.attempts), exhausted ? now() : null, row.id),
        env.DB.prepare('INSERT INTO verification_events (id,session_id,server_timestamp,event_type,metadata) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(), row.session_id, now(), 'webhook_delivery_failed', JSON.stringify({ attempt: row.attempts + 1, exhausted }))
      ]);
    }
  }
}
export async function maintenance(env: Env): Promise<void> {
  const rows = await env.DB.prepare("SELECT * FROM verification_sessions WHERE status IN ('active','reset_marked') AND (expires_at <= ? OR (checker_online = 1 AND last_seen_at <= ?)) LIMIT 200").bind(now(), now() - 12).all<Session>();
  for (const s of rows.results) await settle(env, s);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').bind(now()),
    env.DB.prepare('DELETE FROM rate_limits WHERE window_at < ?').bind(now() - 3600)
  ]);
  await deliver_webhooks(env);
}
