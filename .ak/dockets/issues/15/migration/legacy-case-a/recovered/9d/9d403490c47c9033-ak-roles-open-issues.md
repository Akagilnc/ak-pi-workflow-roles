# Issue #3: judge: separate plan readiness from apply verification depth

URL: https://github.com/Akagilnc/ak-pi-workflow-roles/issues/3

## Context

During Collector v1 construction, the role closure loop exposed a Judge-depth problem:

```text
Authority judgment
→ Coder/Fixer plan judgment
→ Coder/Fixer apply judgment
→ independent Reviewer judgment
```

The early rounds were healthy. Judge fixed public behavior, evidence law, time law, and module ownership; after construction, Judge found real counterexamples despite a green suite.

The loop then became unhealthy at the **plan** step. Judge repeatedly withheld construction authorization until the plan specified implementation-level fixture mechanics: exact fake return arrays, complete library calls, exact collision facades, and which legal field would provide one-byte granularity at 8/32 MiB boundaries. Those are legitimate apply-time proof obligations, but the plan's behavior, owner, red oracle, green oracle, and scope were already stable.

Cross-model variation amplified the problem: worker plans used `or`, `e.g.`, or placeholders, while Judge progressively demanded quasi-code before permitting code to be written. Multiple plan rewrites occurred without changing the repair contract or owning seam.

This belongs to the roles package because it concerns the professional judgment exercised by Judge over Coder/Fixer receipts. Who invokes the roles, in what topology, and what happens next remain outside this package.

## Problem

Judge currently has no explicit burden-of-proof distinction between:

- whether an authority is complete enough to govern work;
- whether a proposed plan is safe enough to begin construction;
- whether completed construction has actually proved its claims;
- whether an independent review finding should be sustained.

As a result, `converged` can be interpreted as “all implementation details are already proven,” even when the artifact under judgment is only a plan. Plan judgment then absorbs apply judgment and produces low-value textual ping-pong.

The package must preserve one generic Judge role and the existing verdict contract. This issue must not add orchestration, routing, next-role semantics, retry ceilings, or a workflow DSL.

## Proposed judgment postures

These are burdens of proof applied to the material presented to Judge, not public workflow phases and not routing states.

### 1. Authority posture — contract completeness

Judge may be maximally strict about:

- public contracts and role boundaries;
- state, time, evidence, and trust semantics;
- irreversible decisions and owner choices;
- module ownership and external seams;
- contradictions or missing counterexamples that make later work unsafe.

Authority may remain unconverged until those matters are resolved.

### 2. Plan posture — construction readiness

For every planned change, Judge requires five facts:

1. **Behavior** — what observable requirement or defect is addressed?
2. **Owner** — which deep module/seam owns the behavior?
3. **Red oracle** — what counterexample must fail before repair?
4. **Green oracle** — what observable result proves repair?
5. **Scope** — what explicitly remains unchanged?

A plan is construction-ready once these cover the governing authority and no contract, owner decision, incompatible seam, or feasibility blocker remains unresolved.

`converged` in response to a plan means only: **the plan is safe enough to construct**. It does not testify that construction evidence already exists.

Judge may place concrete construction obligations in the existing optional `note`. The note remains advisory receipt content with no package-owned routing semantics.

### 3. Apply posture — executable proof

When judging completed work, Judge is strict about actual evidence:

- tests really exercised the claimed red/green behavior;
- fixtures crossed the required production/Pi/package seam;
- exact time/byte/state boundaries were actually reached;
- no duplicate guard, parallel mechanism, or test-only production hook was added;
- every governing counterexample and plan obligation is implemented;
- commit, diff, lifecycle, and verification claims match live facts.

Implementation-level fixture and calibration failures belong here.

### 4. Review posture — finding adjudication

When judging an independent Reviewer receipt, Judge decides whether each finding is factually sustained against current authority and code. It must not demand that Reviewer repair code or turn review prose into workflow routing semantics.

## Plan blocking law

Judge may keep a plan unconverged only for a construction-readiness blocker:

- unresolved public behavior or owner decision;
- missing governing requirement;
- unclear owning module/seam;
- mutually incompatible alternatives still open;
- absent red or green behavioral oracle;
- proposed parallel mechanism or forbidden scope expansion;
- evidence that the proposed construction is infeasible;
- security or irreversible choice that must precede construction.

Once behavior, owner, oracle, and scope are fixed, these are not plan blockers:

- exact helper/function/file names;
- exact fake arrays or fixture object literals;
- complete library call syntax;
- table-driven versus separate tests;
- which legal field calibrates an exact byte boundary;
- local algorithm choice inside the approved owning seam;
- implementation details that Apply judgment can decisively verify.

Those become apply obligations in `note`, not reasons to demand another prose rewrite.

## Complete-first and late-finding discipline

On its first non-converged plan verdict, Judge should enumerate all construction-readiness blockers discoverable from the supplied authority, plan, and current code.

On a later plan judgment, Judge checks those blockers. It may add a new plan blocker only when:

- the revision introduced a new contradiction; or
- genuinely new evidence proves the construction approach infeasible or changes a contract/owner decision.

A newly noticed fixture or implementation detail does not move the plan goalpost; it becomes an apply obligation.

This is not a numeric retry ceiling. A genuinely unresolved plan may iterate without limit.

## Authority freeze

Once Judge has accepted the governing authority:

- later plan judgment must not silently add public requirements;
- implementation risks default to apply obligations;
- a real contract change must be identified explicitly as an authority-level issue;
- fixture precision cannot mutate authority by attrition.

## Example

This is sufficient for construction readiness:

```text
Behavior:
Cross-leg request evidence contaminates a missing leg.

Owner:
Collector receipt's attempt-to-leg evidence join.

Red:
Two configured legs; only A has request/recovery evidence; B is missing.

Green:
B leg and B terminal report contain no A evidence IDs, while A evidence remains in the receipt root.

Scope:
Do not change request markers, terminal statuses, or the public receipt envelope.
```

Plan Judge may block if one of those facts is absent or contradictory. It should not block until the plan spells the exact IDs, fake arrays, or helper calls. Apply Judge must inspect whether the resulting test and implementation genuinely establish the oracle.

## Layering constraints

Follow the package's Soul discipline:

- only irreducible burden-of-proof judgment belongs in `souls/judge.md`;
- receipt fields and mechanical validity remain in schema/runtime;
- invocation examples belong in README;
- caller-specific process/topology belongs outside this package;
- do not add Judge CLI phase flags merely to encode a caller's workflow;
- do not duplicate a long review rubric across Soul, prompts, and docs.

The implementation should first decide whether the posture distinction is an irreducible Judge principle, a caller-supplied authority distinction, or a small combination. Soul must remain short.

## Acceptance criteria

- [ ] Judge can distinguish authority completeness, plan readiness, apply proof, and review adjudication from the material presented without new routing semantics.
- [ ] Plan readiness uses Behavior / Owner / Red / Green / Scope.
- [ ] Plan `converged` means construction authorization, not completed implementation proof.
- [ ] Plan blocking is limited to the construction-readiness law above.
- [ ] Implementation-local details can be carried as apply obligations in existing `note` without a new verdict state.
- [ ] Complete-first / late-finding discipline is defined without a numeric iteration ceiling.
- [ ] Authority freeze prevents later plan review from silently expanding requirements.
- [ ] Apply judgment remains strict and rejects implementations that fail exact real-seam or boundary evidence.
- [ ] Review finding adjudication remains independent from repair and routing.
- [ ] Existing `converged | continue | escalate` contract remains unchanged.
- [ ] Existing Judge singleton output, Soul-compliance audit, tool narrowing, fatal behavior, and caller independence remain unchanged.
- [ ] No orchestration, workflow DSL, next-role field, retry cap, generic finding classifier, or caller-specific topology is added.
- [ ] Soul review proves necessary judgment is present and implementation/process detail is absent.
- [ ] Tests or recorded role probes demonstrate both directions: unresolved contract/seam/oracle blocks, while fixture-mechanics-only objections do not block construction.

## Non-goals

- Weakening authority or apply review.
- Hiding genuine plan ambiguity.
- Limiting real design iteration by count.
- Having runtime classify prose objections mechanically.
- Encoding fixture pseudocode in Judge Soul.
- Specifying who invokes Judge or what role runs next.


---

# Issue #2: Institutional memory: judgment packets, development closure, probe lifecycle

URL: https://github.com/Akagilnc/ak-pi-workflow-roles/issues/2

Workshop learning currently lives in volatile places: the driver session (bounded, auto-compacts), `/tmp` probe files (lost on restart), and each fresh Judge (no memory — observed fresh instances paying an avoidable first-submission audit tax before relearning “evidence first”). Lessons must live where they are enforced, not where one session happens to remember them.

This issue owns **institutional-memory carriers for developing this roles package**. It does not define product orchestration, caller topology, stage transitions, or a workflow runtime.

The Judge plan-depth law is owned by #3. This issue consumes that law after #3 resolves its correct layer; it must not restate or independently mutate it.

## Tasks

- [ ] **1. Posture-aware judgment packet templates** (new `packets/` layer beside `souls/`, only if #3 confirms packet participation):
  - `judge-authority.md`
  - `judge-plan.md`
  - `judge-apply.md`
  - `judge-review.md`
  - `fixer-repair.md`

  Each template contains only an invariant dispatch skeleton: required artifact paths and digests, the relevant burden of proof, required evidence classes, and notice that Soul audit traces factual claims. It must not duplicate Soul text, implementation recipes, or caller routing.

  Evidence requirements vary by judgment posture:

  | Packet | Required evidence depth |
  |---|---|
  | `judge-authority` | authority clauses, decisions, counterexamples, artifact digest |
  | `judge-plan` | #3’s Behavior / Owner / Red / Green / Scope construction-readiness law; no implementation-fixture pseudocode |
  | `judge-apply` | live code/tests, `file:line` where applicable, real seam/probe evidence, committed artifact digest |
  | `judge-review` | each finding bound to authority, current code/facts, and reviewed-range digest |
  | `fixer-repair` | exact Judge-sustained repair scope and preserved non-goals; **mandated-item ledger (R#)** — see below |

  Guard-audit three-question evidence is required only when the judged change actually adds or approves a new guardrail.

  **Mandated-item ledger (`fixer-repair` only).** Evidence from the Collector repair line (2026-07-28): three consecutive post-fix rounds each caught approximate delivery — skipped matrix rows, similar-but-not-ordered cases substituted, one oracle omitted per row — and the Judge had to reconcile delivered-vs-ordered rows by hand each round. Mechanical reconciliation belongs at the receipt gate, not in a judgment seat:

  - the repair packet enumerates every mandated counterexample/row/oracle with a stable ID (`R1..Rn`); no mandated item may arrive only as prose;
  - the fixer receipt must carry a per-item disposition table: `R# → implemented(<test name>) | refused(<reason>)`;
  - the Soul audit rejects any receipt whose disposition table does not cover the packet's full `R#` set — approximate delivery bounces at submission, before any Judge round.

  This reuses the existing audit/receipt machinery; no new mechanism. (Same medicine that cured bare-`converged`: the cheapest path through the gate becomes literal compliance.) A blanket `file:line` requirement must not leak Apply burden into Authority/Plan judgment.

  Amendments are forward commits through the normal role-development closure. **Dependency:** do not finalize `judge-plan.md` before #3 determines whether the law belongs in Soul, packet, caller authority, or a small combination. **Acceptance:** a fresh Judge’s first evidence-complete submission passes Soul audit without requiring implementation detail before construction.

- [ ] **2. `docs/development-closure.md` contributor checklist** (not root `FLOW.md`): one-page description of how this repository’s maintainers close role construction. Include the canonical manual sequence, artifact preservation rules, and restart hygiene:
  - an accepted artifact is never discarded/redone without explicit disposition;
  - filenames must not claim verdicts (`approved` is a gate result, not a naming choice);
  - timeout guidance may vary by docket weight;
  - after restart/compaction, re-seed by reading the artifact trail before dispatching.

  The document must state explicitly that it is a contributor/dogfood playbook, is not packaged workflow authority, does not prescribe who calls a role, and creates no routing or next-role semantics.

- [ ] **3. Probe lifecycle law** (one concise paragraph in `CLAUDE.md`): probes are Judge drafts. After adjudication, each probe either graduates into a Fixer/Coder red regression test or dies; keeping both is duplicate shape. Sole exception: a bare-seam probe that exercises a seam ordinary tests cannot reach may graduate into `test/adjudication/` as a permanent regression. Do not retain volatile `/tmp` probes as institutional truth.

## Explicitly removed from this issue

`ak-flow` / stage machine / artifact-transition blocker / persisted flow-ledger work does not belong to `@ak/pi-workflow-roles`. The package remains caller- and topology-independent. If a real orchestrator or driver later demands that capability, it requires separate authority in the owning repository; this issue does not pre-create or defer-build it.

## Acceptance criteria

- [ ] #3 remains the single source for Plan Judge depth; this issue only consumes it.
- [ ] Packet names align with Authority / Plan / Apply / Review postures.
- [ ] Plan packets do not require Apply-level fixture or `file:line` proof.
- [ ] Apply/Review packets preserve exact evidence and digest sealing.
- [ ] `docs/development-closure.md` is clearly contributor-only and non-packaged as workflow authority.
- [ ] Probe lifecycle has one graduation path and no duplicate permanent shape.
- [ ] No stage machine, flow ledger, routing, next-role semantics, or workflow DSL enters this package.

Items 1–3 are file-only institutional-memory work. They should be implemented only after #3’s semantic decision is settled, so carrier and law do not drift apart.



---

# Issue #1: PRD: standalone 完成——任意 session 随手可调(通用法重写 + targetHead 绑定 + 判官门禁 + 测试重整)

URL: https://github.com/Akagilnc/ak-pi-workflow-roles/issues/1

## 完成线(task-list)

- [ ] 通用法重写:judge soul 换成自足通用裁决法,零外部机构引用(ADR 0005;随片删对 soul 散文的 grep 闸)
- [ ] 判官门禁:`--ak-role judge` 激活即工具名单收窄,写改类摘除(ADR 0008)
- [ ] live 验收 tracer:真 `pi` CLI + 真模型一发打穿(激活→soul 注入→判卷→审计→回执),env 开关、非 CI 门槛——「任意 session 随手可调」的字面验收
- [ ] 破坏性命令窄名单闸:`tool_call` 字面 denylist(`rm -rf`/`git reset --hard`/`git clean`/`git checkout --` 类),seatbelt 定性,永不长成语义分类器(ADR 0008 修正案,2026-07-27 rm-rf 实证拉动)

> 不切子票(owner 2026-07-27 裁定:仓内单热 session 顺流施工,票据管线跟不上分钟级开发循环)。做到即勾;流停后剩余项由接手者清尾。测试删并持续随流进行,交付时测试数净减或持平。

## Problem Statement

今天要让一个 session 按判官/修复工的纪律干活,调用方得自己拼装:soul 文件路径自己找、工具集自己收窄、交卷纪律靠散文自觉——每个调用方各拼一遍,拼错了没有任何机械拦截。判官现役 soul 是从上一代系统逐字搬来的,引用的机构(容器全局法文件、票据系统、台账)在本包世界不存在:判官照着不存在的法办案,合规审计员拿同一部幽灵法审案。

## Solution

装好本包后,任意 session 一个 flag 激活角色:soul 自动注入、门禁自动收窄、交卷只认具名 typed 工具、判词过 soul 合规审计才被接受。完成标准(owner 拍定):**任意 session 随手可调,不依赖任何特定调用方在场。**

## User Stories

1. 作为 session 操作者,我想用一个 flag(`--ak-role judge`)激活判官,以便不用手动拼 soul 路径和工具清单。
2. 作为 session 操作者,我想让判官只能经具名交卷工具交判词,以便散文口令永远不会被误当成裁决。
3. 作为评审流程所有者,我想让每份判词在被接受前过 soul 合规审计,以便不按法办案的判词出不了车间门。
4. 作为评审流程所有者,我想让审计打回时附上具名违规条目,以便判官当场改判重交而不是瞎猜。
5. 作为 session 操作者,我想让判官的 soul 是一部自足的通用裁决法,以便判官不会引用我环境里不存在的机构。
6. 作为评审流程所有者,我想让判官激活时写改类工具自动摘除,以便「不改码、不 commit」是拦得住的禁令而不是自觉。
7. 作为委托修复的操作者,我想让 fixer 以 plan 阶段先交规划,以便动刀前看到它要干什么。
8. 作为委托修复的操作者,我想让 fixer 经具名工具报告 planned/completed/refused,以便拒办是显式通道而不是沉默失败。
9. 作为委托修复的操作者,我想拿 git commit 当核查证据、拿角色报告当交卷,以便完成声明和客观证据互相对得上。
10. 作为 session 操作者,我想 `pi install` 本包后角色开箱即用,以便每台机器不用重复配置。
11. 作为评审流程所有者,我想让不认识的角色名在启动时响亮失败,以便配错角色不会静默变成裸 session。
12. 作为 session 操作者,我想在 README 看到每个角色的交卷契约(工具名+回执形状),以便不读源码就能消费回执。

## Implementation Decisions

权威 = 本仓 ADR 0001-0009(引用不复制)。剩余实施面见顶部 task-list。既有已实现契约维持不重做:fixer plan/apply 两阶段与 `planned/completed/refused` 薄信封(ADR 0003 修订版)、同模独立审计(ADR 0006)。重试一律复用 Pi 自身机制,包内零自建重试/刹车(ADR 0007)。targetHead 机械绑定闸 **deferred**(ADR 0004,owner 同日复裁:standalone 世界无绑定方,等第一个真实绑定方拉动;判官报告所判 head 属 soul 层要求)。交卷契约(每角:工具名、回执形状)文档化进 README。

## Testing Decisions

- 好测试 = 真实入口进、沿真实行为走、在外部可见结果上断言;mock 顶替真实调用是缺陷不是修复。
- **主缝 = 真链路集成缝**:Pi SDK 真 agent session + Pi 一等 faux provider 脚本化响应(prior art:本仓现有 package-entrypoint 集成测试)。剩余实施活的行为测试全骑此缝:激活后真 session 工具态收窄、新 soul 全文原样到达 provider 与审计员。
- **验收档 = live**:真 `pi` CLI + 真模型,env 开关控制、非 CI 门槛;phase 完成线。
- 存量手写假环境单测:凡集成缝已覆盖同一契约的删并(测试净增减原则);盯文闸不新增,存量 soul 文本 grep 闸随通用法重写删除(三态契约已由 schema 与集成测试在行为层钉死)。

## Out of Scope

- 任何编排/派发/拓扑(CONTEXT 法:角色永不派发 worker)。
- npm 发布与 LICENSE(等外部消费者拉动,ADR 0009)。
- 异模独立审计、审计重试帽、targetHead 绑定闸(已预见拉动点,ADR 0006/0007/0004)。
- 新角色(按 ADR 0001,等真实需求拉动)。

## Further Notes

ADR 包(0001-0009)与本 PRD 走设计评审闭环后,ADR Status 统一翻 accepted;评审态真源 = ADR Status。


---

