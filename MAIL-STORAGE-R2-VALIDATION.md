# D1 + R2 邮件存储验收报告

基线为 `hk9992221/cloudflare_temp_email` 的 `main`，提交 `50619c4227b4c6ba2368e681612c0f338c03696f`。项目版本为 `v1.15.0`。交付为本地源码和可应用的 Git 补丁。

## 实现范围

| 模块 | 交付内容 |
| --- | --- |
| Worker 写入 | `worker/src/email/storage.ts` 和 `worker/src/email/storage/r2.ts`。完整 MIME 字节写入私有 R2 对象，支持原样或 Gzip。D1 先登记写入意图，再原子提交邮件引用。写入错误会阻止该邮件后续的正常通知 |
| 数据库 | `db/schema.sql`、`db/2026-11-25-mail-storage-r2.sql`、`worker/src/admin_api/db_api.ts`。Schema 升级至 `v0.0.12`，管理入口可重入，保留历史 ID |
| 读取 | D1 明文、D1 Gzip、R2 原样和 R2 Gzip 共用原文访问层。原有权限检查仍在对象读取之前执行。Web 邮件列表使用轻量查询，详情、原文和批量导出按需读取 |
| 回收与迁移 | D1 删除触发器登记对象回收任务。历史迁移采用持久化游标、暂停和继续、失败重试和 SHA-256 读回校验 |
| 管理界面 | 快速设置中的「邮件存储管理」显示配置、逻辑容量、迁移进度及队列状态，支持手动分批处理 |
| 配置与上线 | `MAIL_STORAGE_BACKEND` 默认 `d1`，`MAIL_STORAGE_R2_GZIP` 默认 `true`，原生 R2 Binding 名为 `MAIL_STORAGE`。部署、回滚和上游同步见中英文使用文档 |

## 本地验收

以下集成测试使用 Wrangler 本地 D1、R2 和 KV。Telegram 外部请求使用测试夹具记录，Webhook 使用本地 HTTP 回调和真实签名校验。

| 检查 | 结果 |
| --- | --- |
| R2 专项及相关 Worker API 回归 | 6 项 R2 专项纳入 30 项通过的 API 用例。另有 122 项 Gzip、删除、Telegram 链接、Webhook 和转发回归通过 |
| Chromium 浏览器回归 | 14 项。整组运行时有一项既有 D1 套餐重载用例等候超时，隔离环境重复执行通过两次 |
| Worker 及前端单元测试 | Worker 测试通过 237 项，前端通过 123 项 |
| Worker 与前端构建 | Worker lint、Wrangler dry run、Pages 和 Telegram Pages 构建通过 |

- R2 使用明文和 Gzip 两种编码，混合邮件分页、详情和二进制导出可读。超过 2 MB 的测试 MIME 在 R2 保留完整内容。下载校验覆盖非 UTF-8 字节和 PNG、PDF、ZIP 附件。
- 注入 R2 PUT 失败、D1 提交失败、提交响应丢失、写入意图超时、R2 删除失败和对象缺失或损坏。验证拒收、提交结果恢复、故障补偿、回收退避及有引用对象的保护。
- 历史明文与 Gzip 数据迁移，验证暂停、预览、失败保留、重试和删除后 ID 重用。验证单封、邮箱清空及管理员自定义 SQL 的删除链路。
- 在 Chromium 验证收件箱按需加载、桌面和移动布局、附件与原文下载，以及管理界面的配置检查和迁移预览。
- 用旧版 Schema 和现有行运行增量 SQL。另在本地 Wrangler 验证 SQL 入口升级至 `v0.0.12`，在 Worker 中验证初始化和重复管理员迁移。

## 命令

```bash
(cd worker && corepack pnpm lint)
(cd worker && corepack pnpm build)
(cd e2e && npm run test:unit)
(cd frontend && corepack pnpm test)
(cd frontend && corepack pnpm run build:pages)
(cd frontend && corepack pnpm run build:telegram:pages)
```

Worker 构建使用 Wrangler dry run。下列 Playwright 命令在本地测试 Worker 和前端启动后执行。完整测试栈及所需环境变量见 `e2e/README.md`。

```bash
cd e2e
npx playwright test --project=api mail-storage-r2 mail-detail cleanup telegram-binding \
  mail-gzip mail-deletion mail-row-id webhook-attachments internal-mail-forwarding
npx playwright test --project=browser browser/tests/mail/inbox.spec.ts \
  browser/tests/admin/database-storage.spec.ts
```

## 剩余验收

- 生产启用前，使用真实 Email Routing、现有 Telegram Bot 和 S3 手动收藏，在隔离环境验证外部投递、Telegram 历史命令、实际配额及压缩 CPU 余量。此次验收使用本地资源，真实 S3 帐户和生产服务待验证。
- R2 单封原文上限为 12 MiB。历史迁移每批最多 5 封，尝试转存的原文累计最多 16 MiB。传统列表请求的 R2 原文总预算为 24 MiB，超过时可使用轻量列表和逐封详情。
- 全仓 `tsc --noEmit` 仍报告基线已有的 Config、兑换码、Passkey 和 Turnstile 类型问题。Worker lint 和 dry run 构建以及 Pages 构建分别验证。
- D1 的原文字段大小、数据库分配页数和计费统计是不同指标。正式回滚时可把新写入切回 `d1`，并保留 R2 绑定与双读版本。更早的 Worker 版本须在已有 R2 邮件具备独立访问或恢复路径后再使用。

[部署及回滚指南](vitepress-docs/docs/zh/guide/feature/mail-storage-r2.md)
