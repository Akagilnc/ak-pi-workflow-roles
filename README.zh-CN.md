# @akagilnc/pi-workflow-roles

为 [Pi](https://pi.dev) 打包的工作流角色：大理寺（judge）、修内司（fixer）、将作监（coder）、御史台（reviewer）、门下省（collector）、太医署（doctor）、校书郎（merger）。English: [README.md](README.md)。

## 安装

经 Pi 安装，令 CLI 与运行时同出一份包副本；把 Pi 私有 npm bin 加进 `PATH`（一次）：

```bash
pi install npm:@akagilnc/pi-workflow-roles
export PATH="$HOME/.pi/agent/npm/node_modules/.bin:$PATH"
```

更新用 `pi update npm:@akagilnc/pi-workflow-roles`——勿另起全局 `npm install -g`。查看能力：`ak-role roles`、`ak-role help <role>`；设席位默认：`ak-role config set judge openai-codex/gpt-5.6-sol:high`。

## 读结果

`ak-role` 是唯一受支持的调用方式。每次运行的完整 Terminal 结果写在 stdout——从那里读或正常重定向，不要刮 Pi session 文件：

```bash
ak-role judge --attach ./plan.md "Review this plan." > result.txt
```

退出码报的是生命周期诚实，不是业务成败：一切合法 typed 终态（含 `audit_escalation`）退出零；无合法终态的失败退出非零，其 Terminal 携带 Error Artifact 引用与原始原因，不伪造回执。

被 Codex/xAI typed HTTP 429 打断且无合法终态的运行，其失败 Terminal 内含完整 `ak-role resume <runId>` 命令。resume 重开同一 session；临时换模型用全局旗标。包绝不自动换 provider；只有 typed 429 可恢复；未知、已终结、并发重复的 run ID 一律拒绝。门下省、太医署为一次性，无 resume。

全局覆盖前后皆可：`ak-role --model xai/grok-4.5:high resume <runId>`。

每次运行游奕使自动出席，建议随同一 Terminal 给出。配置：

```bash
ak-role config set navigator openai-codex/gpt-5.6-luna:medium
```

回执是 typed 的，调用者不必解析散文即可组合角色；顺序与停止归调用者。编程消费者从 `src/package-contracts/` 导出推导契约，不从本文。

## 调用百官

通用旗标：`--attach <文件>`（可重复，受理即冻结）、`--project <路径>`。指令对大理寺、门下省、太医署可省略，对将作监、修内司、御史台、校书郎必须非空。

```bash
# 大理寺——审断所供材料；自行推断举证责任，无 burden 旗标
ak-role judge --attach ./findings.md --attach ./adr.md "Adjudicate every finding."

# 将作监——营造新作；phase 默认 apply，或显式 plan
ak-role coder plan "Propose the first implementation plan."
ak-role coder apply --attach ./plan.md "Implement the approved slice."
# apply 强制包内 TDD 方法；勿绑 home Skill 顶替

# 御史台——固定目标双轴察举（Standards + Spec）
ak-role reviewer --base main --attach ./issue.md "Review the branch."
# --base 只是提示；completed ≠ 准行——findings 在 Terminal 里

# 门下省——GitHub PR 收证；仅 github.com，需 gh 已认证；一次性
ak-role collector --pr 42 --leg codex:CodexBot --leg cursor:cursor-bot,cursor-bot-2
# leg 语法 id:author[,author...]；repo 默认取 origin，--repo owner/repo 覆盖

# 修内司——缮修所指 findings；phase 默认 apply，或显式 plan
ak-role fixer --attach ./findings.md --prerequisites ./prereqs.json "Repair the findings."
# --prerequisites 为 {id, requirement} JSON 数组；语法畸形退出 2

# 太医署——单案诊断；一次性
ak-role doctor --issue 115 "Diagnose this retained case."
# --runs 须为项目相对的 .ak-roles/books/<book>/issues/<n>/runs 且匹配 --issue

# 校书郎——雠校一个已在冲突的 merge（先用 Git ort 起动）
ak-role merger --project /path/to/worktree "Reconcile the active merge."
# 遇新意图/权限问题交回调用者，不捏造 authority
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
| **审刑院** | judge-auditor／reviewer-auditor（无 CLI，共享内部接缝） | **复核成案。** 不重新争论事情本身，而是检查整个办理过程是否合乎规矩。关注是否有人越过职责、是否遗漏必要步骤、是否以错误方式得出正确结果。 |
| **门下省** | collector | **承接百议。** 位于决策之前，收集各方反馈与意见，确认事情是否已经具备继续推进的条件。它不替人裁决，只负责让信息完整、状态清楚。 |
| **校书郎** | merger | **雠校异文。** 面对不同来源的修改，负责整理、校合与调和。保留双方有价值的部分，解决彼此冲突；遇到无法自行决定之处，则留待重新裁量。 |
| **游奕使** | navigator（无 CLI，自动出席） | **巡行问路。** 不掌具体事务，而是观察全局变化，结合当前局面提醒下一步方向。它提供建议与路径参考，但最终选择仍由执掌之人决定。 |

其余席位：

| 席位 | 名 | 职掌 | 状态 |
| --- | --- | --- | --- |
| doctor | **太医署** | 单案诊断工厂机制，开 `keep｜thin｜delete` 方 | 已建 |
| — | **司天台** | 记候簿——只打点、只指针，不分析不执法 | **一期不是角色**（[ADR 0047](docs/adr/0047-sitian-phase-one-mechanism-not-role.md)：零 LLM 双面对账）；席位形态属 [#67](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/67) 素材，未定 |
| — | **兰台** | 读档议制——耗时／缺口／冗余三条，上奏不执法 | 未建（[#67](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/67) 两席之一） |
| — | **考功司** | 考具体效率——角色与档位的升档率、一次通过率、每票成本 | 留档，不属 #67，需要时另立票 |
| — | **主簿** | 合并后勾稽销案：核实确已合上、清理残留、报到达 | 未建 |

**merge 按钮归调用者**，没有任何角色握不可逆权限：门下省把收证这件苦活做完并报收集终态，人（或 AI）自己判断、自己点，点完想调主簿就调、不调也可以。

上表**不规定调用顺序**——组合、顺序、重复次数归调用者（[ADR 0010](docs/adr/0010-callers-own-role-composition-and-repetition.md)）。御史台／大理寺／审刑院是**职责分立的类比，不是必经链**；审刑院也并非只跟在大理寺之后，大理寺、修内司、御史台、太医署各自都有一次。

`拾遗补阙` 成对留档，待将来出现第二个进言席再启用。

## 开发者接缝：手拼 session（高级）

多数调用者不需要本节。源码树保留一条可显式装载的 raw-Pi 接缝，供包开发与底层诊断；它不是受支持的调用配方——外部调用者用 `ak-role`。

原始运行显式装载角色运行时，经内部旗标选角色。以下 argv 全形取自 CLI 自身 builder 与卷宗实记：

```bash
run=~/.ak-roles/books/<book>/issues/<issue>/runs/<invocation>@<源树>
pi --no-extensions \
  -e <packageRoot>/extensions/role-runtime.ts \
  --no-skills --no-prompt-templates --no-themes --no-context-files \
  --session "$run/session/session.jsonl" \
  --session-dir "$run/session" \
  --ak-role judge --mode json \
  "Adjudicate the attached materials." \
  </dev/null >/dev/null 2>"$run/stderr.log"
```

`--session` 指精确 session 文件正本（非 directory-latest）；`--session-dir` 为其目录。大理寺的指令走 prompt；其余角色经各自内部旗标传持久 payload 文件（`--ak-coder-task`、`--ak-fix-packet` 等），由各角色 builder（`src/public-cli/*-run.ts`）经装载边界 `src/public-cli/explicit-internal.ts` 装配。旗标从源码与卷宗实记推导，勿从散文推导。

纪律：

- stdin 须以 `</dev/null` 封死——Pi 会将非 TTY stdin 读到 EOF 才开工，未封死的后台管道＝永久停车；
- stdout 丢 `/dev/null`——session 文件才是正本，stdout 是无上限副本面；仪表挂 `stderr.log` 与 session 文件；
- `stderr.log` 与 `invocation.json` 落在同次 `runs/` 目录，如上例。

Codex fast 档：安装或升级 Pi 0.84.1 后运行一次 `ak-deploy-codex-fast-patch`。开启：`echo "fast_mode = on" > ~/.pi-codex-fast`；关闭：`echo "fast_mode = off" > ~/.pi-codex-fast`（或删文件）。修改后无需重启，下一个请求即生效。Fast 档价格高于默认档。
