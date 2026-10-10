# 未完终态报事实不报诊断

Status: accepted

本次增设 worker 的 `unfinished`，用来陈述本次调用未结清，而不是诊断到调用者之外的处置；选用 status 表达而非新增 blocker cause。状态、理由与剩余范围声明由 [Coder](../../src/package-contracts/worker-output.ts)／[Fixer 输出契约](../../src/package-contracts/fixer-output.ts) 承接，本页不平行维护字段合同。provider/工具/runtime 故障仍以非零退出结束，不得表达为 unfinished。工具故障非零终局不得涵盖已交回存活席位的外包引擎失败（#1213 澄清：外包失败沿同席结果通道交回，不升格为宿主/席位终止）。审刑院判准与 Fixer Soul 冲突句须同批适应「有没有说实话」；#1132 将缺理由催全纳入统一配置上限（owner `9d824bfb-78de-41d2-9bdc-802e5f29f24f` 改定 B）；现行催全与用尽处置见 [worker 交卷接缝](../../src/worker-submission-gates.ts)，配置字段见 [公开配置](../../src/public-cli/config.ts)。
