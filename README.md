# @akagilnc/pi-workflow-roles

Packaged workflow roles for [Pi](https://pi.dev): `judge`, `fixer`, `coder`, `reviewer`, `collector`, `doctor`, `merger`. 中文说明见 [README.zh-CN.md](README.zh-CN.md)。

## Public CLI (`ak-role`)

`ak-role` is the only supported way to call the package (ADR 0052). Install it through Pi so the executable and runtime always come from the same package copy, then add Pi’s private npm bin directory to `PATH` once:

```bash
pi install npm:@akagilnc/pi-workflow-roles
export PATH="$HOME/.pi/agent/npm/node_modules/.bin:$PATH"
```

Update CLI and runtime together from that same Pi-managed copy (do not add a second global `npm install -g`):

```bash
pi update npm:@akagilnc/pi-workflow-roles
# or refresh every installed Pi package:
pi update --extensions
```

Inspect the installed capabilities and choose persistent defaults:

```bash
ak-role roles
ak-role help
ak-role help judge
ak-role config set judge openai-codex/gpt-5.6-sol:high
ak-role config set navigator openai-codex/gpt-5.6-luna:medium
```

### Call Judge

Pass an optional instruction directly after the role. Use repeatable `--attach` options for local regular files and `--project` when the target is not the current project:

```bash
ak-role judge \
  --attach ./review-findings.md \
  --attach ./governing-adr.md \
  "Adjudicate every finding against the supplied authority."

ak-role judge \
  --project /path/to/project \
  --attach /path/to/plan.md \
  "Decide whether this plan is ready for construction."
```

The complete Terminal result is written to stdout. Read it there or redirect that same result normally; do not discard stdout or scrape Pi session files. Exit status reports whether the CLI lifecycle completed honestly, not business success: every lawful typed terminal result—including `audit_escalation`—exits zero; structural or infrastructure failure without a lawful typed terminal result exits nonzero. On controlled post-admission failure the same Terminal carries the durable Error Artifact ref and original cause identity rather than a fabricated role Receipt:

```bash
ak-role judge --attach ./plan.md "Review this plan." > judge-result.txt
```

Judge deliberately has no public burden flag: it infers Authority, Plan, Apply, or Review from the request. Global one-run overrides may appear before or after the role command:

```bash
ak-role --model openai-codex/gpt-5.6-sol --thinking high \
  judge --attach ./decision.md "Adjudicate this decision."
```

When a Role run is interrupted by an observed typed Codex/xAI HTTP 429 and has no lawful terminal result, the failure Terminal includes a complete `ak-role resume <runId>` command (the run ID appears only there). Resume reopens the exact Pi session with the admitted instruction, frozen Attachments, and typed role values; choose a temporary model with the usual global flags without changing persistent configuration. The package never auto-switches providers or models after a quota interruption, and concurrent resume of one run is rejected before a second dispatch. Quota-like prose alone never makes a run resumable — only a typed HTTP 429 observation does. Unknown, terminal, and non-resumable run IDs reject without replay.

```bash
ak-role --model xai/grok-4.5:high resume <runId>
```

Judge, Coder, Fixer, Collector, Doctor, Reviewer, and Merger are the completed public run paths. `roles` lists the full callable registry plus automatic Navigator. Ordinary Pi startup does not expose the package’s internal activation flag.

### Call Coder

Coder accepts the common Invocation request (optional attachments, project override, nonblank task instruction). Phase defaults to `apply`; pass an explicit `plan` token to preserve plan through admission and any continuation:

```bash
ak-role coder \
  --attach ./approved-plan.md \
  "Implement the approved vertical slice."

ak-role coder plan \
  --project /path/to/project \
  "Propose the first implementation plan for this task."

ak-role coder apply \
  --attach ./notes.md \
  "Execute the approved plan and verify with package-owned TDD."
```

Apply binds the package-owned Matt TDD method from the installed package (including `tests.md` and `mocking.md`) without ambient home Skill discovery or network fetch. Lawful Terminal results and Artifact refs use the same success interface as Judge.

### Call Reviewer

Reviewer accepts the common Invocation request plus an optional `--base` revision hint for the fixed review target. Capabilities are adapter-derived from exact task bytes; callers never submit capability packets:

```bash
ak-role reviewer \
  --base main \
  --attach ./originating-issue.md \
  "Review the branch on Standards and Spec."

ak-role reviewer \
  --project /path/to/project \
  "Review the latest commits; pin the base through proposal/preflight."
```

The package-owned adapted code-review method is forced from the installed package without ambient home Skill discovery, Matt setup files, or project-governance mutation. Lawful Terminal results and Artifact refs use the same success interface as Judge.

### Call Collector

Collector accepts an explicit positive PR number and repeatable leg declarations (`id:author[,author...]`). Repository defaults from the project’s `origin` GitHub remote; pass `--repo owner/repo` to override. Optional instruction and `--attach` / `--project` follow the common Invocation request. The adapter assembles the retained leg manifest — callers do not author internal JSON or invent expected authors from prose:

```bash
ak-role collector \
  --pr 42 \
  --leg codex:CodexBot \
  --leg cursor:cursor-bot,cursor-bot-2

ak-role collector \
  --project /path/to/project \
  --repo OtherOrg/OtherRepo \
  --pr 7 \
  --leg codex:CodexBot
```

Well-formed but nonexistent PRs or authors are not rejected by CLI preflight; Collector reports them through its existing typed receipt. Collector is one-shot (no `ak-role resume`). Lawful Terminal results and Artifact refs use the same success interface as Judge and Coder.

### Call Fixer

```bash
ak-role fixer \
  --attach ./findings.md \
  --prerequisites ./prereqs.json \
  "Repair the caller-assigned findings."

ak-role fixer plan \
  --project /path/to/project \
  "Propose the first repair plan."
```

Phase defaults to `apply`. Optional `--prerequisites` is a JSON array of `{id,requirement}` objects. Fixer apply and resume mount both package-owned methods from the installed package: diagnosis at `resources/methods/diagnosing-bugs/` (adapted from Matt Pocock’s `mattpocock/skills` source, MIT-attributed) and test-driven development at `resources/methods/tdd/` (the pinned `mattpocock/skills` source, with testing and mocking material). Neither is forced into the repair prompt.

### Call Doctor

```bash
ak-role doctor \
  --issue 115 \
  --project /path/to/project \
  "Diagnose this retained case."
```

`--issue` is required. Optional `--runs` must stay project-relative and match the Issue’s retained runs grammar. Doctor is one-shot (no `ak-role resume`).

### Call Merger

```bash
ak-role merger \
  --project /path/to/conflicted-worktree \
  --attach ./authority-notes.md \
  "Reconcile the active merge without inventing new authority."
```

There is no phase token. The adapter derives the active merge envelope; callers do not author internal merger-input JSON. Package-owned merge-only method is forced from the install.

Read every Terminal result from `ak-role` stdout (or a normal redirect of that same stream). Do not scrape Pi event streams, session JSONL, or status-only `grep`/`jq` recipes for role outcomes or Navigator advice.

Navigator advice is included in that same Terminal result. After the role settles, Navigator has at most 10 seconds to finish; healthy preparation returns immediately. Timeout or preparation failure is reported as unavailable and does not invalidate the role result.

## Names

Roles are named after Tang/Song offices; the full roster and naming rule live in [README.zh-CN.md](README.zh-CN.md).

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

上表**不规定调用顺序**——组合、顺序、重复次数归调用者（[ADR 0010](docs/adr/0010-callers-own-role-composition-and-repetition.md)）。御史台／大理寺／审刑院是**职责分立的类比，不是必经链**；审刑院也并非只跟在大理寺之后，Judge、Fixer、Reviewer、Doctor 各自都有一次。

`拾遗补阙` 成对留档，待将来出现第二个进言席再启用。
