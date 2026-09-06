# #685 C3 删案承接表（owner 2026-09-06 r13）

口径（owner 御批选项 1）：

- **不再点火**真宿主 / 冷装 / 聚合脚本。
- 承接只用**既有真实卷宗**逐案指认：具名 `runId` + **绝对路径**；该卷必须确实证明该契约。
- 证不了的明确标 **未结**。
- **自拟聚合摘要不算 run**（含 `runs/01a072fc-685-c3-agg-*@fixer/aggregation-dossier.json` 及其 checks）。
- 七处伪 run 目录原地保全，本表不引用、不删除。

前缀：`/Users/akagilnc/.ak-roles/books/ak-pi-workflow-roles/runs/`

留存 CI 案（确定性 call-input）可作同根承接，与生产卷并列写明。

| 删案 | 契约 | 必要性 | 同根 | 处置 | 精确承接 | 结态 |
| --- | --- | --- | --- | --- | --- | --- |
| `test/integration/collector-real-entry.test.ts` 整文件 | Collector 公开入口 settle | 真宿主 | 生产 collector | 删 | runId `01a07280-5ba5-7554-b8a3-2ab8294ce0d9`；绝对路径 `…/runs/01a07280-5ba5-7554-b8a3-2ab8294ce0d9@collector`；`entryMode=public-cli`，`rolePackageRoot`→`~/.pi/agent/npm/…/pi-workflow-roles`，`state=terminal`，`outcome=collected`。**不**证 resume 失败面 | 健康 settle **已结**；resume 失败面 **未结** |
| `test/integration/public-cli-collector-run.test.ts` | collector 公开 run | 真宿主 | 同上 | 删 | 同 `01a07280-5ba5-7554-b8a3-2ab8294ce0d9@collector` | 同上 |
| `test/integration/gatekeeper-real-entry.test.ts` 整文件 | 直召 Inspector / Notary | 真宿主 | 生产 gate 席 | 删 | Inspector：`01a07237-8bab-7606-ab2f-ea2f181fbfe7` → `…/01a07237-8bab-7606-ab2f-ea2f181fbfe7@inspector`（public-cli，terminal，session 在盘）。Notary：`01a0628a-c182-7887-98a7-085af456ac63` → `…/01a0628a-c182-7887-98a7-085af456ac63@notary`（public-cli，terminal） | 健康直召 **已结** |
| `test/integration/gleaner-left-real-entry.test.ts` | gleaner-left 真入口 | 真宿主 | 生产 gleaner | 删 | `01a06fa4-2f99-7df8-92c8-f70c1f24061b` → `…/01a06fa4-2f99-7df8-92c8-f70c1f24061b@gleaner-left`（public-cli，terminal，session 在盘） | 健康入口 **已结** |
| `test/integration/fixer-pi-loader-methods.test.ts` | fixer 方法装载 / 公开 settle | 真宿主 | 生产 fixer | 删 | `01a07240-fc0d-7ef3-8bd5-7fb38f346220` → `…/01a07240-fc0d-7ef3-8bd5-7fb38f346220@fixer`（public-cli，terminal，accepted completed） | 健康 settle **已结** |
| `test/integration/public-cli-judge-run.test.ts` | Judge 公开 CLI 真跑 | 真宿主 | 生产 judge | 删 | `01a0726d-5d67-713f-956e-81c201907e59` → `…/01a0726d-5d67-713f-956e-81c201907e59@judge`（escalate）；`01a07246-0999-7ec9-a422-fb06dad57d18` → `…/01a07246-0999-7ec9-a422-fb06dad57d18@judge`（continue）。二者均为 public-cli + `~/.pi/agent/npm` 安装根 + terminal。**不**证非法激活 / observation 失败 | 健康/裁决路径 **已结**；非法激活失败面 **未结**（ADR 0019 留存确定性案另担） |
| `test/integration/public-cli-coder-installed-run.test.ts` | coder 已装包入口 settle | 真宿主 | 生产 coder | 删 | 健康 coder：`01a07257-43a1-7f09-ac08-d0d7d67ca20a` → `…/01a07257-43a1-7f09-ac08-d0d7d67ca20a@coder`；`01a07222-0cb7-72f1-b1ae-6ded5aa3cf89` → `…/01a07222-0cb7-72f1-b1ae-6ded5aa3cf89@coder`（均 public-cli + npm 安装根 + completed）。provider-stop/resume 失败面 | 健康已装入口 **已结**；provider-stop/resume 失败 **未结** |
| `test/package/package-entrypoint-packaged-workers.integration.test.ts` 健康 worker 腿 | 打包后 worker 公开 settle | 真宿主 | 生产 coder/fixer/judge | 删 | coder/fixer/judge 健康卷见上列具名路径 | 健康 settle **已结** |
| 同上 · 跨进程 dossier 隔离 | 两独立 packaged 进程 dossier 不串 | 真宿主+隔离 | 指针隔离 | 删 | 留存 CI：`test/unit/dossier-resolution.test.ts`「concurrent pointers keep two runs from crossing dossiers」。生产两独立 run 目录并存可观察，但**不是**原案「两 packaged Pi 进程」专用证明 | 指针隔离 **已结**（留存案）；原 packaged 双进程隔离 **未结** |
| `test/integration/public-cli-judge-engine-detour.test.ts` | engine-detour 失败 typed 停整 run（ADR 0071） | 真宿主失败面 | 0071 | 删 | `01a00dd4-679c-7031-8553-c2a41a871e07` → `…/01a00dd4-679c-7031-8553-c2a41a871e07@judge`：`artifacts/error.json` 为 `EngineDetourInfrastructureError` / `engine detour exited with code 1`，`invocation.engine=opus`，`state=terminal`，无 accepted report。同形：`01a00dd5-5e7a-7b82-9b09-2fc81daecfd5@judge`、`01a00dd4-b672-752d-8ae3-9bad6c713842@judge`。留存 CI 补 call-input：`test/integration/engine-detour-cancel-idle.test.ts`（spawn/abort）、`public-cli-engine-axis.test.ts`（engine 名/配置） | judge detour 失败停 run **已结** |
| `test/integration/public-cli-reviewer-engine-detour.test.ts` | reviewer engine-detour 失败 | 真宿主失败面 | 0071 | 删 | `01a067dd-924f-74a1-9d56-e068df06be4d` → `…/01a067dd-924f-74a1-9d56-e068df06be4d@reviewer`：`EngineDetourInfrastructureError`（「本激活内劳务引擎已使用」），`engine=opus`，terminal。另 `01a067d3-01cc-74f4-817c-8dac3b787cca@reviewer` / `01a067d7-6fa2-749b-a6e5-2c5150294964@reviewer` 有同 identity 的 error 落盘 | reviewer detour 失败面 **已结** |
| `test/package/public-cli-install.test.ts` | 隔离 Pi home 执行 install 并发现 bin | 真 npm install | 安装过程 | 删 | 生产大量 run 的 `rolePackageRoot` 已落在 `~/.pi/agent/npm/node_modules/@akagilnc/pi-workflow-roles`（例：上列 collector/coder/fixer/judge），只证明**已装包可被 public-cli 加载**，**不**证明 install 命令本身或隔离 home 构造 | 已装包加载面 **已结**；install 过程/隔离 home **未结** |
| `test/package/package-entrypoint-cold-help.integration.test.ts` | 冷装 live help 随 extension 重读 | 真宿主+冷装 | help | 删 | 无生产 run 归档 `ak-role … --help` 输出 | **未结** |
| `test/package/public-cli-cold-matrix.test.ts` | 冷装版本矩阵 / 文档化 update | 真 install 矩阵 | 安装矩阵 | 删 | 无版本矩阵真跑卷 | **未结** |
| `test/integration/shared-cold-install-construction.test.ts` | 共享冷装指纹重建 | 真 install | 安装构造 | 删 | 无 | **未结** |
| `test/package/package-entrypoint-navigator.integration.test.ts` | 包内 Navigator 真会话 | 真宿主 | 生产导航 | 删 | Navigator 嵌在生产腿内，无单独 `@navigator` run 目录可指认专用契约（准备/失败矩阵/跨角色连续性） | **未结**（无具名 navigator 卷） |
| `test/integration/navigator-lifecycle-real-session.test.ts` | Navigator 真会话生命周期 | 真宿主 | 同上 | 删 | 同上 | **未结** |
| `test/package/package-entrypoint-observation.integration.test.ts` | tool-execution observation 面 | 真宿主 | observation | 删 | 无 observation 专用生产卷可核 | **未结** |
| `test/integration/audit-failure-subprocess.test.ts` | audit 失败子进程 typed 终局 | 真宿主失败面 | judge/auditor 失败 | 删 | 留存 CI：`test/integration/judge-auditor-dossier.test.ts`（missing-dossier/subject + **no-call** childCalls=0）；`test/unit/dossier-resolution.test.ts`。健康 judge **不**承接 audit 失败子进程 | 负向 dossier/no-call **已结**（留存案）；原 subprocess 失败矩阵 **未结** |
| `test/package/judge-auditor-fixture-tracer.test.ts` | judge-auditor fixture tracer | 真宿主 | 同上 | 删 | 同上留存案 | 同上 |
| `test/integration/reviewer-activation-rejection-books.test.ts` | reviewer 激活拒绝 | 真宿主拒绝面 | 激活屏障 | 删 | 健康 reviewer `01a07244-6de6-7cda-856d-8de0cecb3a13` → `…/01a07244-6de6-7cda-856d-8de0cecb3a13@reviewer` 只证健康路径；拒绝面无卷 | 健康 **已结**；拒绝面 **未结** |
| `test/package/doctor-package-lifecycle.test.ts` | Doctor 包生命周期 / 审计输出 | 真宿主 | 生产 doctor | 删 | `01a06625-5bfd-738f-8214-d402cb84a5f1` → `…/01a06625-5bfd-738f-8214-d402cb84a5f1@doctor`（public-cli，terminal，status=refused）只证入口可达+拒绝 settle，**不**证「fresh Pi + 一次 audited output 完成」 | 入口/拒绝 **部分**；audited 完成轨迹 **未结** |
| `test/package/collector-package-lifecycle.test.ts` / `reviewer-package-lifecycle.test.ts` | 角色包生命周期 | 真宿主 | 生产对应角色 | 删 | collector/reviewer 健康卷见上；lifecycle 专用矩阵无卷 | 健康 settle **已结**；lifecycle 专用 **未结** |
| `test/integration/package-tool-idle-removed.test.ts` | 包工具/stream idle 移除后行为 | 真宿主 | 生产角色腿 | 删 | 健康 coder 见上；idle 专用失败面无卷。留存：`engine-detour-cancel-idle.test.ts` 声明 package-owned idle backstop 已移除 | idle 专用 **未结** |
| activation-envelope `withInProcessPi` 宿主案 | 注册/拒绝/observation / 多进程 ledger race | 真宿主 | 生产激活 + 留存非宿主案 | 删宿主 | 健康激活旁证：`01a07246-0999-7ec9-a422-fb06dad57d18@judge`。多进程 O_APPEND/mkdir race：生产 books 下并发 run 目录可观察，但**无**原 8+8/16-worker 专用卷。留存：symlink escape 确定性案 | 健康旁证 **已结**；race 专用 / 非法激活 observation **未结** |
| judge-role skill-expansion host 案 | 缺 skill 非 pass | 真宿主 | 生产 coder/judge | 删 | 健康 coder/judge 见上；缺 skill 拒绝面无卷 | 缺 skill 拒绝 **未结** |
| merger-role session repo host 案 | 会话 cwd 真扩展 | 真宿主 | 生产 merger | 删 | `01a06fa5-aaf0-7b19-a67f-7c86c3e09530` → `…/01a06fa5-aaf0-7b19-a67f-7c86c3e09530@merger`；`01a06bde-2e3e-7f92-85a8-369fef08fd41` → `…/01a06bde-2e3e-7f92-85a8-369fef08fd41@merger`（public-cli，terminal，completed） | 健康 merger **已结** |
| oauth-keepalive host×N | session keepalive | 真宿主 | 生产会话 | 删 | 健康 reviewer 会话见上；keepalive 异常面无卷。留存 oauth 案仅 route/cause 身份 | keepalive 异常 **未结** |
| worker-submission-gates durability host | recordSession 耐久 | 真宿主 | 生产 fixer | 删 | `01a07240-fc0d-7ef3-8bd5-7fb38f346220@fixer`（session+artifacts 在盘）；留存非宿主 gate arm 仍在 CI | 耐久旁证 **已结** |
| fixtures `*-provider.ts` 等真宿主 provider | 仅服务已删宿主案 | 无独立契约 | 同上 | 随案删 | 无单独承接 | — |
| 自拟聚合 `01a072fc-685-c3-agg-*@fixer` | （非删案）r7 污染目录 | — | — | **不引用、不删除** | 七处伪目录与 `aggregation-dossier.json` **不算** run | 排除 |

## 明确排除

- 任何 `aggregation-dossier.json` / `deletedContractHandoff` / scratch 聚合脚本输出。
- `01a072fc-685-c3-agg-*@fixer` 七伪目录（owner：原地保全）。
- 通配 `01a072*@{role}`。

## 聚合脚本

worktree 内无聚合脚本、无向 `~/.ak-roles/books` 写伪 run 目录的提交代码。r7 scratch（`.test-tmp-685-agg-script.mjs` 等）未入仓；本轮不复跑、不复写。

## 与 r7 代码的关系

- **保留**：C4 状态转换 / primary-aware-cleanup / hermes CJS 边界；C3 `judge-auditor-dossier` no-call（childCalls=0）与 grok 声明收缩。
- **作废为承接**：r7 自拟聚合四核 allOk 摘要。
