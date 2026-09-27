import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
import assert from "node:assert/strict";
import { isAbsolute, resolve } from "node:path";
import test from "node:test";
import { Value } from "typebox/value";

import {
  ActivationLedgerError,
  resolveActivationLedgerHome,
  writeActivationTraceRecord,
} from "../../src/role-runtime.ts";
import { activationTraceRecordSchema } from "../../src/activation-trace.ts";

test("resolved ledger home rejects relative process home (pure path math)", () => {
  for (const relativeHome of [".", "relative-home", ""] as const) {
    assert.throws(
      () => resolveActivationLedgerHome(relativeHome),
      (error: unknown) => {
        assert.ok(error instanceof ActivationLedgerError);
        assert.equal(error.code, "AK_ACTIVATION_LEDGER");
        return true;
      },
    );
  }

  const absoluteHome = worktreeTempPrefix("ak-ledger-abs-home");
  const ledgerHome = resolveActivationLedgerHome(absoluteHome);
  assert.equal(isAbsolute(ledgerHome), true);
  assert.equal(ledgerHome, resolve(absoluteHome, ".ak-roles"));
});

function assertRetryingJsonlWriter(input: {
  write: (record: never, writeSync: typeof import("node:fs").writeSync) => void;
  record: unknown;
  schema: unknown;
  chunkSize: number;
  expectedFd?: number;
}): void {
  const chunks: Buffer[] = [];
  let calls = 0;
  input.write(
    input.record as never,
    ((_fd: number, buffer: Uint8Array, offset: number, length: number) => {
      if (input.expectedFd !== undefined) assert.equal(_fd, input.expectedFd);
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("busy"), { code: "EAGAIN" });
      const count = Math.min(input.chunkSize, length);
      chunks.push(Buffer.from(buffer.subarray(offset, offset + count)));
      return count;
    }) as typeof import("node:fs").writeSync,
  );
  const line = Buffer.concat(chunks).toString();
  assert.equal(line.endsWith("\n"), true);
  assert.equal(Value.Check(input.schema as never, JSON.parse(line)), true);
  assert.ok(calls > 2);
}

test("default trace writer retries short writes and writes schema-valid records", () => {
  assertRetryingJsonlWriter({
    write: writeActivationTraceRecord as never,
    record: { role: "judge", stageId: "load", status: "failed", timestamp: "2025-01-01T00:00:00.000Z", cause: { identity: "Error", name: "Error", message: "failed" } },
    schema: activationTraceRecordSchema,
    chunkSize: 7,
  });
});
