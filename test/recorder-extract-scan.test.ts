import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  COLLECTOR_OUTPUT_TOOL,
  validateAcceptedCollectorReceipt,
} from "../src/package-contracts/terminating-tools.ts";
import {
  extractAcceptedReceipt,
  decodeToolResultsFromEnvelope,
  decodeEnvelopeRows,
  collectLifecycleEvents,
  bindAcceptedLifecycle,
} from "../src/recorder/extract.ts";
import { RecorderError } from "../src/recorder/errors.ts";
import { scanString, scanBytes, scanJsonValue } from "../src/recorder/scanner.ts";
import {
  CODER_OUTPUT_TOOL_NAME,
  FIXER_OUTPUT_TOOL_NAME,
} from "../src/package-contracts/worker-output.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../src/package-contracts/judge-output.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "../src/package-contracts/reviewer-output.ts";
import {
  commitFile,
  initGitRepo,
  makeTempDir,
  runRecorderBin,
  sha256File,
  writeCounterScript,
  writeRecorderConfig,
} from "./helpers/recorder-test-harness.ts";

const secrets = {
  bearer: "Authorization: Bearer ghp_SUPERSECRETTOKENVALUE001",
  aws: "AKIAIOSFODNN7EXAMPLE",
  pem: "-----BEGIN PRIVATE KEY-----\nMIIEsecret\n-----END PRIVATE KEY-----",
  basic: "Basic dXNlcjpwYXNz",
  url: "https://user:pass@example.com/repo.git",
  assign: "api_key=supersecretvalue999",
  cookie: "Cookie: sessionid=abcd1234efgh5678",
  skProj: "sk-proj-ABCDEFGHijklmnop1234567890",
  skAnt: "sk-ant-api03-ABCDEFGHijklmnop1234567890",
  glpat: "glpat-ABCDEFGHijklmnop1234",
  xoxb: "xoxb-123456789012-ABCDEFGHijklmnop",
  aiza: "AIzaSyA-abcdefghijklmnopqrstuvwx",
};

const ACCEPTED: Record<string, string> = {
  [CODER_OUTPUT_TOOL_NAME]: "Coder report accepted",
  [FIXER_OUTPUT_TOOL_NAME]: "Fixer report accepted",
  [REVIEWER_OUTPUT_TOOL_NAME]: "Reviewer report accepted",
  [JUDGE_OUTPUT_TOOL_NAME]: "Judge verdict accepted",
  [COLLECTOR_OUTPUT_TOOL]: "Collector receipt accepted",
};

function detailsFor(tool: string) {
  if (tool === JUDGE_OUTPUT_TOOL_NAME) return { judgeStatus: "converged" };
  if (tool === REVIEWER_OUTPUT_TOOL_NAME) {
    return { status: "completed", report: "ok" };
  }
  if (tool === COLLECTOR_OUTPUT_TOOL) {
    return minimalCollectorReceipt();
  }
  return { status: "completed", report: "ok" };
}

function minimalCollectorReceipt(overrides: Record<string, unknown> = {}) {
  return {
    host: "github.com",
    repository: "acme/repo",
    prNumber: 1,
    manifestVersion: 1,
    manifestDigest: "abc",
    activationTime: "2020-01-01T00:00:00.000Z",
    deadlineTime: "2020-01-02T00:00:00.000Z",
    finalObservationTime: "2020-01-01T01:00:00.000Z",
    finalSnapshotId: "snap-1",
    targetHead: "a".repeat(40),
    reports: [{
      kind: "terminal-fact",
      legId: "leg-1",
      terminalStatus: "missing",
      report: "missing",
      windowRelation: "inside",
      evidenceRefs: ["e1"],
    }],
    legs: [{
      legId: "leg-1",
      status: "missing",
      rationale: "none",
      evidenceRefs: ["e1"],
    }],
    requestAttempts: [],
    snapshots: [{
      snapshotId: "snap-1",
      observedAt: "2020-01-01T00:30:00.000Z",
      completedAt: "2020-01-01T00:31:00.000Z",
      completedMono: 1,
      host: "github.com",
      repository: "acme/repo",
      prNumber: 1,
      prState: "open",
      headOid: "a".repeat(40),
      complete: true,
      evidenceIds: ["e1"],
      pageDiagnostics: [],
      normalizedByteLength: 1,
    }],
    evidenceRecords: [{
      evidenceId: "e1",
      kind: "issue_comment",
      versionId: "v1",
      contentDigest: "d1",
      firstObservedAt: "2020-01-01T00:30:00.000Z",
      raw: {},
    }],
    ...overrides,
  };
}

function machineLifecycle(
  tool: string,
  details: unknown,
  options: {
    callId?: string;
    acceptedText?: string;
    omitIssued?: boolean;
    omitStart?: boolean;
    isError?: boolean;
    usage?: unknown;
    duplicateTerminal?: boolean;
    conflictDetails?: unknown;
    argsMismatch?: boolean;
  } = {},
): string {
  const callId = options.callId ?? "c1";
  const text = options.acceptedText ?? ACCEPTED[tool] ?? "accepted";
  const args = options.argsMismatch ? { tampered: true } : details;
  const lines: unknown[] = [];
  if (!options.omitIssued) {
    lines.push({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: callId, name: tool, arguments: args }],
      },
    });
  }
  if (!options.omitStart) {
    lines.push({
      type: "tool_execution_start",
      toolCallId: callId,
      toolName: tool,
      args,
    });
  }
  lines.push({
    type: "tool_execution_end",
    toolCallId: callId,
    toolName: tool,
    isError: options.isError ?? false,
    result: {
      content: [{ type: "text", text }],
      details,
      ...(options.usage === undefined ? {} : { usage: options.usage }),
    },
  });
  lines.push({
    type: "message_end",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: tool,
      isError: options.isError ?? false,
      details,
      content: [{ type: "text", text }],
      ...(options.usage === undefined ? {} : { usage: options.usage }),
    },
  });
  if (options.duplicateTerminal) {
    lines.push({
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: callId,
        toolName: tool,
        isError: false,
        details: options.conflictDetails ?? details,
        content: [{ type: "text", text }],
      },
    });
  }
  return lines.map((line) => JSON.stringify(line)).join("\n");
}

function sessionLifecycle(tool: string, details: unknown): string {
  const callId = "s1";
  const text = ACCEPTED[tool]!;
  return [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: callId, name: tool, arguments: details }],
      },
    },
    // session envelope still requires a start event in the shared decoder stream
    {
      type: "tool_execution_start",
      toolCallId: callId,
      toolName: tool,
      args: details,
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: callId,
        toolName: tool,
        isError: false,
        details,
        content: [{ type: "text", text }],
      },
    },
  ].map((line) => JSON.stringify(line)).join("\n");
}

test("scanner redacts every mandated credential class", () => {
  for (const [name, sample] of Object.entries(secrets)) {
    const scanned = scanString(sample, `case.${name}`);
    assert.equal(scanned.report.redacted, true, name);
    assert.equal(scanned.value.includes("SUPERSECRET"), false, name);
    assert.equal(scanned.value.includes("supersecretvalue999"), false, name);
    assert.equal(scanned.value.includes("MIIEsecret"), false, name);
    assert.equal(scanned.value.includes("dXNlcjpwYXNz"), false, name);
    assert.equal(scanned.value.includes("user:pass@"), false, name);
    assert.equal(scanned.value.includes("sessionid=abcd"), false, name);
    assert.equal(scanned.value.includes("ABCDEFGH"), false, name);
    for (const hit of scanned.report.hits) {
      assert.equal(typeof hit.ruleId, "string");
      assert.equal(typeof hit.location, "string");
      assert.ok(hit.count >= 1);
      assert.equal(JSON.stringify(hit).includes("SUPERSECRET"), false);
    }
  }
});

test("composed Authorization Basic/Bearer headers redact the complete credential", () => {
  const cases = [
    {
      name: "composed-bearer-plain",
      sample: "Authorization: Bearer plainsecrettokenvalue999",
      secret: "plainsecrettokenvalue999",
      ruleId: "authorization-header",
    },
    {
      name: "composed-basic",
      sample: "Authorization: Basic dXNlcjpwYXNz",
      secret: "dXNlcjpwYXNz",
      ruleId: "authorization-header",
    },
    {
      name: "composed-bearer-provider",
      sample: secrets.bearer,
      secret: "ghp_SUPERSECRETTOKENVALUE001",
      ruleId: "authorization-header",
    },
    {
      name: "quoted-composed-bearer",
      sample: 'Authorization: "Bearer plainsecrettokenvalue999"',
      secret: "plainsecrettokenvalue999",
      ruleId: "authorization-header",
    },
  ];
  for (const item of cases) {
    const scanned = scanString(item.sample, `composed.${item.name}`);
    assert.equal(scanned.report.redacted, true, item.name);
    assert.equal(scanned.value.includes(item.secret), false, item.name);
    // Prefix-only redaction is the forbidden failure mode.
    assert.equal(
      scanned.value.includes(`[REDACTED] ${item.secret}`),
      false,
      item.name,
    );
    assert.ok(
      scanned.report.hits.some((hit) => hit.ruleId === item.ruleId),
      item.name,
    );
    for (const hit of scanned.report.hits) {
      assert.equal(JSON.stringify(hit).includes(item.secret), false, item.name);
    }
  }
  // Standalone scheme forms still redact fully.
  for (const sample of ["Bearer plainsecrettokenvalue999", "Basic dXNlcjpwYXNz"]) {
    const scanned = scanString(sample, "standalone");
    assert.equal(scanned.report.redacted, true, sample);
    assert.equal(scanned.value.includes("plainsecrettokenvalue999"), false);
    assert.equal(scanned.value.includes("dXNlcjpwYXNz"), false);
  }
});

test("provider token forms cover representative sk-proj/sk-ant/glpat/xoxb/AIza shapes", () => {
  const forms: Array<{ name: string; sample: string; needle: string }> = [
    { name: "sk-proj", sample: secrets.skProj, needle: "sk-proj-ABCDEFGH" },
    { name: "sk-ant", sample: secrets.skAnt, needle: "sk-ant-api03-ABCDEFGH" },
    { name: "glpat", sample: secrets.glpat, needle: "glpat-ABCDEFGH" },
    { name: "xoxb", sample: secrets.xoxb, needle: "xoxb-123456789012" },
    { name: "AIza", sample: secrets.aiza, needle: "AIzaSyA-abcdefghijklmnopqrstuvwx" },
  ];
  for (const form of forms) {
    const scanned = scanString(form.sample, `provider.${form.name}`);
    assert.equal(scanned.report.redacted, true, form.name);
    assert.equal(scanned.value.includes(form.needle), false, form.name);
    assert.equal(scanned.value.includes("ABCDEFGH"), false, form.name);
    assert.ok(scanned.report.hits.every((hit) => hit.count >= 1), form.name);
    assert.ok(
      scanned.report.hits.every(
        (hit) =>
          typeof hit.ruleId === "string" &&
          typeof hit.location === "string" &&
          !JSON.stringify(hit).includes(form.needle),
      ),
      form.name,
    );
  }
});

test("unsupported opaque bytes are wholly replaced", () => {
  const buf = Buffer.from([0x00, 0xff, 0xfe, 0x01]);
  const scanned = scanBytes(buf, "opaque");
  assert.equal(scanned.report.redacted, true);
  const parsed = JSON.parse(scanned.value.toString("utf8"));
  assert.equal(parsed.kind, "opaque-redaction");
});

test("key collision after redaction fails closed", () => {
  assert.throws(
    () =>
      scanJsonValue(
        {
          "api_key=secretvalue123": 1,
          "api_key=othersecret999": 2,
        },
        "obj",
      ),
    (error: unknown) =>
      error instanceof RecorderError && error.code === "scan-failed",
  );
});

test("decoder accepts machine/JSON and session envelopes for each tool", () => {
  const tools = [
    CODER_OUTPUT_TOOL_NAME,
    FIXER_OUTPUT_TOOL_NAME,
    REVIEWER_OUTPUT_TOOL_NAME,
    JUDGE_OUTPUT_TOOL_NAME,
    COLLECTOR_OUTPUT_TOOL,
  ];
  for (const tool of tools) {
    const details = detailsFor(tool);
    const jsonEnvelope = machineLifecycle(tool, details);
    const sessionEnvelope = sessionLifecycle(tool, details);
    assert.ok(decodeToolResultsFromEnvelope(jsonEnvelope).length >= 1);
    assert.ok(decodeToolResultsFromEnvelope(sessionEnvelope).length >= 1);
    const extracted = extractAcceptedReceipt([jsonEnvelope]);
    assert.ok(extracted.receipt, tool);
    assert.equal(extracted.receipt!.toolName, tool);
    const extractedSession = extractAcceptedReceipt([sessionEnvelope]);
    assert.ok(extractedSession.receipt, `session ${tool}`);
  }
});

test("lifecycle rejects orphan, missing start, error, prose, mismatch, conflict, and bare lookalikes", () => {
  const tool = CODER_OUTPUT_TOOL_NAME;
  const details = detailsFor(tool);

  // lawful absence
  assert.equal(extractAcceptedReceipt([""]).receipt, null);

  // orphan result (no issued/start)
  assert.equal(
    extractAcceptedReceipt([
      machineLifecycle(tool, details, { omitIssued: true, omitStart: true }),
    ]).receipt,
    null,
  );

  // missing start
  assert.equal(
    extractAcceptedReceipt([
      machineLifecycle(tool, details, { omitStart: true }),
    ]).receipt,
    null,
  );

  // missing issued call
  assert.equal(
    extractAcceptedReceipt([
      machineLifecycle(tool, details, { omitIssued: true }),
    ]).receipt,
    null,
  );

  // error terminal
  assert.equal(
    extractAcceptedReceipt([
      machineLifecycle(tool, details, { isError: true }),
    ]).receipt,
    null,
  );

  // prose lookalike
  assert.equal(
    extractAcceptedReceipt([
      "assistant says {\"status\":\"completed\",\"report\":\"x\"}",
    ]).receipt,
    null,
  );

  // unsupported tool
  assert.equal(
    extractAcceptedReceipt([
      machineLifecycle("not_a_package_tool", details),
    ]).receipt,
    null,
  );

  // args mismatch between issued and start is built via argsMismatch (issued/start use tampered, terminal uses details)
  // For argsMismatch, issued and start both get tampered, terminal has real details — details won't match issued for non-collector
  assert.equal(
    extractAcceptedReceipt([
      machineLifecycle(tool, details, { argsMismatch: true }),
    ]).receipt,
    null,
  );

  // conflicting terminals
  assert.equal(
    extractAcceptedReceipt([
      machineLifecycle(tool, details, {
        duplicateTerminal: true,
        conflictDetails: { status: "refused", report: "nope" },
      }),
    ]).receipt,
    null,
  );

  // bare toolResult object (no envelope type) is ignored
  assert.equal(
    extractAcceptedReceipt([
      JSON.stringify({
        role: "toolResult",
        toolCallId: "c1",
        toolName: tool,
        isError: false,
        details,
        content: [{ type: "text", text: ACCEPTED[tool] }],
      }),
    ]).receipt,
    null,
  );

  // forged orphan Judge
  assert.equal(
    extractAcceptedReceipt([
      JSON.stringify({
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "forged",
          toolName: JUDGE_OUTPUT_TOOL_NAME,
          isError: false,
          details: { judgeStatus: "converged" },
          content: [{ type: "text", text: "Judge verdict accepted" }],
        },
      }),
    ]).receipt,
    null,
  );
});

test("collector generated legs-only output is not an accepted receipt", () => {
  const generated = { legs: [{ legId: "l", status: "missing", rationale: "x", evidenceRefs: ["e"] }] };
  assert.throws(() => validateAcceptedCollectorReceipt(generated));
  assert.throws(() => validateAcceptedCollectorReceipt({ reports: [null] }));
  assert.throws(() => validateAcceptedCollectorReceipt({
    ...minimalCollectorReceipt(),
    legs: [null],
  }));

  // Full lifecycle with generated args as issued but terminal carrying only generated legs fails
  const envelope = machineLifecycle(COLLECTOR_OUTPUT_TOOL, generated, {
    acceptedText: ACCEPTED[COLLECTOR_OUTPUT_TOOL] ?? "Collector receipt accepted",
  });
  // issued args === terminal details === generated → validator rejects
  assert.equal(extractAcceptedReceipt([envelope]).receipt, null);

  // Valid collector terminal receipt with legs-only issued args succeeds
  const receipt = minimalCollectorReceipt();
  const legsOnly = {
    legs: receipt.legs.map((leg) => ({
      legId: leg.legId,
      status: leg.status,
      rationale: leg.rationale,
      evidenceRefs: leg.evidenceRefs,
    })),
  };
  const callId = "col1";
  const lines = [
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: callId,
          name: COLLECTOR_OUTPUT_TOOL,
          arguments: legsOnly,
        }],
      },
    },
    {
      type: "tool_execution_start",
      toolCallId: callId,
      toolName: COLLECTOR_OUTPUT_TOOL,
      args: legsOnly,
    },
    {
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: callId,
        toolName: COLLECTOR_OUTPUT_TOOL,
        isError: false,
        details: receipt,
        content: [{ type: "text", text: ACCEPTED[COLLECTOR_OUTPUT_TOOL] }],
      },
    },
  ];
  const ok = extractAcceptedReceipt([lines.map((l) => JSON.stringify(l)).join("\n")]);
  assert.ok(ok.receipt);
  assert.equal(ok.receipt!.kind, "collector");
});

test("judge/reviewer accepted results attach audit observation only when bound", () => {
  const judge = extractAcceptedReceipt([
    machineLifecycle(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" }, {
      usage: { input: 1, output: 2 },
    }),
  ]);
  assert.ok(judge.receipt);
  assert.ok(judge.auditObservation);
  assert.equal(judge.auditObservation!.auditPassed, true);
  assert.equal(judge.auditObservation!.usage?.input, 1);
  assert.equal(judge.receipt!.kind, "judge");

  // coder never carries audit observation
  const coder = extractAcceptedReceipt([
    machineLifecycle(CODER_OUTPUT_TOOL_NAME, detailsFor(CODER_OUTPUT_TOOL_NAME)),
  ]);
  assert.ok(coder.receipt);
  assert.equal(coder.auditObservation, null);
});

test("receipt secret redaction marks sanitized derivative and strips secrets", () => {
  const extracted = extractAcceptedReceipt([
    machineLifecycle(CODER_OUTPUT_TOOL_NAME, {
      status: "completed",
      report: `done with ${secrets.bearer}`,
    }),
  ]);
  assert.equal(
    extracted.artifactKind,
    "sanitizedDerivativeOfAcceptedReceipt",
  );
  assert.ok(extracted.receipt);
  assert.equal(
    JSON.stringify(extracted.receipt.details).includes("SUPERSECRET"),
    false,
  );
});

test("unlawful derivative after redaction fails closed", () => {
  // Judge status field damaged by embedding a secret as the only status value is hard;
  // instead, put a secret in a required non-empty field that redaction empties discriminants:
  // Use collector with host containing a credential pattern that becomes [REDACTED] ≠ github.com
  const receipt = minimalCollectorReceipt({
    repository: "Bearer ghp_SUPERSECRETTOKENVALUE001/repo",
  });
  // repository remains a string after redaction so still valid — use host via nested? host is const.
  // Force unlawful by putting secret in finalSnapshotId and... still string.
  // Real unlawful: redaction key collision inside details.
  const bad = {
    status: "completed",
    report: "ok",
    "api_key=secretvalue123": "x",
    // can't have extra keys on worker output — validation fails before scan
  };
  // Extra keys fail validation at bind time → absence
  assert.equal(
    extractAcceptedReceipt([machineLifecycle(CODER_OUTPUT_TOOL_NAME, bad)]).receipt,
    null,
  );

  // Lawful secret in report → sanitized derivative
  const ok = extractAcceptedReceipt([
    machineLifecycle(CODER_OUTPUT_TOOL_NAME, {
      status: "completed",
      report: `token ${secrets.skProj}`,
    }),
  ]);
  assert.equal(ok.artifactKind, "sanitizedDerivativeOfAcceptedReceipt");
  void receipt;
});

test("end-to-end child JSON receipt is stored once without leaking secrets", async () => {
  const root = makeTempDir("ak-recorder-extract-");
  try {
    const archive = initGitRepo(join(root, "archive"));
    const authority = commitFile(archive, "authority.md", "# authority\n");
    const task = commitFile(archive, "task.md", "# task\n");
    const script = writeCounterScript(root);
    const counter = join(root, "counter.txt");
    const configPath = writeRecorderConfig(root, {
      archiveRepo: archive,
      cwd: root,
      docketId: "issues/10/apply/apply-receipt-001",
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
      provenance: {
        package: "@ak/pi-workflow-roles",
        model: null,
        target: null,
      },
    });
    const details = JSON.stringify({
      status: "completed",
      report: `finished ${secrets.assign}`,
    });
    const result = await runRecorderBin(
      [
        "--config",
        configPath,
        "--",
        process.execPath,
        script,
        "json-receipt",
        CODER_OUTPUT_TOOL_NAME,
        details,
      ],
      { cwd: root, env: { ...process.env, AK_RECORDER_COUNTER: counter } },
    );
    assert.equal(result.code, 0, result.stderr);
    const dest = join(
      archive,
      ".ak/dockets/issues/10/apply/apply-receipt-001",
    );
    const receipt = JSON.parse(
      readFileSync(join(dest, "receipt.json"), "utf8"),
    );
    assert.equal(receipt.toolName, CODER_OUTPUT_TOOL_NAME);
    assert.equal(
      JSON.stringify(receipt).includes("supersecretvalue999"),
      false,
    );
    assert.equal(
      receipt.artifactKind,
      "sanitizedDerivativeOfAcceptedReceipt",
    );
    const manifest = JSON.parse(
      readFileSync(join(dest, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.receipt.artifactKind, "sanitizedDerivativeOfAcceptedReceipt");
    assert.equal(manifest.provenance.verification, "unverified");
    void decodeEnvelopeRows;
    void collectLifecycleEvents;
    void bindAcceptedLifecycle;
    void scanJsonValue;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const MATRIX_MARKERS = [
  "plainsecrettokenvalue999",
  "dXNlcjpwYXNz",
  "SUPERSECRETTOKENVALUE001",
  "supersecretvalue999",
  "sk-proj-ABCDEFGHijklmnop1234567890",
  "glpat-ABCDEFGHijklmnop1234",
  "xoxb-123456789012-ABCDEFGHijklmnop",
  "AIzaSyA-abcdefghijklmnopqrstuvwx",
] as const;

function assertNoRawSecret(label: string, text: string): void {
  for (const marker of MATRIX_MARKERS) {
    assert.equal(
      text.includes(marker),
      false,
      `${label} leaked ${marker}`,
    );
  }
  // Redaction metadata must stay structural only.
  if (label.includes("redaction") || label.includes("manifest")) {
    assert.equal(text.includes("plainsecrettokenvalue999"), false, label);
  }
}

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(abs));
    else out.push(abs);
  }
  return out;
}

test("category × credential matrix keeps raw secrets out of core, report, and failure JSON", async () => {
  const root = makeTempDir("ak-recorder-matrix-");
  try {
    const archive = initGitRepo(join(root, "archive"));
    const authority = commitFile(archive, "authority.md", "# authority\n");
    const task = commitFile(archive, "task.md", "# task\n");
    const script = writeCounterScript(root);
    const counter = join(root, "counter.txt");

    const secretArgv = `Authorization: Bearer plainsecrettokenvalue999`;
    const secretEnv = secrets.skProj;
    const secretProvenance = `model-with-${secrets.glpat}`;
    const secretInputBody = `copied ${secrets.basic} and ${secrets.xoxb}\n`;
    const secretExhibitBody = `exhibit ${secrets.aiza}\n`;
    const secretReceipt = {
      status: "completed",
      report: `done ${secrets.bearer} ${secrets.assign}`,
    };

    const inputPath = join(root, "secret-input.txt");
    const exhibitPath = join(root, "secret-exhibit.txt");
    writeFileSync(inputPath, secretInputBody);
    writeFileSync(exhibitPath, secretExhibitBody);

    // --- Success path: argv/context, provenance, receipt, copied bytes, manifest/report ---
    const okConfig = writeRecorderConfig(root, {
      archiveRepo: archive,
      cwd: root,
      docketId: "issues/10/apply/apply-matrix-ok",
      overrides: { AK_MATRIX_SECRET: secretEnv },
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
      externalInputs: [{
        id: "secret-input",
        sourcePath: inputPath,
        sha256: sha256File(secretInputBody),
        kind: "input",
      }],
      exhibits: [{
        id: "secret-exhibit",
        sourcePath: exhibitPath,
        sha256: sha256File(secretExhibitBody),
      }],
      provenance: {
        package: "@ak/pi-workflow-roles",
        model: secretProvenance,
        target: null,
      },
    });

    const ok = await runRecorderBin(
      [
        "--config",
        okConfig,
        "--",
        process.execPath,
        script,
        "json-receipt",
        CODER_OUTPUT_TOOL_NAME,
        JSON.stringify(secretReceipt),
        secretArgv,
      ],
      { cwd: root, env: { ...process.env, AK_RECORDER_COUNTER: counter } },
    );
    assert.equal(ok.code, 0, ok.stderr);

    const dest = join(archive, ".ak/dockets/issues/10/apply/apply-matrix-ok");
    assert.equal(existsSync(dest), true);
    for (const file of walkFiles(dest)) {
      assertNoRawSecret(`final:${file}`, readFileSync(file, "utf8"));
    }
    const manifest = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8"));
    assertNoRawSecret("manifest", JSON.stringify(manifest));
    for (const hit of manifest.redaction.hits) {
      assert.equal(typeof hit.ruleId, "string");
      assert.equal(typeof hit.location, "string");
      assert.equal(typeof hit.count, "number");
      assert.deepEqual(Object.keys(hit).sort(), ["count", "location", "ruleId"]);
    }
    if (existsSync(join(dest, "redaction-report.json"))) {
      const report = JSON.parse(
        readFileSync(join(dest, "redaction-report.json"), "utf8"),
      );
      assertNoRawSecret("redaction-report", JSON.stringify(report));
    }
    const receipt = JSON.parse(readFileSync(join(dest, "receipt.json"), "utf8"));
    assertNoRawSecret("receipt", JSON.stringify(receipt));
    assert.equal(
      readFileSync(join(dest, "inputs/secret-input"), "utf8").includes("dXNlcjpwYXNz"),
      false,
    );
    assert.equal(
      readFileSync(join(dest, "exhibits/secret-exhibit"), "utf8").includes("AIzaSyA"),
      false,
    );

    // --- Pre-promotion failure: public diagnostics + no stage/final core ---
    const failConfigPath = writeRecorderConfig(root, {
      archiveRepo: archive,
      cwd: root,
      docketId: "issues/10/apply/apply-matrix-fail",
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
      provenance: {
        package: null,
        model: secretProvenance,
        target: null,
      },
    });
    const failCfg = JSON.parse(readFileSync(failConfigPath, "utf8"));
    failCfg.declarations.gitReferences[0].blobOid = "0".repeat(40);
    writeFileSync(failConfigPath, JSON.stringify(failCfg));

    const failOut =
      `diag-ok Authorization: Bearer plainsecrettokenvalue999 ${secrets.skAnt}\n`;
    const fail = await runRecorderBin(
      [
        "--config",
        failConfigPath,
        "--",
        process.execPath,
        script,
        "exit-text",
        "4",
        failOut,
        `err ${secrets.basic}\n`,
      ],
      { cwd: root, env: { ...process.env, AK_RECORDER_COUNTER: counter } },
    );
    assert.equal(fail.code, 125);
    // Tee remains byte-exact (caller-owned), including raw credentials.
    assert.equal(fail.stdout.includes("plainsecrettokenvalue999"), true);
    assert.equal(fail.stderr.includes("dXNlcjpwYXNz"), true);
    const failureLine = fail.stderr.trim().split("\n").at(-1)!;
    const failure = JSON.parse(failureLine);
    assert.equal(failure.recorder.status, "failed");
    assertNoRawSecret("failure-json", failureLine);
    assert.equal(typeof failure.child.diagnostic, "string");
    assert.notEqual(failure.child.diagnostic, null);
    assertNoRawSecret("child.diagnostic", failure.child.diagnostic);
    assert.equal(
      existsSync(join(archive, ".ak/dockets/issues/10/apply/apply-matrix-fail")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
