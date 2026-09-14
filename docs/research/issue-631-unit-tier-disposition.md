# #631 unit 档外部资源名实不符 — 扫描处置账

票庭 run `01a09f5b-b21a-722e-91ff-81dce8631870@countersign` r3 `converged`（sealed `2026-09-14T10:31:00.037Z`，attemptId `8ea9c02a-7b75-4b0a-9279-4bd023750fba`）。
基线 HEAD：`dadb5318`。计时口径：`node --import tsx --import ./scripts/test-process-env-preload.mjs --test --test-reporter=tap test/unit/**/*.test.ts` 的单案 `duration_ms`（含 runner 并发等待；与 suite 墙钟分别记账）。

## 扫描方法

类别：`test/unit/` 下真实临时目录 / 读写真实文件系统 / 起子进程 / 碰网络。
扫描：源码静态（`mkdtemp`/`tmpdir`/`node:fs` 写读 / `child_process` / 网络 API）+ 处置后复扫（去掉注释后的代码面）。

## 基线 → 处置后

| 项 | 基线 (dadb5318) | 处置后 |
|---|---|---|
| `test/unit/` 测试文件 | 37 | 26 |
| 代码面命中 mkdtemp/写FS/子进程/网络 | 17 文件 | **0** |
| 单案 `duration_ms` > 100ms | 38 | **0** |
| unit suite 墙钟 | ~6.07s | ~2.0s |
| unit 案数 | （基线未单列） | 84 pass |

## 逐案处置

### 改纯（路径仅为不透明坐标 / 死 import / 假阳性脚手架）

| 文件 | 资源形态 | 契约 / 法源 | 处置 | 理由 |
|---|---|---|---|---|
| `test/unit/acp-set-model-provider-model.test.ts` | mkdtemp | #644 hermes `session/set_model` provider:model；假 ACP | **改** | fake connection 不落盘；路径改不透明字符串 |
| `test/unit/host-retry-verdict-relay.test.ts` | mkdtemp | #813 ACP opaque retry.message；假 ACP | **改** | 同上；headless 面已在 integration |
| `test/unit/activation-envelope-module.test.ts` | withTempRoot + existsSync | activation fact / ledger home / observation face | **改** | 相对 home 拒收是路径数学；删 temp root 脚手架 |
| `test/unit/engine-material.test.ts` | mkdtemp 写 notes | #356/#376/#883 路径安全 + session 行 | **改（拆）** | 纯语法/append 留 unit；FS 发现移 integration |
| `test/unit/public-cli-option-definitions.test.ts` | 死 `execFile` import | #342 option table→parser | **改** | 删除未用 spawn import；本体本已是纯解析 |

### 移 integration（契约必须观察本机资源 / 子进程）

| 原 unit 路径 | 现路径 | 资源形态 | 契约 / 法源 | 理由 |
|---|---|---|---|---|
| `gate-submission-candidate.test.ts` | `test/integration/…` | mkdir/write session | #836 dossier 整 run 指针 | `createAuditorDossierTool` 实读 session 树 |
| `run-terminal-artifacts.test.ts` | `test/integration/…` | mkdir/write error json | T10 parent unique error bind | `readRunTerminalArtifact` 实读 |
| `activation-ledger-nofollow-missing.test.ts` | `test/integration/…` | mkdtemp + register hooks + append | O_NOFOLLOW fail-closed | 真 ledger append 缝 |
| `collector-handbook.test.ts` | `test/integration/…` | mkdir/write/symlink/read | #677 handbook UTF-8 / ADR 0038 | 真 handbook 读写与 symlink 拒 |
| `host-pi-runtime.test.ts` | `test/integration/…` | outside-worktree mkdtemp + symlink | host pi PATH 解析 | 真 node_modules / PATH 隔离 |
| `host-session-live-records.test.ts` | `test/integration/host-session-acp-write-fail.test.ts` | chmod 冻目录 | #811 ACP write-fail abort race | 真 FS 权限竞态；与既有 headless integration 分文件 |
| `human-format.test.ts` | `test/integration/…` | mkdir/write ledger | #162 S2 board data-* / 人读 span | `renderFactoryBoardHtml` 读 ledger |
| `package-method-skill.test.ts` | `test/integration/…` | 读 package skill + 写 provenance | method skill 装载 / provenance | 真 package 树与 home |
| `ticket-trajectory-binding.test.ts` | `test/integration/…` | mkdir/write runs | ticket trajectory index | 真 book 树扫描 |
| `test-process-env.test.ts` | `test/integration/…` | spawnSync + mkdtemp | #549/#612/#685 测试 HOME 隔离 | 测试基建；须真进程生命周期 |
| `test-user-profile-preload.test.ts` | `test/integration/…` | mkdtemp + subprocess | #604 userInfo preload | 测试基建；须真 `--require` 子进程 |
| （自 unit 拆出）`engine-material` FS 案 | `test/integration/engine-material.test.ts` | mkdir/write notes | listEngineMaterialNames / FromOptions | 真 readdir/existsSync 发现 |

### 保留 unit（扫描假阳性：注释或路径字符串，无外部资源）

| 文件 | 为何曾命中 | 契约 | 保留理由 |
|---|---|---|---|
| `collector-github-parse.test.ts` | 注释含 “spawn” | collector normalize/marker 纯函数 | 无 FS/子进程；真 spawn 在 integration |
| `user-dialogue-stdin.test.ts` | 路径字符串 `/tmp/...` | #879 typed stdin codec | 无 FS；纯编解码与 argv 投影 |
| `submission-status-open-domain.test.ts` | （基线未入 17；复扫无命中） | #836 提交 status 开域 | 纯 TypeBox Value.Check |

其余未命中的 unit 文件不在本类，未改。

## 超线案专项审视

处置后 unit 全量 **0** 案 `duration_ms > 100ms`（计时口径同上；84 案，suite 墙钟 ~2.0s）。基线 38 案超线随移档/改纯消失；不因超线删断言或失败路径。

## 未新增机制

- 无新 harness / 夹具 / 分档框架。
- 仅 `git mv` 归位、删死 import、路径改不透明字符串、按既有 `test/integration/` 目录承接。
- `host-session-acp-write-fail.test.ts` 为避免与既有 `host-session-live-records.test.ts` 文件名碰撞的改名，非平行机制。

## 复扫

去掉注释后的 `test/unit/**/*.test.ts` 代码面：`mkdtemp` / `node:fs` 写 / `child_process` / 网络 API → **0 命中**。

## 验证

- `node … --test test/unit/**/*.test.ts` → 84 pass，fail 0，>100ms = 0，duration_ms ≈ 1993。
- 聚焦：全部移档文件 + 改纯文件 → 60 pass。
- 本片未跑全量（quality-law：施工轮次只跑触及面；全量留最终待合并状态）。
