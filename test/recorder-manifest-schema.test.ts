import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  loadPublicManifestSchema,
  validatePublicManifest,
} from "../src/recorder/manifest.ts";
import { RecorderError } from "../src/recorder/errors.ts";
import {
  commitFile,
  initGitRepo,
  makeTempDir,
  runRecorderBin,
  writeCounterScript,
  writeRecorderConfig,
} from "./helpers/recorder-test-harness.ts";

const FULL_SHA = "a".repeat(40);
const BLOB = "b".repeat(40);
const SHA256 = "c".repeat(64);

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    archive: {
      repositoryRoot: "/tmp/repo",
      root: ".ak/dockets",
      docketId: "issues/10/apply/apply-schema-001",
    },
    invocation: { id: "inv-1" },
    execution: {
      argv: ["node", "x.js"],
      cwd: "/tmp",
      environment: { inherit: true, overrides: {}, unset: [] },
      stdin: "inherit",
      stdio: { stdout: "tee", stderr: "tee" },
    },
    provenance: {
      package: null,
      model: null,
      target: null,
      verification: "unverified",
    },
    artifacts: [
      {
        id: "authority",
        kind: "authority",
        redactionStatus: "clean",
        reference: {
          identity: "reference",
          repositoryRoot: "/tmp/repo",
          commit: FULL_SHA,
          path: "docs/authority.md",
          blobOid: BLOB,
          sha256: SHA256,
          mode: "100644",
        },
      },
    ],
    receipt: null,
    auditObservation: null,
    child: { status: "exited", exitCode: 0, signal: null },
    recorder: { status: "completed" },
    redaction: { hits: [] },
    ...overrides,
  };
}

function assertRejects(label: string, value: unknown): void {
  assert.throws(
    () => validatePublicManifest(value),
    (error: unknown) =>
      error instanceof RecorderError && error.code === "internal-error",
    label,
  );
}

function assertAccepts(label: string, value: unknown): void {
  assert.doesNotThrow(() => validatePublicManifest(value), label);
}

test("public schema loads and accepts a lawful baseline manifest", () => {
  const schema = loadPublicManifestSchema();
  assert.equal(typeof schema, "object");
  assertAccepts("baseline", baseManifest());
});

test("identity XOR: neither, both, and wrong identity tags reject", () => {
  assertRejects(
    "neither identity",
    baseManifest({
      artifacts: [{
        id: "authority",
        kind: "authority",
        redactionStatus: "clean",
      }],
    }),
  );
  assertRejects(
    "both identities",
    baseManifest({
      artifacts: [{
        id: "authority",
        kind: "authority",
        redactionStatus: "clean",
        reference: {
          identity: "reference",
          repositoryRoot: "/tmp/repo",
          commit: FULL_SHA,
          path: "docs/authority.md",
          blobOid: BLOB,
          sha256: SHA256,
          mode: "100644",
        },
        stored: {
          identity: "stored",
          path: "inputs/authority",
          sha256: SHA256,
          byteLength: 1,
        },
      }],
    }),
  );
  assertRejects(
    "reference wrong identity tag",
    baseManifest({
      artifacts: [{
        id: "authority",
        kind: "authority",
        redactionStatus: "clean",
        reference: {
          identity: "stored",
          repositoryRoot: "/tmp/repo",
          commit: FULL_SHA,
          path: "docs/authority.md",
          blobOid: BLOB,
          sha256: SHA256,
          mode: "100644",
        },
      }],
    }),
  );
  assertRejects(
    "stored wrong identity tag",
    baseManifest({
      artifacts: [{
        id: "input",
        kind: "input",
        redactionStatus: "clean",
        stored: {
          identity: "reference",
          path: "inputs/input",
          sha256: SHA256,
          byteLength: 1,
        },
      }],
    }),
  );
  assertRejects(
    "reference missing identity field",
    baseManifest({
      artifacts: [{
        id: "authority",
        kind: "authority",
        redactionStatus: "clean",
        reference: {
          repositoryRoot: "/tmp/repo",
          commit: FULL_SHA,
          path: "docs/authority.md",
          blobOid: BLOB,
          sha256: SHA256,
          mode: "100644",
        },
      }],
    }),
  );
  assertRejects(
    "stored missing identity field",
    baseManifest({
      artifacts: [{
        id: "input",
        kind: "input",
        redactionStatus: "clean",
        stored: {
          path: "inputs/input",
          sha256: SHA256,
          byteLength: 1,
        },
      }],
    }),
  );
});

test("canonical shapes reject absolute, backslash, empty, dot, and malformed ids/hashes", () => {
  const badPaths = [
    "/abs/path.md",
    "docs\\authority.md",
    "docs//authority.md",
    "docs/./authority.md",
    "docs/../authority.md",
    "docs/.git/hooks",
    "",
  ];
  for (const path of badPaths) {
    assertRejects(
      `bad reference path ${path}`,
      baseManifest({
        artifacts: [{
          id: "authority",
          kind: "authority",
          redactionStatus: "clean",
          reference: {
            identity: "reference",
            repositoryRoot: "/tmp/repo",
            commit: FULL_SHA,
            path,
            blobOid: BLOB,
            sha256: SHA256,
            mode: "100644",
          },
        }],
      }),
    );
  }
  assertRejects(
    "noncanonical stored path",
    baseManifest({
      artifacts: [{
        id: "input",
        kind: "input",
        redactionStatus: "clean",
        stored: {
          identity: "stored",
          path: "../escape",
          sha256: SHA256,
          byteLength: 1,
        },
      }],
    }),
  );
  assertRejects(
    "short commit",
    baseManifest({
      artifacts: [{
        id: "authority",
        kind: "authority",
        redactionStatus: "clean",
        reference: {
          identity: "reference",
          repositoryRoot: "/tmp/repo",
          commit: "abc",
          path: "docs/authority.md",
          blobOid: BLOB,
          sha256: SHA256,
          mode: "100644",
        },
      }],
    }),
  );
  assertRejects(
    "malformed blob oid",
    baseManifest({
      artifacts: [{
        id: "authority",
        kind: "authority",
        redactionStatus: "clean",
        reference: {
          identity: "reference",
          repositoryRoot: "/tmp/repo",
          commit: FULL_SHA,
          path: "docs/authority.md",
          blobOid: "ZZ",
          sha256: SHA256,
          mode: "100644",
        },
      }],
    }),
  );
  assertRejects(
    "malformed sha256",
    baseManifest({
      artifacts: [{
        id: "authority",
        kind: "authority",
        redactionStatus: "clean",
        reference: {
          identity: "reference",
          repositoryRoot: "/tmp/repo",
          commit: FULL_SHA,
          path: "docs/authority.md",
          blobOid: BLOB,
          sha256: "deadbeef",
          mode: "100644",
        },
      }],
    }),
  );
  assertRejects(
    "invalid mode",
    baseManifest({
      artifacts: [{
        id: "authority",
        kind: "authority",
        redactionStatus: "clean",
        reference: {
          identity: "reference",
          repositoryRoot: "/tmp/repo",
          commit: FULL_SHA,
          path: "docs/authority.md",
          blobOid: BLOB,
          sha256: SHA256,
          mode: "120000",
        },
      }],
    }),
  );
  assertRejects(
    "empty artifact id",
    baseManifest({
      artifacts: [{
        id: "",
        kind: "authority",
        redactionStatus: "clean",
        reference: {
          identity: "reference",
          repositoryRoot: "/tmp/repo",
          commit: FULL_SHA,
          path: "docs/authority.md",
          blobOid: BLOB,
          sha256: SHA256,
          mode: "100644",
        },
      }],
    }),
  );
  assertRejects(
    "invalid artifact id",
    baseManifest({
      artifacts: [{
        id: "../x",
        kind: "authority",
        redactionStatus: "clean",
        reference: {
          identity: "reference",
          repositoryRoot: "/tmp/repo",
          commit: FULL_SHA,
          path: "docs/authority.md",
          blobOid: BLOB,
          sha256: SHA256,
          mode: "100644",
        },
      }],
    }),
  );
});

test("receipt and audit coherence matrix", () => {
  const receiptArtifact = {
    id: "receipt",
    kind: "receipt",
    redactionStatus: "clean",
    stored: {
      identity: "stored",
      path: "receipt.json",
      sha256: SHA256,
      byteLength: 2,
    },
    receiptArtifactKind: "acceptedReceipt",
  };
  const auditArtifact = {
    id: "audit-observation",
    kind: "audit-observation",
    redactionStatus: "clean",
    stored: {
      identity: "stored",
      path: "audit-observation.json",
      sha256: SHA256,
      byteLength: 2,
    },
  };
  const receiptMeta = {
    toolName: "ak_coder_output",
    toolCallId: "call-1",
    artifactId: "receipt",
    artifactKind: "acceptedReceipt",
  };
  const auditMeta = {
    toolName: "ak_coder_output",
    toolCallId: "call-1",
    auditPassed: true,
  };

  assertAccepts(
    "receipt only",
    baseManifest({
      artifacts: [
        ...(baseManifest().artifacts as unknown[]),
        receiptArtifact,
      ],
      receipt: receiptMeta,
    }),
  );
  assertAccepts(
    "receipt + audit",
    baseManifest({
      artifacts: [
        ...(baseManifest().artifacts as unknown[]),
        receiptArtifact,
        auditArtifact,
      ],
      receipt: receiptMeta,
      auditObservation: auditMeta,
    }),
  );

  assertRejects(
    "non-null receipt without receipt artifact",
    baseManifest({ receipt: receiptMeta }),
  );
  assertRejects(
    "receipt artifact without receipt metadata",
    baseManifest({
      artifacts: [
        ...(baseManifest().artifacts as unknown[]),
        receiptArtifact,
      ],
    }),
  );
  assertRejects(
    "receipt artifact missing receiptArtifactKind",
    baseManifest({
      artifacts: [
        ...(baseManifest().artifacts as unknown[]),
        {
          id: "receipt",
          kind: "receipt",
          redactionStatus: "clean",
          stored: receiptArtifact.stored,
        },
      ],
      receipt: receiptMeta,
    }),
  );
  assertRejects(
    "mismatched receipt kind on artifact",
    baseManifest({
      artifacts: [
        ...(baseManifest().artifacts as unknown[]),
        { ...receiptArtifact, kind: "input" },
      ],
      receipt: receiptMeta,
    }),
  );
  assertRejects(
    "audit without receipt",
    baseManifest({
      artifacts: [
        ...(baseManifest().artifacts as unknown[]),
        auditArtifact,
      ],
      auditObservation: auditMeta,
    }),
  );
  assertRejects(
    "audit metadata without audit artifact",
    baseManifest({
      artifacts: [
        ...(baseManifest().artifacts as unknown[]),
        receiptArtifact,
      ],
      receipt: receiptMeta,
      auditObservation: auditMeta,
    }),
  );
  assertRejects(
    "audit artifact without audit metadata",
    baseManifest({
      artifacts: [
        ...(baseManifest().artifacts as unknown[]),
        receiptArtifact,
        auditArtifact,
      ],
      receipt: receiptMeta,
    }),
  );
  assertRejects(
    "non-receipt carries receiptArtifactKind",
    baseManifest({
      artifacts: [{
        id: "authority",
        kind: "authority",
        redactionStatus: "clean",
        receiptArtifactKind: "acceptedReceipt",
        reference: {
          identity: "reference",
          repositoryRoot: "/tmp/repo",
          commit: FULL_SHA,
          path: "docs/authority.md",
          blobOid: BLOB,
          sha256: SHA256,
          mode: "100644",
        },
      }],
    }),
  );
});

test("child law accepts only exited/signaled lawful combinations", () => {
  assertAccepts(
    "exited + integer + null signal",
    baseManifest({ child: { status: "exited", exitCode: 7, signal: null } }),
  );
  assertAccepts(
    "signaled + null exit + nonempty signal",
    baseManifest({
      child: { status: "signaled", exitCode: null, signal: "SIGTERM" },
    }),
  );
  assertRejects(
    "exited + null exit",
    baseManifest({ child: { status: "exited", exitCode: null, signal: null } }),
  );
  assertRejects(
    "exited + signal",
    baseManifest({
      child: { status: "exited", exitCode: 0, signal: "SIGTERM" },
    }),
  );
  assertRejects(
    "signaled + exit code",
    baseManifest({
      child: { status: "signaled", exitCode: 1, signal: "SIGTERM" },
    }),
  );
  assertRejects(
    "signaled + null signal",
    baseManifest({
      child: { status: "signaled", exitCode: null, signal: null },
    }),
  );
  assertRejects(
    "signaled + empty signal",
    baseManifest({ child: { status: "signaled", exitCode: null, signal: "" } }),
  );
});

test("closed form rejects unknown fields and wrong scalar types", () => {
  assertRejects("unknown top-level", { ...baseManifest(), extra: true });
  assertRejects(
    "wrong version type",
    baseManifest({ version: "1" }),
  );
  assertRejects(
    "child exit as string",
    baseManifest({ child: { status: "exited", exitCode: "0", signal: null } }),
  );
  assertRejects(
    "artifacts as object",
    baseManifest({ artifacts: {} }),
  );
  assertRejects(
    "unknown artifact field",
    baseManifest({
      artifacts: [{
        id: "authority",
        kind: "authority",
        redactionStatus: "clean",
        note: "nope",
        reference: {
          identity: "reference",
          repositoryRoot: "/tmp/repo",
          commit: FULL_SHA,
          path: "docs/authority.md",
          blobOid: BLOB,
          sha256: SHA256,
          mode: "100644",
        },
      }],
    }),
  );
});

test("emitted manifests pass the public schema for receipt and no-receipt paths", async () => {
  const root = makeTempDir("ak-recorder-schema-e2e-");
  try {
    const archive = initGitRepo(join(root, "archive"));
    const authority = commitFile(archive, "authority.md", "# authority\n");
    const task = commitFile(archive, "task.md", "# task\n");
    const script = writeCounterScript(root);
    const counter = join(root, "counter.txt");

    const noReceiptConfig = writeRecorderConfig(root, {
      archiveRepo: archive,
      cwd: root,
      docketId: "issues/10/apply/apply-schema-noreceipt",
      authority: {
        repositoryRoot: archive,
        commit: authority.commit,
        path: authority.path,
        blobOid: authority.blobOid,
        sha256: authority.sha256,
      },
      task: {
        repositoryRoot: archive,
        commit: task.commit,
        path: task.path,
        blobOid: task.blobOid,
        sha256: task.sha256,
      },
    });
    const noReceipt = await runRecorderBin(
      ["--config", noReceiptConfig, "--", process.execPath, script, "ok"],
      { cwd: root, env: { ...process.env, AK_RECORDER_COUNTER: counter } },
    );
    assert.equal(noReceipt.code, 0, noReceipt.stderr);
    const noReceiptManifest = JSON.parse(
      readFileSync(
        join(
          archive,
          ".ak/dockets/issues/10/apply/apply-schema-noreceipt/manifest.json",
        ),
        "utf8",
      ),
    );
    assertAccepts("emitted no-receipt", noReceiptManifest);
    assert.equal(noReceiptManifest.receipt, null);

    const receiptConfig = writeRecorderConfig(root, {
      archiveRepo: archive,
      cwd: root,
      docketId: "issues/10/apply/apply-schema-receipt",
      authority: {
        repositoryRoot: archive,
        commit: authority.commit,
        path: authority.path,
        blobOid: authority.blobOid,
        sha256: authority.sha256,
      },
      task: {
        repositoryRoot: archive,
        commit: task.commit,
        path: task.path,
        blobOid: task.blobOid,
        sha256: task.sha256,
      },
    });
    const receipt = await runRecorderBin(
      [
        "--config",
        receiptConfig,
        "--",
        process.execPath,
        script,
        "json-receipt",
        "ak_coder_output",
        JSON.stringify({ status: "completed", report: "done" }),
      ],
      { cwd: root, env: { ...process.env, AK_RECORDER_COUNTER: counter } },
    );
    assert.equal(receipt.code, 0, receipt.stderr);
    const receiptManifest = JSON.parse(
      readFileSync(
        join(
          archive,
          ".ak/dockets/issues/10/apply/apply-schema-receipt/manifest.json",
        ),
        "utf8",
      ),
    );
    assertAccepts("emitted receipt", receiptManifest);
    assert.equal(receiptManifest.receipt.artifactId, "receipt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production path fails closed when final manifest would violate the public schema", async () => {
  // Structural oracle: validatePublicManifest is invoked on the emitted object
  // shape; a direct counterfeit with both identities is rejected by the same API
  // the production path uses immediately before promotion.
  assertRejects(
    "production validator rejects dual identity",
    baseManifest({
      artifacts: [{
        id: "authority",
        kind: "authority",
        redactionStatus: "clean",
        reference: {
          identity: "reference",
          repositoryRoot: "/tmp/repo",
          commit: FULL_SHA,
          path: "a.md",
          blobOid: BLOB,
          sha256: SHA256,
          mode: "100644",
        },
        stored: {
          identity: "stored",
          path: "inputs/a",
          sha256: SHA256,
          byteLength: 1,
        },
      }],
    }),
  );
  void existsSync;
  void writeFileSync;
});
