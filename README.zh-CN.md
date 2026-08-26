# @akagilnc/pi-workflow-roles

为 [Pi](https://pi.dev) 打包的工作流角色：大理寺（judge）、修内司（fixer）、将作监（coder）、御史台（reviewer）、通进司（collector）、太医署（doctor）、校书郎（merger）、符宝郎（notary）、太史（analyst）。English: [README.md](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/README.md)。

## 安装

经 Pi 安装，令 CLI 与运行时同出一份包副本；把 Pi 私有 npm bin 加进 `PATH`（一次）：

```bash
pi install npm:@akagilnc/pi-workflow-roles
export PATH="$HOME/.pi/agent/npm/node_modules/.bin:$PATH"
```

更新用 `pi update npm:@akagilnc/pi-workflow-roles`——勿另起全局 `npm install -g`。查看能力：`ak-role roles`、`ak-role help <role>`；设席位模型默认：`ak-role config set <seat> <provider/model[:thinking]>`（可调用席位，以及自动出席的 `gatekeeper`／`inspector`／`navigator`）；清除门下省官钉：`ak-role config unset <gatekeeper|inspector|notary>`；设或清持久劳务引擎（可调用角色）：`ak-role config set-engine <seat> <name>` / `ak-role config unset-engine <seat>`。

## 读结果

`ak-role` 是唯一受支持的调用方式。每次运行的完整 Terminal 结果写在 stdout——从那里读或正常重定向，不要刮 Pi session 文件：

```bash
ak-role judge --attach ./plan.md "Review this plan." > result.txt
```

退出码报的是生命周期诚实，不是业务成败：一切合法 typed 终态（含 `audit_escalation`）退出零；无合法终态的失败退出非零，其 Terminal 携带 Error Artifact 引用与原始原因，不伪造回执。

`ak-role resume <runId> [message]` 重开该次运行的同一 Pi session。角色 `escalate`（直通御前）后拿到 owner 裁定，标准续跑是 `ak-role resume <runId> "<裁定>"`——把裁定喂回同一 session，角色继续走到终局。`runId` 后可选的 `message` 原样作为续跑 prompt（opaque：不进全局旗标语法）；省略则用包自带 resume envelope。要不要续跑由调用者决定：不再要求 typed HTTP 429，也不要求 `resumable` 状态。未知 run ID、session 主体不在则拒绝。通进司、太医署、符宝郎仍为一次性，无 resume。包绝不自动换 provider；临时换模型用全局旗标。

大理寺、将作监、修内司、御史台、校书郎在单次调用内对非 lawful LLM 终态原地续跑（同一 `runId` 与 session），次数上限为 `autoResumeLimit`。缺键默认 2；`ak-role config set-auto-resume-limit <N>` 写入（`0` 关闭自动续）。lawful typed 终态（`accepted` / `audit_escalation` / `no_receipt`）立即停止。手动 `ak-role resume` 仍可用。

全局覆盖须在 opaque message 段之前：`ak-role --model <provider/model[:thinking]> resume <runId>` 或 `ak-role resume --model <provider/model[:thinking]> <runId>`。

每次运行游奕使自动出席，建议随同一 Terminal 给出。配置：

```bash
ak-role config set judge <provider/model[:thinking]>
ak-role config set navigator <provider/model[:thinking]>
# 门下省官席（交卷自动出席；除直调符宝郎外无独立命令）
ak-role config set gatekeeper <provider/model[:thinking]>
ak-role config set inspector <provider/model[:thinking]>
ak-role config set notary <provider/model[:thinking]>
ak-role config unset gatekeeper
# 持久劳务引擎（可调用角色；不含 navigator）；一次性覆盖仍用 --engine
ak-role config set-engine judge opus
ak-role config unset-engine judge
ak-role config set-auto-resume-limit 3
```

`config set` 存席位模型默认。门下省官席（`gatekeeper`／`inspector`／`notary`）解析顺序：官自钉 → 省钉（`gatekeeper`）→ 继承父 session；显式指定失败响亮、不回退。`config unset` 只清这三官的覆盖。`config set-engine`／`unset-engine` 在可调用角色上写入或清除持久劳务引擎名（与 `--engine` 同轴；拒收 navigator——无独立 activation）。`config set-auto-resume-limit` 写入单次调用自动续跑上限。用法与拒绝文案以 `ak-role config`／`ak-role help config` 为准。

回执是 typed 的，调用者不必解析散文即可组合角色；顺序与停止归调用者。编程消费者从 `src/package-contracts/` 导出推导契约，不从本文。

### 门下省交卷闸

完成侧交卷时，包可能在本局结算前起门下省：`gatekeeper` 读受审物并派官（`inspector` 给事中或 `notary` 符宝郎）；既有审刑院挂钩仍在原位。闸在交卷 session 内运行；封驳＝当场重写重交，不是角色失败；最终回执即过闸产物。`planned`／`refused`／`unfinished` 不调省。指针：[ADR 0067](docs/adr/0067-menxia-province-founding-jishizhong-fubaolang.md)、[ADR 0072](docs/adr/0072-menxia-pre-pr-submission-hooks.md)。闸史已投影进 typed 回执：可选 menxia 段列出实际在场席位、每轮派官（officer 与逐字 reason）与各官报告（席位/判决/findings）；无闸调用时该段缺席。勿刮 session 散文当闸状态——读 typed 段。

当劳务引擎绕行失败、座席回到主路继续劳务时，typed 回执可带机械字段 `engineLaborFallback`：`{ engine, failure, laborBy: "seat" }`。仅在真实绕行失败并座席顶班后出现——成功绕行或调用方 cancel 不出现。同一次 activation 内先到先得；无包内 latch 时剥离模型伪造的 `engineLaborFallback` 键。唯一构造点：`src/engine-labor-fallback.ts`；决策记录：[ADR 0071](docs/adr/0071-engine-detour-failure-seat-fallback-declaration.md)。本文只投影该契约。

## 调用百官

公开 option 身份、别名、必填性与 mode 面以生成区 [公开 CLI 选项（生成）](#公开-cli-选项生成) 与 `ak-role help <command>` 为准——二者同源。下例只是用法速写，不是第二份旗标合同。指令对大理寺、通进司、太医署可省略；符宝郎零 prompt／附件；太史为确定性命令（见 help）。对将作监、修内司、御史台、校书郎必须非空。

```bash
# 大理寺——审断所供材料；自行推断举证责任，无 burden 旗标
ak-role judge --attach ./findings.md --attach ./adr.md "Adjudicate every finding."

# 将作监——营造新作；phase 默认 apply，或显式 plan
ak-role coder plan "Propose the first implementation plan."
ak-role coder apply --attach ./plan.md "Implement the approved slice."
# apply 强制包内 TDD 方法；勿绑 home Skill 顶替

# 御史台——固定目标双轴察举（Standards + Spec）
ak-role reviewer --base main "Review the branch."
# --base 为必填并钉住 fixed point；御史台不接受 --attach
# completed ≠ 准行——findings 在 Terminal 里

# 通进司——GitHub PR 收证；仅 github.com，需 gh 已认证；一次性
ak-role collector --pr 42 --repo owner/repository
ak-role collector --pr 42 --request-manifest ./requests.json
# 无配置时仅观察；可选 request manifest 为 {requests:[{id,body}]}；repo 默认取 origin

# 修内司——缮修所指 findings；phase 默认 apply，或显式 plan
ak-role fixer --attach ./findings.md --prerequisites ./prereqs.json "Repair the findings."
# --prerequisites 为 {id, requirement} JSON 数组；语法畸形退出 2

# 太医署——单案诊断；一次性
ak-role doctor --issue 115 "Diagnose this retained case."
# --runs 须为项目相对的 .ak-roles/books/<book>/issues/<n>/runs 且匹配 --issue

# 校书郎——雠校一个已在冲突的 merge（先用 Git ort 起动）
ak-role merger --project /path/to/worktree "Reconcile the active merge."
# 遇新意图/权限问题交回调用者，不捏造 authority

# 符宝郎——对一份留存 source run 做文书核验；零 prompt／附件；一次性
ak-role notary --source-run <runId@role|path>

# 太史——确定性指标（cwd 候簿＝git common-dir）；裸调＝整簿
ak-role analyst
ak-role analyst --ticket <N>
ak-role analyst sweep --attach ./payload.md
ak-role analyst --cohort \
  --group-a-label A --group-a-issues 1,2 \
  --group-b-label B --group-b-issues 3,4

# escalate 后：把 owner 裁定喂回同一 session（标准链；细则见上方「读结果」resume 段）
ak-role resume <runId> "<裁定>"
```

## 班子（唐宋官署命名）

角色按唐宋官署／官职命名，判据与被否方案见 [ADR 0051](docs/adr/0051-roles-are-named-after-tang-song-offices.md)。**朝廷对应：皇帝＝陛下，宰相＝调用者，百官＝各角色。** 工厂没有政事堂——中枢是陛下。百官各司其职，彼此制衡，共同完成从谋划、建设、审查到收敛的完整流程。

**只是名字。** `ak-role <name>` 的角色标识符以及工具名与 schema 字段一律使用下表席位列的英文名；中文名只是呈现层称谓。

| 名号 | 席位 | 职掌 |
| --- | --- | --- |
| **将作监** | coder | **营造新作。** 承接新的谋划与需求，从一片空白开始设计、建造，直到形成可供使用的新成果。讲究先明其意，再定其形，不妄增枝节，只做当下所需之事。 |
| **修内司** | fixer | **缮修旧物。** 面对已有问题，不急于表面修补，而是追寻问题根源，找到真正需要修整之处。既要修复眼前缺漏，也要防止同类问题再次出现。 |
| **御史台** | reviewer | **察举百弊。** 置身事外，以旁观之眼审视成果，寻找其中的不妥、遗漏与隐患。只负责指出问题、陈明依据，不参与修改，也不替人作最终判断。 |
| **大理寺** | judge | **审理定谳。** 承接各方意见与材料，依照既定规则逐项判断，辨明是非曲直。可以准行、退回或请示更高决定，但自身不参与建设与修改。 |
| **审刑院** | judge-auditor／reviewer-auditor（无 CLI，共享内部接缝） | **复核成案。** 不重新争论事情本身，而是检查整个办理过程是否合乎规矩。关注是否有人越过职责、是否遗漏必要步骤、是否以错误方式得出正确结果。直属陛下，不入门下省编制。 |
| **门下省** | gatekeeper（无独立 CLI；交卷自动出席） | **质量保证省。** 交卷时判断受审物、够不够审、该谁审，派给事中或符宝郎；省内政，不是外层编排器。规范见 [ADR 0067](docs/adr/0067-menxia-province-founding-jishizhong-fubaolang.md)、[ADR 0072](docs/adr/0072-menxia-pre-pr-submission-hooks.md)。 |
| **给事中** | inspector（无独立 CLI；可由门下省派发） | **复杂度与测试质量两轴质检。** 受审物是将作监／修内司完成侧交卷；封驳＝当场打回重写，不是本局失败。 |
| **符宝郎** | notary | **引语真伪与票面对齐。** 受审物是大理寺拟判等文书；可被门下省派发，也可 `ak-role notary` 单独调。 |
| **通进司** | collector | **承接百议／收证。** 门下省下的收证衙门：收集外部 GitHub PR 材料与意见，只收不审、不替人裁决。canonical 键仍为 `collector`。 |
| **校书郎** | merger | **雠校异文。** 面对不同来源的修改，负责整理、校合与调和。保留双方有价值的部分，解决彼此冲突；遇到无法自行决定之处，则留待重新裁量。 |
| **游奕使** | navigator（无 CLI，自动出席） | **巡行问路。** 不掌具体事务，而是观察全局变化，结合当前局面提醒下一步方向。它提供建议与路径参考，但最终选择仍由执掌之人决定。 |

其余席位：

| 席位 | 名 | 职掌 | 状态 |
| --- | --- | --- | --- |
| doctor | **太医署** | 单案诊断工厂机制，开 `keep｜thin｜delete` 方 | 已建 |
| analyst | **太史** | 司天台分析席：只读司天记录、出高阶指标；确定性机制，非 LLM，可单独调用 | 已建（[ADR 0068](docs/adr/0068-taishi-analysis-seat-reads-records-writes-sibling-home.md)；机器面键 `analyst`，[#445](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/445) 拼音清零） |
| — | **司天台** | 记候簿——只打点、只指针，不分析不执法 | **一期不是角色**（[ADR 0047](docs/adr/0047-sitian-phase-one-mechanism-not-role.md)：零 LLM 双面对账）；分析席已由太史承担；机器面键 `archivist`（[#445](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/445)） |
| — | **兰台** | 读档议制——耗时／缺口／冗余三条，上奏不执法 | 未建 |
| — | **考功司** | 考具体效率——角色与档位的升档率、一次通过率、每票成本 | 留档，需要时另立票 |
| — | **主簿** | 合并后勾稽销案：核实确已合上、清理残留、报到达 | 未建 |

**merge 按钮归调用者**，没有任何角色握不可逆权限：通进司把收证这件苦活做完并报收集终态，人（或 AI）自己判断、自己点，点完想调主簿就调、不调也可以。

上表**不规定调用顺序**——组合、顺序、重复次数归调用者（[ADR 0010](docs/adr/0010-callers-own-role-composition-and-repetition.md)）。御史台／大理寺／审刑院是**职责分立的类比，不是必经链**；审刑院也并非只跟在大理寺之后，大理寺、御史台、太医署各自都有一次。门下省交卷闸是完成侧挂钩，不是调用者必经编排链。

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
