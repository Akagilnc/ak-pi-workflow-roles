# CONTEXT — @ak/pi-workflow-roles 词表

> 只放术语,零实现细节。决策的为什么在 `docs/adr/`。

- **角色(Role)**:soul + 角色门禁 + (可选)交卷工具组成的**车间内**治理单元。角色只管一个 Pi session 的内政,永不派发 worker、永不含编排拓扑。
- **Soul**:角色的法典,经系统提示注入。分两层:**通用法**(本包内,零业务词)与**业务法**(宿主项目 overlay,随调用附加)。
- **角色门禁(Role gating)**:车间内的机械限制——工具集收窄、工具调用拦截。区别于 soul 的文本约束:门禁是拦得住的,不靠自觉。
- **交卷工具(Submission tool)**:角色具名的 terminating 工具(`ak_<role>_output`)。**回执(Receipt)** = 其 typed 产物,是角色劳动成果的唯一法定出口;散文不构成交卷。并非每个角色都有交卷工具。
- **Judge(判官)**:只判卷、不改码、不 commit 的裁决角色。canonical 名;`verify` 是上一代编排器的席位旧名,**历史别名,退役中**。
- **Fixer(修复工)**:以 `plan`(只规划)或 `apply`(施工)阶段处理调用方提供的修理包的角色。经具名交卷工具报告 `planned`/`completed`/`refused`;git commit 是供调用方查证的客观证据,不是完整回执。
- **Coder(实现者)**:以 `plan`/`apply` 两阶段完成首次实现或据理拒绝派单的角色。apply 经 Pi 原生 `/skill:tdd` 调用 canonical Matt TDD;自查三连证据留在 report 供调用方处置,两者都不进入 Soul。Coder 回执不以新 commit 为无条件前提,拒绝可零 commit 直接交调用方处置。
- **Reviewer(评审者)**:围绕一个固定目标形成独立、可追溯代码评审的角色;不修复、不发布、不路由、不作最终裁决。经 Pi 原生 `/skill:code-review` 使用外部 canonical 方法,回执只表达 `completed` 或 `refused`,不表达批准、合并或流转语义。
- **Reviewer CMR**:保留给未来 AK CMR 跨模型 panel 的独立角色概念;当前未实现。Reviewer 使用 active model,不承诺跨模型多样性。
- **Collector(证据收集者)**:单次调用内独立观察外部 GitHub PR 评审腿、可选请求、判定收集终态并提交自包含回执的角色;不评审、不裁决、不修复、不路由,也没有“轮数”概念。v1 仅支持 `github.com`,无默认腿清单。
- **评审腿(Review leg)**:Reviewer 内部 `Agent` 形成的独立评审上下文;它不是角色派单或工作流边。Collector 的配置腿是外部 GitHub 作者集合,与 Reviewer 内部 Agent 腿不同。
- **Soul 合规审计(Soul-compliance audit)**:交卷被接受前的第二次模型调用,只审「判官是否可证地按 soul 办了案」,不得替换判官的实质裁决。
- **绑定(Binding)**:等待真实调用方拉动的未来机械校验能力。当前包既不提供 `targetHead` 绑定输入,也不提供对应的 fail-closed 绑定闸。
- **角色调用(Role invocation)**:一个角色从输入到回执的单次独立劳动。角色只拥有该次调用的内政;调用者拥有角色组合、顺序、重复次数、预算和停止条件。
- **编排器(Orchestrator)**:包外的交通系统——起各角色 Pi 进程、递材料、按三态判词走边。它只读回执,不定义交卷形状。
- **三态判词**:`converged` / `continue` / `escalate`。环境/工具链故障不是判词,以非零退出走故障通道。
- **裁类循环（Class-repair loop）**：由判词类字段、回执对账键、圈界参数三份合同自然组成的修理循环；次序是合同的推论，非规定流程。
- **Doctor(医生)**:从一个保留的 Pi 原生 session-dir 案例读取工厂症状，产出单案过程成本诊断并开方的举证角色;不施工、不裁决、不改法。病人仍是工厂,方子走正常法链。
- **工厂(Factory)**:车间整体——角色、闸、法、包模板、流程站点。医生的唯一病人;案子只是症状载体,永远不是病人。
- **方子(Prescription)**:医生的 finding 加处置建议(`keep|thin|delete`);治系统不治症状,同任何提案一样走法链。
- **真咬人(Real bite)**:某道闸最近真拦下东西的证据——dockets 里的实际 Receipt/verdict 引用;回声与散文不构成证据。完整有界检索得到的 `noRealBite` 是无咬人证明,不是一次咬人。
- **过程成本报告(Process-cost report)**:由保留 runs 路径中的 Pi session 字节可重算的单案调用数、腿数、墙钟、turn/token、工具调用、命名重试、typed 状态、commit 观察和具名 payload 字节账。趋势是读取多案后才有的独立输出类型。
