import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import '../../shared/style.css';
import { error_message, escape, mount_window } from '../../shared/ui';
interface View { connection: string; status: string; current_hwid_preview: string | null; expected_hwid_preview: string | null; identity_changed_after_reset: boolean; last_update: number | null; message: string; }
const app = document.querySelector<HTMLElement>('#app')!;
let view: View | null = null, endpoint = '', dev = false, last_received = 0, rendered = '';
mount_window(true);
function initial() {
  app.innerHTML = `<div class="checker"><div class="wordmark">vexor</div><h1>hwid verification</h1><p class="checker-intro">Enter the verification code provided<br>by staff.</p><form id="start">
    ${dev ? `<details class="dev-config"><summary>Development connection</summary><label for="server">Verification server</label><input id="server" type="url" required value="${escape(endpoint)}" spellcheck="false"></details>` : ''}
    <label for="code">Verification code</label><input class="code-input" id="code" required maxlength="20" placeholder="VXH-7K4P92" autocomplete="off" autocapitalize="characters" spellcheck="false">
    <button class="primary wide" type="submit">Continue</button><p id="error" role="alert" class="error" hidden></p></form>
    <p class="footer">Only device identifiers required for verification<br>are processed.</p></div>`;
  app.querySelector('#start')!.addEventListener('submit', async event => {
    event.preventDefault();
    const button = app.querySelector<HTMLButtonElement>('#start button')!, error = app.querySelector<HTMLElement>('#error')!;
    button.disabled = true; button.textContent = 'Connecting…'; error.hidden = true;
    try {
      endpoint = app.querySelector<HTMLInputElement>('#server')?.value.trim() || endpoint;
      await invoke('set_endpoint', { endpoint });
      await invoke('checker_start', { code: app.querySelector<HTMLInputElement>('#code')!.value.trim().toUpperCase() });
      view = await invoke<View>('checker_status'); last_received = performance.now(); render();
    } catch (failure) { error.textContent = error_message(failure); error.hidden = false; button.disabled = false; button.textContent = 'Continue'; }
  });
}
function render() {
  if (!view?.connection) return;
  const key = JSON.stringify([view.connection,view.status,view.current_hwid_preview,view.identity_changed_after_reset,view.message]);
  if (key === rendered) return; rendered = key;
  const terminal = ['completed','failed','expired','cancelled'].includes(view.connection), success = view.connection === 'completed', bad = view.connection === 'failed';
  const title = success ? 'Verification completed' : bad ? 'Verification failed' : view.connection === 'expired' ? 'Verification expired' : view.connection === 'cancelled' ? 'Verification cancelled' : 'Verification active';
  const state = view.connection === 'reconnecting' ? 'Reconnecting' : view.connection === 'connecting' ? 'Connecting' : success ? 'Completed' : bad ? 'Failed' : view.connection === 'expired' ? 'Expired' : view.connection === 'cancelled' ? 'Cancelled' : 'Connected';
  app.innerHTML = `<div class="checker"><div class="wordmark">vexor</div><h1>${title}</h1><div class="connection" role="status"><div class="connection-symbol ${success ? 'success' : bad ? 'error' : ''}">${success ? '✓' : bad ? '!' : ['connecting','reconnecting'].includes(view.connection) ? '<span class="spinner"></span>' : `<span class="dot ${terminal ? '' : 'success'}"></span>`}</div><div class="connection-label ${bad ? 'error' : ''}">${state}</div></div>
    <p class="checker-intro">${success ? 'Your verification is complete.' : bad ? 'Please contact staff to continue.' : terminal ? 'This verification has ended.' : view.connection === 'reconnecting' ? 'Restoring your connection.<br>Keep this window open.' : 'Your device is being monitored<br>during the hwid reset process.'}</p>
    <div class="device-info"><label>hwid</label><p class="mono">${escape(view.current_hwid_preview || 'Waiting for device…')}</p><label>last update</label><p id="last-update">Just now</p></div>
    ${view.identity_changed_after_reset && !terminal ? '<p class="error" role="status">Your device identity changed. Staff has been notified.</p>' : ''}
    ${bad && view.status === 'mismatch' ? '<p class="error">The claimed hwid differs from this device.</p>' : ''}
    ${view.message && !['reconnecting','connecting'].includes(view.connection) ? `<p class="error" role="alert">${escape(view.message)}</p>` : ''}
    <p class="instruction">${terminal ? 'You may close this window.' : 'Keep this window open until staff tells you<br>the verification is complete.'}</p></div>`;
}
async function boot() {
  const info = await invoke<{ endpoint: string; development: boolean }>('app_info'); endpoint = info.endpoint; dev = info.development;
  await listen<View>('checker_status', event => { if (event.payload.last_update !== view?.last_update) last_received = performance.now(); view = event.payload; render(); });
  initial();
}
setInterval(() => {
  const slot = document.querySelector('#last-update');
  if (slot && view?.last_update) { const seconds = Math.max(0,Math.floor((performance.now()-last_received)/1000)); slot.textContent = seconds < 2 ? 'Just now' : `${seconds} seconds ago`; }
},1000);
boot().catch(error => { app.innerHTML = `<div class="checker"><div class="wordmark">vexor</div><h1>Unable to start</h1><p class="error">${escape(error_message(error))}</p></div>`; });
