# 第十一阶段：本地 TTS 正确性与验收证据校正

> **执行者：DSH，继续当前 typeless 会话。** 先修下面已经定位的边界和验收缺口，自行补齐文档、测试、证据与提交，再通过 Codex 桥汇报。本轮完成后等待下一份任务，不自行开展其他迁移。

**状态：待实施。** 基线 `c85e982`，实现提交 `4ad5cdd`；当前生产 helper SHA-256 为 `f915ea6fe0b32618e2a53c12f4704ebfdcd65bea7403a6d726d645a01f20e6e0`，与阶段 10 报告一致。

**目标：** 修正已接入的 Rust TTS 边界、完成/错误事件语义和无效验收，重测真实收益。保持 Electron、按需独立 helper、现有音色、设置与业务接口；不新增语音引擎、后台服务、端口、依赖或 UI。

## 1. Codex 复核事实（2026-11-04）

下列事实来自 `c2d398e..c85e982` 源码与交付二进制复核，不是对用户声卡、热插拔或泄漏现象的推断。

| 编号 | 位置与事实 | 必须解决的问题 |
| --- | --- | --- |
| R1 | `fixtures/speech-native.cjs::survivors` 将整数 PID 经 `Where-Object` 后用 `$_.Id` 输出，整数没有 Id 属性。实测 `fixture.leftovers([process.pid], 2000)` 对仍存活的 Node 也返回 `[]` | 现有“无残留”断言不能识别存活进程，须修复并增加活进程阳性对照 |
| R2 | `speech-native.test.ts` 的首末 `sample(pid)` 在 `await fixture.request(voices)` 之后执行，此时进程已退出；实测得到 `{}`，`if (typeof handles === 'number')` 跳过断言。31 次调用全是 `voices` | 未证明合成/暂停/停止路径回收，也未测到声称的句柄趋势 |
| R3 | “超过 20 秒启动期限”用例调用 `fixture.live`，其代码直接 spawn helper，未调用 `createSpeechRunner` 的 20 秒计时器 | 需实际经过生产运行器验证计时器取消与控制/停止，不能只改测试名称后继续声称已覆盖 |
| R4 | `main.rs::speakable` 用 `split('\0').next()` 截断。向交付 exe 发 `前半句\u0000后半句`、rate 10、volume 0，实测退出 0 并输出 started 和 ok:true | helper 直连会丢后半句却成功，违反阶段 10 文本完整性要求；上层 `speechText` 已移除 NUL、保留两侧，正常业务路径未复现丢字，不能把二者混为一谈 |
| R5 | SAPI `GetEvents` 失败被忽略，`WaitForNotifyEvent` HRESULT 被丢弃；END 没有前置 START 时会补发 `started` | 读取失败可能在启动计时器已取消后持续等待；缺失开始证据时不能补造开始成功。这里是明确代码出口缺口，未声称已复现真实设备故障 |
| R6 | benchmark 在 `exit` 后 `setTimeout(finish, 200)`，`totalMs` 把人为等待算入请求；CPU 是一次采样时的进程累计 CPU。配置 `samplesPerHost:10`，实际 raw 每侧20条 | 校正时间边界、CPU 口径与样本元数据，旧百分比不能继续作为已校准的完整执行成本 |

本轮复核另运行了 `speech.test.ts`、`speech-playback.test.ts`、`providers/tts.test.ts`：3 文件、49 用例通过。一次音色枚举交叉检查为 Rust 响应/close 34/35ms、PS 898/939ms，仅说明原基准的 200ms 人为延迟问题，不是新的 P50/P95。

## 2. 任务 A：先让验收确实能发现失败

修改 `tests/yu-v2/fixtures/speech-native.cjs`、`src/main/speech-native.test.ts`，必要时修改 `src/main/speech.test.ts`。

- [ ] 优先使用 Node 已有的进程存在性接口，或修正 PowerShell 输出对象；保留逐 PID 隔离，不回到全局进程数量。明确区分已退出、仍存活和查询失败。
- [ ] 增加阳性对照：测试期间仍活着的受控 PID 必须被检出；受控子进程退出后必须不被检出。旧 `survivors` 应使阳性对照失败。不要使用 timeout=0 直接返回初始 PID 列表冒充探测。
- [ ] 句柄/线程采样在进程真实合成或暂停存活期间执行，实际覆盖至少首/中/末几次。必须断言采样字段有效；缺测如实失败或记录环境限制，不能用 if 跳过后写成通过。
- [ ] 至少 30 次真实 speak 的开始→暂停/继续或取消→退出，记录自己启动的 PID 与退出结果；不能用音色枚举冒充音频路径。合理控制各次时长，统一 volume 0，保留实际音频设备交互的说明。
- [ ] 新增通过生产 `createSpeechRunner` 的真实超过 20 秒暂停后继续用例，验证 started 后启动计时器已清除；另覆盖启动前取消、暂停时取消、下一次朗读打断旧请求、迟到控制/旧进程退出不影响新请求。
- [ ] 仅在测试需要时使用最小内部 seam/现有 mock；不给产品增加测试开关或 PID 管理框架。fixture 的超时定时器在完成时清理，监听 close 并收齐 stdout，任何失败出口也回收本测试子进程。

## 3. 任务 B：修复 helper 文本与事件合同

修改 `native/speech/src/main.rs`，确有需要时调整 `json.rs` 和相关测试；不重写云 TTS、文本清理与整个运行器。

- [ ] 直连 helper 对包含 NUL 的请求明确拒绝：一行不含正文的 `ok:false`，没有 started，非零退出。保留上层现有 NUL 清理行为与完整两侧文本；修改当前错误地期待 `Some("前半句")` 的单测，并增加真实 exe 反例。不要“截断后成功”。
- [ ] START 仅由匹配本次 stream 的真实 START 事件确认；END 缺少 START 时明确报告异常，不补发 started。结束成功、取消、EOF 和错误分别处理，终态只发一次。
- [ ] 对 `GetEvents` 与等待接口的真正失败 HRESULT 明确退出、停止合成并释放资源；`S_FALSE`/正常超时不是致命错误。错误信息保留失败阶段及 HRESULT，避免全部压成无法定位的 unavailable；不带用户正文。
- [ ] 用最小内部测试替身或既有可控路径验证：普通超时继续、读取错误退出、等待失败退出、END 无 START 不确认开始、旧 stream 事件不匹配当前请求。区分模拟错误与真实设备实测，不能把模拟结果写成无设备/热插拔已验收。
- [ ] 核对仍然存在的 `WaitForNotifyEvent(50)`：当前控制输入依靠最长约 50ms 的定时检查。可用最小 Win32 事件让输入/EOF 唤醒；若保持此设计，文档须直说有界控制轮询及其测量，不能宣称完全无轮询。不要为改名引入复杂线程框架。

## 4. 任务 C：校正基准并重新保存证据

修改 `scripts/benchmark-speech.mjs`，新报告使用 `tests/yu-v2/evidence/rust-speech-correctness-20261104.json`，保留原 `rust-speech-20261104.json` 不覆盖。

- [ ] 对协议响应、started、终态、exit/close 分别记录真实时间；通过 close 等待输出管道关闭，删除人为 200ms 完成延迟。无需为等待管道引入宽限计时器。
- [ ] 消除测试/采样定时器残留、stdin EPIPE 未处理和 spawn 失败不收尾的问题；等待必要采样完成或如实缺测，不把任务已结束当成还有活进程可采样。
- [ ] CPU 现有值是采样时的进程累计值。可以保留为明确标记的快照，并记录实际采样时间和范围；若声称整次朗读 CPU，则需测量完整进程生命周期，不能从一个早期快照推导。内存快照同样不称作峰值；采样延迟300ms是安排时间，不是 PowerShell 查询完成的时刻。
- [ ] 区分轮次、请求数、有效样本数与失败数，以 raw 实际数量填写；默认每侧至少20个有效枚举/启动样本。失败样本保留，checks 失败时脚本非零退出，不能只打印 failed 后返回成功。
- [ ] 同机、同音色、同 rate/volume、同输出方式，按 PS/Rust/Rust/PS 交错，预热后重新采样；新报告记录最终 exe 哈希。复核阶段 10 的采纳条件并报告是否仍成立。
- [ ] 原基准数据保留为历史；新结果修正文档，不把原 totalMs 减200ms当作重测，也不把本次单样本交叉检查写成分位数。

## 5. 验证、文档与交付

优先运行直接相关测试；原生代码变更后才按现有入口构建与扩大回归，不重新跑 622 秒唤醒会话：

```text
cd native/speech
cargo fmt -- --check
cargo clippy --locked --offline --all-targets -- -D warnings
cargo test --locked --offline
cd ../..
pnpm build:native
pnpm exec vitest run src/main/speech.test.ts src/main/speech-native.test.ts src/main/speech-playback.test.ts src/main/providers/tts.test.ts
pnpm typecheck
```

- [ ] 修复后运行必要全量 `pnpm test:native`、`pnpm test`、`pnpm build`，记录实际通过/跳过/失败数量。沿用固定依赖及 E 盘现有缓存，不升级依赖、不为本轮打包安装器。
- [ ] 自行逐项回填本计划的实际结果：每个 R1–R6 的修复文件、反例、测试入口、重测结果与未测项；无法完成的项保持未完成。不得通过扩大超时、删除断言或降低采样要求掩盖失败。
- [ ] 更新阶段 10 文档、`docs/rust-refactor-plan.md` 与 README 中英的本轮相关表述；正确标注上层清理/直连接口、有界轮询、模拟/实测、历史/新指标。开发版正常重启后生效的边界照实记录，不强制关闭用户应用。
- [ ] 对新 helper 保存哈希；清理本轮可重建产物，保留源码、最终二进制、fixture 与原始报告，不删除用户数据、旧证据或无关缓存。
- [ ] Diff 检查后只提交本阶段文件，自动 Conventional Commit，不 push。自行记录实现/文档提交编号，再从当前 Codex 桥汇报 R1–R6 处理情况、验证与限制，结束本轮。

## 官方依据

- [SAPI GetEvents](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/ms717851(v=vs.85))：成功、无事件和真正失败须区别处理。
- [SAPI WaitForNotifyEvent](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/ee450848(v=vs.85))：阻塞等待、超时与 HRESULT 语义。
- [SAPI TTS 事件](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/ms720164(v=vs.85))：输出开始/结束与 stream 对应关系。
- [Node ChildProcess close](https://nodejs.org/api/child_process.html#event-close)：进程结束与 stdio 管道关闭的区别；实现同时核对当前 Node/Electron 版本。
