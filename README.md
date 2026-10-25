# 小米语音克隆 WEB

上传一段参考音频（mp3 / wav），输入文本，调用小米 MiMo 克隆模型生成同音色语音，
可在线试听、下载音频（mp3，失败时自动回落 wav 并标注），并下载一份生成信息 JSON。

管理后台可以配置小米模型 URL、API Key、输出格式和可选的生成访问密码。

## 功能

- 首页：拖拽/选择参考音频、试听参考音频、输入文本与风格指令、生成、试听结果、下载音频、下载信息 JSON
- 管理后台（`/admin.html`）：配置 Base URL、模型名、API Key、输出格式、生成密码；测试连接（调 OpenAI 兼容的 `/models`，不花合成费用）；导出 Vercel 环境变量文本
- 安全：API Key 只在服务端使用，前端和管理后台都只显示掩码；参考音频和生成结果不落盘、不留存，生成后只在浏览器里下载

## 小米接口说明（按官方文档）

- 模型：`mimo-v2.5-tts-voiceclone`（基于音频样本复刻任意音色）
- 调用：OpenAI 兼容 `POST {BaseURL}/chat/completions`，目标文本放 `role=assistant`，风格指令放 `role=user`，参考音频放 `audio.voice`，格式为 `data:audio/mpeg;base64,...` 或 `data:audio/wav;base64,...`
- 参考音频限制：小米文档的 Base64 上限是 10MB，但本项目部署在 Vercel 上时，Vercel 单次请求体上限 4.5MB 更先触发，所以本项目按原始文件 3MB 拦截（3MB 原文件 ≈ 4MB 请求体，留有余量；超过会在函数运行前被 Vercel 直接返回 413 纯文本，前端已把这类响应转成一句人话，不再显示 JSON 解析报错）
- 输出：文档示例格式是 wav / pcm16；本项目默认请求 mp3，若上游不接受 mp3 会自动回落 wav，并在结果信息里如实标注实际格式
- 计费：按小米按量计费页，TTS 系列（含克隆模型）目前标注为“限时免费”，不等于永久免费，请以官方账单和公告为准

## 本地运行

```bash
cd xiaomi-voice-clone
node server.mjs
# 打开 http://localhost:3000 ，管理后台 http://localhost:3000/admin.html
# 本地默认管理口令是 admin123（仅本机测试，终端会打印警告）
```

不调用真小米、只验证整条链路：

```bash
XIAOMI_MOCK=1 node server.mjs
```

此时生成接口返回 1 秒测试音，管理后台仍可用假 Key 走通保存流程。生产环境不要设置 `XIAOMI_MOCK`。

## 部署到 Vercel（推荐：GitHub 导入）

1. 把本文件夹推到一个 GitHub 仓库（不要提交真实 Key，`.gitignore` 已排除 `.env`）。
2. 在 Vercel 点 New Project → Import 这个仓库，不需要改构建命令（零依赖、无构建步骤）。
3. 在项目 Settings → Environment Variables 里设置（至少前两项）：

   | 变量 | 说明 |
   |---|---|
   | `ADMIN_PASSWORD` | 管理后台口令，必填，设一个强口令 |
   | `XIAOMI_API_KEY` | 小米 API Key |
   | `XIAOMI_BASE_URL` | 默认 `https://api.xiaomimimo.com/v1`，不填也行 |
   | `XIAOMI_MODEL` | 默认 `mimo-v2.5-tts-voiceclone`，不填也行 |
   | `XIAOMI_OUTPUT_FORMAT` | `mp3` 或 `wav`，默认 `mp3` |
   | `CLONE_PASSWORD` | 可选；填了则首页生成时要输入该密码 |

4. Deploy，打开域名 → 先到 `/admin.html` 登录，点“测试连接”，通过后再到首页生成。

也可以用 Vercel CLI：`vercel`（按提示选项目），再用 `vercel env add` 逐项加环境变量后重新部署。

## 存储方式（请如实理解）

- 环境变量是长期配置，重新部署后仍在。
- 管理后台保存的配置是“运行时覆盖”，只存在于当前函数实例的内存里，冷启动或重新部署后会恢复为环境变量的值。
- 所以：临时换 Key、换模型用管理后台就够了；想长期固定，点管理后台的“生成环境变量文本”，粘贴到 Vercel 环境变量里再重新部署。
- 如需跨实例持久化的后台配置，需要另外接数据库（例如 Neon Postgres），本版本没有引入数据库依赖，保持零依赖部署。

## 接口

- `GET /api/health`：公开状态（是否已配置、模型、输出格式，不含 Key）
- `GET /api/config`：管理后台读取（需 `x-admin-password`，Key 只返回掩码）
- `POST /api/config`：管理后台保存（需 `x-admin-password`；Key 留空 = 保持原有）
- `POST /api/test`：管理后台测试连接（需 `x-admin-password`，调 `/models`）
- `POST /api/clone`：生成。JSON：`{ text, style?, referenceAudio: "data:audio/...;base64,...", referenceName? }`；可选请求头 `x-clone-password`。返回：`audioBase64`、`audioMime`、`audioFormat`、`fileName`、`sizeBytes`、`model`、`text`、`referenceName`、`createdAt` 等。

## 限制与注意事项

- 单次文本上限 5000 字（平台自设，非小米模型上限）。超过 300 字的长文本会自动分段：前端按句切段（每段约 300 字，单句超长时再按逗号切、仍超长才硬切），逐段调 `/api/clone`（每段都在服务端 55 秒超时内），最后合并成一个文件下载——mp3 直接拼帧，wav 解析 fmt/data 块后拼 PCM 并重建头；各段格式不一致时报错，不会给一个坏文件。超时报错已转成人话，不再显示 `This operation was aborted`。
- 参考音频请用 10-30 秒的清晰人声片段，整首歌（例如 6MB、近 3 分钟）一定会超 Vercel 请求上限，剪短再传才是正确用法。
- 克隆模型目前是非流式：生成完才一次返回，大文本等待时间会长一些，`vercel.json` 已把生成接口超时放宽到 60 秒。
- 克隆仅用于你有权使用的声音，请勿用于冒充他人、诈骗等用途；公开部署时建议设置 `CLONE_PASSWORD` 或只把链接给可信的人，避免他人盗用你的 Key。
- 本项目不含任何真实 Key；你之前给过的 Key 没有写进代码、文件或记忆。
