# Issue #1: PRD: standalone 完成——任意 session 随手可调(通用法重写 + targetHead 绑定 + 判官门禁 + 测试重整)

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

