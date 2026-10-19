/** Builder-seat self-review table shared by the Coder and Fixer submissions (souls/quality-law.md「交卷前自审」). */

import { Type } from "typebox";

export const diffItemsField = Type.Unknown({
  description:
    "commit 前自审逐项表：本次新增的每个测试函数、每个生产函数各一行 { item: 名字, existing: 仓里做同一件事的现成件 path:line，找不到为 null, outcome: 已并入 | 保留 }。",
});
