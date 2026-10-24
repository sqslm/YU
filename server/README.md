# Typeless Rebuild 自建服务端

给 [Typeless Rebuild](../) 桌面客户端用的自建服务端：账号、邮箱验证码、会话、随记云同步、录音（Opus）备份，全部跑在**你自己的机器**上，不依赖任何商业云。

- **单进程、零 npm 依赖**：只用 `node:http`、`node:sqlite`、`node:crypto`、`node:net/tls`。没有 `npm install` 会在离线机器上失败的问题，镜像也小。
- **一个容器搞定**：`docker compose up -d` 就有数据库、文件存储、SMTP 发信和 Web API，不需要 Redis、Postgres、消息队列。
- **本地优先**：客户端不连服务器也能正常记录；连上了才同步，服务端只是备份与多设备对齐的节点。
- **不静默覆盖**：每条随记带版本号，冲突会明确返回给客户端，由人或客户端合并。

> 安全边界先说清楚：随记在服务器上是**明文**存储的（SQLite + 音频文件），服务端管理员可以直接读到。这不是端到端加密，也请不要这样宣传。要 E2EE 得改客户端加密模型，本服务端不做。

---

当前版本 **2.0.2**，协议版本 **1**。新增可选随记标题字段，支持重命名与显式清空；旧客户端省略标题时保留已存名称。数据库启动时自动迁移，无需重建。保留 2.0.1 的音频增量游标修复。更新前使用管理员 CLI 备份数据库和录音，保留原数据卷与私有 `.env`，然后重建容器。

## 1. 功能

| 领域 | 已实现 |
| --- | --- |
| 账号 | 邮箱 + 密码注册、邮箱验证码、登录、退出、刷新令牌轮换、改密后撤销全部会话、禁用账号立即生效 |
| 管理员 | CLI 建号/提权/禁用、开关公开注册、查看账号与用量、单独设置配额、一致性备份 |
| 随记同步 | 随记全字段（原始识别、润色文本、分类、标签、时长、编辑时间）、增量游标、版本冲突检测、删除墓碑 |
| 音频 | Opus/WAV 上传下载、单文件上限、每账号总量配额、流式下载、与随记同生命周期 |
| 运维 | 健康检查、`/api/v1/meta` 能力探测、版本化 migration、优雅关闭、`VACUUM INTO` 备份 |
| 兼容 | 保留旧版 `transcription_history/*` 接口，已发布客户端不用改就能继续同步文字历史 |

**不做**：ASR、AI 润色、转码、支付、团队空间、Web 管理后台、邮件队列、对象存储（S3 留了位置但不实现）。

## 2. 技术结构

```
server/
├── src/
│   ├── main.mjs        启动、优雅关闭
│   ├── app.mjs         HTTP 服务、路由装配、请求上下文、统一错误
│   ├── config.mjs      环境变量 → 配置（含安全校验与警告）
│   ├── db.mjs          SQLite 打开与版本化 migration
│   ├── http.mjs        路由、JSON 读写、统一响
│   ├── session.mjs     访问/刷新令牌、鉴权、撤销
│   ├── password.mjs    scrypt 哈希、令牌生成
│   ├── mail.mjs        零依赖 SMTP 客户端与中文邮件模板
│   ├── storage.mjs     音频路径、流式落盘、配额统计、发送
│   ├── routes/         auth / meta / notes / user / sync(旧版)
│   └── cli.mjs         管理员命令
├── test/               node:test，35 个用例，含本地假 SMTP
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

存储：`SQLite (WAL)` + 本地文件系统。没有外部服务，备份 = 数据库快照 + 音频目录。

## 3. 快速开始（Docker Compose）

```bash
cd server
cp .env.example .env
# 编辑 .env：至少把 SMTP 配好，否则公开注册会被自动关闭
docker compose up -d
docker compose logs -f
```

检查：

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/api/v1/meta
```

第一个管理员（容器里执行）：

```bash
docker compose exec typeless-server node src/cli.mjs create-admin \
  --email you@example.com --password '换成你的强密码'
```

然后在客户端「账号 → 服务器地址」填 `http://你的地址:8787`，用这个邮箱登录。

> 没有 SMTP 也能用：把 `EMAIL_VERIFICATION_REQUIRED` 保持默认，注册会被关闭，只用 CLI 建号即可（`create-admin` 之后还可以 `promote` 别人）。

### 反向代理

服务默认只监听 HTTP，请把 HTTPS 交给 Caddy/Nginx/Traefik：

```caddyfile
typeless.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

反代后把 `TRUST_PROXY=1`、`PUBLIC_URL=https://typeless.example.com` 填上，限流才会按真实 IP 计数。

## 4. 直接跑（不用 Docker）

要求 **Node.js ≥ 22.5**（`node:sqlite`），推荐 24 LTS。Docker Compose 需支持可选 `env_file`（v2.24+）；`.env` 中未在 Compose 显式列出的验证码、会话、请求体等配置也会传入容器。

```bash
cd server
cp .env.example .env          # 或者直接 export 变量
DATA_DIR=./data node --env-file=.env src/main.mjs
```

管理员与备份走同一个 CLI：

```bash
node src/cli.mjs create-admin --email you@example.com
node src/cli.mjs list-users
node src/cli.mjs backup --out /mnt/backup/typeless-$(date +%F)
```

**独立可执行程序**：服务端本体没有任何 npm 依赖，最省事的“独立部署”就是把 `src/`、`package.json` 和一个 Node 运行时放到目标机器（Windows 也一样）。若确实需要单文件可执行程序，可用 Node 官方 SEA（single executable application）：

```bash
npm i -D postject
node --experimental-sea-config sea-config.json   # 见 scripts/sea-config.json
cp "$(command -v node)" typeless-server
npx postject typeless-server NODE_SEA_BLOB sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
```

这一步依赖 `postject`，本仓库的 CI 没有预装它，所以**没在本机验证**；Docker 与 `node src/main.mjs` 两条路径都验证过。SEA 产物同样读环境变量、同样用 `DATA_DIR`。

## 5. SMTP 配置

任何标准 SMTP 都行，`SMTP_TLS_MODE` 选 `implicit`（465）或 `starttls`（587）。生产环境**不允许** `none`：`config.mjs` 会直接抛错，避免明文发密码。

| 服务 | host | port | TLS | 密码是什么 |
| --- | --- | --- | --- | --- |
| QQ 邮箱 | smtp.qq.com | 465 | implicit | 设置里生成的「授权码」 |
| 163 邮箱 | smtp.163.com | 465 | implicit | 客户端授权密码 |
| Gmail | smtp.gmail.com | 587 | starttls | 应用专用密码（需开两步验证） |
| 企业邮箱 | 问管理员 | 465/587 | implicit/starttls | 通常是登录密码或专用密码 |

验证码行为：6 位随机数、默认 5 分钟有效、同邮箱 60 秒冷却、最多试错 5 次、成功即作废、只存 SHA-256 校验值；日志里只记「给谁发了」，不记验证码。注册与找回密码用两套独立的码，互不通用。

## 6. 环境变量

完整清单见 [`.env.example`](.env.example)。最常改的：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` / `PORT` | `0.0.0.0` / `8787` | 监听地址 |
| `DATA_DIR` | `./data` | 数据库、音频、备份的根目录 |
| `PUBLIC_URL` | 空 | 对外地址，写进 `/api/v1/meta` |
| `REGISTRATION_ENABLED` | 跟随 SMTP | `true`/`false`；留空时配了 SMTP 就开放 |
| `EMAIL_VERIFICATION_REQUIRED` | `true` | 关掉只适合私有实例 |
| `DEFAULT_USER_STORAGE_MB` | `1024` | 每账号音频配额 |
| `MAX_AUDIO_UPLOAD_MB` | `50` | 单个音频上限 |
| `SMTP_*` | 空 | 见上一节 |
| `TRUST_PROXY` | `0` | 放在反代后面才开 |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |

配置非法会**启动失败并说明原因**，不会悄悄降级成不安全的默认值。

## 7. 数据、备份与升级

```
$DATA_DIR/
├── app.db          账号、会话、随记元数据、音频索引
├── app.db-wal      写入日志（备份时不能只拷 app.db）
├── audio/<userId>/<noteId>.opus
└── backups/        CLI 生成的备份
```

备份（运行中也能做，`VACUUM INTO` 会拿到一致快照）：

```bash
node src/cli.mjs backup                       # → $DATA_DIR/backups/<时间戳>/
node src/cli.mjs backup --out /mnt/nas/typeless-2026-10-21
```

恢复：停服 → 用备份里的 `app.db` 和 `audio/` 覆盖 `$DATA_DIR` 下同名内容 → 启动。备份目录本身就是完整副本，可以直接整目录搬走。

升级：换镜像/代码后重启即可，启动时会按 `PRAGMA user_version` 逐条执行 migration；已存在的数据不会被删除。**升级前先备份**，尤其是跨大版本。

Docker 用户的数据在命名卷 `typeless-data` 里，`docker compose down`（不带 `-v`）不会删；`docker compose down -v` 会，别手滑。

## 8. 客户端怎么连

客户端「设置 → 账号」填服务器地址（如 `http://192.168.1.10:8787` 或反代后的 `https://typeless.example.com`），然后：

1. `GET /api/v1/meta` 看是否开放注册、是否需要验证码；
2. 需要验证码时 `POST /api/v1/auth/code`，收邮件；
3. `POST /api/v1/auth/register` 或 `/login` 拿 `accessToken` + `refreshToken`；
4. 同步前先 `POST /api/v1/notes/changes` 推本地改动，再 `GET /api/v1/notes?since=<cursor>` 拉服务端变更；
5. 有录音的随记用 `PUT /api/v1/notes/:id/audio?format=ogg` 上传，播放时 `GET` 同一个地址。

接口、字段、错误码、冲突处理见 [docs/API.md](docs/API.md)。

## 9. 测试

```bash
cd server
node --test "test/*.test.mjs"
```

35 个用例覆盖：注册/登录/退出/刷新轮换/验证码过期与试错锁定/密码重置撤销会话/关闭注册/无 SMTP/禁用账号、随记推送与增量拉取/幂等重推/版本冲突/墓碑/分页与游标自愈/跨账号隔离/字段裁剪、音频上传下载/HEAD/单文件与总配额/覆盖/非法格式/路径穿越/删除随记连带删音频。邮件走本地假 SMTP（`test/helpers.mjs` 里的 `startMailServer`），不依赖外网。

`TEST_LOG=1 node --test test/auth.test.mjs` 会把服务端日志打出来，排查时有用。

## 10. 已知限制

- 管理员能读明文随记；没有 E2EE。
- 没有 Web 管理后台，管理动作走 CLI。
- 没有邮件队列：SMTP 失败会立即返回 5xx，让用户重试。
- 音频只存本地磁盘；S3 未实现（接口抽象已留，`storage.mjs` 是唯一出入口）。
- 冲突只做「检测 + 返回双方」，不做 CRDT 或自动语义合并。
- 单实例部署：SQLite + 本地文件决定了它不适合多副本水平扩展。
- Node 的 `node:sqlite` 仍标记为实验特性，启动时会打印一条 `ExperimentalWarning`，不影响功能。

## 11. 许可

MIT，见 [LICENSE](LICENSE)。
