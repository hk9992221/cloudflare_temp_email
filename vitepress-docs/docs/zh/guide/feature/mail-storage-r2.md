# D1 + R2 邮件存储

R2 模式将完整的 MIME 原文存为私有 EML 对象。D1 保存邮箱权限关系、邮件 ID、收发地址、已读状态、摘要、对象引用和完整性信息。原文包含正文、邮件头、内嵌图片和附件，以现有收件规则处理后的内容为准。手动收藏附件继续使用原有 S3 配置。

## 分阶段启用

1. 备份 D1。准备独立测试环境，先部署支持 D1 和 R2 双读取的 Worker，使用默认的 `d1` 写入模式。
2. 在「管理后台 → 快速设置 → 数据库」执行 Schema 升级，确认版本为 `v0.0.12`。该入口可以重复执行。使用 Wrangler 管理数据库时，`db/2026-11-25-mail-storage-r2.sql` 适用于一次性升级原样的 `v0.0.11`，部分升级或重复执行请使用管理后台。新数据库可以通过管理后台初始化，或执行新的 `db/schema.sql` 后再由管理后台登记版本。
3. 在 Worker 绑定私有 R2 Bucket。GitHub Actions 部署读取现有 `BACKEND_TOML`，因此在实际使用的 Wrangler 配置中加入 Binding。保留现有 Secrets、D1 和 KV Binding。设置里的 `[vars]` 须沿用原区块。
4. 在「邮件存储管理」执行「检查配置」，确认 Schema 就绪且 R2 可访问。部署新 Pages 前端之前先部署兼容的 Worker。
5. 将 `MAIL_STORAGE_BACKEND` 切到 `r2`。用纯文本、HTML、内嵌图片、PDF 及超过 2 MB 的测试邮件核对收件、原文下载、附件下载、Telegram 和 Webhook。希望保留大邮件附件时，检查原有 `REMOVE_EXCEED_SIZE_ATTACHMENT` 和 `REMOVE_ALL_ATTACHMENT` 配置。
6. 完成新邮件验证之后，再决定是否迁移 D1 中的历史邮件。

```toml
[vars]
MAIL_STORAGE_BACKEND = "r2"
MAIL_STORAGE_R2_GZIP = true

[[r2_buckets]]
binding = "MAIL_STORAGE"
bucket_name = "private-mail-attachments"
```

保持 Bucket 私有，保留 `_internal/raw-mails/v1/` 命名空间供应用管理。使用同一 Bucket 手动收藏附件时，原有按邮箱划分的路径继续有效。不要在该内部前缀上配置会自动移除邮件原文的生命周期策略。

## 历史迁移和回收

- 「预览迁移」只查询 D1 邮件数和字段大小。「迁移下一批」按持久化游标处理至多 5 封、尝试转存最多 16 MiB 原文。每封邮件用 SHA-256 核对从 R2 读回的内容，再一次性切换引用并清空 D1 原文。暂停后正在处理的邮件可完成，关闭页面后可继续调用「迁移下一批」。
- 已达到本轮末尾时，可用「重新扫描 D1」覆盖后来新增或因 ID 重用而错过的 D1 邮件。处理失败会保留原文并登记错误代码，通过「重试迁移失败项」继续。
- 删除邮件会在同一个 D1 事务中登记对象清理。使用现有 Cron 时，会顺带处理已到期回收任务。也可以在管理后台手动处理，达到退避重试上限的任务需要手动重试。写入意图超时后会取消提交资格，回收时会再安排一次延迟复查。
- R2 字节数是有 D1 引用的对象大小。D1 逻辑字段缩减、实际数据库页大小及 Cloudflare 计费用量的更新可能发生在不同时间。迁移不会运行 `VACUUM` 或清空 Bucket。

## 接口与限制

| 接口 | 行为 |
| --- | --- |
| `GET /api/mails`、`GET /user_api/mails`、`GET /admin/mails`、`GET /admin/mails_unknow` | 加 `summary=true` 返回轻量列表。已有默认格式仍返回原文。大量 R2 原文合计超过 24 MiB 时，使用更小的页或逐封读取 |
| `GET /api/mail/:id`、`GET /user_api/mails/:id`、`GET /admin/mails/:id` | 原有作用域鉴权。加 `download=eml` 返回原文的 EML 二进制 |
| `POST /telegram/get_mail?download=eml` | 使用原 Mini App 授权流程下载 EML |
| `GET /admin/mail_storage`、`GET /admin/mail_storage/check` | 管理员查询统计、迁移进度及 Binding 连通性 |
| `POST /admin/mail_storage/migrate` | JSON 参数 `action` 可为 `preview`、`next`、`pause`、`resume`、`restart`、`retry` |
| `POST /admin/mail_storage/gc` | 手动处理一批回收任务。JSON 参数 `retryFailed: true` 可包含达到重试上限的任务 |

R2 收件及历史迁移单封原文上限为 12 MiB，以限制 MIME 解析、压缩和校验的内存开销。需用接近上限的样本验证生产 Workers 计划的资源余量。写入失败会显式拒收并停止该邮件后续的正常通知。上游投递系统是否重试取决于其实际响应。对象缺失或损坏会返回错误，并保留 D1 记录供排查。

## 回滚与上游同步

常规回滚时，把新邮件写入模式切回 `d1`，保留 R2 Binding 和双读取代码。此后新的大邮件重新受 D1 单行限制。需要回退到没有 R2 读取能力的旧版本时，先验证已有 R2 邮件的独立导出、访问路径和恢复方案。超过 D1 单行限制的原文无法原样塞回单条 D1 记录。保留新增 Schema。

Fork 当前的后端和前端部署工作流都监听 `Upstream Sync` 的完成事件。建议将上游变更先合并到单独的分支，在本地执行 Worker lint、前端测试和 D1/R2 API 回归，再在隔离环境完成收信验证，最后通过明确批准的发布入口上线。在复用自动同步前，给部署工作流增加验证成功的条件和生产发布门禁，确保失败或尚未验收的同步不会自动部署。这次改造保留现有生产工作流触发器。
