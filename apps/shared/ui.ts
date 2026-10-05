import { getCurrentWindow } from '@tauri-apps/api/window';
export interface ClientError { code?: string; message?: string; }
export const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, v => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[v]!));
export const date = (seconds: number | null): string => seconds ? new Date(seconds * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
export const error_message = (error: unknown) => (error as ClientError)?.message || 'Unable to complete this action.';
export function confirm_action(title: string, message: string): Promise<boolean> {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.innerHTML = `<h2>${escape(title)}</h2><p class="muted">${escape(message)}</p><div class="actions"><button id="no">Cancel</button><button id="yes" class="primary">Confirm</button></div>`;
    document.body.append(dialog);
    const finish = (value: boolean) => { dialog.close(); dialog.remove(); resolve(value); };
    dialog.querySelector('#no')!.addEventListener('click', () => finish(false));
    dialog.querySelector('#yes')!.addEventListener('click', () => finish(true));
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
    dialog.showModal();
  });
}
export const icon = (name: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${({sessions:'<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8 9h8M8 13h5M8 17h3"/>',history:'<path d="M4 10a8 8 0 1 1 1 8M4 5v5h5M12 8v5l3 2"/>',settings:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="#111113"/><circle cx="15" cy="17" r="3" fill="#111113"/>',logout:'<path d="M10 4H5v16h5M9 12h11m-4-4 4 4-4 4"/>',back:'<path d="m14 6-6 6 6 6"/>',chevron:'<path d="m9 6 6 6-6 6"/>',copy:'<rect x="8" y="8" width="12" height="12" rx="3"/><path d="M15 5V4H4v11h1"/>',minimize:'<path d="M6 12h12"/>',maximize:'<rect x="6" y="6" width="12" height="12" rx="2"/>',restore:'<path d="M9 5h10v10M5 9h10v10H5z"/>',close:'<path d="m7 7 10 10M17 7 7 17"/>'} as Record<string,string>)[name] || ''}</svg>`;
export function mount_window(checker = false) {
  document.body.classList.add(checker ? 'checker-mode' : 'auth-mode');
  const frame = document.createElement('header'); frame.className = 'titlebar';
  frame.innerHTML = `<div class="titlebar-brand">vexor <span>·</span> ${checker ? 'verification' : 'verify'}</div><div class="window-controls"><button class="window-control" id="window-minimize" aria-label="Minimize" title="Minimize">${icon('minimize')}</button>${checker ? '' : `<button class="window-control" id="window-maximize" aria-label="Maximize" title="Maximize">${icon('maximize')}</button>`}<button class="window-control close" id="window-close" aria-label="Close" title="Close">${icon('close')}</button></div>`;
  const shell = document.createElement('div'); shell.className = 'app-shell';
  const app = document.querySelector('#app')!; app.replaceWith(shell); shell.append(app); document.body.prepend(frame);
  const win = getCurrentWindow();
  frame.addEventListener('mousedown', event => { if (event.button === 0 && !(event.target as Element).closest('button')) win.startDragging().catch(() => toast('Unable to move window.')); });
  if (!checker) frame.addEventListener('dblclick', event => { if (!(event.target as Element).closest('button')) win.toggleMaximize().catch(() => toast('Unable to resize window.')); });
  frame.querySelector('#window-minimize')!.addEventListener('click', () => win.minimize().catch(() => toast('Unable to minimize window.')));
  frame.querySelector('#window-maximize')?.addEventListener('click', () => win.toggleMaximize().catch(() => toast('Unable to resize window.')));
  frame.querySelector('#window-close')!.addEventListener('click', () => win.close().catch(() => toast('Unable to close window.')));
  if (!checker) {
    const update = async () => { const maximized = await win.isMaximized(); const button = frame.querySelector<HTMLButtonElement>('#window-maximize')!; button.innerHTML = icon(maximized ? 'restore' : 'maximize'); button.title = maximized ? 'Restore' : 'Maximize'; button.setAttribute('aria-label', button.title); document.body.classList.toggle('maximized', maximized); };
    win.onResized(update).catch(() => {}); update().catch(() => {});
  }
}
export function toast(message: string) {
  document.querySelector('.toast')?.remove(); const el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role','status'); el.textContent = message; document.body.append(el); setTimeout(() => el.remove(), 2600);
}
export const copyable = (value: string | null) => `<span class="copyable"><span class="mono">${escape(value || 'Awaiting checker')}</span>${value ? `<button class="copy" type="button" data-copy="${escape(value)}" aria-label="Copy value" title="Copy">${icon('copy')}</button>` : ''}</span>`;
export function wire_copy(root: Element) { root.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(button => button.addEventListener('click', async () => { try { await navigator.clipboard.writeText(button.dataset.copy!); toast('Copied to clipboard'); } catch { toast('Select the value to copy it.'); } })); }
export const loading = () => '<div class="loading" role="status"><span class="spinner"></span>Loading sessions…</div>';
export const empty_state = (title: string, message: string) => `<div class="empty">${icon('sessions')}<h2>${escape(title)}</h2><p class="muted">${escape(message)}</p></div>`;
