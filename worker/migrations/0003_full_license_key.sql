-- Preserve historical suffix-only values and all session/audit relationships.
-- New sessions store the full key; staff UI identifies legacy values explicitly.
ALTER TABLE verification_sessions RENAME COLUMN license_suffix TO license_key;
