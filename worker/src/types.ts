export interface Env {
  DB: D1Database;
  HWID_FINGERPRINT_SECRET: string;
  DISCORD_WEBHOOK_URL?: string;
  ENVIRONMENT?: string;
  ALLOWED_ORIGINS?: string;
}
export interface Identity {
  machine_guid: string;
  volume_serial: string;
  computer_name: string;
  windows_install_date: number;
  windows_product: string;
  windows_version: string;
  windows_build: string;
  checker_version: string;
}
export interface Session {
  id: string; code: string; status: string;
  vexor_username: string; vexor_uid: string; license_key: string; old_hwid_preview: string; note: string;
  current_hwid: string | null; current_hwid_preview: string | null;
  expected_hwid: string | null; expected_hwid_preview: string | null; claimed_hwid_preview: string | null;
  machine_guid_fingerprint: string | null; volume_serial_fingerprint: string | null; computer_name_fingerprint: string | null;
  machine_guid_changed: number; volume_serial_changed: number; computer_name_changed: number; identity_changed_after_reset: number;
  windows_install_date: number | null; windows_product: string | null; windows_version: string | null; windows_build: string | null; checker_version: string | null;
  checker_token_hash: string | null; checker_online: number;
  created_at: number; expires_at: number; first_connected_at: number | null; last_seen_at: number | null;
  reset_at: number | null; verified_at: number | null; completed_at: number | null;
  created_by_admin_id: string; revision: number; mutation_id: string | null;
}
