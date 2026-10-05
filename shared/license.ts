// Keep form validation, API validation and masked displays consistent.
export const license_key_pattern = '[Vv][Xx][Pp](-[a-fA-F0-9]{4}){10}';
export const license_key_length = 53;
export const is_full_license_key = (key: string) => new RegExp(`^${license_key_pattern}$`).test(key);
export function mask_license_key(key: string): string {
  // Migrated sessions retain their original suffix; the missing key cannot be recovered.
  return is_full_license_key(key) ? `${key.slice(0, 3)}-****-****-${key.slice(-4)}` : `****-${key}`;
}
