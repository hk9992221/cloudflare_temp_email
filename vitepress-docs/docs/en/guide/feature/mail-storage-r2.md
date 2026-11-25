# D1 and R2 mail storage

R2 mode stores the complete, post-processing MIME message in a private EML object. D1 holds the message ID, addresses, authorization relationships, read state, summary, storage reference, and integrity fields. Existing S3 attachment bookmarks keep their current configuration.

## Rollout

1. Back up D1. Start in a staging environment with the dual-read Worker and the default `d1` write mode.
2. Open Admin → Quick Setup → Database and upgrade to schema `v0.0.12`. The admin upgrade can be repeated or resumed. The SQL file `db/2026-11-25-mail-storage-r2.sql` is a one-time alternative for an unmodified `v0.0.11` database. Use the admin upgrade for a partial migration.
3. In the Cloudflare dashboard, bind the private bucket to the Worker as `MAIL_STORAGE`. The backend GitHub Actions workflow carries over the binding and settings from the active Worker version. Other deployment configuration continues to come from `BACKEND_TOML`. For the first deployment or direct Wrangler deployments, you can use the TOML example below.
4. Use Mail storage → Check configuration to verify the schema and bucket. Deploy the compatible Worker before the Pages frontend.
5. Switch writes to `r2`. Test plain text, HTML, inline images, PDF attachments, and a message over 2 MB. Check the existing attachment stripping settings if large attachments should be kept.
6. Preview and opt in to historical migration only after new-message validation.

```toml
[vars]
MAIL_STORAGE_BACKEND = "r2"
MAIL_STORAGE_R2_GZIP = true

[[r2_buckets]]
binding = "MAIL_STORAGE"
bucket_name = "private-mail-attachments"
```

The backend workflow also carries over dashboard changes to the write mode, gzip setting, and AI extraction switch and model.

Keep the `_internal/raw-mails/v1/` prefix reserved for the Worker and outside any expiry rule. Existing S3 attachment bookmarks can share the bucket under their mailbox prefixes.

## Operations

Migration is opt-in, pausable and resumable. A batch processes at most five messages and attempts to transfer at most 16 MiB of original content. It verifies the uploaded bytes, then atomically updates the reference and clears the original D1 field. Retry failed messages from the admin screen. Rescan D1 to include messages added after a migration snapshot, including newly reused IDs.

Mail deletion records the object for collection in the same D1 transaction. Existing cron runs can process the queue, or an administrator can process batches and reattempt exhausted retries. Stale write intents are fenced before collection and get a delayed second check. Reported byte totals describe referenced payloads. Database page allocation and billing are reported separately in Cloudflare.

| API | Behavior |
| --- | --- |
| `GET /api/mails`, `/user_api/mails`, `/admin/mails`, `/admin/mails_unknow` | `summary=true` opts into metadata. The legacy response retains MIME content. Use a smaller page or the detail API when its R2 payload exceeds 24 MiB |
| `GET /api/mail/:id`, `/user_api/mails/:id`, `/admin/mails/:id` | Add `download=eml` for binary EML under the endpoint's authorization |
| `POST /telegram/get_mail?download=eml` | Return EML using Mini App authorization |
| `GET /admin/mail_storage`, `GET /admin/mail_storage/check` | Read storage state, migration progress, and binding health |
| `POST /admin/mail_storage/migrate` | JSON `action` of `preview`, `next`, `pause`, `resume`, `restart`, or `retry` |
| `POST /admin/mail_storage/gc` | Process a batch. `retryFailed: true` also includes tasks that reached the automatic retry limit |

The R2 ingestion and migration limit is 12 MiB per message. Verify resource headroom with representative mail on your Workers plan. Storage failure triggers explicit rejection before normal notifications. Missing or damaged objects return an error and leave the mail record available for diagnosis.

## Rollback and upstream updates

Switch new writes to `d1` and retain the R2 binding and dual-read Worker. New messages then use D1's original limits. To install an older Worker without R2 support, first verify an independent export and recovery route for referenced objects. Some R2 messages exceed D1's single-row limit.

The fork's deployment workflows currently listen for completion of Upstream Sync. Merge upstream on an integration branch, run the Worker, frontend and API checks, validate staging, and use an approved release trigger. Add a successful-validation gate before enabling production deployment from automatic upstream sync. Existing production triggers are unchanged by this feature.
