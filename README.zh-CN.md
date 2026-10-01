# @akagilnc/pi-workflow-roles

为 [Pi](https://pi.dev) 打包的工作流角色：大理寺（judge）、给事中（countersign）、中书省（secretariat）、左拾遗（gleaner-left）、修内司（fixer）、将作监（coder）、御史台（reviewer）、通进司（collector）、太医署（doctor）、校书郎（merger）、符宝郎（notary）、台院（inspector）、太史（analyst）。English: [README.md](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/README.md)。

## 安装

经 Pi 安装，令 CLI 与运行时同出一份包副本；把 Pi 私有 npm bin 加进 `PATH`（一次）：

```bash
pi install npm:@akagilnc/pi-workflow-roles
export PATH="$HOME/.pi/agent/npm/node_modules/.bin:$PATH"
```

更新用 `pi update npm:@akagilnc/pi-workflow-roles`——勿另起全局 `npm install -g`。查看能力：`ak-role roles`、`ak-role help <role>`；席位与官席配置见下方「读结果」。

发布路由（Actions 真入口，非本地 stamp）：`ci` 在仓库默认分支上成功 push → `latest`。非默认分支的 CI completion、PR completion 与失败 CI 不发布。

## 读结果

`ak-role` 是唯一受支持的调用方式。每次运行的完整 Terminal 结果写在 stdout——从那里读或正常重定向，不要刮 Pi session 文件：

```bash
ak-role judge --model <provider/model[:thinking]> --attach ./plan.md "Review this plan." > result.txt
```

退出码报的是生命周期诚实，不是业务成败：一切合法 typed 终态（含 `audit_escalation`）退出零；无合法终态的失败退出非零，其 Terminal 携带 Error Artifact 引用与原始原因，不伪造回执。

`ak-role resume <runId> [message]` 续跑该次运行。旗位与原样透传的续跑 message 见 `ak-role help resume`；model / host 解析见 `ak-role help`，engine 配置见 `ak-role help config`（[ADR 0082](docs/adr/0082-three-layer-runtime-role-host-face.md)）。先 `ak-role config set <seat> <provider/model[:thinking]>` 配席，或逐次带 `--model`。角色 `escalate`（直通御前）后拿到 owner 裁定，标准续跑是 `ak-role resume <runId> "<裁定>"`——把裁定喂回同一 run，角色继续走到终局。上呈的是审核官时，resume 该官的 runId：上呈只暂停这一席，其后的闸照常接着走。Notary 另行的显式 `new` 命令仍只接受 source-run locator，不接受 caller prompt。换宿主不在本文另立一条：原件复制与先前记录是否递送，见 [ADR 0086](docs/adr/0086-host-dossier-is-native-file-copy-sitian-append-only.md)。要不要续跑由调用者决定：不再要求 typed HTTP 429，也不要求 `resumable` 状态。未知 run ID 则拒绝；其余续跑失败只输出一行指向当次错误记录的指针（`续跑失败，当次错误记录：<path>`），原因看该文件。所有可调用角色均可手动 resume：给事中、左拾遗始于 #599，通进司、太医署、符宝郎、台院始于 #633。

全部可调用角色在单次调用内对非 lawful LLM 终态原地续跑（同一 `runId` 与 session），次数上限为 `autoResumeLimit`。缺键默认 2；`ak-role config set-auto-resume-limit <N>` 写入（`0` 关闭自动续）。lawful typed 终态（`accepted` / `audit_escalation` / `no_receipt`）立即停止。手动 `ak-role resume` 仍可用。

席位与官席配置：

```bash
ak-role config set judge <provider/model[:thinking]>
ak-role config set navigator <provider/model[:thinking]>
# 门下省官席（DONE 交卷直接传召台院/符宝郎；中书省署章由交卷闸传召给事中）
ak-role config set gatekeeper <provider/model[:thinking]>
ak-role config set inspector <provider/model[:thinking]>
ak-role config set notary <provider/model[:thinking]>
ak-role config unset gatekeeper
# 持久劳务引擎（可调用角色）；一次性覆盖仍用 --engine
# 可选型号是独立坐标，与 CLI 引擎名分开指定
ak-role config set-engine judge claude-code
ak-role config set-engine coder cursor cursor-grok-4.6-high
ak-role config set-engine-model coder cursor-grok-4.6-high
ak-role config unset-engine-model coder
ak-role config unset-engine judge
# 持久主会话宿主（可调用角色）；一次性覆盖仍用 --host
ak-role config set-host judge grok-build
ak-role config unset-host judge
ak-role config set-auto-resume-limit 3
```

**宿主轴：** `--host` 为全局公开旗，全部可调用角色与 `resume` 受理。解析序、`config set-host` 之后的命令面，以及机构留在哪一侧，以 `ak-role help` 与 [ADR 0082](docs/adr/0082-three-layer-runtime-role-host-face.md) 为准。

**推荐宿主（省 token，[#971](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/971)）：** 长腿的上下文靠宿主自带的自动压缩封顶，阈值写在各宿主自己的配置里，本包不代写、不另造压缩机制。

| 席位 | 推荐 host | 该宿主的压缩阈值配置（默认路径；宿主自己的家目录覆盖照其约定） |
| --- | --- | --- |
| 大理寺（judge）、给事中（countersign） | `codex` | `~/.codex/config.toml`：`model_auto_compact_token_limit` |
| 将作监（coder）、修内司（fixer） | `grok-build` | `~/.grok/config.toml`：`[model."<id>"] auto_compact_threshold_percent` |
| 其余 LLM 席位（太史是确定性机制，无宿主） | `pi`（包默认） | `~/.pi/agent/settings.json`：`compaction.reserveTokens`（触发线＝模型窗口−该值；需 pi ≥ 0.85.1） |

配席：`ak-role config set-host <seat> <host>`；单次改道仍用 `--host`。换宿主前先确认该席的 model 是该宿主跑得了的（例如 `codex` 只跑 OpenAI 系模型），否则先 `ak-role config set <seat> <provider/model[:thinking]>`。

**宿主 provider 表（#788）：** 席位行只写一份 provider 名。owner 手改 `~/.ak-roles/host-providers.json`（形如 `{ "hermes": { "xai": "xai-oauth" } }`）；代码只读。表里没有的问宿主目录（本票 hermes）：唯一即用，零个或多个响亮失败。优先级：表 > 唯一 > 失败，代码无裁量。`config show` 原样打印该表。

**机器方法 Skill：** 运行 `ak-role setup`，在 `~/.agents/skills` 安装缺失的所需 Skill，并经 Skills CLI（`skills update -g`）升级这些名字。路径已被占用则警告并原样保留。setup 为已安装的 Claude Code、Hermes 建必要软链。该目录是唯一机器安装源。角色发现所需 Skill 缺失时向 stdout 警告并继续。Pi 仅从该目录向原生 `--skill` 传路径；Claude Code 与 Codex 遵从原生 Skill 发现；Hermes ACP 与 Grok ACP 当前 harness 无法强制 Skill。本包不拼剥角色任务文本中的 Skill 命令，也不修改宿主 trust 或配置。

门下省官席解析顺序：官自钉 → 省钉（`gatekeeper`）→ 继承父 session；显式指定失败响亮、不回退。配置用法与拒绝文案以 `ak-role config`／`ak-role help config` 为准。持久配置是全机共享单文件、多 CLI 版本同读：本构建不认识的席位键读时跳过（不报错）；已知席位上的未知字段沿用现行容忍。

回执默认是 typed 的，调用者不必解析散文即可组合角色；游奕使是散文出口例外（[#959](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/959)）——终局原样呈现它说的话。顺序与停止归调用者（[ADR 0010](docs/adr/0010-callers-own-role-composition-and-repetition.md)）。编程消费者从 `src/package-contracts/` 导出推导契约，不从本文。

门下省交卷闸：DONE 侧交卷（`completed`／`partially_completed`）时包按受审物直接传召官（将作监/修内司→`inspector`；大理寺判牒/给事中署章→`notary`），不再起门下省子 session 选席；交卷工具调用结束后才传召审核官；放行即结算、不回被审席，封驳则续跑被审席重交，直至各审核官放行，不是角色失败；`planned`／`refused`／`unfinished` 不传召官、直接结算；`ak-role gatekeeper` 仍可独立 dispatch/pass；闸史读回执 typed gate 段，勿刮 session 散文。指针：[ADR 0067](docs/adr/0067-menxia-province-founding-jishizhong-fubaolang.md)、[ADR 0072](docs/adr/0072-menxia-pre-pr-submission-hooks.md)、[ADR 0079](docs/adr/0079-direct-officer-summons-ticket-memory-pointer-input.md)。劳务引擎绕行失败沿既有基础设施故障路径停止、真因可见（[ADR 0071](docs/adr/0071-engine-detour-failure-seat-fallback-declaration.md)）。运行时事实 `decisiveFacts.engineDetourToolUsage`（#537）只计 package 工具 `ak_engine_detour`；bash/CLI ordinary path 是永久观测盲区，不得读成「该腿没用引擎」。

## 调用百官

下例只是用法速写；option 身份、别名、必填性与 mode 面以 `ak-role help <command>` 为准，不另立第二份旗标合同。

```bash
# model 轴（#178）：调用者指定——可先 `ak-role config set <seat> <provider/model[:thinking]>`
# 配席，或如下逐次带 `--model`。无包内默认模型。

# 大理寺——审断所供材料
ak-role judge --model <provider/model[:thinking]> --attach ./findings.md --attach ./adr.md "Adjudicate every finding."

# 将作监——营造新作
ak-role coder --model <provider/model[:thinking]> plan "Propose the first implementation plan."
ak-role coder --model <provider/model[:thinking]> apply --attach ./plan.md "Implement the approved slice."

# 御史台——固定目标，默认并行察举 completeness 与 correctness；completed ≠ 准行，findings 在 Terminal 里
ak-role reviewer --model <provider/model[:thinking]> --base main --authority-ref docs/adr/0001-roles-grow-by-demand.md "Review the branch."
# 可选单 lens 覆盖
ak-role reviewer --model <provider/model[:thinking]> --base main --lens correctness --authority-ref CLAUDE.md

# 通进司——GitHub PR 收证（LLM 经宿主 CLI 自行取证；可选 request-manifest 作材料）
ak-role collector --model <provider/model[:thinking]> --pr 42 --repo owner/repository "为所指 issue 收证。"
ak-role collector --model <provider/model[:thinking]> --repo owner/repository "为 #42 收证。"
ak-role collector --model <provider/model[:thinking]> --pr 42 --request-manifest ./requests.json "带具名请求正文收证。"

# 修内司——缮修所指 findings
ak-role fixer --model <provider/model[:thinking]> --attach ./findings.md --prerequisites ./prereqs.json "Repair the findings."

# 太医署——单案诊断
ak-role doctor --model <provider/model[:thinking]> --issue 115 "Diagnose this retained case."

# 校书郎——调和工作树中的 merge 材料（无进行中合并时由角色 escalate）
ak-role merger --model <provider/model[:thinking]> --project /path/to/worktree "Reconcile the merge."

# 符宝郎——以 source-run locator 直调；职掌见 souls/notary.md
ak-role notary --model <provider/model[:thinking]> --source-run <runId@role|path>

# 台院——直调复杂度与测试质量两轴
ak-role inspector --model <provider/model[:thinking]> --attach ./change.patch "Review this material."

# 门下省——直调省审：派官或放行
ak-role gatekeeper --model <provider/model[:thinking]> --attach ./submission.json "审：这批材料该谁审？"

# 游奕使——直调散文路线建议；随公开入口顶层腿自动出席
ak-role navigator --model <provider/model[:thinking]> "刚完成 coder apply 收敛，下一步？"

# 开庭前：自上次成录后陛下对本票有新话，调用者自行传召起居郎；无新话直接开庭或续跑
ak-role diarist --model <provider/model[:thinking]> "整理 #582 自上次成录以来的御话。"
# 多票庭只传召一次，指令列明全部票号，起居郎按票分别成录
ak-role diarist --model <provider/model[:thinking]> "整理 #582、#583 自上次成录以来的御话，分别成录。"
# 给事中——票庭五问；不自动传召起居郎；已有起居录先沿用录上票号，无录时自行认票并在交卷申报
ak-role countersign --model <provider/model[:thinking]> --attach ./ticket.md "裁：本票 #582 是否足以开工。"

# 中书省——按《票面法》改票；席位与交卷闸见下方班子表（#924、#1021）
ak-role secretariat --model <provider/model[:thinking]> "整理 #924 票面并送庭。"

# 左拾遗——合并前无锚定风闻；可 resume 续同一 session；--base 必填；instruction 可空；调用者不得传方向性 instruction
ak-role gleaner-left --model <provider/model[:thinking]> --base main

# 太史——确定性指标；裸调＝整簿（无 model 席）
ak-role analyst

# escalate 后：把 owner 裁定喂回同一 session（标准链）
ak-role --model <provider/model[:thinking]> resume <runId> "<裁定>"
```

## 班子（唐宋官署命名）

角色按唐宋官署／官职命名，判据与被否方案见 [ADR 0051](docs/adr/0051-roles-are-named-after-tang-song-offices.md)。**朝廷对应：皇帝＝陛下，宰相＝调用者，百官＝各角色。** 工厂没有政事堂——中枢是陛下。百官各司其职，彼此制衡，共同完成从谋划、建设、审查到收敛的完整流程。

**只是名字。** `ak-role <name>` 的角色标识符以及工具名与 schema 字段一律使用下表席位列的英文名；中文名只是呈现层称谓。

| 名号 | 席位 | 职掌 |
| --- | --- | --- |
| **将作监** | coder | 职掌见 [Soul](souls/coder.md)。 |
| **修内司** | fixer | 职掌见 [Soul](souls/fixer.md)。 |
| **御史台** | reviewer | 职掌见 [Soul](souls/reviewer.md)；调用面见 `ak-role help reviewer`。 |
| **大理寺** | judge | 职掌见 [Soul](souls/judge.md)。 |
| **审刑院** | auditor（调用面见 `ak-role help auditor`） | 依受审对象读取 [大理寺审计 Soul](souls/judge-auditor.md)／[太医署审计 Soul](souls/doctor-auditor.md)。 |
| **门下省** | gatekeeper | 职掌见 [Soul](souls/gatekeeper.md)；独立调用见 `ak-role help gatekeeper`，交卷闸关系见 [ADR 0079](docs/adr/0079-direct-officer-summons-ticket-memory-pointer-input.md)。 |
| **中书省** | secretariat | 职掌见 [Soul](souls/secretariat.md)；调用面见 `ak-role help secretariat`。 |
| **给事中** | countersign | 职掌见 [Soul](souls/countersign.md)；调用面见 `ak-role help countersign`。 |
| **左拾遗** | gleaner-left | 职掌见 [Soul](souls/gleaner-left.md)；调用面见 `ak-role help gleaner-left`。 |
| **台院** | inspector | 职掌见 [Soul](souls/inspector.md)；调用面见 `ak-role help inspector`，名号沿革见 [ADR 0074](docs/adr/0074-gate-province-reorg-jishizhong-chaiyuan-split.md) 与 [#584](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/584)。 |
| **符宝郎** | notary | 职掌见 [Soul](souls/notary.md)；调用面见 `ak-role help notary`。 |
| **通进司** | collector | 职掌见 [Soul](souls/collector.md)。 |
| **校书郎** | merger | 职掌见 [Soul](souls/merger.md)。 |
| **游奕使** | navigator | 职掌见 [Soul](souls/navigator.md)；调用面见 `ak-role help navigator`。 |
| **起居郎** | diarist | 职掌见 [Soul](souls/diarist.md)；调用面见 `ak-role help diarist`。 |

其余席位：

| 席位 | 名 | 职掌 | 状态 |
| --- | --- | --- | --- |
| doctor | **太医署** | 职掌见 [Soul](souls/doctor.md)；调用面见 `ak-role help doctor`。 | 已建 |
| analyst | **太史** | 司天台分析席：只读司天记录、出高阶指标；确定性机制，非 LLM，可单独调用 | 已建（[ADR 0068](docs/adr/0068-taishi-analysis-seat-reads-records-writes-sibling-home.md)；机器面键 `analyst`，[#445](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/445) 拼音清零） |
| — | **司天台** | 记候簿——只打点、只指针，不分析不执法；二期含每票起居录 kind `ticket-provenance` | **一期不是角色**（[ADR 0047](docs/adr/0047-sitian-phase-one-mechanism-not-role.md)：确定性机制；两面对账已删 [#855](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/855)）；分析席已由太史承担；起居录见 [ADR 0075](docs/adr/0075-ticket-provenance-diarist-pipeline.md)；机器面键 `archivist`（[#445](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/445)） |
| marshal | **尚书省** | 审→判→修 质量收敛环的省部级驱动角色：调用方递票号与 baseline，尚书省驱动御史台/大理寺/修内司滚到收敛（converged 唯庭可判）或 escalate 上呈，交回 typed 报告；不弹、不判、不修，只让链条转到收敛 | 已定名（#145）；席位待落地（#146） |
| — | **殿院** | [#560](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/560) 机械定点测试巡查件（产物 kind `test-report`） | 在建/待落地，非席位，不占机器键 |
| — | **察院** | 巡按层名号占位 | 悬置，仅保留名号，巡按机制未建 |
| — | **兰台** | 读档议制——耗时／缺口／冗余三条，上奏不执法 | 未建 |
| — | **考功司** | 考具体效率——角色与档位的升档率、一次通过率、每票成本 | 留档，需要时另立票 |
| — | **主簿** | 合并后勾稽销案：核实确已合上、清理残留、报到达 | 未建 |

**merge 按钮归调用者**，没有任何角色握不可逆权限：通进司把收证这件苦活做完并报收集终态，人（或 AI）自己判断、自己点，点完想调主簿就调、不调也可以。

上表**不规定调用顺序**——组合、顺序、重复次数归调用者（[ADR 0010](docs/adr/0010-callers-own-role-composition-and-repetition.md)）。御史台／大理寺／审刑院是**职责分立的类比，不是必经链**；现行内审关联见 [ADR 0010「内审衙门」](docs/adr/0010-callers-own-role-composition-and-repetition.md)。省部级角色的内部组合属于其单次调用的内政，公开 CLI 语义零变化——外部调用者仍一次启动其选中的一个角色，跨 CLI 调用的顺序、重复与停止仍全归外部调用者。

`拾遗补阙` 成对留档，待将来出现第二个进言席再启用。

## 规范指针

- 命令用法、解析与拒绝文案：`ak-role help`、`ak-role help <command>`、`ak-role help config`（唯一权威）。
- 决策与法理：`docs/adr/`（组合与顺序 ADR 0010、公开 CLI 面 ADR 0052、交卷闸 ADR 0066/0067/0070/0072、劳务引擎 ADR 0069/0071、起居录 ADR 0075 等，未尽举）。
- 术语表：[CONTEXT.md](CONTEXT.md)。编程契约：`src/package-contracts/` 导出。
