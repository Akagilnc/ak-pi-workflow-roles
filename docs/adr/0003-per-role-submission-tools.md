# 每角具名交卷工具，契约真源归包

Status: accepted

有交卷需求的角色各自拥有具名 terminating 工具（`ak_<role>_output`），不设全角色共用交卷工具；fixer 分 plan/apply 两阶段，Git commit 是给调用方核查的客观证据，不取代角色报告。交卷契约唯一真源在本包；具名工具的 schema 即回执契约，handler 只记录与排队、不校验形状、不判内容，审核结论原样回父席，读不出三态则 resume 说话者本人，工具可多次调用，终局由宿主结束。Commit SHA 证据对调用者是 advisory，不要求 Judge 必须产修包或必经 Judge。
