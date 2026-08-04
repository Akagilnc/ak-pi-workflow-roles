# @ak/pi-workflow-roles

Packaged workflow roles for [Pi](https://pi.dev). Supported roles: `judge`, `fixer`, `coder`, `reviewer`, `collector`, `doctor`, and `merger`.

## 班子（唐宋官署命名）

角色按唐宋官署／官职命名，判据与被否方案见 [ADR 0051](docs/adr/0051-roles-are-named-after-tang-song-offices.md)。**朝廷对应：皇帝＝陛下，宰相＝调用者，百官＝各角色。** 工厂没有政事堂——中枢是陛下。

**只是名字。** `--ak-role <name>` 的标识符、CLI 参数、工具名与 schema 字段一律不变，永远是下表左列的英文名；中文名是称谓，属呈现层，不触发任何迁移，既有调用方零改动。

| 席位 | 名 | 职掌 | 状态 |
| --- | --- | --- | --- |
| judge | **大理寺** | 鞫狱定谳——自行取证、下三态判词，不改码不 commit | 已建 |
| reviewer | **御史台** | 察举弹劾——出 finding，不作最终裁决 | 已建 |
| （无 CLI） | **审刑院** | 复核程序是否合法度，不得替换实质裁决 | 已建；共享内部接缝，非 `--ak-role` |
| coder | **将作监** | 营造新作——首次实现 | 已建 |
| fixer | **修内司** | 缮修既有——按修理包结算 | 已建 |
| collector | **门下省** | 合并前收外证：等线上评审、区分 pending／terminal、绑定精确 HEAD，报**收集终态**（腿可为 `valid｜unavailable｜missing`） | 已建；不裁决、不批准，CI／可合并性／thread resolved 均非覆盖范围 |
| （无 CLI） | **游奕使** | 随军游巡、先行备路、进言下一站；建议非授权，调用者可偏离 | 已建；共享生命周期自动出席，非 `--ak-role` |
| merger | **校书郎** | 雠校两本——调和冲突集而不以意改字，需新决定则阙疑上呈 | 已建 |
| doctor | 医生 | 单案诊断工厂机制，开 `keep｜thin｜delete` 方 | 已建；`弘文馆` 挂起 |
| — | **司天台** | 记候簿——只打点、只指针，不分析不执法 | **一期不是角色**（[ADR 0047](docs/adr/0047-sitian-phase-one-mechanism-not-role.md)：零 LLM 双面对账）；席位形态属 [#67](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/67) 素材，未定 |
| — | **兰台** | 读档议制——耗时／缺口／冗余三条，上奏不执法 | 未建（[#67](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/67) 两席之一） |
| — | **考功司** | 考具体效率——角色与档位的升档率、一次通过率、每票成本 | 留档，不属 #67，需要时另立票 |
| — | **主簿** | 合并后勾稽销案：核实确已合上、清理残留、报到达 | 未建 |

**merge 按钮归调用者**，没有任何角色握不可逆权限：门下省把收证这件苦活做完并报收集终态，人（或 AI）自己判断、自己点，点完想调主簿就调、不调也可以。

上表**不规定调用顺序**——组合、顺序、重复次数归调用者（[ADR 0010](docs/adr/0010-callers-own-role-composition-and-repetition.md)）。御史台／大理寺／审刑院是**职责分立的类比，不是必经链**；审刑院也并非只跟在大理寺之后，Judge、Fixer、Reviewer、Doctor 各自都有一次。

`拾遗补阙` 成对留档，待将来出现第二个进言席再启用。

## Quick start: invoke the Judge from a fresh session

Install once (project-local), or pass `-e /absolute/path/to/ak-pi-workflow-roles` on each invocation instead:

```bash
pi install -l /absolute/path/to/ak-pi-workflow-roles
```

**1. Feed materials through the filesystem.** Roles read files with their own tools; write what you want adjudicated into a file and name its path in the prompt.

```bash
mkdir -p /tmp/court/session
cat > /tmp/court/packet.md <<'EOF'
Adjudicate <what>. Evidence: <paths>. Questions: <numbered list>.
EOF
```

**2. Ignite.** Close stdin (`</dev/null` — pi drains a non-TTY stdin to EOF before doing any work, so an unclosed background pipe parks the invocation forever; upstream earendil-works/pi#2078). Discard stdout (an unbounded JSON event stream). Keep stderr and the session directory — they are the run's records.

```bash
pi --ak-role judge --mode json --session-dir /tmp/court/session \
  -p "Adjudicate per the packet at /tmp/court/packet.md. Read it in full first." \
  >/dev/null 2>/tmp/court/stderr.log </dev/null
```

**3. Read the verdict from the session file, not stdout.** The authoritative receipt is the accepted `ak_judge_output` tool call recorded in `/tmp/court/session/*.jsonl`; its `arguments` carry the verdict (shape: [Verdict contract](#verdict-contract)). Plain assistant text is never a completed verdict.

```bash
grep -o '"judgeStatus":"[a-z]*"' /tmp/court/session/*.jsonl | tail -1
```

Judge needs no other flags. Roles with mandatory flags: Fixer (`--ak-fixer-phase`, `--ak-fix-packet`), Reviewer (`--ak-review-task`, `--ak-review-capabilities`), Coder (`--ak-coder-phase`, `--ak-coder-task`) — see each role's section. An ignition that cannot activate its role exits nonzero; nothing falls back to uncaged pi.

## Navigator attendance

Every registered non-Navigator packaged role automatically prepares Navigator advice alongside its own work. The existing `pi --ak-role ...` invocation is unchanged. Navigator uses its own resumable Pi session, waits for that same preparation at typed role settlement, and emits an independent typed attendance event; it never invokes or enforces the recommended role.

When settlement is accepted and Navigator prepared a recommendation, the **accepted `ak_*_output` toolResult** in the role session appends the advice essentials (`路线` when the route changed, `下一步`, `理由`, `命令`) to the toolResult **content text**. Receipt `details` stay exactly the role's terminating-tool contract shape—no extra keys, no nesting, no parallel navigation object. Canonical headless callers that extract only the last `ak_*_output` settlement record therefore see the advice in that one read—no second grep, no sibling file, no extra level beyond the settlement record they already open. Unavailable and intentional silence (human-decision / role-infrastructure) leave the settlement content and details untouched; the role Receipt remains valid and otherwise unchanged. A sibling top-level `ak-navigator-attendance` custom_message and stdout typed events remain for interactive surfaces; they are not required for the headless extraction path.

The first attendance shows the concise role/phase route, one next step, a short reason, and one live-help-based Usage hint. Later attendance omits an unchanged route. Human-decision and role-infrastructure outcomes are silent; Navigator failures are reported honestly as unavailable and never invalidate the role Receipt.

The persistent model setting defaults to `openai-codex/gpt-5.6-luna:max`. Change it with `/navigator-model provider/model[:max]`; each later attendance rereads the setting and has no fallback or retry model.

## Judge

The judge role:

1. loads the bundled [`souls/judge.md`](souls/judge.md) into the system prompt;
2. lets the active Pi model adjudicate with normal tools;
3. accepts a final verdict only through `ak_judge_output`;
4. runs a separate Soul-compliance model call before accepting the verdict;
5. returns a terminating structured tool result only after the audit passes.

The compliance call uses the active Pi model and credentials. It checks demonstrated procedural compliance with the Soul; it does not replace the judge's substantive finding decisions. A successful compliance `audit_escalation` is a typed human-decision terminal result, not an accepted Judge Receipt; it remains distinct from a passed `ak_judge_output` receipt.

Judge infers its burden of proof from the supplied materials alone (authority completeness, plan construction-readiness, apply executable proof, or review finding adjudication).

On activation, Judge narrows active tools to the registered members of this exact whitelist: `read`, `grep`, `find`, `ls`, `bash`, and `ak_judge_output`. In particular, `write`, `edit`, and arbitrary sibling tools are inactive. This is role gating to prevent accidental role drift, not a security boundary; callers that need isolation must provide a sandbox or container.

## Fixer

The fixer role loads `souls/fixer.md` plus caller-supplied opaque prose instructions. Optional typed prerequisites travel as a separate JSON-array attachment:

```markdown
Repair the caller-assigned findings and preserve all unrelated behavior.
```

```json
[{"id":"owner.choice","requirement":"The controlling owner decision exists."}]
```

Instruction prose is rejected at activation when empty or trim-blank, is not machine-parsed, and admitted instruction bytes are preserved exactly. Prerequisite declarations are exported as `fixerPrerequisitesSchema`, `parseFixerPrerequisites`, and `validateFixerPrerequisites`; IDs are case-sensitive, attachment-unique, and match `^[A-Za-z0-9][A-Za-z0-9._-]*$`. The admitted prose and declarations are frozen together for the invocation. There is no frontmatter parser or automatic carry-forward.

The CLI advertises the complete phase vocabulary in `pi --ak-role fixer --help`:

| `--ak-fixer-phase` | Meaning | Legal success status |
| --- | --- | --- |
| `plan` | Inspect and propose a repair plan; do not edit or commit | `planned` or assignment-level `refused` |
| `apply` | Settle finding classes lawfully, or hand over honestly when this call remains unsettled | `completed`, `refused`, `partially_completed`, or `unfinished` |

There is no third phase. Apply `partially_completed` means a mixture of completed and lawfully refused findings, never unfinished work. `unfinished` is an apply-only, non-failure handover stating only that this call did not settle all assigned work; it carries a nonblank typed `remainingScope` and does not diagnose a cause, prescribe the caller's next step, or waive any acceptance.

```bash
pi --ak-role fixer \
  --ak-fixer-phase plan \
  --ak-fix-packet /path/to/fix-instructions.md \
  --ak-fixer-prerequisites /path/to/prerequisites.json \
  -p "Prepare the repair plan."

pi --ak-role fixer \
  --ak-fixer-phase apply \
  --ak-fix-packet /path/to/approved-fix.md \
  --ak-fixer-prerequisites /path/to/prerequisites.json \
  -p "Apply the approved repair plan."
```

Fixer terminates through `ak_fixer_output`. Its legal status-dependent shapes are:

```json
{"status":"planned","report":"Markdown report"}
{"status":"refused","report":"Markdown report","remainingScope":"assignment scope","blocker":{"cause":"authority_violation","evidence":"concrete evidence"}}
{"status":"completed","report":"Markdown report","classResults":[{"name":"Class name","disposition":"completed","searchScope":"complete census scope","exceptions":[{"where":"inspected location","reason":"why no repair was required"}],"commitSha":"committed revision identity"}]}
{"status":"partially_completed","report":"Markdown report","classResults":[{"name":"Done","disposition":"completed","searchScope":"all locations","exceptions":[],"commitSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},{"name":"Blocked","disposition":"refused","remainingScope":"exact remaining assignment scope","blocker":{"cause":"prerequisite_unmet","prerequisiteId":"owner.choice","evidence":"concrete absent prerequisite"}}]}
{"status":"unfinished","report":"This call did not settle all assigned work.","remainingScope":"unsettled assignment scope","classResults":[{"name":"Done","disposition":"completed","searchScope":"all locations","exceptions":[],"commitSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}
```

Every receipt requires `status` and a nonblank `report`. In `plan`, the semantic branches are `planned` or an assignment-level `refused`: a planned receipt has no other required semantic fields, while a plan-level refusal additionally requires nonblank `remainingScope` and a blocker. For apply, ordinary settlement `classResults` is non-empty with unique nonblank `name` values; `unfinished` instead requires nonblank top-level `remainingScope` and may omit `classResults`, but any supplied results are non-empty completed results with commit identities only. Each completed result requires `disposition: "completed"`, nonblank `searchScope` and `commitSha`, and an `exceptions` array whose entries require nonblank `where` and `reason`; a nonblank `commitSha` pointer may be shared by differently named class results. Each refused result requires `disposition: "refused"`, nonblank `remainingScope`, and a blocker. `completed` contains only completed results, `refused` only refused results, and `partially_completed` at least one of each. Authority blockers require `cause: "authority_violation"` and nonblank `evidence`; prerequisite blockers require `cause: "prerequisite_unmet"`, a pattern-valid `prerequisiteId`, and nonblank `evidence`.

These are required semantic fields, not exact object shapes: presentation-only extras such as labels, notes, and decorations are ignored and projected out of the accepted receipt. Contradictory semantic fields are rejected, including top-level `commitSha` or `classesRepaired`, fields from the opposite class-result disposition, and `prerequisiteId` on an authority blocker. A `prerequisite_unmet` blocker may name only an ID declared in the separate `--ak-fixer-prerequisites` JSON-array attachment; opaque instructions supplied through `--ak-fix-packet` do not declare IDs. An undeclared reference is rejected before audit and may be corrected. Empty declarations therefore forbid only `prerequisite_unmet`, not authority refusals or completed settlements.

Typed admission guarantees declaration/reference integrity only. Whether the declared predecessor is actually absent, controlling, and causally blocks lawful work remains an explicitly nondeterministic auditor judgment. The semantic auditor rejects retrospective method/history laundering, but tests and callers must not treat prompt prose as deterministic proof. Completed work remains completed; its report must disclose any method breach, claim only current verification, and not claim test-first execution that did not occur. Provider, authentication, auditor, tool, or transport failure aborts without a receipt. Boundary admission projects each candidate to a typed receipt; that projected receipt and the frozen packet instructions/prerequisites values enter the fresh same-active-model compliance audit without further semantic rewriting. Presentation extras discarded by the existing projection are not promised to survive. Revise permits corrected resubmission, while audit infrastructure failure is nonzero.

Fixer-only bash seatbelt (both `plan` and `apply`): before a `bash` tool executes, the package inspects only the string `command` and blocks when it case-sensitively contains any one of these exact ASCII literals — `rm -rf`, `git reset --hard`, `git clean`, `git checkout --`. The block is an ordinary nonterminating tool error that names the matched literal; bash does not run, the Fixer session stays alive, and the model may retry a different spelling/operation or submit `refused`. This is accidental-destruction drift prevention only — not hostile-code defense, shell sandboxing, filesystem isolation, or bypass resistance. Callers that need isolation must supply a container or sandbox.

## Coder

Coder handles first implementation in two explicit phases:

| `--ak-coder-phase` | Meaning | Legal success status |
| --- | --- | --- |
| `plan` | Inspect the task and propose an implementation plan; do not edit or commit | `planned` |
| `apply` | Execute the approved plan and verify the first implementation | `completed` or `unfinished` |

Either phase may return `refused` with authority and current-code evidence. During `apply`, Coder may also return `unfinished` with a nonblank typed `remainingScope` when this invocation has not settled the task; this is a resumable handoff, not a failure, and it does not waive any acceptance. A refusal does not require a commit and returns to the caller for disposition; Coder never emits `escalate`.

```bash
pi --ak-role coder \
  --ak-coder-phase plan \
  --ak-coder-task /path/to/task.md \
  -p "Prepare the implementation plan."

pi --no-skills \
  --skill ~/.agents/skills/tdd/SKILL.md \
  --ak-role coder \
  --ak-coder-phase apply \
  --ak-coder-task /path/to/approved-plan.md \
  -p "Apply the approved implementation plan."
```

Coder terminates through `ak_coder_output` with the same thin worker envelope:

```json
{"status":"planned|completed|refused","report":"Markdown report","commitSha":"optional self-report"}
{"status":"unfinished","report":"Markdown report","remainingScope":"nonblank typed remaining scope"}
```

During `apply`, the runtime transforms the first input through Pi's native `/skill:tdd`. Use `--no-skills --skill ~/.agents/skills/tdd/SKILL.md` to bind the canonical Matt TDD skill without name collisions. A `completed` receipt is rejected unless the immediately following prompt proves Pi's exact native expansion of the complete canonical TDD Skill and original request; an evidence-bearing `refused` receipt does not require that proof or a commit.

The completed report must preserve TDD evidence plus the same-pattern, introduced-regression, and behavior-fact self-check results for the caller. These are report/audit requirements, not a second bundled Skill. `commitSha` remains advisory evidence rather than a hard package gate. An unfinished receipt carries only its nonblank typed `remainingScope`; it does not carry commit identity or waive acceptance.

## Reviewer

Reviewer performs a fixed-target, two-axis code review through the canonical external Skill at `~/.agents/skills/code-review/SKILL.md`. The package does not bundle or reproduce that method. Bind it explicitly and provide both the existing non-empty opaque Markdown task and a mandatory narrow V1 capability file bound to the task's exact bytes:

```bash
pi --no-skills \
  --skill ~/.agents/skills/code-review/SKILL.md \
  --ak-role reviewer \
  --ak-review-task /path/to/review-task.md \
  --ak-review-capabilities /path/to/review-capabilities.json \
  -p "Review the requested fixed point."
```

The authoritative capability contract and validation live in the exported TypeScript API in [`src/reviewer-dispatch.ts`](src/reviewer-dispatch.ts). A static capability names tools and prerequisite operations; it never supplies a Git range command:

```json
{"version":1,"taskSha256":"<SHA-256 of exact task bytes>","tools":["read","bash"],"prerequisiteOperations":["preflight.git.pin-target","preflight.git.resolve-base","preflight.git.derive-range","preflight.git.list-ordered-commits","preflight.git.read-material","runner.git.materialize-mirror","runner.git.materialize-workspace","runner.git.verify-snapshot"]}
```

The authoritative `Agent` input contract is the exported runtime `reviewerProposalSchema` in [`src/reviewer-role.ts`](src/reviewer-role.ts), with its corresponding TypeScript proposal type in `reviewer-dispatch.ts`. Proposals name a semantic base and materials, not a resolved commit or shell command; the runtime derives and pins those facts. Callers should derive validation and proposal construction from those exports rather than this invocation guide.

Reviewer terminates in two layers. The model submits only a **thin intent** through `ak_reviewer_output`:

```json
{"status":"completed"}
{"status":"refused","diagnostic":"non-empty reason"}
```

The authoritative receipt is the **runtime-assembled V2 receipt returned in that tool call's result** (`details`), validated by `validateRuntimeReviewerReceipt` in [`src/package-contracts/reviewer-output.ts`](src/package-contracts/reviewer-output.ts): it carries `reports.standards` / `reports.spec` as byte-identified Markdown (`{text, utf8Length, sha256}`) plus outcomes and content identities. **Findings live in those reports — read the tool-result details (persisted in the session record), not the thin intent.** A caller that reads only the intent sees `{"status":"completed"}` and no findings; that is the intent by design, not the receipt.

`completed` means the requested review was completed; it says nothing about approval, routing, mergeability, or the next role — consult the reports for findings. `refused` is an evidenced inability to establish the review target, authority, or factual premise. Infrastructure failures instead abort the action and exit nonzero. Both statuses undergo a separate active-model, no-operational-tool method-compliance audit; `revise` permits corrected resubmission.

`reviewer-cmr` is reserved terminology for a possible future AK CMR cross-model-panel role. It is not implemented and Reviewer exposes no panel or model-selection machinery.

## Collector

Collector is a standalone external-GitHub PR evidence collection role. It observes explicitly configured reviewer legs, optionally requests them, classifies collection terminality (`valid` | `unavailable` | `missing`), preserves evidence across HEAD moves, and submits one self-contained receipt through `ak_collector_output`. It is not Reviewer or Judge and never reviews code, repairs, writes code, pushes, merges, approves, or routes.

v1 supports `github.com` only. There is no default leg/bot: callers must supply an explicit non-empty leg manifest. Owner/repo uses a conservative ASCII grammar (owner 1–39, repo 1–100). Enterprise hosts, interactive/RPC mode, resume/continue, and later prompts are unsupported.

**Collector forbids every Skill**, including command-only Skills (`disable-model-invocation: true` / prompt-excluded but command-present). Skills are not part of the supported Collector surface.

Supported one-shot launch profile (required shape):

```bash
pi --no-extensions -e <package-extension> --no-skills --no-prompt-templates \
  --no-context-files --no-session --mode json --ak-role collector \
  --ak-collector-repo <owner/repo> --ak-collector-pr <n> \
  --ak-collector-legs <manifest.json> -p "Start collection."
```

That profile means: `--no-skills`; `--no-extensions` with only the explicit Collector package extension; no prompt templates; no context files; exactly one print/JSON prompt. Do not load Skills, ambient extensions, prompt templates, or context files alongside Collector.

Legs-only caller example (`--ak-collector-legs`):

```json
{
  "legs": [
    {
      "id": "codex",
      "expectedAuthors": ["CodexBot"],
      "request": { "body": "Please review this PR." }
    }
  ]
}
```

Runtime behavior highlights:

- only four tools are active: `ak_collector_observe`, `ak_collector_request`, `ak_collector_wait`, `ak_collector_output`;
- external GitHub text is data-only evidence and cannot change target, legs, policy, or tools;
- eligibility cutoff is 15 minutes from first model dispatch (request/wait gate; final observe/output may finish afterward);
- successful receipts embed `snapshots[]` and `evidenceRecords[]` so every evidence ref resolves inside the tool-result details;
- request attempts are process-local at-most-once per `(repo, PR, HEAD, leg)` with a deterministic HTML correlation marker; concurrent independent Collector processes can still race and duplicate comments—serialize callers when that is unacceptable;
- requires ambient `gh` authentication for `github.com` and model credentials; role gating is drift prevention, not a security boundary;
- on Pi latest, a late hostile sibling-extension injection into `before_agent_start` `systemPromptOptions.skills` is unsupported and fail-closed when detected; that path is not a normally discovered Skill, is not a security boundary, and does not imply a provider-zero guarantee;
- current orchestrator wiring is unsupported and requires a separately authorized migration plus thin adapter.

Failure channels (non-zero, no receipt) include malformed/unsupported config or mode, loaded Skills (including command-only), ambient instruction surfaces, non-OPEN final snapshot, transport/API/pagination/size/model failures, unrecovered request response loss, and later-input/output-singleton violations. There is no Collector `refused` status.

## Doctor

Doctor reads one retained Pi-native case and exposes only the bounded evidence reader plus its terminating output tool:

```bash
pi --no-extensions -e /path/to/extensions/role-runtime.ts \
  --ak-role doctor --ak-doctor-case .ak/work/issues/40/runs \
  --mode json -p "Produce this case's process-cost diagnosis."
```

Case identity is the issue number plus the repository-relative retained-runs path when a `.git` worktree root contains it; outside a repository the resolved absolute path is the explicit fallback. Do not delete or rewrite run directories before Doctor examines them. Each recursive `*.jsonl` is one model-session leg; each immediate run directory is one caller invocation, and `stderr.log` remains evidence for invocations that died before a session header. `ak_doctor_evidence` pages exact admitted session bytes in chunks of at most 4096 characters; filesystem, shell, network, write, and Agent tools remain inactive.

The completed output is one case's cost report plus findings; it never requires a trend. Wall time runs from the session-header outer timestamp to the final accepted, non-error terminating `toolResult`, or to the last row and is labeled incomplete. Truncated JSON tails, missing headers, and non-monotonic endpoints remain incomplete evidence with an explicit degradation reason; unavailable or negative durations are omitted rather than invented or clamped. Assistant message rows with `responseId` count model/API turns and their `usage.output` tokens are summed. Assistant `content[]` `toolCall` items count calls, including the terminal call. Retries are reported only when an immediate run-directory name contains the delimiter-bounded word `retry` (case-insensitive; start/end, `-`, and `_` are delimiters): `review-004-retry-2` counts, while `review-004-retry2` and `2nd-try` do not. Status comes only from typed details on a non-error terminating result, never prose or an attempted call. Commits are only `commitSha` values in typed details of accepted terminating results; abbreviated SHAs retain their stated precision. This deliberately narrows the earlier “observed state transitions” wording under the anchoring law: free-text SHA mentions are not observations, trading broader inference for honest reduced coverage. Output bytes explicitly mean raw JSONL bytes; provider-wire bytes are unavailable, so token counts are reported separately.

The completed testimony carries no cost numbers; the runtime seals its own derived cost into the receipt. The sole final `ak_doctor_output` result undergoes a fresh same-active-model compliance audit; revise permits resubmission, while audit or transport failure aborts without manufacturing refusal. Trend reporting is a separate output type for future multi-case readers.

## Merger

Merger resolves exactly one caller-assigned merge that is already in conflict. It has no phase and does not select branches, start/abort/retry a merge, publish a result, or route another role.

```bash
pi --no-extensions -e /path/to/extensions/role-runtime.ts \
  --ak-role merger --ak-merger-input /path/to/merger-input-v1.json \
  --mode json -p "Resolve the admitted in-progress merge or escalate the required decision."
```

The authoritative exported TypeScript contract is `mergerInputSchema` plus `validateMergerInput`. It binds `attemptId`, exact target/source full object IDs, digest-bound UTF-8 task/authority/target-intent/source-intent bytes, the byte-sorted complete conflict set, permitted resolution scope, and named authorized check argv. Repository location is caller transport and is intentionally absent from portable identity.

Activation compares the contract with production Git facts in Pi's assigned session working directory: `HEAD`, the sole `MERGE_HEAD`, and the complete unmerged path set, and freezes Git's exact `AUTO_MERGE` tree. Before invoking Merger, the caller must have already started a conflicting merge that produced `AUTO_MERGE`; Git's `ort` merge strategy produces it. If `AUTO_MERGE` is absent, activation aborts honestly without a role outcome, as it does for drifted automatic-result evidence, a missing/non-conflicting merge, malformed input, or identity drift. Active tools are exactly `read`, `grep`, `find`, `ls`, `bash`, `write`, `edit`, and `ak_merger_output`. This gating prevents role drift; it is not filesystem or Git security. The caller must isolate the assigned worktree and credentials appropriately.

`ak_merger_output` is singleton and terminating. Its exact leaves are:

```json
{"status":"completed","attemptId":"opaque attempt","report":"nonblank report","mergeCommitId":"full lowercase 40- or 64-hex object ID"}
{"status":"escalate","attemptId":"opaque attempt","diagnosis":"required intent/authority decision","report":"nonblank report"}
```

Before accepting `completed`, the runtime establishes that `mergeCommitId` is current `HEAD`, has exactly the frozen target then source as its two parents, has no unmerged entries, and leaves a clean worktree. It also compares the frozen automatic-result tree with the completed tree using rename-disabled, NUL-delimited exact paths and rejects every resolution-changed path outside `resolutionScope`; clean source-side changes are not resolution edits. This proves only the candidate merge commit, not caller publication. `escalate` is only for a genuine new intent or authority decision. Malformed output and Git/tool/runtime failures abort nonzero rather than being relabeled.

### Non-normative external capability exam

The following is only a feasibility example, not a package recipe or executable/default/required workflow. An external caller may run independent tasks in caller-provided worktrees, integrate completed tasks in completion order, invoke Merger only for a real Git conflict, and perform a final pre-PR review/fix closure. A caller may instead provide a parent and children with a family integration base, start each child from a stable family tip selected by that caller, integrate completed children one at a time, optionally perform a bounded review/adjudication/fix closure after each integration, and perform a final family-wide closure. Every ordering choice, loop, stopping condition, and resource policy belongs to the caller; other compositions are equally lawful. No role knows a predecessor or successor.

## Verdict contract

Judge's legal status-dependent shapes are:

```json
{"judgeStatus":"converged"}
{"judgeStatus":"continue","fix":{"summary":"non-empty repair summary"},"classes":[{"name":"ClassName","owner":"owning seam","boundary":"bounded scope","disposition":"adjudication"}]}
{"judgeStatus":"escalate","decisionGate":{"question":"non-empty 陛下 question","options":["non-empty option"]}}
{"judgeStatus":"converged","evidence":{"checks":[{"name":"verification","passed":true}]}}
```

A `continue` receipt requires non-empty `classes` with unique comma-free nonblank names and nonblank owner, boundary, and disposition fields. `classes` is forbidden on `converged` and `escalate` receipts. The shapes retain these meanings:

- `converged` — relative to the material under judgment (for a plan: construction authorization only)
- `continue` — further repair is warranted
- `escalate` — a 陛下 decision is required

Any verdict may additionally carry an optional non-empty `note` Markdown string. It is an advisory addendum for important information or requirements that should remain separate from the status-specific fields (including apply obligations attached to a construction-ready plan). It has no built-in routing or execution semantics, and callers may ignore it without changing the existing verdict flow.

Any verdict may also carry an optional `evidence` JSON value, including an empty value. It is an opaque retained field: the runtime does not audit, normalize, or interpret its contents beyond receiving well-formed JSON, and no package consumer reads, enforces, classifies, or routes it. The accepted receipt details retain the value unchanged for callers.

Workflow ordering and routing are caller-owned. A separate orchestrator is optional infrastructure, not a package requirement.

## Composing class-repair contracts

Callers may use the typed contracts together without parsing prose: a `continue` Judge receipt identifies non-empty `classes[]`; a caller supplies opaque Fixer instructions and, separately, typed prerequisite declarations; an apply Fixer receipt settles findings in `classResults[]`; and `--ak-review-scope-keys <comma-separated keys>` limits Reviewer to exact class keys (omit it for a full review). Fixer prerequisite declarations and blocker references are typed IDs, but the package does not infer, execute, graph, route, retry, or schedule dependencies. Packet composition, compatibility grouping, contextual reconciliation, sequencing, stopping, invocation budgets, routing, and next-hop acceptance remain caller-owned; these contracts create no orchestration topology.
