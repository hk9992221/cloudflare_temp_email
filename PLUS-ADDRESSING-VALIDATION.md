# Plus Addressing 验收记录

动态别名按 SMTP 信封投递。精确注册地址优先。动态别名继承同域名基础邮箱的权限和生命周期，保留原始收件地址与区分大小写的标签。

| 范围 | 文件 |
| --- | --- |
| 部署配置 | `.github/config/preserve-worker-mail-settings.py`、`.github/config/test_preserve_worker_mail_settings.py`、`worker/wrangler.toml.template` |
| D1 | `db/schema.sql`、`db/2026-11-26-plus-addressing.sql` |
| 收信、转发和存储 | `worker/src/utils/recipient_resolver.ts`、`worker/src/email/{index,forward,storage}.ts`、`worker/src/email/storage/{schema,read}.ts` |
| API 和配置 | `worker/src/{common,commom_api,constants}.ts`、`worker/src/types.d.ts`、`worker/src/models/index.ts`、`worker/src/admin_api/{account_settings_api,mail_webhook_settings}.ts`、`worker/src/mails_api/webhook_settings.ts` |
| Telegram | `worker/src/telegram_api/telegram.ts`、`worker/src/i18n/{en,zh,type}.ts`、`frontend/src/views/telegram/Mail.vue` |
| Webmail | `frontend/src/components/{PlusAlias,AliasFilter,MailBox,MailSummary,MailContentRenderer,WebhookComponent}.vue`、`frontend/src/api/index.js`、`frontend/src/i18n/message-registry.ts`、`frontend/src/views/Index.vue`、`frontend/src/views/index/{AddressBar,SimpleIndex}.vue`、`frontend/src/views/user/UserMailBox.vue`、`frontend/src/views/admin/{AccountSettings,Mails}.vue` |
| 自动化测试 | `e2e/api/tests/plus-addressing.spec.ts`、`e2e/fixtures/{mail-api,worker}.ts` |
| 文档 | `CHANGELOG.md`、`CHANGELOG_EN.md`、`vitepress-docs/docs/{zh,en}/guide/worker-vars.md` |

## 升级与兼容

Schema `v0.0.14` 给 `raw_mails` 新增可空列 `original_recipient`、`alias_tag` 和索引 `(address, alias_tag, id)`。原始 MIME 和 R2 对象沿用现有格式。历史邮件的原始收件地址读取时回退到 `address`。SQLite 以旧 Schema 升级并验证历史行，`EXPLAIN QUERY PLAN` 确认基础邮箱标签筛选命中复合索引。

先迁移 D1，再发布 Worker、Webmail 和 Telegram Mini App。默认关闭动态解析。后台开关可启用，Worker 的显式 `ENABLE_PLUS_ADDRESSING=false` 优先。回滚时先在后台关闭功能，保留迁移字段、已收邮件和已有 R2 对象。需要切回上一 Worker 版本时，无需降级数据库。

现有列表和详情字段保留，新增原始收件地址和标签。Webhook 和 RPC 的 `to` 仍为信封收件地址。Webhook 模板与 RPC 可同时获取实际归属邮箱。启用后，以 SMTP 信封地址为准的既有规则仍适用。

## 验证

- 新增测试覆盖地址语法与大小写、精确注册、关闭与锁定、邮件归属、隔离、历史邮件、标签筛选与分页、转发去重、Webhook、RPC、Telegram 附件，以及 D1 plaintext/gzip 与 R2 identity/gzip 的 EML 和附件 SHA-256。
- Worker 严格类型检查沿用基线的 10 条既有诊断，本次改动未新增诊断。Wrangler 可成功打包 Worker。
- 真实外部 SMTP、生产 Telegram 推送和生产外部 Webhook 为 **Pending**。自动化使用测试环境的传输记录。
- 本地回归运行 148 项 API 测试，148 项通过。前端 126 项 Vitest 测试、部署配置 11 项 Python 测试通过。Webmail 和 Telegram Mini App 均成功构建。

| 测试附件 | 字节数 | 原始与下载 SHA-256 |
| --- | ---: | --- |
| 原始照片.jpg | 660 | `a79207e71384a5a39139c242b1e2ff14c8a2a399cd588feef6257185f5916988` |
| pixel.png | 79 | `c108190ce90e1e2e40bf24dad6ae8630f1c3503ce0be99dbe4d3983019c0c41d` |
