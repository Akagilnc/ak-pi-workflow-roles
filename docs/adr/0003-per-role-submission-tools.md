# 每角具名交卷工具，契约真源归包

Status: accepted

fixer 分 plan/apply 两阶段，Git commit 是给调用方核查的客观证据，不取代角色报告。交卷契约唯一真源在本包；具名工具的 schema 即回执契约，handler 只记录与排队、不校验形状、不判内容。所有具名交卷工具先完成交卷、结束调用，再由流程起审核衙门；审核通过直接过闸，不返回受审衙门；封驳则 resume 受审衙门重交，反复至各闸通过。上呈暂停，陛下答复后 resume 上呈衙门并走剩余闸。读不出三态则 resume 说话者本人，工具可多次调用，终局由宿主结束。Commit SHA 证据对调用者是 advisory，不要求 Judge 必须产修包或必经 Judge。
