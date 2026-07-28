# 0003 — 每角具名交卷工具,契约真源归包

Status: accepted
Date: 2026-07-27

有交卷需求的角色各自拥有具名 terminating 工具(`ak_<role>_output`),不设全角色共用的通用交卷工具。judge 用 `ak_judge_output`;fixer 因为既可规划、施工也可抗辩,用 `ak_fixer_output` 交统一薄信封。fixer 分 `plan`/`apply` 两个显式调用阶段,没有第三阶段。Git commit 是供调用方核查的客观证据,不取代 fixer 对 `planned`/`completed`/`refused` 的角色报告。交卷契约(工具名 + 回执 schema)的唯一真源在本包;包外调用方只读和转运,不在运行期定义任何交卷形状。

> **Supersession (accepted ADR 0010, owner 2026-07-28):** the earlier “供判官核查” consumer wording is superseded. Commit SHA evidence is advisory for the **caller**; Judge authorship of the repair packet and mandatory next-hop to Judge are not package requirements. The rest of this ADR remains `accepted`, subject to ADR 0010's explicit supersession.
