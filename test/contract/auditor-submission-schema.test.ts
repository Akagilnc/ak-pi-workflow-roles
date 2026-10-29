import assert from "node:assert/strict";
import { test } from "vitest";
import { Value } from "typebox/value";

import { auditorSubmissionSchema } from "../../src/review-submission.ts";

// The auditor's complexity account: one mechanism row per added state / lock / cache / dependency line,
// in the inspector's two shapes, plus what the verdict said about that layer (or null).
test("auditor submission carries the complexity account with the verdict's words per layer", () => {
  const face = { status: "continue" };
  const deleteRow = {
    where: "ming/ledger/__init__.py:236",
    keeps: "read_results: LRUCache(10000) 跨提交保留读结果及依赖集",
    layer: 5,
    official: "eventsourcing https://eventsourcing.readthedocs.io/en/stable/topics/examples/fts-content-management.html 读派生表直接 execute，不缓存结果",
    disposition: "删：示范不带这一层也处理得了",
    judgeSaid: null,
  };
  const keepRow = {
    where: "ming/ledger/__init__.py:231",
    keeps: "AGGREGATE_CACHE_FASTFORWARD；eventsourcing application 页示范里就带这一项",
    layer: 3,
    official: null,
    disposition: "留：示范本身就为同一关切带同样的层",
    judgeSaid: "聚合缓存沿用框架设置",
  };
  assert.equal(Value.Check(auditorSubmissionSchema as never, { ...face, mechanisms: [deleteRow, keepRow] }), true);
  assert.equal(Value.Check(auditorSubmissionSchema as never, { ...face, mechanisms: [] }), true);
  // The table is required; a row without the verdict's words is no row; the two shapes stay coupled.
  assert.equal(Value.Check(auditorSubmissionSchema as never, face), false);
  const { judgeSaid: _dropped, ...withoutJudge } = deleteRow;
  assert.equal(Value.Check(auditorSubmissionSchema as never, { ...face, mechanisms: [withoutJudge] }), false);
  assert.equal(Value.Check(auditorSubmissionSchema as never, { ...face, mechanisms: [{ ...deleteRow, official: null }] }), false);
});
