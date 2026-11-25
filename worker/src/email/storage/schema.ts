const columns = {
    storage_backend: "TEXT NOT NULL DEFAULT 'd1' CHECK (storage_backend IN ('d1', 'r2'))",
    r2_key: 'TEXT',
    raw_encoding: 'TEXT',
    raw_size: 'INTEGER',
    stored_size: 'INTEGER',
    content_sha256: 'TEXT',
    subject: 'TEXT',
    sender: 'TEXT',
    preview: 'TEXT',
    attachment_count: 'INTEGER',
};

const schema = {
    idx_raw_mails_r2_key: `CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_mails_r2_key
        ON raw_mails(r2_key) WHERE r2_key IS NOT NULL`,
    idx_raw_mails_storage_backend: `CREATE INDEX IF NOT EXISTS idx_raw_mails_storage_backend
        ON raw_mails(storage_backend, id)`,
    mail_storage_gc: `CREATE TABLE IF NOT EXISTS mail_storage_gc (
        object_key TEXT PRIMARY KEY,
        reason TEXT NOT NULL CHECK (reason IN ('write', 'orphan', 'delete', 'verify')),
        mail_id INTEGER,
        next_retry_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error_code TEXT,
        lease_token TEXT,
        lease_until INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,
    idx_mail_storage_gc_due: `CREATE INDEX IF NOT EXISTS idx_mail_storage_gc_due
        ON mail_storage_gc(next_retry_at)`,
    idx_mail_storage_gc_mail_id: `CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_storage_gc_mail_id
        ON mail_storage_gc(mail_id) WHERE mail_id IS NOT NULL`,
    mail_storage_migration: `CREATE TABLE IF NOT EXISTS mail_storage_migration (
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
    )`,
    mail_storage_migration_failures: `CREATE TABLE IF NOT EXISTS mail_storage_migration_failures (
        mail_id INTEGER PRIMARY KEY,
        error_code TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,
    raw_mails_storage_insert_guard: `CREATE TRIGGER IF NOT EXISTS raw_mails_storage_insert_guard
        BEFORE INSERT ON raw_mails
        WHEN (NEW.storage_backend = 'r2' AND (
                NEW.r2_key IS NULL OR NEW.raw IS NOT NULL OR NEW.raw_blob IS NOT NULL
                OR NEW.raw_encoding IS NULL OR NEW.raw_size IS NULL OR NEW.stored_size IS NULL
                OR NEW.content_sha256 IS NULL)) OR (NEW.storage_backend = 'd1' AND NEW.r2_key IS NOT NULL)
        BEGIN
            SELECT RAISE(ABORT, 'Invalid mail storage row');
        END`,
    raw_mails_storage_update_guard: `CREATE TRIGGER IF NOT EXISTS raw_mails_storage_update_guard
        BEFORE UPDATE OF storage_backend, r2_key, raw, raw_blob, raw_encoding, raw_size, stored_size, content_sha256 ON raw_mails
        WHEN (OLD.storage_backend = 'r2' AND (NEW.storage_backend <> 'r2' OR NEW.r2_key IS NOT OLD.r2_key))
            OR (NEW.storage_backend = 'r2' AND (
                NEW.r2_key IS NULL OR NEW.raw IS NOT NULL OR NEW.raw_blob IS NOT NULL
                OR NEW.raw_encoding IS NULL OR NEW.raw_size IS NULL OR NEW.stored_size IS NULL
                OR NEW.content_sha256 IS NULL)) OR (NEW.storage_backend = 'd1' AND NEW.r2_key IS NOT NULL)
        BEGIN
            SELECT RAISE(ABORT, 'Invalid mail storage row');
        END`,
    raw_mails_storage_delete: `CREATE TRIGGER IF NOT EXISTS raw_mails_storage_delete
        AFTER DELETE ON raw_mails
        BEGIN
            INSERT OR IGNORE INTO mail_storage_gc(object_key, reason, next_retry_at)
                SELECT OLD.r2_key, 'delete', unixepoch() WHERE OLD.r2_key IS NOT NULL;
            UPDATE mail_storage_gc SET mail_id = NULL, reason = 'orphan', next_retry_at = unixepoch()
                WHERE mail_id = OLD.id;
            DELETE FROM mail_storage_migration_failures WHERE mail_id = OLD.id;
        END`,
};

async function mailColumns(db: D1Database) {
    const { results } = await db.prepare('PRAGMA table_info(raw_mails)').all<{ name: string }>();
    return new Set(results.map(({ name }) => name));
}

export async function inspectMailStorageSchema(db: D1Database) {
    const tableColumns = await mailColumns(db);
    const { results } = await db.prepare('SELECT name FROM sqlite_master WHERE name IN (' +
        Object.keys(schema).map(() => '?').join(',') + ')')
        .bind(...Object.keys(schema)).all<{ name: string }>();
    return {
        hasMailTable: tableColumns.size > 0,
        hasBackend: tableColumns.has('storage_backend'),
        ready: ['raw', 'raw_blob', 'is_unread', ...Object.keys(columns)]
            .every(column => tableColumns.has(column)) && results.length === Object.keys(schema).length,
    };
}

export async function ensureMailStorageSchema(db: D1Database) {
    const existing = await mailColumns(db);
    // SQLite has no ALTER TABLE ADD COLUMN IF NOT EXISTS. Read the schema again
    // after a failed ALTER to handle another administrator applying it concurrently.
    for (const [name, declaration] of Object.entries(columns)) {
        if (existing.has(name)) continue;
        try {
            await db.prepare(`ALTER TABLE raw_mails ADD COLUMN ${name} ${declaration}`).run();
        } catch (error) {
            if (!(await mailColumns(db)).has(name)) throw error;
        }
    }
    // Prepare each statement so the DELETE trigger's semicolons are preserved.
    await db.batch(Object.values(schema).map(sql => db.prepare(sql)));
    if (!(await inspectMailStorageSchema(db)).ready) throw new Error('MAIL_STORAGE_SCHEMA_REQUIRED');
}
