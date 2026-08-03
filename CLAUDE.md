# ak-pi-workflow-roles

## Soul 内容纪律

**Soul 是角色的注意力预算，不是完整说明书。** 单个 Soul 越长，核心原则越容易被字段说明、运行机制和任务细节稀释。默认删减；只保留角色做专业判断时不可缺少、且无法由更低层可靠表达的内容。

### 内容分层

| 内容 | 真源 |
| --- | --- |
| 角色不可约的职责、判断方法与专业原则 | Soul |
| 字段名称、类型、可选性和字段语义 | Tool / output schema |
| 唯一调用、非空、状态组合、终止和其他机械不变式 | TypeScript runtime |
| CLI 参数、安装方式和调用方使用说明 | README / CLI help |
| 特定任务方法、仓库惯例或业务规则 | Skill / host overlay |

不要在 Soul 中重复 schema、runtime、README 或宿主 overlay 已经拥有的内容。机械上能约束的规则优先机械化；只是 transport/API 说明的内容留在 schema；只对某个宿主成立的内容不得进入 bundled Soul。

### Soul 准入检查

向 Soul 增加一句话前，依次问：

1. 没有它，角色是否会缺失一项不可约的专业判断能力？
2. 它能否由 schema 或 runtime 更准确地表达或强制？
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

调用角色时使用 `pi --session-dir .ak/work/<issue>/runs/<invocation>/session`（不用 `--no-session`），stdout **须**丢到 `/dev/null`（stdout 流是无上限副本面，session 才是正本——2026-08-03 一条 med 腿 stdout 膨胀 137GB 实证；仪表挂 `stderr.log` 与 session 文件），`stderr.log` 和 `invocation.json` 留在同次 `runs/` 目录。

## 锚定宪法

**机器只咬契约，不咬呈现**：对自由文本的正则/措辞/表头机械依赖、对图像的像素机械依赖，视同缺陷；机器要消费的信息必须以键、typed 字段或 schema 提供。呈现为人服务，随时可重排。

**票面先过大理寺再开工；决策问题上呈 owner。**

丞相编排建议：御史台 findings 宜经大理寺裁决后再派修理腿（劾→判→修）。

没有绑定直接 owner 原话与明确 decision keys，不得标作 owner authority。

## 修订通道

Soul 与本文件（CLAUDE.md）的修订走 owner 直改通道（全文过目直落主线），不走工厂流程，且负持续精进义务；工厂只供修订素材，不拥有动笔权。
