-- Canonical v0.0.11 to v0.0.12 DDL. Use the admin migration for safe repeat/resume.
ALTER TABLE raw_mails ADD COLUMN storage_backend TEXT NOT NULL DEFAULT 'd1' CHECK (storage_backend IN ('d1', 'r2'));
ALTER TABLE raw_mails ADD COLUMN r2_key TEXT;
ALTER TABLE raw_mails ADD COLUMN raw_encoding TEXT;
ALTER TABLE raw_mails ADD COLUMN raw_size INTEGER;
ALTER TABLE raw_mails ADD COLUMN stored_size INTEGER;
ALTER TABLE raw_mails ADD COLUMN content_sha256 TEXT;
ALTER TABLE raw_mails ADD COLUMN subject TEXT;
ALTER TABLE raw_mails ADD COLUMN sender TEXT;
ALTER TABLE raw_mails ADD COLUMN preview TEXT;
ALTER TABLE raw_mails ADD COLUMN attachment_count INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_mails_r2_key
    ON raw_mails(r2_key) WHERE r2_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_raw_mails_storage_backend
    ON raw_mails(storage_backend, id);

CREATE TABLE IF NOT EXISTS mail_storage_gc (
    object_key TEXT PRIMARY KEY,
    reason TEXT NOT NULL CHECK (reason IN ('write', 'orphan', 'delete', 'verify')),
    mail_id INTEGER,
    next_retry_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error_code TEXT,
    lease_token TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_mail_storage_gc_due
    ON mail_storage_gc(next_retry_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_storage_gc_mail_id
    ON mail_storage_gc(mail_id) WHERE mail_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mail_storage_migration (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    cursor INTEGER NOT NULL DEFAULT 0,
    upper_id INTEGER NOT NULL,
    scanned INTEGER NOT NULL DEFAULT 0,
    migrated INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    bytes_migrated INTEGER NOT NULL DEFAULT 0,
    paused INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS mail_storage_migration_failures (
    mail_id INTEGER PRIMARY KEY,
    error_code TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TRIGGER IF NOT EXISTS raw_mails_storage_insert_guard
    BEFORE INSERT ON raw_mails
    WHEN (NEW.storage_backend = 'r2' AND (
            NEW.r2_key IS NULL OR NEW.raw IS NOT NULL OR NEW.raw_blob IS NOT NULL
            OR NEW.raw_encoding IS NULL OR NEW.raw_size IS NULL OR NEW.stored_size IS NULL
            OR NEW.content_sha256 IS NULL)) OR (NEW.storage_backend = 'd1' AND NEW.r2_key IS NOT NULL)
    BEGIN
        SELECT RAISE(ABORT, 'Invalid mail storage row');
    END;

CREATE TRIGGER IF NOT EXISTS raw_mails_storage_update_guard
    BEFORE UPDATE OF storage_backend, r2_key, raw, raw_blob, raw_encoding, raw_size, stored_size, content_sha256 ON raw_mails
    WHEN (OLD.storage_backend = 'r2' AND (NEW.storage_backend <> 'r2' OR NEW.r2_key IS NOT OLD.r2_key))
        OR (NEW.storage_backend = 'r2' AND (
            NEW.r2_key IS NULL OR NEW.raw IS NOT NULL OR NEW.raw_blob IS NOT NULL
            OR NEW.raw_encoding IS NULL OR NEW.raw_size IS NULL OR NEW.stored_size IS NULL
            OR NEW.content_sha256 IS NULL)) OR (NEW.storage_backend = 'd1' AND NEW.r2_key IS NOT NULL)
    BEGIN
        SELECT RAISE(ABORT, 'Invalid mail storage row');
    END;

CREATE TRIGGER IF NOT EXISTS raw_mails_storage_delete
    AFTER DELETE ON raw_mails
    BEGIN
        INSERT OR IGNORE INTO mail_storage_gc(object_key, reason, next_retry_at)
            SELECT OLD.r2_key, 'delete', unixepoch() WHERE OLD.r2_key IS NOT NULL;
        UPDATE mail_storage_gc SET mail_id = NULL, reason = 'orphan', next_retry_at = unixepoch()
            WHERE mail_id = OLD.id;
        DELETE FROM mail_storage_migration_failures WHERE mail_id = OLD.id;
    END;

INSERT INTO settings(key, value) VALUES ('db_version', 'v0.0.12')
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP;
