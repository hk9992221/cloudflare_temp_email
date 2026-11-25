# 邮件附件修复验收记录

## 修复结果

| 链路 | 核对结果 |
| --- | --- |
| Webmail 附件 | 大小取自下载使用的 `Blob.size`。保留 ArrayBufferView 的原始偏移和长度。缺失或不符合解析器类型约定的内容显示错误，合法空文件显示 `0 B`。 |
| 授权与按需加载 | 邮箱、用户中心、管理员和 Telegram 小程序打开详情时，通过现有授权接口读取原始 EML 字节。Webmail 列表仅加载摘要，本页文本筛选匹配主题和摘要预览。 |
| CID 和浏览器资源 | CID 引用解析为对应附件的 Blob URL，同一 CID 可重复使用。关闭或切换邮件、组件卸载及过时请求返回时释放附件 URL。 |
| D1 | 有效 UTF-8 可继续以明文保存。启用 Gzip 或收到无法以 D1 TEXT 无损保存的邮件时，用现有 `raw_blob` 保存压缩后的原始字节。历史明文及 Gzip 仍按原格式读取。已在旧版本写入时损失的字节无法恢复。 |
| R2 | 原有明文/Gzip 对象、对象键和元数据兼容。读取仍检查压缩前后长度与 `content_sha256`，随后把恢复的原始 MIME 字节交给解析器。 |
| Telegram | 同一邮件内多张图片、视频或音频用 `sendMediaGroup` 按文档类型发送，保留文件名与原始字节。单个媒体和普通附件逐个用 `sendDocument`，邮件自带的 ZIP 也按普通附件处理。上传失败或超限时继续处理后续附件，并向当前授权 Chat 发送一次 Webmail 下载提示。正文与邮件保存独立，现有绑定和全局推送规则继续生效。 |

## 自动化结果

| 套件 | 结果 | 实际覆盖 |
| --- | ---: | --- |
| 前端单元测试 | 126 通过 | ArrayBuffer、Uint8Array、带偏移 TypedArray、DataView、空文件、内容缺失、MIME 解析异常和 Blob URL 释放。 |
| Worker 和 E2E 工具单元测试 | 239 通过 | 包含 Telegram 超限、分组边界、部分失败以及上传字节切片。 |
| API 主回归 | 34 通过 | 9 项附件验收，以及原有 R2 完整性、邮件详情和 Telegram 绑定回归。 |
| API 扩展回归 | 122 通过 | 历史及混合 D1/Gzip 邮件、转发、删除、行 ID、签名 Webhook 附件下载。 |
| Chromium | 19 通过 | 6 种存储场景下共 48 次浏览器下载，核对文件名、MIME Type、界面字节大小和 SHA-256。覆盖真实 CID 图片渲染、关闭时释放 URL、列表按需加载和原有桌面/移动端、已读状态回归。 |
| 可选 Worker WASM 解析配置 | 9 通过 | 用部署使用的 `mail-parser-wasm-worker@0.2.3` 打补丁后重复 API 附件验收。 |
| 前端构建 | 通过 | `pnpm build:pages` 和 `pnpm build:telegram:pages`。 |
| Worker 构建 | 通过 | 默认配置和可选 WASM 配置的 Wrangler dry-run，以及 `pnpm lint`。单独运行 `tsc --noEmit` 与修改前的 10 条既有诊断一致。 |

Chromium 使用本地 Wrangler 模拟的 D1 和 R2，覆盖 D1 明文、D1 Gzip、未启用 Gzip 的 D1 收到非 UTF-8 邮件、R2 明文、R2 Gzip、历史 D1。API 补充混合收件箱和接近 12 MiB 的两附件邮件。已有 R2 回归包含篡改对象后的完整性拒绝。Telegram 测试使用本地 mock 核对提交的 multipart 数据、发送目标和调用顺序。

## SHA-256 对比

每一行的 SHA-256 在原件与测试下载文件中相同。前八项经浏览器下载，末两项来自接近大小上限的 R2 Gzip 邮件，经附件接口下载。该大邮件的原始 EML 下载也与压缩前 EML 的 SHA-256 一致。

| 文件 | 字节数 | 共同 SHA-256 |
| --- | ---: | --- |
| 原始照片.jpg | 660 | `a79207e71384a5a39139c242b1e2ff14c8a2a399cd588feef6257185f5916988` |
| pixel.png | 79 | `c108190ce90e1e2e40bf24dad6ae8630f1c3503ce0be99dbe4d3983019c0c41d` |
| report.pdf | 430 | `b8fefefa271dda5339c9ea4c3b0addb22f9c743a005f0ce681122313231950d0` |
| document.docx | 1068 | `0299c41b1303c82765d10d8db4a6c05656441af2741fd4c8578ebbf71d3409d6` |
| archive.zip | 134 | `d1280198107e113ffb2241a0f0ce4a1f72397aafcc6880858dd96815061e2670` |
| 文字.txt | 12 | `e76394733ffaa3973b91f18563d300cd5c33154f7530845a1aa023f2a75cda0d` |
| binary.bin | 6 | `997ab7dc051dbd6f0e449914cc8aca0cd855a3791008be43d6edae770f158b28` |
| empty.txt | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| near-1.bin | 4460000 | `fce4a937b510d0569cd0bab07ed6c380c5a56de69f7c05bcd104510c05600361` |
| near-2.bin | 4460000 | `8c8d8e7dec120232243ba985e1ac4431338234592cab3e382637aca58da188ba` |

JPG 和 PNG 经图像解码，PDF 经 `pdfinfo` 读取，ZIP 和 DOCX 经 `unzip -t` 校验。

## 修改文件

| 范围 | 路径 |
| --- | --- |
| Webmail 解析与呈现 | `frontend/src/utils/email-parser.js`、`frontend/src/components/MailBox.vue`、`frontend/src/components/MailContentRenderer.vue`、`frontend/src/i18n/message-registry.ts` |
| 邮箱与小程序读取入口 | `frontend/src/views/Index.vue`、`frontend/src/views/index/SimpleIndex.vue`、`frontend/src/views/admin/Mails.vue`、`frontend/src/views/admin/MailsUnknow.vue`、`frontend/src/views/user/UserMailBox.vue`、`frontend/src/views/telegram/Mail.vue` |
| Worker 原始邮件与解析 | `worker/src/common.ts`、`worker/src/email/index.ts`、`worker/src/email/storage.ts`、`worker/src/email/storage/read.ts`、`worker/src/gzip.ts`、`worker/src/utils/mail_parser.ts`、`.github/config/mail-parser-wasm-worker.patch` |
| Telegram 推送 | `worker/src/telegram_api/telegram.ts`、`worker/src/telegram_api/tg_file_upload.ts`、`worker/src/i18n/en.ts`、`worker/src/i18n/zh.ts`、`worker/src/i18n/type.ts` |
| 测试与样例 | `frontend/src/utils/__tests__/email-parser.test.js`、`e2e/api/tests/attachment-integrity.spec.ts`、`e2e/browser/tests/mail/attachment-integrity.spec.ts`、`e2e/fixtures/attachment-test-mail.ts`、`e2e/fixtures/mail-api.ts`、`e2e/unit/tests/telegram-attachment-upload.test.mjs` |
| 文档 | `CHANGELOG.md`、`CHANGELOG_EN.md`、`vitepress-docs/docs/zh/guide/worker-vars.md`、`vitepress-docs/docs/en/guide/worker-vars.md`、`MAIL-ATTACHMENT-VALIDATION.md` |

## 最小部署步骤

1. 用同一修复版本依次运行现有 **Deploy Backend** 和 **Deploy Frontend** Actions。启用了 Telegram 小程序的 Pages 站点随前端发布。
2. 后端使用现有生产 Worker 的邮件存储设置和私有 R2 绑定。保持 `ENABLE_TG_PUSH_ATTACHMENT=true` 与 `ENABLE_AI_EMAIL_EXTRACT=false`。本修复无需补写 `BACKEND_TOML`、修改邮件路由或执行数据库迁移。
3. **生产验收 Pending**。发布后可用测试邮箱打开一封既存 R2 邮件，核对原始 EML 与附件。真实 Telegram 下载哈希需要独立测试 Bot 或明确授权的测试环境。本记录中的测试均在发布前执行，使用本地模拟的 Telegram 接口。
