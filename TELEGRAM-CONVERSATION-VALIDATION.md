# Telegram Bot 交互式命令验收

本地工作区基于 `main` 的 `e83edc5` 实施。生产 Worker、D1、Webhook 和 Bot 配置未修改。

## 命令清单

| 命令 | 菜单触发时 | 带参调用 |
| --- | --- | --- |
| `/new` | 随机生成、自定义名称后选域名，或随机名称并选域名 | `name@domain`、`name`、`@domain` 直接执行，`name@` 继续选域名 |
| `/bind` | 用 ForceReply 收集邮箱凭证，凭证错误可重新输入 | 直接绑定 |
| `/unbind` | 从已绑定邮箱选择，或手动输入 | 校验绑定后直接解绑 |
| `/delete` | 选择或输入已绑定的邮箱，再确认删除 | 校验邮箱所有权后仍需二次确认 |
| `/mails` | 可查看首个有效绑定邮箱、选择邮箱或手动输入 | 直接查询指定邮箱，兼容已有邮件翻页按钮 |
| `/lang` | 在 `TG_ALLOW_USER_LANG` 启用时显示语言按钮 | `zh` 或 `en` 直接生效 |
| `/start`、`/address`、`/cleaninvalidaddress` | 直接执行 | 沿用原有无参数行为 |
| `/cancel` | 取消尚未开始执行的会话 | 无参数 |

同一 Bot、Chat 和 Telegram 用户共用一个活跃会话。每次有效交互续期 300 秒，每页最多显示 8 个选项。交互状态保存在 D1，破坏性操作必须先原子取得执行权。Webhook 重放记录保留 48 小时，定时任务分批清理过期会话和重放记录。运行中的操作返回执行状态，结果不确定时请先检查邮箱，Bot 不会自动重试删除。

Bot 继续使用私聊。Telegram 的 Webhook secret header 在解析 Update 前校验，命令创建和执行阶段都检查现有允许列表。删除确认会绑定当时的邮箱 ID，实际执行时再次核对当前绑定身份和 `ENABLE_USER_DELETE_EMAIL`。手动输入的邮箱 JWT 只用于当次绑定处理。

## 验收结果

| 验收项 | 本地结果 |
| --- | --- |
| AC-01 至 AC-08 | 通过。伪造 Update 被拒绝，模拟 Bot 初始化注册了完整菜单。测试覆盖完整和部分参数、ForceReply、私聊普通文本、域名按钮以及无效输入重试。 |
| AC-09 至 AC-11 | 通过。测试覆盖 `/cancel`、切换命令、旧消息和两个不同的超时入口。 |
| AC-12 至 AC-14 | 通过。并发重复确认最多执行一次，两个并发用户会话独立，其他用户、聊天和 Bot 的按钮操作被拒绝。群聊回调明确拒绝。 |
| AC-15 | 本地通过。停止第一个 Wrangler Worker 进程后，第二个进程用同一个 D1 继续了原 ForceReply 会话。真实 Cloudflare 多实例待验。 |
| AC-16 至 AC-22 | 通过。测试覆盖邮箱所有权、权限关闭和撤销、删除确认、8 项分页、生成域名过滤、按钮长度、重复投递及旧按钮。 |
| AC-23、AC-24 | 本地通过。现有 Telegram 正文、附件推送、绑定 API 以及无参数 Bot 命令回归通过。 |
| AC-25 | 部分通过。Worker dry-run、Webmail Pages、Telegram Pages 构建和 Worker ESLint 均通过。全量 `tsc --noEmit` 仍有 10 条基线诊断，逐行对比与修改前相同，涉及管理员配置、兑换码、Passkey 和 Turnstile。 |
| AC-26 | 本地相关回归通过。242 项 Worker/E2E 单元测试、126 项前端单元测试、49 项本地 API 与集成测试通过，其中 7 项是本次新增的 Bot Webhook 测试。集成环境使用本地 D1、KV、R2 和模拟 Telegram API。 |

**Pending**。真实 Telegram 客户端命令菜单、真实 Bot Webhook 及 Cloudflare 多实例联调，均待独立测试环境或明确生产授权。完整 Docker Compose 浏览器和 SMTP 套件本轮未执行。

## Schema 与上线兼容

新增 `telegram_conversations` 与 `telegram_conversation_updates` 两张表及两个过期索引，Schema 升到 `v0.0.13`。管理后台迁移和独立 SQL 都可创建表。已测试从 `v0.0.12` 重复执行独立 SQL 会保留已有邮箱和邮件。没有新增环境变量。

既有部署在更新前可以先应用独立迁移文件。部署 Worker 后，从管理后台的 Telegram 设置重新初始化 Webhook。旧 Webhook 未注册 secret header 的投递会被拒绝，初始化完成后恢复。初始化也会把 `/cancel` 加入 Bot 命令菜单。更换 Bot Token 后同样需要重新初始化。

## 修改文件

| 范围 | 文件 |
| --- | --- |
| 会话、分发和存储 | `worker/src/telegram_api/conversation.ts`、`worker/src/telegram_api/conversation-store.ts`、`worker/src/telegram_api/commands.ts` |
| Bot 接入和权限 | `worker/src/telegram_api/index.ts`、`worker/src/telegram_api/telegram.ts`、`worker/src/telegram_api/common.ts` |
| Schema 与回收 | `db/schema.sql`、`db/2026-11-26-telegram-conversations.sql`、`worker/src/admin_api/db_api.ts`、`worker/src/constants.ts`、`worker/src/scheduled.ts` |
| 双语消息 | `worker/src/i18n/en.ts`、`worker/src/i18n/zh.ts`、`worker/src/i18n/type.ts` |
| 测试 | `e2e/api/tests/telegram-conversation.spec.ts`、`e2e/unit/tests/telegram-conversation-store.test.mjs`、`e2e/unit/tests/address-expiry.test.mjs`、`e2e/fixtures/worker.ts`、`e2e/fixtures/mail-api.ts` |
| 发布说明 | `CHANGELOG.md`、`CHANGELOG_EN.md`、`vitepress-docs/docs/zh/guide/feature/telegram.md`、`vitepress-docs/docs/en/guide/feature/telegram.md`、`TELEGRAM-CONVERSATION-VALIDATION.md` |
