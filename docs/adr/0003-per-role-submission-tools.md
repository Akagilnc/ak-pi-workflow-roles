# 0003 — 每角具名交卷工具,契约真源归包

Status: proposed(owner 2026-07-27 grill 拍定;评审闭环后转 accepted)
Date: 2026-07-27

有交卷需求的角色各自拥有具名 terminating 工具(`ak_<role>_output`,如 `ak_judge_output`),不设全角色共用的通用交卷工具;并非每个角色都交卷(fixer 的回执是 git forward commit)。交卷契约(工具名 + 回执 schema)的唯一真源在本包;编排器只读回执,不在运行期定义任何交卷形状。
