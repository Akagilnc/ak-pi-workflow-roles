# @akagilnc/pi-workflow-roles

为 [Pi](https://pi.dev) 打包的工作流角色：大理寺（judge）、给事中（countersign）、左拾遗（gleaner-left）、修内司（fixer）、将作监（coder）、御史台（reviewer）、通进司（collector）、太医署（doctor）、校书郎（merger）、符宝郎（notary）、太史（analyst）。English: [README.md](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/README.md)。

## 安装

经 Pi 安装，令 CLI 与运行时同出一份包副本；把 Pi 私有 npm bin 加进 `PATH`（一次）：

```bash
pi install npm:@akagilnc/pi-workflow-roles
export PATH="$HOME/.pi/agent/npm/node_modules/.bin:$PATH"
```

更新用 `pi update npm:@akagilnc/pi-workflow-roles`——勿另起全局 `npm install -g`。查看能力：`ak-role roles`、`ak-role help <role>`；席位与官席配置见下方「读结果」。

### 测试通道（`next`）

家族／dogfood 安装面复用同一包，经 dist-tag `next` 取得；测试面自有 `HOME`，其下的 AK config／ledger／book 与 `PI_CODING_AGENT_DIR` 一并独立，不与宿主已装包共享。测试面不挂载、不复制宿主凭据；不以 book／worktree 冒充安装隔离。不装第二份全局 npm。

```bash
export HOME=/path/to/test-home          # 测试面自有 HOME
export PI_CODING_AGENT_DIR="$HOME/.pi/agent"
export PATH="$PI_CODING_AGENT_DIR/npm/node_modules/.bin:$PATH"
```

- **首次装 next**：`pi install npm:@akagilnc/pi-workflow-roles@next` → `ak-role roles` 可跑；装到的版本形如 `0.1.<count>-next.<shortsha>`。
- **推进到新 next**：`pi update npm:@akagilnc/pi-workflow-roles@next` → 版本号里的 `<shortsha>` 变为新 CI `head_sha` 的前 7 位。
- **同版本重装／恢复**：重跑首次安装命令 → 幂等，版本不变（对应 stamp「版本已在 registry 则只移 dist-tag」路径）。

发布路由（Actions 真入口，非本地 stamp）：`ci` 在 `main` 上成功 push → `latest`；`ci` 在 allowlist 非 main 分支上成功 push（见 `.github/workflows/ci.yml` 的 `push.branches`）→ `next`。PR completion 与失败 CI 不发布。

## 读结果

`ak-role` 是唯一受支持的调用方式。每次运行的完整 Terminal 结果写在 stdout——从那里读或正常重定向，不要刮 Pi session 文件：

```bash
ak-role judge --attach ./plan.md "Review this plan." > result.txt
```

退出码报的是生命周期诚实，不是业务成败：一切合法 typed 终态（含 `audit_escalation`）退出零；无合法终态的失败退出非零，其 Terminal 携带 Error Artifact 引用与原始原因，不伪造回执。

`ak-role resume <runId> [message]` 重开该次运行的同一 Pi session。角色 `escalate`（直通御前）后拿到 owner 裁定，标准续跑是 `ak-role resume <runId> "<裁定>"`——把裁定喂回同一 session，角色继续走到终局。`runId` 后可选的 `message` 原样作为续跑 prompt（opaque：不进全局旗标语法）；省略则用包自带 resume envelope。要不要续跑由调用者决定：不再要求 typed HTTP 429，也不要求 `resumable` 状态。未知 run ID、session 主体不在则拒绝。通进司、太医署、符宝郎、给事中、左拾遗仍为一次性，无 resume。模型解析自**现行席位配置**；在乎身份的续跑显式带 `--model` 钉住（#552 裁定口径）。

大理寺、将作监、修内司、御史台、校书郎在单次调用内对非 lawful LLM 终态原地续跑（同一 `runId` 与 session），次数上限为 `autoResumeLimit`。缺键默认 2；`ak-role config set-auto-resume-limit <N>` 写入（`0` 关闭自动续）。lawful typed 终态（`accepted` / `audit_escalation` / `no_receipt`）立即停止。手动 `ak-role resume` 仍可用。

席位与官席配置：

```bash
ak-role config set judge <provider/model[:thinking]>
ak-role config set navigator <provider/model[:thinking]>
# 门下省交卷闸官席（察院/符宝郎，交卷自动出席；给事中票庭由调用者直召，见「调用百官」）
ak-role config set gatekeeper <provider/model[:thinking]>
ak-role config set inspector <provider/model[:thinking]>
ak-role config set notary <provider/model[:thinking]>
ak-role config unset gatekeeper
# 持久劳务引擎（可调用角色；不含 navigator）；一次性覆盖仍用 --engine
ak-role config set-engine judge opus
ak-role config unset-engine judge
ak-role config set-auto-resume-limit 3
```

门下省官席解析顺序：官自钉 → 省钉（`gatekeeper`）→ 继承父 session；显式指定失败响亮、不回退。配置用法与拒绝文案以 `ak-role config`／`ak-role help config` 为准。

回执是 typed 的，调用者不必解析散文即可组合角色；顺序与停止归调用者（[ADR 0010](docs/adr/0010-callers-own-role-composition-and-repetition.md)）。编程消费者从 `src/package-contracts/` 导出推导契约，不从本文。

门下省交卷闸：完成侧交卷时包可在本局结算前起省（`gatekeeper` 派 `inspector`／`notary`），封驳＝当场重写重交，不是角色失败；`planned`／`refused`／`unfinished` 不调省；闸史读回执 typed gate 段，勿刮 session 散文。指针：[ADR 0067](docs/adr/0067-menxia-province-founding-jishizhong-fubaolang.md)、[ADR 0072](docs/adr/0072-menxia-pre-pr-submission-hooks.md)。劳务引擎绕行失败沿既有基础设施故障路径停止、真因可见（[ADR 0071](docs/adr/0071-engine-detour-failure-seat-fallback-declaration.md)）。

## 调用百官

下例只是用法速写；option 身份、别名、必填性与 mode 面以 `ak-role help <command>` 为准，不另立第二份旗标合同。

```bash
# 大理寺——审断所供材料
ak-role judge --attach ./findings.md --attach ./adr.md "Adjudicate every finding."

# 将作监——营造新作
ak-role coder plan "Propose the first implementation plan."
ak-role coder apply --attach ./plan.md "Implement the approved slice."

# 御史台——固定目标双轴察举；completed ≠ 准行，findings 在 Terminal 里
ak-role reviewer --base main "Review the branch."

# 通进司——GitHub PR 收证；一次性
ak-role collector --pr 42 --repo owner/repository

# 修内司——缮修所指 findings
ak-role fixer --attach ./findings.md --prerequisites ./prereqs.json "Repair the findings."

# 太医署——单案诊断；一次性
ak-role doctor --issue 115 "Diagnose this retained case."

# 校书郎——调和已在冲突的 merge（先用 Git ort 起动）
ak-role merger --project /path/to/worktree "Reconcile the active merge."

# 符宝郎——文书核验一份留存 source run；一次性；可选 --ticket 调起居录
ak-role notary --source-run <runId@role|path>
ak-role notary --source-run <runId@role|path> --ticket 582

# 给事中——票庭五问；可选 --ticket（起居郎流水线前序工序按票刷新起居录）
ak-role countersign --ticket 582 --attach ./ticket.md "裁：本票是否足以开工。"

# 左拾遗——合并前无锚定风闻；一次性；--base 必填；instruction 可空；调用者不得传方向性 instruction
ak-role gleaner-left --base main

# 太史——确定性指标；裸调＝整簿
ak-role analyst

# escalate 后：把 owner 裁定喂回同一 session（标准链）
ak-role resume <runId> "<裁定>"
```

## 班子（唐宋官署命名）

角色按唐宋官署／官职命名，判据与被否方案见 [ADR 0051](docs/adr/0051-roles-are-named-after-tang-song-offices.md)。**朝廷对应：皇帝＝陛下，宰相＝调用者，百官＝各角色。** 工厂没有政事堂——中枢是陛下。百官各司其职，彼此制衡，共同完成从谋划、建设、审查到收敛的完整流程。

**只是名字。** `ak-role <name>` 的角色标识符以及工具名与 schema 字段一律使用下表席位列的英文名；中文名只是呈现层称谓。

| 名号 | 席位 | 职掌 |
| --- | --- | --- |
| **将作监** | coder | **营造新作。** 承接新的谋划与需求，从一片空白开始设计、建造，直到形成可供使用的新成果。讲究先明其意，再定其形，不妄增枝节，只做当下所需之事。 |
| **修内司** | fixer | **缮修旧物。** 面对已有问题，不急于表面修补，而是追寻问题根源，找到真正需要修整之处。既要修复眼前缺漏，也要防止同类问题再次出现。 |
| **御史台** | reviewer | **察举百弊，风闻奏事。** 置身事外审视成果；Standards／Spec 两条取证腿由 runtime 代跑，本席收腿报告出薄回执与 amendment。弹章须指明所劾之处，言不为狱——不负坐实义务，坐实归大理寺。 |
| **大理寺** | judge | **审理定谳。** 承接各方意见与材料，依照既定规则逐项判断，辨明是非曲直。可以准行、退回或请示更高决定，但自身不参与建设与修改。 |
| **审刑院** | judge-auditor／doctor-auditor（无 CLI，共享内部接缝；御史台侧闸已退役） | **复核成案。** 不重新争论事情本身，而是检查整个办理过程是否合乎规矩。关注是否有人越过职责、是否遗漏必要步骤、是否以错误方式得出正确结果。直属陛下，不入门下省编制。 |
| **门下省** | gatekeeper（无独立 CLI；交卷自动出席） | **审署诏敕与质量保证的省。** 交卷时判断受审物、够不够审、该谁审，派察院或符宝郎；给事中票庭由调用者开工前传召；左拾遗由调用者合并前传召（皆非闸派）；省内政，不是外层编排器。规范见 [ADR 0067](docs/adr/0067-menxia-province-founding-jishizhong-fubaolang.md)、[ADR 0072](docs/adr/0072-menxia-pre-pr-submission-hooks.md)、[ADR 0074](docs/adr/0074-gate-province-reorg-jishizhong-chaiyuan-split.md)。 |
| **给事中** | countersign（无交卷闸派发；开工前由调用者传召） | **票庭审读五问。** 制度符合／授权真实（以起居录为据）／文书符意／退回重议／发布资格；读码取证是本职，实现细节不上票面。票庭流水线在本席 turn 前跑起居郎工序（调用者无感）；交卷闸出席符宝郎。署＝放行开工，封驳＝退票重议，上呈＝陛下裁决。规范见 [ADR 0074](docs/adr/0074-gate-province-reorg-jishizhong-chaiyuan-split.md)、[ADR 0075](docs/adr/0075-ticket-provenance-diarist-pipeline.md)。 |
| **左拾遗** | gleaner-left（无交卷闸派发；合并前由调用者传召） | **合并前无锚定风闻。** 对全幅合并候选作冷眼评审；只上弹章、不封驳不裁决。规范见 [ADR 0067](docs/adr/0067-menxia-province-founding-jishizhong-fubaolang.md) 修正案。 |
| **察院** | inspector（无独立 CLI；可由门下省派发） | **事后察举：复杂度与测试质量两轴。** 受审物是将作监／修内司完成侧交卷；封驳＝当场打回重写，不是本局失败。原给事中，ADR 0074 分立。 |
| **符宝郎** | notary | **首责唯一：核实实际授权出处**（防乱编乱扩）。行事两步：读该票起居录→以录核旨；引语真伪与票面对齐为手段。受审物是大理寺拟判与给事中署章；可被门下省派发，也可 `ak-role notary` 单独调。规范见 [ADR 0075](docs/adr/0075-ticket-provenance-diarist-pipeline.md)。 |
| **通进司** | collector | **承接百议／收证。** 门下省下的收证衙门：收集外部 GitHub PR 材料与意见，只收不审、不替人裁决。canonical 键仍为 `collector`。 |
| **校书郎** | merger | **雠校异文。** 面对不同来源的修改，负责整理、校合与调和。保留双方有价值的部分，解决彼此冲突；遇到无法自行决定之处，则留待重新裁量。 |
| **游奕使** | navigator（无 CLI，自动出席） | **巡行问路。** 不掌具体事务，而是观察全局变化，结合当前局面提醒下一步方向。它提供建议与路径参考，但最终选择仍由执掌之人决定。 |

其余席位：

| 席位 | 名 | 职掌 | 状态 |
| --- | --- | --- | --- |
| doctor | **太医署** | 单案诊断工厂机制，开 `keep｜thin｜delete` 方 | 已建 |
| analyst | **太史** | 司天台分析席：只读司天记录、出高阶指标；确定性机制，非 LLM，可单独调用 | 已建（[ADR 0068](docs/adr/0068-taishi-analysis-seat-reads-records-writes-sibling-home.md)；机器面键 `analyst`，[#445](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/445) 拼音清零） |
| — | **司天台** | 记候簿——只打点、只指针，不分析不执法；二期含每票起居录 kind `ticket-provenance` | **一期不是角色**（[ADR 0047](docs/adr/0047-sitian-phase-one-mechanism-not-role.md)：零 LLM 双面对账）；分析席已由太史承担；起居录见 [ADR 0075](docs/adr/0075-ticket-provenance-diarist-pipeline.md)；机器面键 `archivist`（[#445](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/445)） |
| — | **起居郎** | 票庭流水线前序工序：LLM 语义收集＋机械保全，按票刷新起居录 | **非公开席位**（无 soul 开府、不出席闸；[ADR 0075](docs/adr/0075-ticket-provenance-diarist-pipeline.md)；机器面键 `diarist`） |
| marshal | **尚书省** | 审→判→修 质量收敛环的省部级驱动角色：调用方递票号与 baseline，尚书省驱动御史台/大理寺/修内司滚到收敛（converged 唯庭可判）或 escalate 上呈，交回 typed 报告；不弹、不判、不修，只让链条转到收敛 | 已定名（#145）；席位待落地（#146） |
| — | **兰台** | 读档议制——耗时／缺口／冗余三条，上奏不执法 | 未建 |
| — | **考功司** | 考具体效率——角色与档位的升档率、一次通过率、每票成本 | 留档，需要时另立票 |
| — | **主簿** | 合并后勾稽销案：核实确已合上、清理残留、报到达 | 未建 |

**merge 按钮归调用者**，没有任何角色握不可逆权限：通进司把收证这件苦活做完并报收集终态，人（或 AI）自己判断、自己点，点完想调主簿就调、不调也可以。

上表**不规定调用顺序**——组合、顺序、重复次数归调用者（[ADR 0010](docs/adr/0010-callers-own-role-composition-and-repetition.md)）。御史台／大理寺／审刑院是**职责分立的类比，不是必经链**；审刑院也并非只跟在大理寺之后，大理寺、御史台、太医署各自都有一次。门下省交卷闸是完成侧挂钩，不是调用者必经编排链。省部级角色的内部组合属于其单次调用的内政，公开 CLI 语义零变化——外部调用者仍一次启动其选中的一个角色，跨 CLI 调用的顺序、重复与停止仍全归外部调用者。

`拾遗补阙` 成对留档，待将来出现第二个进言席再启用。

## Codex fast 档

开启：`echo "fast_mode = on" > ~/.pi-codex-fast`；关闭：`echo "fast_mode = off" > ~/.pi-codex-fast`（或删文件）。修改后无需重启，下一个请求即生效。Fast 档价格高于默认档。

<!-- BEGIN GENERATED: public-cli-options -->
## 公开 CLI 选项（生成）

本表由 `src/public-cli/option-definitions.ts` 生成；以 `ak-role help <command>` 为准。勿手改本区。

### `global`

| 拼写 | 别名 | 值 | 必填 | 可重复 | 形式 | 模式/阶段 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--model` | — | `provider/model` | 否 | 否 | option | — | 覆盖本调用有效席位模型（可置于子命令前或后）。 |
| `--thinking` | — | `level` | 否 | 否 | option | — | 覆盖 thinking 档位：off\|minimal\|low\|medium\|high\|xhigh\|max。 |
| `--engine` | — | `name` | 否 | 否 | option | — | 本调用可选劳动引擎（池令名字；有包内调法笔记则附卷；全部角色可用）。 |
| `--host` | — | `name` | 否 | 否 | option | — | 为本调用选择具名主会话宿主适配器。 |
| `--help` | `-h` | — | 否 | 否 | option | — | 显示公开 CLI 帮助并退出。 |

### `judge`

| 拼写 | 别名 | 值 | 必填 | 可重复 | 形式 | 模式/阶段 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--project` | — | `path` | 否 | 否 | option | — | 卷宗身份用的项目根（默认进程 cwd）。 |
| `--attach` | — | `path` | 否 | 是 | option | — | 附加普通文件；受理即冻结（可重复）。 |

### `coder`

| 拼写 | 别名 | 值 | 必填 | 可重复 | 形式 | 模式/阶段 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `plan\|apply` | `plan`, `apply` | — | 否 | 否 | positional | phases=plan\|apply; default=apply | 指令前可选 phase 词元；默认 apply。 |
| `--project` | — | `path` | 否 | 否 | option | — | 卷宗身份用的项目根（默认进程 cwd）。 |
| `--attach` | — | `path` | 否 | 是 | option | — | 附加普通文件；受理即冻结（可重复）。 |

### `fixer`

| 拼写 | 别名 | 值 | 必填 | 可重复 | 形式 | 模式/阶段 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `plan\|apply` | `plan`, `apply` | — | 否 | 否 | positional | phases=plan\|apply; default=apply | 指令前可选 phase 词元；默认 apply。 |
| `--project` | — | `path` | 否 | 否 | option | — | 卷宗身份用的项目根（默认进程 cwd）。 |
| `--attach` | — | `path` | 否 | 是 | option | — | 附加普通文件；受理即冻结（可重复）。 |
| `--prerequisites` | — | `path` | 否 | 否 | option | — | {id, requirement} 前置条件 JSON 数组路径。 |

### `reviewer`

| 拼写 | 别名 | 值 | 必填 | 可重复 | 形式 | 模式/阶段 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--project` | — | `path` | 否 | 否 | option | — | 卷宗身份用的项目根（默认进程 cwd）。 |
| `--base` | — | `revision` | 是 | 否 | option | — | 必填；钉住审查目标的 fixed-point revision。 |
| `--authority-ref` | — | `ref` | 否 | 是 | option | — | 持久 authority 引用/URL（可重复；仅 ref，非内联散文）。 |

### `collector`

| 拼写 | 别名 | 值 | 必填 | 可重复 | 形式 | 模式/阶段 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--project` | — | `path` | 否 | 否 | option | — | 卷宗身份用的项目根（默认进程 cwd）。 |
| `--attach` | — | `path` | 否 | 是 | option | — | 附加普通文件；受理即冻结（可重复）。 |
| `--pr` | — | `number` | 是 | 否 | option | — | 必填；正整数 GitHub PR 号。 |
| `--repo` | — | `owner/repo` | 否 | 否 | option | — | GitHub owner/repo 覆盖（默认取 github.com origin）。 |
| `--request-manifest` | — | `path` | 否 | 否 | option | — | 可选 request manifest JSON 路径（{requests:[{id,body}]}）。 |

### `doctor`

| 拼写 | 别名 | 值 | 必填 | 可重复 | 形式 | 模式/阶段 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--project` | — | `path` | 否 | 否 | option | — | 卷宗身份用的项目根（默认进程 cwd）。 |
| `--attach` | — | `path` | 否 | 是 | option | — | 附加普通文件；受理即冻结（可重复）。 |
| `--issue` | — | `number` | 是 | 否 | option | — | 必填；留存病例的正整数 issue 号。 |
| `--runs` | — | `path` | 否 | 否 | option | — | 可选项目相对 .ak-roles/books/<book>/issues/<n>/runs 覆盖，且须匹配 --issue。 |

### `merger`

| 拼写 | 别名 | 值 | 必填 | 可重复 | 形式 | 模式/阶段 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--project` | — | `path` | 否 | 否 | option | — | 已有进行中 ordinary merge 的项目根（默认 cwd）。 |
| `--attach` | — | `path` | 否 | 是 | option | — | 附加普通文件；受理即冻结（可重复）。 |

### `notary`

| 拼写 | 别名 | 值 | 必填 | 可重复 | 形式 | 模式/阶段 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--project` | — | `path` | 否 | 否 | option | — | 卷宗身份用的项目根（默认进程 cwd）。 |
| `--source-run` | — | `runId@role\|path` | 是 | 否 | option | — | 必填源 run 定位符（簿内 runId@role，或该 run 目录路径）。零 prompt/附件投影。 |
| `--ticket` | — | `number` | 否 | 否 | option | — | 可选票号：符宝郎按票键调取起居录时使用。 |


### `countersign`

| 拼写 | 别名 | 值 | 必填 | 可重复 | 形式 | 模式/阶段 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--project` | — | `path` | 否 | 否 | option | — | 卷宗身份的项目根（默认 process cwd）。 |
| `--attach` | — | `path` | 否 | 是 | option | — | 附卷普通文件；受理时冻结（可重复）。 |
| `--ticket` | — | `number` | 否 | 否 | option | — | 票号：起居郎流水线与起居录票键。与附件 frontmatter 并存时以本旗为准。 |

### `gleaner-left`

可选自由 positional `instruction` 可空。调用者不得传方向性 instruction；本席按 `--base` 自取合并候选 diff。

| 拼写 | 别名 | 值 | 必填 | 可重复 | 形式 | 模式/阶段 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--project` | — | `path` | 否 | 否 | option | — | 卷宗身份的项目根（默认 process cwd）。 |
| `--base` | — | `revision` | 是 | 否 | option | — | 必填；无锚定合并候选 diff 的比较基线 revision。 |

### `analyst`

| 拼写 | 别名 | 值 | 必填 | 可重复 | 形式 | 模式/阶段 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `sweep` | — | — | 否 | 否 | positional | modes=sweep | 可选 sweep 模式词元（至多一次；不得夹带其他 positional）。 |
| `--ticket` | — | `number` | 否 | 否 | option | modes=issue | 票号；在 cwd 候簿（git common-dir）内按 invocation.ticketNumber 现取现算。裸调用=整簿。不依赖 library-index 自举。 |
| `--attach` | — | `path` | 条件:sweep | 是 | option | modes=sweep; max=sweep:1 | sweep 模式附件路径；sweep 必填且恰一次；载荷为附件正文。 |
| `--cohort` | — | — | 否 | 否 | option | modes=cohort | 选择 cohort 模式。 |
| `--group-a-label` | — | `label` | 条件:cohort | 否 | option | modes=cohort | cohort A 组标签（cohort 模式必填）。 |
| `--group-a-issues` | — | `N\|book:N[,...]` | 条件:cohort | 否 | option | modes=cohort | cohort A 组 issue：裸 N 归属 cwd 簿；book:N 显式跨簿；簿键中的逗号/反斜杠用 \, / \\ 转义（cohort 模式必填）。 |
| `--group-b-label` | — | `label` | 条件:cohort | 否 | option | modes=cohort | cohort B 组标签（cohort 模式必填）。 |
| `--group-b-issues` | — | `N\|book:N[,...]` | 条件:cohort | 否 | option | modes=cohort | cohort B 组 issue：裸 N 归属 cwd 簿；book:N 显式跨簿；簿键中的逗号/反斜杠用 \, / \\ 转义（cohort 模式必填）。 |
<!-- END GENERATED: public-cli-options -->

## 规范指针

- 命令用法与拒绝文案：`ak-role help <command>`、`ak-role help config`（唯一权威）。
- 决策与法理：`docs/adr/`（组合与顺序 ADR 0010、公开 CLI 面 ADR 0052、交卷闸 ADR 0066/0067/0070/0072、劳务引擎 ADR 0069/0071、起居录 ADR 0075 等，未尽举）。
- 术语表：[CONTEXT.md](CONTEXT.md)。编程契约：`src/package-contracts/` 导出。
