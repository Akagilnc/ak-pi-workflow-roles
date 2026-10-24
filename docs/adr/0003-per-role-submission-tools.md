# 每角具名交卷工具，契约真源归包

Status: accepted

本次选择每角具名交卷工具与包内单一契约真源；字段见 [交卷工具契约](../../src/package-contracts/terminating-tools.ts)，handler 与宿主终局的分工见 [CLAUDE.md 开篇](../../CLAUDE.md)。Fixer 阶段输入见 [ADR 0034](0034-required-worker-phase-inputs-remain.md)。Git commit 是给调用方核查的客观证据，不取代角色报告。所有具名交卷工具先完成交卷、由宿主结束本轮，再由流程起审核衙门；#1268 修订：pi 与 ACP 未绑定腿在收卷回话询问票号、本轮不即结束，宿主差异见 [README](../../README.zh-CN.md)。授权源卷 `~/.claude/projects/-Users-akagilnc-WorkSpace-ak-pi-workflow-roles/e4b50c8e-15c7-4c92-9263-959efadb24eb.jsonl`，owner uuid `10e3776f-235e-4db4-bafd-5a8dc62c66e7`、`1b53a288-921b-4cfc-9f04-5ca82433bddf`。审核通过直接过闸，不返回受审衙门；封驳则 resume 受审衙门重交，反复至各闸通过。上呈暂停，陛下答复后 resume 上呈衙门并走剩余闸。读不出审核结论的回送归属见 [ADR 0055](0055-shape-validation-failure-must-not-abort-the-run.md)，不在此另定义；交卷次数与终局仍适用仓内宪法。Commit SHA 证据对调用者是 advisory，不要求 Judge 必须产修包或必经 Judge。
