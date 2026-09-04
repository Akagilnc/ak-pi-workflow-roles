# ak-pi-workflow-roles

## 0. 代码拒收裁量

**代码对角色交上来的东西没有拒收权，也不得因形状不合中止本局**

**审刑院、大理寺等 LLM 角色**不在本条禁止之列，角色打回走重交通道，不掐局。

**「要求 X」不是授权代码检查 X**——ADR、schema、prompt 一律如此。主语是代码、动词是拒收或中止的句子才是检查。漏了由下游角色在内容层找他麻烦。key 名字不必逐字相同。

**读取与呈现不设上限**：代码可以读任意字段。代码仍拥有两件事：受理**唯一一次**交卷，交卷后**终止本局**。

**记账位**：每份角色输出有精确 key 及取值域（如 `judgeStatus`），供落账与呈现。

## 全局宪法（先读）

**个人全局规则在场即为法**（陛下 2026-08-24 拍）：用户的全局规则文件（本机为 `~/.claude/CLAUDE.md`；其**共享硬规块**与 `~/.codex/AGENTS.md` 同块 byte-identical——两文件整体并不相同）在场即适用。**pi session 默认不读它们**——凡在本仓工作的 agent（含 pi 起的角色腿与驱动 session），视其为本文件的一部分，开工先读、主动去扫。本包是公开 npm 包，不得把任何用户本地文件当运行前提：不在场不报错，在场即法。


## 法源优先

各 ADR 已落定的具体决策，在本仓优先于宪法的通用条文；其中违反宪法者，须绑陛下原话与 decision key。

## Commit 前缀法（2026-08-10 陛下拍定；2026-08-24 陛下勘明两轨）

前缀＝真实产者署名：**工厂腿**的提交一律冠 `ak-roles:` 在最前；**陛下直改通道／驱动 session** 的提交冠其真实平台前缀（如 `claude:`）。署非产者＝假 provenance，即缺陷。

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
- 角色模块内出现生命周期代码即缺陷——生命周期取广义，不限于角色自身激活：子进程/子会话的目录、配置、socket、进程桥、spawn、中止与清理同属生命周期；一律归注册席共享信封与共享执行接缝独家拥有，角色模块至多保留 label、soul、证据组装、决定工具与结果投影（ADR 0018；广义口径陛下 2026-08-10 拍定）。

## Probe lifecycle

A probe is temporary evidence. After its evidence purpose is disposed, either delete it or graduate its behavior exactly once into the regression suite owned by the affected seam, then delete the scratch copy. Only a bare-seam probe that ordinary tests cannot reach may remain under `test/adjudication/`. Do not keep duplicate permanent shapes of the same probe behavior.

## 失败诚实宪法

**接住可以，洗白不行**：未识别异常不得冒用具体标签；真因必须落痕；catch 后照常继续视同缺陷，除非「此失败下继续」是文档化契约。

## Role invocation evidence

调用角色时使用 `pi --session-dir ~/.ak-roles/books/<主仓目录名>/issues/<issue>/runs/<invocation>@<源树>/session`（session 直落机器账本之家，ADR 0048——仓工作树内不再落卷宗；#11 launcher 落地后此路径由机器自算。不用 `--no-session`），stdin **须**以 `</dev/null` 封死（pi 启动会将非 TTY stdin 读到 EOF 才干活，未封死的后台管道=永久停车，README 点火第 2 步 / upstream pi#2078），stdout **须**丢到 `/dev/null`（stdout 流是无上限副本面，session 才是正本——2026-08-03 一条 med 腿 stdout 膨胀 137GB 实证；仪表挂 `stderr.log` 与 session 文件），`stderr.log` 和 `invocation.json` 留在家中同次 `runs/` 目录。

## 锚定宪法

**机器只咬契约，不咬呈现**：对自由文本的正则/措辞/表头机械依赖、对图像的像素机械依赖，视同缺陷；机器要消费的信息必须以键、typed 字段或 schema 提供。呈现为人服务，随时可重排。

**生产与统计两个 regime（陛下 2026-08-25 释宪）**：上条禁令的对象是生产代码对不可穷举输入的机械依赖。统计/分析对**已冻结卷宗**不适用该禁令——太史报告层可由 LLM 做语义分类与统计，逐条附卷宗引证即为可核；形式语言命令（shell 等）非散文，不因 LLM 书写而成「自由文本」。太史代码机制维持确定性（ADR 0047/0068 不动）；闸判据仍只认 typed 键。报告引证同符宝郎证据条款：**指针（runId/toolCallId/路径）即合格引用，开卷核对相符即成立，不誊原文进报告**——卷宗是唯一真源，复印副本违 DRY；举证到问题所需粒度为止，汇总申报方法与判据即可，不逐条立账。

**票面先过给事中再开工；决策问题上呈陛下。**（ADR 0074：票庭审读由大理寺移交门下省给事中。）

丞相编排建议：御史台 findings 宜经大理寺裁决后再派修理腿（劾→判→修）。

没有绑定直接陛下原话与明确 decision keys，不得标作陛下 authority。

## 修订通道

Soul 与本文件（CLAUDE.md）的内容修订走陛下直批通道：最终文字须经陛下过目确定，且负持续精进义务；工厂在未获陛下授权（内容确定）前不得改动，获授权后可由工厂腿落笔，谁写的不是要件。
