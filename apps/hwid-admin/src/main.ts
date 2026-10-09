import { invoke } from '@tauri-apps/api/core';
import { is_full_license_key, license_key_max_length, license_key_pattern, mask_license_key } from '../../../shared/license';
import '../../shared/style.css';
import { confirm_action, copyable, date, empty_state, error_message, escape, icon, loading, mount_window, toast, wire_copy, type ClientError } from '../../shared/ui';
interface Session {
  id: string; code: string; status: string; vexor_username: string; vexor_uid: string; license_key: string; old_hwid_preview: string; note: string;
  current_hwid: string | null; current_hwid_preview: string | null; expected_hwid: string | null; expected_hwid_preview: string | null; claimed_hwid_preview: string | null;
  online: boolean; last_seen_at: number | null; created_at: number; expires_at: number; reset_at: number | null; verified_at: number | null;
  windows_install_date: number | null; windows_product: string | null; windows_version: string | null; windows_build: string | null; checker_version: string | null;
  machine_guid_fingerprint: string | null; volume_serial_fingerprint: string | null; computer_name_fingerprint: string | null;
  machine_guid_changed: number; volume_serial_changed: number; computer_name_changed: number; identity_changed_after_reset: number;
}
interface AuditEvent { id: string; server_timestamp: number; event_type: string; metadata: string; }
const app = document.querySelector<HTMLElement>('#app')!;
let endpoint = '', username = '', detail_id = '', screen = 'login', filter = 'all', busy = false, dev = false, history = false;
let clock_offset = 0, expires_at = 0, poll_running = false, detail_key = '';
mount_window();
const active = (s: Session) => ['active','reset_marked'].includes(s.status);
const age = (s: number | null) => { if (!s) return 'Not yet connected'; const n = Math.max(0,Math.floor(Date.now()/1000+clock_offset)-s); return n < 2 ? 'Just now' : n < 60 ? `${n} seconds ago` : n < 3600 ? `${Math.floor(n/60)} minutes ago` : date(s); };
const label = (s: Session) => s.status === 'completed' ? 'Verified' : s.status === 'mismatch' ? 'HWID mismatch' : s.status === 'reset_marked' ? 'Reset in progress' : s.status === 'active' ? (s.current_hwid ? 'Monitoring' : 'Awaiting device') : s.status.charAt(0).toUpperCase()+s.status.slice(1);
function badge(s: Session) { return `<span class="badge ${s.status === 'completed' ? 'success' : s.status === 'mismatch' ? 'error' : ''}">${escape(label(s))}</span>`; }
function message(error: unknown) {
  if ((error as ClientError)?.code === 'unauthorized') { username = ''; screen = 'login'; login(); }
  const slot = document.querySelector<HTMLElement>('#error'); if (slot) { slot.textContent = error_message(error); slot.hidden = false; } else toast(error_message(error));
}
async function api<T>(method: string, path: string, payload?: unknown): Promise<T> { return invoke<T>('admin_request', { method, path, payload }); }
function sidebar() {
  document.body.classList.remove('auth-mode');
  let el = document.querySelector<HTMLElement>('.sidebar'); if (!el) { el = document.createElement('aside'); el.className = 'sidebar'; document.querySelector('.app-shell')!.prepend(el); }
  el.innerHTML = `<div class="sidebar-brand">vexor verify<small>Device verification</small></div><nav aria-label="Main navigation"><button id="nav-sessions" class="sidebar-item ${!history && screen !== 'settings' ? 'selected' : ''}">${icon('sessions')}Sessions</button><button id="nav-history" class="sidebar-item ${history && screen !== 'settings' ? 'selected' : ''}">${icon('history')}History</button></nav><div class="sidebar-bottom"><button id="nav-settings" class="sidebar-item ${screen === 'settings' ? 'selected' : ''}">${icon('settings')}Settings</button><button id="logout" class="sidebar-item">${icon('logout')}Sign out</button><div class="account"><span class="avatar">${escape(username.slice(0,1).toUpperCase())}</span><div><div class="account-name">${escape(username)}</div><small>Staff account</small></div></div></div>`;
  el.querySelector('#nav-sessions')!.addEventListener('click', () => { history = false; filter = 'all'; home(); });
  el.querySelector('#nav-history')!.addEventListener('click', () => { history = true; filter = 'all'; home(); });
  el.querySelector('#nav-settings')!.addEventListener('click', settings);
  el.querySelector('#logout')!.addEventListener('click', async () => { busy = true; try { await invoke('admin_logout'); } catch { /* Native credentials are cleared before network I/O. */ } username = ''; screen = 'login'; busy = false; login(); });
}
function header(title: string, subtitle = '', back = false) {
  return `${back ? `<button class="back-link" id="back">${icon('back')}Sessions</button>` : ''}<div class="page-header row"><div><h1>${escape(title)}</h1>${subtitle ? `<small>${escape(subtitle)}</small>` : ''}</div>${!back ? '<button id="new" class="primary">New verification</button>' : ''}</div><p class="error" id="error" role="alert" hidden></p>`;
}
function wire_header() {
  app.querySelector('#new')?.addEventListener('click', create_form);
  app.querySelector('#back')?.addEventListener('click', () => { detail_id = ''; home(); });
}
function login() {
  document.body.classList.add('auth-mode'); document.querySelector('.sidebar')?.remove();
  app.innerHTML = `<div class="auth"><div class="wordmark">vexor</div><p class="subtitle">admin verification</p><form id="login">
    ${dev ? `<details class="dev-config"><summary>Development connection</summary><label for="server">Verification server</label><input id="server" type="url" value="${escape(endpoint)}" required spellcheck="false"></details>` : ''}
    <label for="username">Username</label><input id="username" placeholder="Username" required maxlength="64" autocomplete="username" autocapitalize="none" spellcheck="false">
    <label for="password">Password</label><input id="password" placeholder="Password" type="password" required maxlength="256" autocomplete="current-password">
    <button class="wide primary">Sign in</button><p class="error" id="error" role="alert" hidden></p></form><p class="footer">Private staff access</p></div>`;
  app.querySelector('#login')!.addEventListener('submit', async event => {
    event.preventDefault(); const button = app.querySelector<HTMLButtonElement>('#login button')!; button.disabled = true; button.textContent = 'Signing in…';
    const password = app.querySelector<HTMLInputElement>('#password')!;
    try {
      endpoint = app.querySelector<HTMLInputElement>('#server')?.value.trim() || endpoint; await invoke('set_endpoint', { endpoint });
      const result = await invoke<{username: string; expires_at: number}>('admin_login', { username: app.querySelector<HTMLInputElement>('#username')!.value.trim(), password: password.value });
      password.value = ''; username = result.username; expires_at = result.expires_at; history = false; await home();
    } catch (error) { password.value = ''; message(error); button.disabled = false; button.textContent = 'Sign in'; }
  });
}
async function home() {
  screen = 'home'; detail_id = ''; sidebar();
  app.innerHTML = `${header(history ? 'Verification History' : 'Verification Sessions',history ? 'Completed verifications and their results.' : 'Monitor devices through each reset.')}<div class="summary" id="summary"><div><label>Active</label><strong>—</strong></div><div><label>Verified</label><strong>—</strong></div><div><label>Mismatch</label><strong>—</strong></div></div><div class="row list-toolbar"><h2>${history ? 'Past sessions' : 'Sessions'}</h2><select class="session-filter" id="filter" aria-label="Filter sessions"><option value="all">All sessions</option><option value="active">Active</option><option value="completed">Verified</option><option value="mismatch">Mismatch</option><option value="expired">Expired</option><option value="cancelled">Cancelled</option></select></div><div id="sessions">${loading()}</div><p class="footer">Latest 200 sessions · updates automatically</p>`;
  wire_header(); app.querySelector<HTMLSelectElement>('#filter')!.value = filter;
  app.querySelector('#filter')!.addEventListener('change', event => { filter = (event.target as HTMLSelectElement).value; refresh_home().catch(message); });
  try { await refresh_home(); } catch (error) { message(error); }
}
async function refresh_home() {
  const result = await api<{sessions: Session[]; server_timestamp: number}>('GET','/api/admin/sessions'); if (screen !== 'home') return;
  app.querySelector<HTMLElement>('#error')!.hidden = true; clock_offset = result.server_timestamp-Date.now()/1000;
  app.querySelector('#summary')!.innerHTML = [['Active',result.sessions.filter(active).length],['Verified',result.sessions.filter(s=>s.status==='completed').length],['Mismatch',result.sessions.filter(s=>s.status==='mismatch').length]].map(([title,n])=>`<div><label>${title}</label><strong>${n}</strong></div>`).join('');
  const sessions = result.sessions.filter(s => (!history || !active(s)) && (filter === 'all' || (filter === 'active' ? active(s) : s.status === filter)));
  app.querySelector('#sessions')!.innerHTML = sessions.length ? sessions.map(s=>`<button class="session-row" data-open="${s.id}" aria-label="Open ${escape(s.code)} for ${escape(s.vexor_username)}"><span class="dot ${s.online && active(s) ? 'success' : s.status === 'mismatch' ? 'error' : ''}"></span><div class="session-body"><div class="session-heading"><strong class="mono">${escape(s.code)}</strong><span>${escape(s.vexor_username)}</span></div><div class="session-meta"><span>uid ${escape(s.vexor_uid)}</span><span>${escape(mask_license_key(s.license_key))}</span></div><p class="session-hwid mono">${escape(s.current_hwid_preview || 'Awaiting device connection')}</p><small class="subtle">${s.online && active(s) ? 'Online' : active(s) && !s.current_hwid ? 'Waiting' : active(s) ? 'Offline' : escape(label(s))} · ${s.last_seen_at ? 'updated '+escape(age(s.last_seen_at)).toLowerCase() : 'code ready to share'}</small></div>${badge(s)}<span class="session-chevron">${icon('chevron')}</span></button>`).join('') : empty_state('No sessions yet',history ? 'Completed verifications will appear here.' : 'Create a verification to connect a device.');
  for (const button of app.querySelectorAll<HTMLButtonElement>('[data-open]')) button.addEventListener('click',()=> { detail_id = button.dataset.open!; detail().catch(message); });
}
function create_form() {
  screen = 'create'; sidebar(); app.scrollTop = 0;
  app.innerHTML = `${header('New verification','Create a code for the device you want to verify.',true)}<form class="form-page" id="create"><div class="grid"><div><label for="vexor_username">Vexor username</label><input id="vexor_username" required maxlength="64" placeholder="xynr"></div><div><label for="vexor_uid">Vexor uid</label><input id="vexor_uid" required pattern="[0-9]+" maxlength="32" placeholder="25404"></div></div><label for="license_key">License key</label><input class="mono" id="license_key" required pattern="${license_key_pattern}" maxlength="${license_key_max_length}" placeholder="VXP-0000-1111-2222-3333-4444-5555-6666-7777-8888-F8B3" title="Paste the full license key." spellcheck="false" autocapitalize="none" autocomplete="off"><label for="old_hwid_preview">Old hwid preview</label><input class="mono" id="old_hwid_preview" required maxlength="1024" placeholder="a18c88219d41ab…44a921" spellcheck="false"><label for="note">Note <span class="subtle">(optional)</span></label><textarea id="note" maxlength="1000" placeholder="Context for other staff"></textarea><p class="footer">Share the generated code with the customer.<br>They have 15 minutes to connect.</p><div class="actions"><button class="primary">Create verification</button></div></form>`;
  wire_header();
  app.querySelector('#create')!.addEventListener('submit',async event=> {
    event.preventDefault(); const button = app.querySelector<HTMLButtonElement>('#create button')!; button.disabled = true;
    const payload = Object.fromEntries(['vexor_username','vexor_uid','license_key','old_hwid_preview','note'].map(key=>[key,app.querySelector<HTMLInputElement>(`#${key}`)!.value.trim()]));
    try { const result = await api<{session: Session}>('POST','/api/admin/sessions',payload); detail_id = result.session.id; await detail(); toast('Verification code ready to share'); } catch(error) { message(error); button.disabled = false; }
  });
}
async function detail() {
  screen = 'detail'; detail_key = ''; sidebar(); app.scrollTop = 0;
  app.innerHTML = `<button class="back-link" id="back">${icon('back')}Sessions</button><p class="error" id="error" role="alert" hidden></p><div id="detail" class="detail-content">${loading()}</div>`; wire_header(); await refresh_detail();
}
async function refresh_detail() {
  const id = detail_id, result = await api<{session: Session; events: AuditEvent[]}>('GET',`/api/admin/sessions/${id}`); if (screen !== 'detail' || detail_id !== id) return;
  const s = result.session, structural = JSON.stringify([{...s,last_seen_at:null,server_timestamp:null,revision:null,mutation_id:null},result.events.map(e=>e.id)]);
  const last = app.querySelector('#detail-last-update'); if (last) last.textContent = age(s.last_seen_at);
  app.querySelector<HTMLElement>('#error')!.hidden = true;
  if (structural === detail_key) return; detail_key = structural;
  const claim_input = app.querySelector<HTMLInputElement>('#claimed')?.value || '', focused = document.activeElement?.id === 'claimed';
  const input_selection = [app.querySelector<HTMLInputElement>('#claimed')?.selectionStart,app.querySelector<HTMLInputElement>('#claimed')?.selectionEnd], scroll = app.scrollTop;
  const audit_open = app.querySelector<HTMLDetailsElement>('.audit')?.open || false;
  app.querySelector('#detail')!.innerHTML = `<div class="detail-title"><div class="row"><div><h1>${escape(s.code)}</h1><p>${escape(s.vexor_username)} · uid ${escape(s.vexor_uid)}</p></div><button class="copy" data-copy="${escape(s.code)}" aria-label="Copy verification code" title="Copy code">${icon('copy')}</button></div>${badge(s)}</div>
    ${s.claimed_hwid_preview ? `<section class="result ${s.status === 'mismatch' ? 'mismatch' : ''}" aria-label="${s.status === 'completed' ? 'VERIFIED' : 'HWID MISMATCH'}"><div class="result-icon">${s.status === 'completed' ? '✓' : '!'}</div><h2>${s.status === 'completed' ? 'Verified' : 'HWID mismatch'}</h2><p>${s.status === 'completed' ? 'The claimed hwid preview matches the device monitored during the reset.' : 'The hwid that claimed the license does not match the device monitored during the reset.'}</p><dl><dt>Expected</dt><dd>${copyable(s.expected_hwid_preview)}</dd><dt>Claimed</dt><dd>${copyable(s.claimed_hwid_preview)}</dd></dl></section>` : ''}
    <section class="section"><h2>License</h2><dl><dt>License key</dt><dd>${is_full_license_key(s.license_key) ? copyable(s.license_key) : `<span class="subtle">Full key unavailable for this legacy session (${escape(mask_license_key(s.license_key))}).</span>`}</dd><dt>Old hwid</dt><dd>${copyable(s.old_hwid_preview)}</dd></dl></section>
    <section class="section"><h2>Monitored device</h2><dl><dt>Current hwid</dt><dd>${copyable(s.current_hwid_preview)}</dd><dt>Status</dt><dd><span class="dot ${s.online && active(s) ? 'success' : ''}"></span>${s.online && active(s) ? 'Online' : s.current_hwid ? 'Offline' : 'Awaiting connection'}</dd><dt>Last update</dt><dd id="detail-last-update">${escape(age(s.last_seen_at))}</dd><dt>Windows installed</dt><dd>${escape(date(s.windows_install_date))}</dd></dl></section>
    <section class="section"><h2>Identity</h2><dl>${[['Machine guid','machine_guid'],['Volume','volume_serial'],['Computer name','computer_name']].map(([title,key])=>`<dt>${title}</dt><dd class="${s[`${key}_changed` as keyof Session] ? 'error' : 'muted'}">${s[`${key}_changed` as keyof Session] ? 'Changed during session' : s.current_hwid ? 'Unchanged' : 'Awaiting device'}</dd>`).join('')}</dl></section>
    ${s.identity_changed_after_reset ? '<div class="notice error">Device identity changed after reset.<p>Review the event history before trusting device continuity.</p></div>' : ''}
    ${s.status === 'reset_marked' ? `<section class="section"><h2>Hwid reset in progress</h2><dl><dt>Expected hwid</dt><dd>${copyable(s.expected_hwid_preview)}</dd></dl><div class="continuity"><p><span class="dot ${s.online ? 'success' : ''}"></span>${s.online ? 'Device still connected' : 'Waiting for device to reconnect'}</p><p><span class="dot ${s.current_hwid === s.expected_hwid ? 'success' : 'error'}"></span>${s.current_hwid === s.expected_hwid ? 'Expected hwid still being reported' : 'Device is reporting a different hwid'}</p></div></section><form class="detail-actions" id="claim"><label for="claimed">Hwid shown in Vexor after claim</label><input class="mono" id="claimed" required maxlength="1024" value="${escape(claim_input)}" placeholder="Paste hwid preview" spellcheck="false"><div class="actions"><button class="primary" ${!s.online ? 'disabled' : ''}>Verify claim</button></div>${!s.online ? '<p>Reconnect the device to verify the claim.</p>' : ''}</form>` : ''}
    ${s.status === 'active' ? `<div class="detail-actions">${!s.current_hwid ? `<div class="notice">Share this code with the customer.<p class="mono selectable">${escape(s.code)}</p><small>Connect before ${escape(date(s.expires_at))}.</small></div>` : ''}<button class="primary" id="reset" ${!s.online || !s.current_hwid ? 'disabled' : ''}>Mark hwid reset</button><p>This saves the monitored device as the expected hwid.<br>Perform the reset in the Vexor panel.</p></div>` : ''}
    ${active(s) ? '<button class="quiet danger" id="cancel">Cancel session</button>' : ''}
    ${s.note ? `<section class="section"><h2>Staff note</h2><p class="muted selectable">${escape(s.note)}</p></section>` : ''}
    <details class="audit" ${audit_open ? 'open' : ''}><summary>Event history · ${result.events.length} events</summary>${result.events.map(event=>`<div class="event"><div class="row"><span>${escape(event.event_type.replaceAll('_',' '))}</span><small>${escape(date(event.server_timestamp))}</small></div><p class="mono">${escape(event.metadata)}</p></div>`).join('')}<section class="section"><h2>Device evidence</h2><dl><dt>Windows</dt><dd>${escape([s.windows_product,s.windows_version,s.windows_build].filter(Boolean).join(' · ') || '—')}</dd><dt>Checker version</dt><dd>${escape(s.checker_version || '—')}</dd><dt>Created</dt><dd>${escape(date(s.created_at))}</dd><dt>Expires</dt><dd>${escape(date(s.expires_at))}</dd></dl>${[['Machine guid','machine_guid'],['Volume','volume_serial'],['Computer name','computer_name']].map(([title,key])=>`<label>${title} fingerprint</label><p class="mono subtle">${escape(s[`${key}_fingerprint` as keyof Session] || 'Awaiting device')}</p>`).join('')}</section></details><p class="footer">Device identity is client-reported. A preview match compares<br>the visible hwid characters supplied by Vexor.</p>`;
  wire_copy(app);
  app.querySelector('#reset')?.addEventListener('click',async()=> {
    busy = true; try { if(await confirm_action('Mark hwid reset',`Save ${s.current_hwid_preview} as the expected device and begin the reset?`)) { await api('POST',`/api/admin/sessions/${id}/reset`,{confirmed:true}); await refresh_detail(); } } catch(error) { message(error); } finally { busy = false; }
  });
  app.querySelector('#cancel')?.addEventListener('click',async()=> {
    busy = true; try { if(await confirm_action('Cancel verification','End this session? The customer will be told that verification was cancelled.')) { await api('POST',`/api/admin/sessions/${id}/cancel`,{confirmed:true}); await refresh_detail(); } } catch(error) { message(error); } finally { busy = false; }
  });
  app.querySelector('#claim')?.addEventListener('submit',async event=> {
    event.preventDefault(); if(busy) return; busy = true; const button = app.querySelector<HTMLButtonElement>('#claim button')!; button.disabled = true;
    try { await api('POST',`/api/admin/sessions/${id}/claim`,{claimed_hwid_preview:app.querySelector<HTMLInputElement>('#claimed')!.value}); await refresh_detail(); app.scrollTop = 0; } catch(error) { message(error); button.disabled = false; } finally { busy = false; }
  });
  if(focused) { const input = app.querySelector<HTMLInputElement>('#claimed'); input?.focus(); if(input_selection[0] != null) input?.setSelectionRange(input_selection[0],input_selection[1] ?? input_selection[0]); }
  app.scrollTop = scroll;
}
function settings() {
  screen = 'settings'; sidebar(); app.scrollTop = 0;
  app.innerHTML = `<div class="page-header"><h1>Settings</h1><small>Your staff account and connection.</small></div><p class="error" id="error" role="alert" hidden></p><section class="section settings-form"><h2>Account</h2><dl><dt>Username</dt><dd>${escape(username)}</dd><dt>Access</dt><dd>Private staff</dd><dt>Session ends</dt><dd>${escape(date(expires_at))}</dd></dl></section><section class="section settings-form"><h2>Connection</h2><dl><dt>Environment</dt><dd>${dev ? 'Development' : 'Production'}</dd><dt>Backend</dt><dd class="mono">${escape(endpoint)}</dd></dl><p class="footer">Credentials and session tokens stay in memory.<br>Sign out to revoke your session.</p></section>`;
}
setInterval(async()=> {
  if(!username || busy || poll_running) return;
  if(Date.now()/1000+clock_offset >= expires_at) { busy = true; try { await invoke('admin_logout'); } catch {} username = ''; screen = 'login'; busy = false; login(); message({message:'Your session expired. Sign in again.'}); return; }
  poll_running = true; try { if(screen === 'home') await refresh_home(); else if(screen === 'detail') await refresh_detail(); } catch(error) { message(error); } finally { poll_running = false; }
},3000);
invoke<{endpoint: string; development: boolean}>('app_info').then(info=> { endpoint = info.endpoint; dev = info.development; login(); }).catch(message);
