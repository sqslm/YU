# 语（YU）自建服务端 API

## Web 管理接口（2.1.0）

页面入口为 `/admin`，静态资源位于 `/admin/app.js`、`/admin/style.css`。登录、刷新和退出沿用 `/api/v1/auth/*`。以下接口都要求有效 Bearer 会话且账号 `is_admin=1`；未登录返回 401，普通账号或管理员被降权返回 403。每次请求重新检查权限，不在 URL 中传令牌。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/api/v1/admin/overview` | 当前管理员、服务版本、账号数、有效随记/历史数、音频字节数 |
| GET | `/api/v1/admin/settings` | 生效设置 `values`、并发版本 `revision`、`smtpPasswordSet`、SMTP 配置状态/警告、只读部署信息；永不返回 SMTP 密码 |
| PUT | `/api/v1/admin/settings` | JSON `{revision,values}`，设置键沿用 `.env.example`；仅允许可热更新字段；错误整体拒绝，过期版本 409；保存后立即生效且持久化 |
| GET | `/api/v1/admin/users?page=1&q=` | 按邮箱搜索；每页 30 条，返回 `users,total,page` |
| GET | `/api/v1/admin/users/:userId` | 账号公开信息、禁用状态、有效配额/覆盖值、音频用量、随记/历史/统计设备数 |
| PUT | `/api/v1/admin/users/:userId` | JSON `{disabled?:boolean,quotaMb?:number}`；配额为 0–1000000 整数 MB，0 恢复默认。停用撤销全部会话；网页禁止停用管理员 |
| GET | `/api/v1/admin/users/:userId/notes` | 有效随记，`items,total,page`；`q` 搜索标题/原文/润色，`page` 默认 1，每页 30 |
| GET | `/api/v1/admin/users/:userId/history` | 有效听写历史，`items,total,page`；`q` 搜索存储的 JSON 正文 |
| GET | `/api/v1/admin/users/:userId/stats` | 设备统计快照，`items,total,page`；`q` 搜索设备 ID |
| GET/HEAD | `/api/v1/admin/users/:userId/notes/:id/audio` | 指定账号随记录音；下载鉴权同样要求管理员，无 URL 令牌 |
| DELETE | `/api/v1/admin/users/:userId/notes/:id` | JSON `{version}`；版本不匹配返回 409。清除文字/录音，递增版本和游标，保留墓碑 |
| DELETE | `/api/v1/admin/users/:userId/history/:id` | JSON `{updatedAt}`；时间戳不匹配返回 409。清除正文并写入更大的删除时间戳、游标和 revision |
| GET | `/api/v1/admin/users/:userId/export` | 流式 JSON 附件：`exportedAt,user,notes,history,stats`，只含该账号有效数据，不含密码/令牌及音频二进制 |

统计只读，删除随记/历史不会重置统计。导出过程中允许客户端继续写入，因此不是跨表原子快照；完整灾备请用管理员 CLI。已有客户端未上传的本地修改可能重新上传，管理删除前应先完成同步。

设置 `values` 支持 `.env.example` 中除 `HOST`、`PORT`、`DATA_DIR` 以外的设置。`NODE_ENV` 同样只读。布尔字段必须为 JSON boolean，数字字段必须为 number。`SMTP_PASSWORD` 缺省保留、字符串更换、空字符串清除，读取接口仅返回是否已设置。设置覆盖优先于环境变量，保存在现有 `meta` 表中，无需数据库迁移；账号 JSON 导出不会包含它们。注册开关沿用 `registration_enabled`，CLI 的开关同样反映到页面。

协议版本：`1`（`GET /api/v1/meta` → `protocolVersion`）。所有接口在 `/api/v1/` 下，除 `meta`、`health`、`auth/*` 外都要求 `Authorization: Bearer <accessToken>`。

- 请求与响应都是 JSON（音频上传/下载除外）。
- 时间戳一律是**毫秒**整数。
- 错误统一为 `{"error":"<code>","message":"<给人看的中文>"}`，HTTP 状态码表达类别。
- 响应带 `cache-control: no-store`；客户端不要缓存账号与随记响应。

## 目录

1. [服务探测](#1-服务探测)
2. [健康检查](#2-健康检查)
3. [认证](#3-认证)
4. [当前用户与用量](#4-当前用户与用量)
5. [随记同步](#5-随记同步)
6. [音频](#6-音频)
7. [设备统计同步](#7-设备统计同步)
8. [旧版听写历史（兼容保留）](#8-旧版听写历史兼容保留)
9. [错误码](#9-错误码)
10. [客户端同步流程](#10-客户端同步流程)

---

## 1. 服务探测

```http
GET /api/v1/meta
```

无需鉴权。客户端在显示登录表单之前用它决定「显示注册还是只显示登录」「要不要发验证码」。

```json
{
  "name": "typeless-server",
  "version": "2.0.0",
  "protocolVersion": 1,
  "registrationEnabled": true,
  "emailVerificationRequired": true,
  "smtpConfigured": true,
  "publicUrl": "https://typeless.example.com",
  "limits": {
    "maxAudioUploadBytes": 52428800,
    "defaultStorageQuotaBytes": 1073741824,
    "maxJsonBytes": 2097152,
    "notesPerPush": 200,
    "notesPerPull": 500
  },
  "features": { "notes": true, "notesAudio": true, "history": true, "statistics": true, "passwordReset": true }
}
```

`registrationEnabled` 已经综合了「管理员开关」和「没有 SMTP 就不能验证」两条规则，客户端照着显示即可。

## 2. 健康检查

```http
GET /health
GET /api/v1/health
```

```json
{ "ok": true, "version": "2.0.0", "uptimeSeconds": 42, "time": "2026-10-21T10:00:00.000Z" }
```

给容器 healthcheck 和反代探活用的，不含任何账号信息。

## 3. 认证

### 3.1 发送验证码

```http
POST /api/v1/auth/code
{ "email": "you@example.com", "purpose": "register" }
```

`purpose`：`register`（默认）或 `reset`（找回密码）。

成功：

```json
{ "ok": true, "sent": true, "required": true, "expiresIn": 300, "cooldownSeconds": 60 }
```

- `emailVerificationRequired=false` 且 `purpose=register` 时返回 `{"ok":true,"sent":false,"required":false}`，客户端应跳过验证码输入框。
- 邮箱已注册（注册）或未注册（找回）时**仍然返回成功**：这个接口不能当成「某邮箱是否存在」的查询器。
- `purpose=register` 且管理员关闭了注册 → `403 registration_closed`。
- 没有配置 SMTP → `503 email_not_configured`。
- 冷却中 → `429 code_cooldown`（响应头带 `retry-after` 秒数）；限流 → `429 rate_limited`。
- 邮件发送失败 → `502 email_send_failed`，且刚写入的验证码会立即作废。

### 3.2 注册

```http
POST /api/v1/auth/register
{ "email": "you@example.com", "password": "至少 8 位", "code": "123456" }
```

邮箱大小写不敏感。成功返回同登录：

```json
{
  "accessToken": "…",
  "refreshToken": "…",
  "expiresIn": 43200,
  "user": {
    "id": "uuid",
    "email": "you@example.com",
    "isAdmin": false,
    "createdAt": 1761000000000,
    "subscription": { "plan": "trial", "active": true, "trialEndsAt": 1762200000000, "currentPeriodEnd": null, "cancelAtPeriodEnd": false }
  }
}
```

错误：`403 registration_closed`、`503 email_not_configured`、`400 bad_code`/`code_invalid`/`code_expired`、`429 too_many_attempts`、`409 email_taken`、`400 bad_email`/`bad_password`。

> `email_taken` 是唯一会暴露「邮箱已注册」的地方，因为注册必须告诉用户换个邮箱。

### 3.3 登录

```http
POST /api/v1/auth/login
{ "email": "you@example.com", "password": "…" }
```

成功同注册。邮箱不存在与密码错误都返回 `401 bad_credentials`，响应完全一致。账号被禁用返回 `403 account_disabled`。

### 3.4 刷新令牌

```http
POST /api/v1/auth/refresh
{ "refreshToken": "…" }
```

成功返回新的 `accessToken` + `refreshToken`（**旧 refresh 立即失效**，轮换制）。失败 `401 refresh_invalid`，客户端应清掉本地会话回到登录页。

### 3.5 退出

```http
POST /api/v1/auth/logout
Authorization: Bearer <accessToken>
{ "refreshToken": "…" }
```

撤销这一个会话（不是全部设备）。`refreshToken` 可省略，此时按 Bearer 里的访问令牌定位会话。返回 `{"ok":true}`。

### 3.6 当前用户

```http
GET /api/v1/auth/me
```

```json
{ "user": { "id": "uuid", "email": "…", "isAdmin": false, "createdAt": 1761000000000, "subscription": { … } } }
```

每次请求都会回源查账号，所以禁用、撤销会立刻生效。

### 3.7 重置密码

```http
POST /api/v1/auth/password/reset
{ "email": "you@example.com", "password": "新密码", "code": "123456" }
```

需要先 `POST /auth/code` 且 `purpose=reset`。成功返回 `{"ok":true,"revokedSessions":2}`，该账号**所有设备**都要重新登录。

## 4. 当前用户与用量

```http
GET /api/v1/user/info      → { "user": { … } }
GET /api/v1/user/storage
```

```json
{
  "usedBytes": 10485760,
  "quotaBytes": 1073741824,
  "noteCount": 12,
  "audioCount": 9,
  "maxAudioUploadBytes": 52428800
}
```

`quotaBytes` 已经包含「账号单独配额优先、否则用实例默认」的规则。

## 5. 随记同步

### 5.1 数据模型

服务端保存的随记与客户端 `NoteEntry` 对齐，另加三个服务端字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 客户端生成，`[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`，全局唯一 |
| `version` | 服务端维护的版本号，从 1 开始，每次成功写入 +1 |
| `serverUpdatedAt` | 服务端写入时间，仅用于展示/调试 |
| `deleted` | 墓碑标记 |
| `audio` | `{ "bytes", "format": "ogg"\|"wav", "sha256" }` 或 `null` |

完整字段：`id, title, createdAt, updatedAt, durationMs, transcript, polished, polishStatus, polishError, categoryId, tags, editedAt, version, deleted, audio, serverUpdatedAt`。

`title`（2.0.2）为可选名称，最多 200 字符；推送省略时保留原名称，空字符串明确清空。旧客户端继续兼容。

`tags` 服务端会 trim、去空、去重、每个最多 64 个字符、最多 32 个；`categoryId` 原样保存（是否存在于分类列表由客户端判断）。单条 `transcript`/`polished` 上限 200000 字符。

### 5.2 增量拉取

```http
GET /api/v1/notes?since=<cursor>&limit=<1..500>
```

```json
{
  "cursor": 128,
  "notes": [ { "id": "…", "version": 3, "deleted": false, "…": "…" } ],
  "hasMore": false,
  "serverTime": 1761000000000
}
```

- `cursor` 是服务端单调递增的序号，**不要用客户端时钟**。下次带上它就能只拿新变更。
- `since` 缺省为 0。若传入的值比服务端当前最大序号还大（数据库重建、换了服务器），服务端会从 0 重新开始，避免客户端永远拉不到东西。
- 删除的随记以墓碑返回：`deleted:true`，`transcript`/`polished` 为空、`tags` 为空、`categoryId` 为 `null`，`audio` 为 `null`。
- 用 `hasMore` 继续翻页，直到它为 `false`。

### 5.3 单条读取

```http
GET /api/v1/notes/:id
→ { "note": { … } }
```

不存在或不属于当前账号 → `404 note_not_found`。

### 5.4 批量提交本地变更

```http
POST /api/v1/notes/changes
{
  "changes": [
    { "id": "…", "createdAt": 1761000000000, "updatedAt": 1761000001000,
      "durationMs": 3200, "transcript": "原始识别", "polished": "润色后",
      "polishStatus": "ok", "categoryId": "cat-1", "tags": ["工作"],
      "version": 0 }
  ]
}
```

- 一次最多 200 条（`413 too_many_changes`）。
- 新建时 `version` 传 `0`（或省略）；更新时传**本地最后一次看到的版本号**。
- 删除某条：`{ "id": "…", "version": 3, "deleted": true }`。

成功（没有冲突）时返回 200：

```json
{
  "applied": ["note-a"],
  "duplicates": ["note-b"],
  "conflicts": [],
  "cursor": 130,
  "serverTime": 1761000000000
}
```

- `applied`：真正写入的 id。
- `duplicates`：这条变更之前已经落库（版本正好是 `version+1` 且内容一致），重试安全，不用处理。
- 有冲突时返回 **409**，并且**没有任何一条被静默覆盖**：

```json
{
  "error": "conflict",
  "message": "这些随记在服务器上已经被改过，请先合并",
  "applied": ["note-a"],
  "duplicates": [],
  "conflicts": [ { "id": "note-b", "server": { "id": "note-b", "version": 4, "transcript": "另一台机器的版本", "…": "…" } } ],
  "cursor": 131
}
```

冲突处理建议（第一版，不做 CRDT）：

1. 用 `conflicts[].server` 覆盖本地缓存的那份，或把两边都展示给用户选；
2. 用户确认后再以 `server.version` 作为 `version` 重新提交；
3. 同一批里 `applied` 的部分已经生效，不要重发。

若 `id` 已被**另一个账号**占用，该条进入 `conflicts` 且带 `"error":"note_id_taken"`、`server:null`——换一个 id 即可，服务端不会泄露对方内容。

### 5.5 单条写入 / 删除

```http
PUT /api/v1/notes/:id
{ "createdAt": …, "updatedAt": …, "transcript": "…", "version": 3, … }
→ { "note": { … }, "duplicate": false, "serverTime": … }
```

冲突时 `409`，body 带 `server`。`id` 被占用时 `409 note_id_taken`。

```http
DELETE /api/v1/notes/:id?version=3
→ { "ok": true, "deleted": true, "version": 4 }
```

`version` 必填（`400 version_required`）；冲突 `409`；本来就不存在时返回 `{"ok":true,"deleted":true,"alreadyGone":true}`。删除会同时删掉音频。

## 6. 音频

音频与随记一对一，路径由随记 id 决定，客户端不需要自己拼文件路径。

### 6.1 上传 / 覆盖

```http
PUT /api/v1/notes/:id/audio?format=ogg
Content-Type: audio/ogg
<二进制>
```

`format` 可省略，此时按 `Content-Type` 推断（`audio/ogg`/`audio/opus` → `ogg`，`audio/wav`/`audio/x-wav` → `wav`）；其他格式 `415 unsupported_media_type`。随记必须已存在且未删除，否则 `404 note_not_found`。

```json
{ "ok": true, "noteId": "…", "bytes": 48213, "format": "ogg", "sha256": "…" }
```

- 超过单文件上限 → `413 audio_too_large`（`Content-Length` 超限时在读流之前就拒绝）。
- 超过账号总量配额 → `413 quota_exceeded`；此时**旧录音保持原样**。
- 空文件 → `400 empty_audio`。
- 上传先写临时文件、校验配额、再原子重命名，最后写索引；任何一步失败都不会破坏已有录音。

### 6.2 下载 / 探测

```http
GET  /api/v1/notes/:id/audio
HEAD /api/v1/notes/:id/audio
```

返回原始字节，`content-type` 为 `audio/ogg` 或 `audio/wav`，带 `content-length`、`etag`（内容 SHA-256）、`cache-control: private`。支持 `HEAD` 只拿头。没有录音 → `404 audio_not_found`；随记不属于当前账号 → `404 note_not_found`。

### 6.3 删除音频

```http
DELETE /api/v1/notes/:id/audio
→ { "ok": true, "removed": true }
```

只删录音，保留随记。

## 7. 设备统计同步

统计数据按设备保存为独立快照，客户端汇总展示。请求需要登录；每个账号只能读写自己的设备快照。数据只包含每日计数、累计数字及应用名称，不含听写文本或录音。

```http
PUT /api/v1/stats/devices/:deviceId
{ "stats": { "version": 1, "records": 10, "lastAt": 1792890000000, "days": {}, "apps": {} } }

GET /api/v1/stats/devices
→ { "devices": [{ "deviceId": "…", "stats": { "version": 1, "records": 10, "lastAt": 1792890000000, "days": {}, "apps": {} } }] }
```

上传同一设备的新快照会替换旧快照，不会累加重复数据。历史记录清空不会删除统计快照。

## 8. 旧版听写历史（兼容保留）

已经发布的客户端只认这组接口，所以服务端继续提供，行为与 1.x 一致（payload 原样 JSON、LWW 合并、墓碑）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/sync/check` | 服务器时间、revision、条数 |
| POST | `/api/v1/transcription_history/push` | `{ entries, deleted }` 推送 |
| GET | `/api/v1/transcription_history/pull?since=&limit=` | 增量拉取 |
| GET | `/api/v1/transcription_history/sync_status` | 条数与启用状态 |
| DELETE | `/api/v1/transcription_history/wipe` | 全部转墓碑 |

新客户端应优先用第 5 节的随记接口（结构化字段、真实冲突检测）。

## 8.5 日程与提醒同步（1.0.0-rc.6）

日程和提醒各有一对接口，协议与随记同源：**递增 `seq` 作拉取游标、删除是墓碑、一次推送一个事务**。写入是 upsert，**不做版本检查**——日程和待办是用户随手在哪台设备上改的个人数据，服务端没有比刚提交那次编辑更权威的版本，「别人改过」的答复只会为用户的自己的修改弹一个冲突框。因此同一 `id` 上的顺序是「后写覆盖」，而删除保留墓碑，离线设备推送旧副本也不会让这一行复活。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/calendar?since=&limit=` | 增量拉取，返回 `cursor,events,hasMore,serverTime`；`limit` 默认 200、上限 500 |
| GET | `/api/v1/calendar/changes?since=&limit=` | 同上，随记客户端已在用的别名 |
| POST | `/api/v1/calendar` | 单条事件，或 `{changes:[…]}` 批量；一次最多 200 条 |
| GET | `/api/v1/reminders?since=&limit=` | 增量拉取，返回 `cursor,reminders,hasMore,serverTime` |
| GET | `/api/v1/reminders/changes?since=&limit=` | 同上 |
| POST | `/api/v1/reminders` | 单条提醒，或 `{changes:[…]}` 批量；一次最多 200 条 |

推送响应（两者一致）：

```json
{ "applied": ["id"], "duplicates": ["id"], "conflicts": [{ "id": "…", "error": "…_id_taken" }], "cursor": 42 }
```

`duplicates` 表示内容与既有行相同、**不推进 `seq`**，因此重复推送不会制造无意义的游标前进。`conflicts` 只在这一行已属于别的账号时出现。

**游标约定**：`since` 大于该账号历史上得到过的最大 `seq`（换机器、恢复备份、服务端换库）时服务端**从 0 重来**，否则那个客户端会永远拿到空数组。客户端只在整页处理成功后才持久化新游标。

**日程事件**：`id,title,start,end,allDay,location,notes,leadMinutes,source,uid,status,updatedAt,deletedAt,seq`。`start`/`end` 是毫秒时间戳，`allDay` 为布尔，`leadMinutes` 可为 `null`（用户显式「这次别提醒」），`status` 取 `confirmed`/`cancelled`，`source` 取 `voice`/`manual`/`import`。`title` 上限 200 字符、`notes` 2000、`location` 300、`uid` 300。

**提醒**：`id,title,dueAt,level,priority,deadlineAt,recurrence,status,data,updatedAt,deletedAt,seq`。`dueAt` 是「什么时候弹提醒」，`deadlineAt` 是「必须完成的时刻」，两者分开，只设截止时间不会被当成提醒时刻；`priority` 取 `low`/`normal`/`high`。整行原始内容同时放进 `data` 保存，这样重复规则、稍后提醒等字段往返不丢。

**墓碑**：`deletedAt` 有值时该行的内容不再返回（`data`/`notes` 为空），只剩身份与时间戳——删除的那台设备已经把内容丢掉了，把内容回显给别的设备只会让它一直活着。

## 9. 错误码

| HTTP | `error` | 含义 / 客户端动作 |
| --- | --- | --- |
| 400 | `bad_json` | 请求体不是 JSON 对象 |
| 400 | `bad_email` / `bad_password` | 参数不合法，提示用户 |
| 400 | `bad_code` / `code_invalid` / `code_expired` | 验证码错误或过期，重新发 |
| 400 | `bad_note_id` | id 不合规 |
| 400 | `version_required` | 删除随记必须带 `version` |
| 400 | `missing_token` | refresh 请求缺 `refreshToken` |
| 400 | `empty_audio` | 上传了 0 字节 |
| 401 | `unauthorized` | 未登录或访问令牌过期 → 尝试 refresh，再失败回登录页 |
| 401 | `bad_credentials` | 邮箱或密码错误 |
| 401 | `refresh_invalid` | 刷新令牌失效 → 清会话回登录页 |
| 403 | `registration_closed` | 管理员关闭了注册 |
| 403 | `account_disabled` | 账号被停用 |
| 404 | `not_found` / `note_not_found` / `audio_not_found` | 资源不存在或不属于你 |
| 405 | `method_not_allowed` | 方法不对 |
| 409 | `email_taken` | 邮箱已注册 |
| 409 | `conflict` | 版本冲突，按 5.4 合并后重试 |
| 409 | `note_id_taken` | id 被其他账号占用，换 id |
| 413 | `payload_too_large` / `too_many_changes` / `audio_too_large` / `quota_exceeded` | 超限 |
| 415 | `unsupported_media_type` | 音频格式不支持 |
| 429 | `rate_limited` / `code_cooldown` / `too_many_attempts` | 按 `retry-after` 等待 |
| 500 | `internal_error` | 服务端异常，不暴露细节 |
| 502/503 | `email_send_failed` / `email_not_configured` | 发信问题，联系管理员 |

## 10. 客户端同步流程

推荐的最小实现（客户端已有本地存储，服务端只是备份节点）：

```
启动 / 每 N 秒 / 手动点击：
  if 未登录 or 未启用云同步: 跳过

  1. 从本地取出 pending 的随记（新建、修改、删除）
  2. POST /api/v1/notes/changes   带上各自的 version
     - 200: applied + duplicates，清掉这些 pending
     - 409: conflicts[].server 写回本地待合并队列，其余按 applied 清掉
  3. 对每条有本地录音但服务端没有的随记：
       PUT /api/v1/notes/:id/audio?format=ogg
     （服务端 409/404 时跳过，下次再试）
  4. GET /api/v1/notes?since=<本地 cursor>&limit=200
     - 合并 notes：墓碑 → 删除本地；否则比较 version，服务端更新则覆盖本地缓存
     - 保存返回的 cursor
     - hasMore 为 true 时继续
  5. 记录 lastSyncAt / 错误信息，供设置页显示
```

要点：

- **先推后拉**。先推能把本地新改动尽快变成服务端版本，减少下一轮冲突。
- 每条记录用 `version` 判断，不用时间戳判断谁新——两台机器的时钟可能不一致。
- 推送失败不要丢 pending；服务端是幂等的（`duplicates`），重试安全。
- 冲突不要自动二选一，保留双方，交给用户或后续策略。
- 录音是可选备份：客户端本地删了音频但服务端还有时，以随记的 `audio` 字段为准决定是否重新上传。
