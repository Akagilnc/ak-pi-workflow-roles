# 0009 — 最小工程面:git 分发,npm/LICENSE 等拉动

Status: proposed(owner 2026-07-27 grill 拍定;评审闭环后转 accepted)
Date: 2026-07-27

建 GitHub private remote 并保持推送——备份(无备份单盘产出是不会响的失败)、线上评审闭环与 `pi install git:` 分发的共同前提;CI 只跑 `npm test` + `typecheck`。分发形态 = `pi install git:<repo>@<ref>` 或本地路径,**不发 npm**:npm 发布与 LICENSE 等第一个外部消费者拉动。版本耦合纪律记方向不建机制:phase-2 编排器接入时以 git ref pin 包版本,并以双侧契约 tracer 测试钉住交卷契约。
