import { normalize_preview } from './crypto';
import type { Identity } from './types';
export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'invalid_request');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !fields.includes(key))) throw new ApiError(400, 'invalid_request');
  return result;
}
export function string(value: unknown, min: number, max: number, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || (pattern && !pattern.test(value))) throw new ApiError(400, 'invalid_request');
  return value;
}
export function preview(value: unknown): string {
  // Whitespace is harmless when staff pastes the panel value.
  if (typeof value !== 'string' || value.length > 100) throw new ApiError(400, 'invalid_request');
  return string(normalize_preview(value), 21, 21, /^[a-f0-9]{14}…[a-f0-9]{6}$/);
}
export function identity(value: unknown): Identity {
  const v = object(value, ['machine_guid','volume_serial','computer_name','windows_install_date','windows_product','windows_version','windows_build','checker_version']);
  const volume = string(v.volume_serial, 1, 10, /^(0|[1-9][0-9]*)$/);
  if (Number(volume) > 4294967295) throw new ApiError(400, 'invalid_request');
  if (!Number.isSafeInteger(v.windows_install_date) || (v.windows_install_date as number) < 0 || (v.windows_install_date as number) > 4102444800) throw new ApiError(400, 'invalid_request');
  return {
    machine_guid: string(v.machine_guid, 1, 128), volume_serial: volume,
    computer_name: string(v.computer_name, 1, 255),
    windows_install_date: v.windows_install_date as number,
    windows_product: string(v.windows_product, 1, 128), windows_version: string(v.windows_version, 1, 64),
    windows_build: string(v.windows_build, 1, 64), checker_version: string(v.checker_version, 1, 32, /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/)
  };
}
export async function body(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ApiError(415, 'invalid_request');
  if (Number(request.headers.get('content-length') || 0) > 8192) throw new ApiError(413, 'request_too_large');
  if (!request.body) throw new ApiError(400, 'invalid_request');
  const reader = request.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) { await reader.cancel(); throw new ApiError(413, 'request_too_large'); }
      chunks.push(value);
    }
    const data = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_request');
  }
}
