CREATE TABLE IF NOT EXISTS raw_mails (
    id INTEGER PRIMARY KEY,
    message_id TEXT,
    source TEXT,
    address TEXT,
    raw TEXT,
    raw_blob BLOB,
    metadata TEXT,
    is_unread INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    storage_backend TEXT NOT NULL DEFAULT 'd1' CHECK (storage_backend IN ('d1', 'r2')),
    r2_key TEXT,
    raw_encoding TEXT,
    raw_size INTEGER,
    stored_size INTEGER,
    content_sha256 TEXT,
    subject TEXT,
    sender TEXT,
    preview TEXT,
    attachment_count INTEGER
);

CREATE INDEX IF NOT EXISTS idx_raw_mails_address ON raw_mails(address);

CREATE INDEX IF NOT EXISTS idx_raw_mails_created_at ON raw_mails(created_at);

CREATE INDEX IF NOT EXISTS idx_raw_mails_message_id ON raw_mails(message_id);

CREATE INDEX IF NOT EXISTS idx_raw_mails_cleanup_unknown ON raw_mails(created_at, id, address);

CREATE INDEX IF NOT EXISTS idx_raw_mails_source_domain_created_at ON raw_mails(lower(trim(substr(source, instr(source, '@') + 1), ' <>')), created_at, id);

CREATE TABLE IF NOT EXISTS address (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    password TEXT,
    source_meta TEXT,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_address_name ON address(name);

CREATE INDEX IF NOT EXISTS idx_address_created_at ON address(created_at);

CREATE INDEX IF NOT EXISTS idx_address_updated_at ON address(updated_at);

CREATE INDEX IF NOT EXISTS idx_address_source_meta ON address(source_meta);

CREATE INDEX IF NOT EXISTS idx_address_expires_at ON address(expires_at);

CREATE TABLE IF NOT EXISTS auto_reply_mails (
    id INTEGER PRIMARY KEY,
    source_prefix TEXT,
    name TEXT,
    address TEXT UNIQUE,
    subject TEXT,
    message TEXT,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auto_reply_mails_address ON auto_reply_mails(address);

CREATE TABLE IF NOT EXISTS address_sender (
    id INTEGER PRIMARY KEY,
    address TEXT UNIQUE,
    balance INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_address_sender_address ON address_sender(address);

CREATE TABLE IF NOT EXISTS sendbox (
    id INTEGER PRIMARY KEY,
    address TEXT,
    raw TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sendbox_address ON sendbox(address);

CREATE INDEX IF NOT EXISTS idx_sendbox_created_at ON sendbox(created_at);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    user_email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    user_info TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_user_email ON users(user_email);

CREATE TABLE IF NOT EXISTS users_address (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    address_id INTEGER UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_address_user_id ON users_address(user_id);

CREATE INDEX IF NOT EXISTS idx_users_address_address_id ON users_address(address_id);

CREATE TABLE IF NOT EXISTS user_roles (
    id INTEGER PRIMARY KEY,
    user_id INTEGER UNIQUE NOT NULL,
    role_text TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id);

CREATE TABLE IF NOT EXISTS user_passkeys (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    passkey_name TEXT NOT NULL,
    passkey_id TEXT NOT NULL,
    passkey TEXT NOT NULL,
    counter INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_passkeys_user_id ON user_passkeys(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_passkeys_user_id_passkey_id ON user_passkeys(user_id, passkey_id);

CREATE TABLE IF NOT EXISTS redeem_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    redeem_type TEXT NOT NULL,
    value TEXT NOT NULL,
    result TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    redeemed INTEGER NOT NULL DEFAULT 0 CHECK (redeemed IN (0, 1)),
    expires_at DATETIME NOT NULL,
    redeemed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_redeem_codes_type ON redeem_codes(redeem_type);

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
