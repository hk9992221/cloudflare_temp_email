-- v0.0.13 to v0.0.14. For a repeatable or partially applied migration,
-- use the administrator migration, which checks each column before adding it.
ALTER TABLE raw_mails ADD COLUMN original_recipient TEXT;
ALTER TABLE raw_mails ADD COLUMN alias_tag TEXT;
CREATE INDEX IF NOT EXISTS idx_raw_mails_address_alias_tag ON raw_mails(address, alias_tag, id);
UPDATE settings SET value = 'v0.0.14', updated_at = CURRENT_TIMESTAMP
WHERE key = 'db_version' AND value = 'v0.0.13';
