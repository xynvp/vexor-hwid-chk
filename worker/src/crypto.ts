const encoder = new TextEncoder();
export function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes instanceof Uint8Array ? bytes : bytes)).map(v => v.toString(16).padStart(2, '0')).join('');
}
export async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}
export async function hmac(secret: string, domain: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(domain + '\0' + value)));
}
export function random_token(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}
export function random_code(): string {
  // 32 symbols, exact uniform sampling (no modulo bias), 40 bits of entropy.
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  return 'VXH-' + Array.from(crypto.getRandomValues(new Uint8Array(8)), v => alphabet[v & 31]).join('');
}
export function constant_equal(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
}
export function hwid_preview(hwid: string): string { return hwid.slice(0, 14) + '…' + hwid.slice(-6); }
export function normalize_preview(value: string): string {
  // Accept the panel's ellipsis or three ASCII dots. Never normalize hex case.
  return value.replace(/\s/g, '').replace(/\.{3}/g, '…');
}
export async function password_hash(password: string, salt = random_token().slice(0, 32)): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256);
  return `pbkdf2-sha256$100000$${salt}$${hex(hash)}`;
}
export async function password_verify(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256' || parts[1] !== '100000') return false;
  return constant_equal(await password_hash(password, parts[2]), stored);
}
