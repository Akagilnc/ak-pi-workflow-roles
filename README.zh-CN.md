# @akagilnc/pi-workflow-roles

为 [Pi](https://pi.dev) 打包的工作流角色：大理寺（judge）、给事中（countersign）、中书省（secretariat）、左拾遗（gleaner-left）、修内司（fixer）、将作监（coder）、御史台（reviewer）、通进司（collector）、太医署（doctor）、校书郎（merger）、符宝郎（notary）、台院（inspector）、太史（analyst）。English: [README.md](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/README.md)。

## 安装

安装约定见 [ADR 0052](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0052-public-cli-is-the-only-supported-external-role-interface.md)。操作示例：

```bash
pi install npm:@akagilnc/pi-workflow-roles
export PATH="$HOME/.pi/agent/npm/node_modules/.bin:$PATH"
```

更新示例：`pi update npm:@akagilnc/pi-workflow-roles`。查看能力：`ak-role roles`、`ak-role help <role>`；席位与官席配置见下方「读结果」。

发布路由见 [registry workflow](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/.github/workflows/publish-registry.yml)。

## 读结果

公开入口与结果交付见 [ADR 0052](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0052-public-cli-is-the-only-supported-external-role-interface.md)。重定向示例：

```bash
ak-role judge --model <provider/model[:thinking]> --attach ./plan.md "Review this plan." > result.txt
```

`--attach` 与通进司 `--request-manifest` 把调用方路径原样写进衙门第一句话。包不读、不复制、不校验；调用方当前目录与 `--project` 不同时请给绝对路径（[ADR 0087](docs/adr/0087-package-routes-and-passes-through-code-hands-no-paths.md)）。

退出码与 Terminal 语义见 [ADR 0052](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0052-public-cli-is-the-only-supported-external-role-interface.md)、[Terminal 实现](src/public-cli/terminal.ts)。

手动续跑用法与旗位见 `ak-role help resume`；model / host 解析见 `ak-role help`，engine 配置见 `ak-role help config`。审核续跑归属见 [ADR 0003](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0003-per-role-submission-tools.md)。换宿主与先前记录递送见 [ADR 0086](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0086-host-dossier-is-native-file-copy-sitian-append-only.md)。续跑失败处置见 [公开执行接缝](src/public-cli/post-admission.ts)。headless 回合启动材料目录在宿主终局之后（或 setup 失败已抛出之旁）清理失败时，经 package-fault 保留真因后继续，不另造宿主失败、也不改写已形成的终局（见 [headless 宿主](src/headless-host/role-turn-host.ts)）。

自动续跑行为见 [auto-resume 实现](src/public-cli/auto-resume.ts)；配置用法见 `ak-role help config`，有效上限用 `ak-role config show` 查看。

催交与实发次数记账（#1132）见 [角色运行时](src/role-runtime.ts)、[回执递送策略](src/receipt-delivery-policy.ts)、[外部宿主循环](src/external-host-turn-loop.ts)。unfinished 缺理由处置见 [ADR 0050](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0050-unfinished-terminal-state-reports-fact-not-diagnosis.md)。

席位与官席配置：

```bash
ak-role config set judge <provider/model[:thinking]>
ak-role config set navigator <provider/model[:thinking]>
# 官席配置示例
ak-role config set gatekeeper <provider/model[:thinking]>
ak-role config set inspector <provider/model[:thinking]>
ak-role config set notary <provider/model[:thinking]>
ak-role config unset gatekeeper
# 引擎配置示例
ak-role config set-engine judge claude-code
ak-role config set-engine coder cursor cursor-grok-4.6-high
ak-role config set-engine-model coder cursor-grok-4.6-high
ak-role config unset-engine-model coder
ak-role config unset-engine judge
# 宿主配置示例
ak-role config set-host judge grok-build
ak-role config unset-host judge
ak-role config set-auto-resume-limit 3
```

**宿主轴：** 用法与解析见 `ak-role help`；机构边界见 [ADR 0082](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0082-three-layer-runtime-role-host-face.md)。宿主推荐与原生压缩配置见 [#971](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/971)。

**宿主 provider：** 见 `ak-role help` 与 [provider 解析](src/public-cli/host-providers.ts)；表内容用 `ak-role config show` 查看。

**机器方法 Skill：** 运行 `ak-role setup`；安装行为见 [机器 Skill setup](src/public-cli/machine-method-skills.ts)、[ADR 0052](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0052-public-cli-is-the-only-supported-external-role-interface.md)；宿主能力见 [Pi Skill 递送](src/pi/role-turn-host.ts)、[外部 host 描述](src/host-descriptions.ts)。

**官席解析：** 见 [机构解析](src/institutional-resolution.ts)；配置用法见 `ak-role help config`，持久文件读取见 [config 实现](src/public-cli/config.ts)。

**回执：** 见 [导出契约](src/package-contracts/)；游奕使出口见 `ak-role help navigator`。组合与停止见 [ADR 0010](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0010-callers-own-role-composition-and-repetition.md)。

**交卷闸：** 见 [ADR 0079](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0079-direct-officer-summons-ticket-memory-pointer-input.md)、[交卷闸实现](src/submission-gate.ts)、[worker 审核组合](src/worker-role.ts)、[judge 审核组合](src/judge-role.ts)。劳务引擎失败处置见 [ADR 0071](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0071-engine-detour-failure-seat-fallback-declaration.md)，使用量观测见 [usage fact 真源](src/engine-detour-usage.ts)。

## 调用百官

下例只是用法速写；option 身份、别名、必填性与 mode 面以 `ak-role help <command>` 为准，不另立第二份旗标合同。

```bash
# model 用法见 ak-role help

# 大理寺
ak-role judge --model <provider/model[:thinking]> --attach ./findings.md --attach ./adr.md "Adjudicate every finding."

# 将作监
ak-role coder --model <provider/model[:thinking]> plan "Propose the first implementation plan."
ak-role coder --model <provider/model[:thinking]> apply --attach ./plan.md "Implement the approved slice."

# 御史台
ak-role reviewer --model <provider/model[:thinking]> --base main --authority-ref docs/adr/0001-roles-grow-by-demand.md "Review the branch."
# 可选单 lens 覆盖
ak-role reviewer --model <provider/model[:thinking]> --base main --lens correctness --authority-ref CLAUDE.md

# 通进司
ak-role collector --model <provider/model[:thinking]> --pr 42 --repo owner/repository "为所指 issue 收证。"
ak-role collector --model <provider/model[:thinking]> --repo owner/repository "为 #42 收证。"
ak-role collector --model <provider/model[:thinking]> --pr 42 --request-manifest ./requests.json "带具名请求正文收证。"

# 修内司
ak-role fixer --model <provider/model[:thinking]> --attach ./findings.md --prerequisites ./prereqs.json "Repair the findings."

# 太医署
ak-role doctor --model <provider/model[:thinking]> --issue 115 "Diagnose this retained case."

# 校书郎
ak-role merger --model <provider/model[:thinking]> --project /path/to/worktree "Reconcile the merge."

# 符宝郎——以 source-run locator 直调；职掌见 souls/notary.md
ak-role notary --model <provider/model[:thinking]> --source-run <runId@role|path>

# 台院
ak-role inspector --model <provider/model[:thinking]> --attach ./change.patch "Review this material."

# 门下省
ak-role gatekeeper --model <provider/model[:thinking]> --attach ./submission.json "审：这批材料该谁审？"

# 游奕使
ak-role navigator --model <provider/model[:thinking]> "刚完成 coder apply 收敛，下一步？"

# 起居郎请求示例；方法见 resources/diarist-collect.md
ak-role diarist --model <provider/model[:thinking]> "整理 #582 自上次成录以来的御话。"
# 多票请求示例
ak-role diarist --model <provider/model[:thinking]> "整理 #582、#583 自上次成录以来的御话，分别成录。"
# 给事中
ak-role countersign --model <provider/model[:thinking]> --attach ./ticket.md "裁：本票 #582 是否足以开工。"

# 中书省
ak-role secretariat --model <provider/model[:thinking]> "整理 #924 票面并送庭。"

# 左拾遗
ak-role gleaner-left --model <provider/model[:thinking]> --base main

# 太史
ak-role analyst

# 续跑请求示例；审核续跑归属见 ADR 0003
ak-role --model <provider/model[:thinking]> resume <runId> "<裁定>"
```

## 班子（唐宋官署命名）

名号判据、朝廷对应与机器键边界见 [ADR 0051](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0051-roles-are-named-after-tang-song-offices.md)。下表为名号索引。

| 名号 | 席位 | 职掌 |
| --- | --- | --- |
| **将作监** | coder | 职掌见 [Soul](souls/coder.md)。 |
| **修内司** | fixer | 职掌见 [Soul](souls/fixer.md)。 |
| **御史台** | reviewer | 职掌见 [Soul](souls/reviewer.md)；调用面见 `ak-role help reviewer`。 |
| **大理寺** | judge | 职掌见 [Soul](souls/judge.md)。 |
| **审刑院** | auditor（调用面见 `ak-role help auditor`） | 依受审对象读取 [大理寺审计 Soul](souls/judge-auditor.md)／[太医署审计 Soul](souls/doctor-auditor.md)。 |
| **门下省** | gatekeeper | 职掌见 [Soul](souls/gatekeeper.md)；独立调用见 `ak-role help gatekeeper`，交卷闸关系见 [ADR 0079](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0079-direct-officer-summons-ticket-memory-pointer-input.md)。 |
| **中书省** | secretariat | 职掌见 [Soul](souls/secretariat.md)；调用面见 `ak-role help secretariat`。 |
| **给事中** | countersign | 职掌见 [Soul](souls/countersign.md)；调用面见 `ak-role help countersign`。 |
| **左拾遗** | gleaner-left | 职掌见 [Soul](souls/gleaner-left.md)；调用面见 `ak-role help gleaner-left`。 |
| **台院** | inspector | 职掌见 [Soul](souls/inspector.md)；调用面见 `ak-role help inspector`，名号沿革见 [ADR 0074](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0074-gate-province-reorg-jishizhong-chaiyuan-split.md) 与 [#584](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/584)。 |
| **符宝郎** | notary | 职掌见 [Soul](souls/notary.md)；调用面见 `ak-role help notary`。 |
| **通进司** | collector | 职掌见 [Soul](souls/collector.md)。 |
| **校书郎** | merger | 职掌见 [Soul](souls/merger.md)。 |
| **游奕使** | navigator | 职掌见 [Soul](souls/navigator.md)；调用面见 `ak-role help navigator`。 |
| **起居郎** | diarist | 职掌见 [Soul](souls/diarist.md)；调用面见 `ak-role help diarist`。 |

其余席位：

| 席位 | 名 | 职掌 | 状态 |
| --- | --- | --- | --- |
| doctor | **太医署** | 职掌见 [Soul](souls/doctor.md)；调用面见 `ak-role help doctor`。 | 已建 |
| analyst | **太史** | 职掌见 [ADR 0068](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0068-taishi-analysis-seat-reads-records-writes-sibling-home.md)；调用面见 `ak-role help analyst`。 | 已建（[ADR 0068](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0068-taishi-analysis-seat-reads-records-writes-sibling-home.md)；机器面键 `analyst`，[#445](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/445) 拼音清零） |
| — | **司天台** | 职掌见 [ADR 0047](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0047-sitian-phase-one-mechanism-not-role.md)、[ADR 0065](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0065-sitian-phase-two-records-have-one-entry.md)。 | **一期不是角色**（[ADR 0047](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0047-sitian-phase-one-mechanism-not-role.md)：确定性机制；两面对账已删 [#855](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/855)）；分析席已由太史承担；起居录见 [ADR 0075](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0075-ticket-provenance-diarist-pipeline.md)；机器面键 `archivist`（[#445](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/445)） |
| marshal | **尚书省** | 审→判→修 质量收敛环的省部级驱动角色：调用方递票号与 baseline，尚书省驱动御史台/大理寺/修内司滚到收敛（converged 唯庭可判）或 escalate 上呈，交回 typed 报告；不弹、不判、不修，只让链条转到收敛 | 已定名（#145）；席位待落地（#146） |
| — | **殿院** | [#560](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/560) 机械定点测试巡查件（产物 kind `test-report`） | 在建/待落地，非席位，不占机器键 |
| — | **察院** | 巡按层名号占位 | 悬置，仅保留名号，巡按机制未建 |
| — | **兰台** | 读档议制——耗时／缺口／冗余三条，上奏不执法 | 未建 |
| — | **考功司** | 考具体效率——角色与档位的升档率、一次通过率、每票成本 | 留档，需要时另立票 |
| — | **主簿** | 合并后勾稽销案：核实确已合上、清理残留、报到达 | 未建 |

**merge 按钮归调用者**，没有任何角色握不可逆权限：通进司把收证这件苦活做完并报收集终态，人（或 AI）自己判断、自己点，点完想调主簿就调、不调也可以。

角色组合、调用顺序、停止与内审关联见 [ADR 0010](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0010-callers-own-role-composition-and-repetition.md)；通进司职责见 [Soul](souls/collector.md)。

`拾遗补阙` 成对留档，待将来出现第二个进言席再启用。

## 规范指针

- 命令用法、解析与拒绝文案：`ak-role help`、`ak-role help <command>`、`ak-role help config`（唯一权威）。
- 决策与法理：[docs/adr/](https://github.com/Akagilnc/ak-pi-workflow-roles/tree/main/docs/adr)（组合与顺序 ADR 0010、公开 CLI 面 ADR 0052、交卷闸 ADR 0066/0067/0070/0072、劳务引擎 ADR 0069/0071、起居录 ADR 0075 等，未尽举）。
- 术语表：[CONTEXT.md](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/CONTEXT.md)。编程契约：`src/package-contracts/` 导出。
