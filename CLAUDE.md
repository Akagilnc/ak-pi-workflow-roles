# ak-pi-workflow-roles

## 0. 代码零拒收裁量

**代码对角色交上来的东西没有拒收权。** 不得因数组性、非空、字段全集、跨字段组合、字段名拼写而拒收；**不得因形状不合中止本局**。形状是否可读、语义是否成立，归语义审计（审刑院）与调用者。

**本条只约束代码。** 审刑院、大理寺等 LLM 角色对同样内容做检查、据以打回，**不在本条禁止之列**——那是它们的职掌。角色打回走既有的重交通道（错误回喂、角色自改），不掐局；代码的形状拒收才是本条所禁。

**schema 与 prompt 里对字段的声明是「要求」，不是「必须」。** 要求负责告诉角色该把什么写在哪，让内容分类、不堆一处；它**不授权代码在自己这一侧强制检查**。key 名字不必逐字相同（`fix.summary` / `fixSummary` / `fix summary` 一律合法），合不合格由审刑院判——**判准是读不读得懂**，读得懂就放行；要紧的是内容是否符合事实，不是键名是否一模一样。审刑院打回时可以建议 key 名字。

**读取与呈现不设上限。** 代码可以读任意字段、可以落账、可以渲染、可以对账。本条限制的是「因什么拒收或中止」，不是「能读什么」。

**代码仍拥有两件事**：受理**唯一一次**交卷，并在交卷后**终止本局**（与下方内容分层表「唯一调用与终止 → TypeScript runtime」同指）。

**记账位**：每份角色输出有且只有一个精确 key 及取值域（如 `judgeStatus`），供落账、呈现与渲染分支。它不是编排控制流——代码不据此决定派谁，角色顺序归调用者（ADR 0010）。判定其有效性仍归 ADR 0040；本条只禁一件事：**不得因其缺失、拼错或取值域外而中止本局**。该情形下原样落账、在终局结果中显式呈现「未判」、交调用者处置。

**不在本条射程的保留项（判据；本条是该判据的唯一真源，其它文件只引用、不另列名单）**：① 凡各 ADR 自述为 ADR 0036 特别理由保留例外者（可机械 grep）；② 另有独立 authority 的保留裁定——因其不援引 0036、机械捞不到，故举例具名：ADR 0018 的激活闸、ADR 0023 的 runtime 行为验证、ADR 0041 的 sole final call。**两支均以各 ADR 自述为准，施工前逐条复核；举例不是穷举。** 这些属语义或现场事实核验，非形状校验；其失败按失败诚实宪法与 ADR 0052 走响亮终结，不得静默放行。

「输入输出只验证必须有的」真源在 ADR 0025 / 0036，本条不复述、不加严。删与留之争按 CONTEXT.md「承接者判据」裁。

**下一个读它的是角色，不是代码。** 角色读得懂散文，读得懂写歪的 JSON，读得懂塞在字符串里的数组。读不懂的只有一份因形状不合而根本没被交出来的判词。

## 全局宪法（先读）

本机全局规则在 `~/.claude/CLAUDE.md`（与 `~/.codex/AGENTS.md` byte-identical）。**pi session 默认不读全局 CLAUDE.md / AGENTS.md**——凡在本仓工作的 agent（含 pi 起的角色腿与驱动 session），视全局文件为本文件的一部分，开工先读。


## Soul 内容纪律

**Soul 是角色的注意力预算，不是完整说明书。** 单个 Soul 越长，核心原则越容易被字段说明、运行机制和任务细节稀释。默认删减；只保留角色做专业判断时不可缺少、且无法由更低层可靠表达的内容。

### 内容分层

| 内容 | 真源 |
| --- | --- |
| 角色不可约的职责、判断方法与专业原则 | Soul |
| 字段名称、类型、可选性和字段语义 | Tool / output schema |
| 唯一调用与终止 | TypeScript runtime |
| CLI 参数、安装方式和调用方使用说明 | README / CLI help |
| 特定任务方法、仓库惯例或业务规则 | Skill / host overlay |

不要在 Soul 中重复 schema、runtime、README 或宿主 overlay 已经拥有的内容。只是 transport/API 说明的内容留在 schema；只对某个宿主成立的内容不得进入 bundled Soul。

### Soul 准入检查

向 Soul 增加一句话前，依次问：

1. 没有它，角色是否会缺失一项不可约的专业判断能力？
2. 它能否由 schema 或 runtime **合法且**更准确地表达或强制？（第 0 条禁止的形状拒收不算「能」）
3. 它是否只是字段、CLI、transport、阶段装配或错误处理说明？
4. 它是否只属于某个任务、仓库或业务域？
5. 能否删除、合并或缩成更短的原则而不损失角色能力？

只有第 1 题为“是”，且第 2–4 题为“否”时，内容才应进入 bundled Soul。第 5 题始终优先选择更短版本。

### 修改要求

- 新增或修改角色能力时，同时审计 Soul 是否被实现细节污染。
- 增加 schema 字段不自动意味着增加 Soul 条文。
- 增加阶段或调用方式不自动意味着复制一套角色方法。
- 发现同一规则跨 Soul/schema/runtime/README 重复时，保留在拥有该语义的最深层，其余删除或只留必要引用。
- Soul review 必须检查两件事：必要原则是否缺失，以及非 Soul 内容是否混入。
- 角色模块内出现生命周期代码即缺陷——激活归共享信封独家拥有（ADR 0018）。

## Probe lifecycle

A probe is temporary evidence. After its evidence purpose is disposed, either delete it or graduate its behavior exactly once into the regression suite owned by the affected seam, then delete the scratch copy. Only a bare-seam probe that ordinary tests cannot reach may remain under `test/adjudication/`. Do not keep duplicate permanent shapes of the same probe behavior.

## 失败诚实宪法

**接住可以，洗白不行**：未识别异常不得冒用具体标签；真因必须落痕；catch 后照常继续视同缺陷，除非「此失败下继续」是文档化契约。

## Role invocation evidence

调用角色时使用 `pi --session-dir ~/.ak-roles/books/<主仓目录名>/issues/<issue>/runs/<invocation>@<源树>/session`（session 直落机器账本之家，ADR 0048——仓工作树内不再落卷宗；#11 launcher 落地后此路径由机器自算。不用 `--no-session`），stdin **须**以 `</dev/null` 封死（pi 启动会将非 TTY stdin 读到 EOF 才干活，未封死的后台管道=永久停车，README 点火第 2 步 / upstream pi#2078），stdout **须**丢到 `/dev/null`（stdout 流是无上限副本面，session 才是正本——2026-08-03 一条 med 腿 stdout 膨胀 137GB 实证；仪表挂 `stderr.log` 与 session 文件），`stderr.log` 和 `invocation.json` 留在家中同次 `runs/` 目录。

## 锚定宪法

**机器只咬契约，不咬呈现**：对自由文本的正则/措辞/表头机械依赖、对图像的像素机械依赖，视同缺陷；机器要消费的信息必须以键、typed 字段或 schema 提供。呈现为人服务，随时可重排。

**票面先过大理寺再开工；决策问题上呈陛下。**

丞相编排建议：御史台 findings 宜经大理寺裁决后再派修理腿（劾→判→修）。

没有绑定直接陛下原话与明确 decision keys，不得标作陛下 authority。

## 修订通道

Soul 与本文件（CLAUDE.md）的修订走陛下直改通道（全文过目直落主线），不走工厂流程，且负持续精进义务；工厂只供修订素材，不拥有动笔权。
