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
  type MinimalConfigInput,
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

type EnvelopeKind = "machine" | "session";

type LifecycleOptions = {
  envelope?: EnvelopeKind;
  callId?: string;
  acceptedText?: string;
  omitIssued?: boolean;
  omitStart?: boolean;
  omitTerminal?: boolean;
  isError?: boolean;
  usage?: unknown;
  /** Replay an identical second terminal after the first success. */
  duplicateTerminal?: boolean;
  /** Conflicting second terminal details (implies a second terminal). */
  conflictDetails?: unknown;
  argsMismatch?: boolean;
  /** Emit terminal before start (ordering violation). */
  terminalBeforeStart?: boolean;
  /** Emit start/terminal before issuance. */
  startBeforeIssued?: boolean;
  /** Terminal details override (default: detailsFor(tool)). */
  details?: unknown;
  /** Issued/start args override. Collector defaults to legs-only. */
  args?: unknown;
};

/**
 * Build one lawful or contaminated lifecycle in either supported envelope form.
 * Collector keeps legs-only issuance args versus full accepted receipt details.
 */
function lifecycle(tool: string, options: LifecycleOptions = {}): string {
  const envelope: EnvelopeKind = options.envelope ?? "machine";
  const callId = options.callId ?? (envelope === "machine" ? "c1" : "s1");
  const text = options.acceptedText ?? ACCEPTED[tool] ?? "accepted";
  const details = options.details ?? detailsFor(tool);
  let args: unknown;
  if (options.args !== undefined) {
    args = options.args;
  } else if (options.argsMismatch) {
    args = { tampered: true };
  } else if (tool === COLLECTOR_OUTPUT_TOOL) {
    const receipt = isCollectorReceiptShape(details)
      ? details
      : minimalCollectorReceipt();
    args = collectorLegsOnlyArgs(receipt);
  } else {
    args = details;
  }

  const issued = envelope === "machine"
    ? {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: callId, name: tool, arguments: args }],
      },
    }
    : {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: callId, name: tool, arguments: args }],
      },
    };
  const start = {
    type: "tool_execution_start",
    toolCallId: callId,
    toolName: tool,
    args,
  };
  const terminal = envelope === "machine"
    ? {
      type: "tool_execution_end",
      toolCallId: callId,
      toolName: tool,
      isError: options.isError ?? false,
      result: {
        content: [{ type: "text", text }],
        details,
        ...(options.usage === undefined ? {} : { usage: options.usage }),
      },
    }
    : {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: callId,
        toolName: tool,
        isError: options.isError ?? false,
        details,
        content: [{ type: "text", text }],
        ...(options.usage === undefined ? {} : { usage: options.usage }),
      },
    };
  const duplicateTerminal = envelope === "machine"
    ? {
      type: "tool_execution_end",
      toolCallId: callId,
      toolName: tool,
      isError: false,
      result: {
        content: [{ type: "text", text }],
        details: options.conflictDetails ?? details,
      },
    }
    : {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: callId,
        toolName: tool,
        isError: false,
        details: options.conflictDetails ?? details,
        content: [{ type: "text", text }],
      },
    };

  const lines: unknown[] = [];
  const pushIssued = () => {
    if (!options.omitIssued) lines.push(issued);
  };
  const pushStart = () => {
    if (!options.omitStart) lines.push(start);
  };
  const pushTerminal = () => {
    if (!options.omitTerminal) lines.push(terminal);
  };

  if (options.startBeforeIssued) {
    pushStart();
    pushTerminal();
    pushIssued();
  } else if (options.terminalBeforeStart) {
    pushIssued();
    pushTerminal();
    pushStart();
  } else {
    pushIssued();
    pushStart();
    pushTerminal();
  }

  if (options.duplicateTerminal || options.conflictDetails !== undefined) {
    lines.push(duplicateTerminal);
  }
  return lines.map((line) => JSON.stringify(line)).join("\n");
}

function isCollectorReceiptShape(
  value: unknown,
): value is ReturnType<typeof minimalCollectorReceipt> {
  return isRecordLike(value) && Array.isArray(value.legs);
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Machine-envelope convenience used by non-matrix focused cases. */
function machineLifecycle(
  tool: string,
  details: unknown,
  options: Omit<LifecycleOptions, "envelope" | "details"> = {},
): string {
  return lifecycle(tool, { ...options, envelope: "machine", details });
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

test("composed Authorization Basic/Bearer/Token headers redact the complete credential", () => {
  const cases = [
    {
      name: "composed-bearer-plain",
      sample: "Authorization: Bearer plainsecrettokenvalue999",
      secret: "plainsecrettokenvalue999",
      suffixes: ["plainsecrettokenvalue999"],
      ruleId: "authorization-header",
    },
    {
      name: "composed-basic",
      sample: "Authorization: Basic dXNlcjpwYXNz",
      secret: "dXNlcjpwYXNz",
      suffixes: ["dXNlcjpwYXNz"],
      ruleId: "authorization-header",
    },
    {
      name: "composed-generic-token",
      sample: "Authorization: Token plainsecrettokenvalue999",
      secret: "plainsecrettokenvalue999",
      suffixes: ["plainsecrettokenvalue999"],
      ruleId: "authorization-header",
    },
    {
      name: "composed-bearer-provider",
      sample: secrets.bearer,
      secret: "ghp_SUPERSECRETTOKENVALUE001",
      suffixes: ["ghp_SUPERSECRETTOKENVALUE001"],
      ruleId: "authorization-header",
    },
    {
      name: "quoted-composed-bearer",
      sample: 'Authorization: "Bearer plainsecrettokenvalue999"',
      secret: "plainsecrettokenvalue999",
      suffixes: ["plainsecrettokenvalue999"],
      ruleId: "authorization-header",
    },
    {
      name: "composed-digest-parameters",
      sample:
        'Authorization: Digest username="Mufasa", realm="testrealm@host.com", nonce="abc123", uri="/dir/index.html", response="6629fae49393a05397450978507c4ef1"',
      secret: 'response="6629fae49393a05397450978507c4ef1"',
      suffixes: [
        'username="Mufasa"',
        'realm="testrealm@host.com"',
        'response="6629fae49393a05397450978507c4ef1"',
        "6629fae49393a05397450978507c4ef1",
      ],
      ruleId: "authorization-header",
    },
    {
      name: "composed-custom-parameterized",
      sample:
        'Authorization: HOBA result="success", signed="plainsecrettokenvalue999 abc def"',
      secret: 'signed="plainsecrettokenvalue999 abc def"',
      suffixes: [
        'result="success"',
        'signed="plainsecrettokenvalue999 abc def"',
        "plainsecrettokenvalue999 abc def",
        "plainsecrettokenvalue999",
      ],
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
    for (const suffix of item.suffixes) {
      assert.equal(
        scanned.value.includes(suffix),
        false,
        `${item.name}:suffix:${suffix}`,
      );
      assert.equal(
        scanned.value.includes(`[REDACTED] ${suffix}`),
        false,
        `${item.name}:redacted-suffix:${suffix}`,
      );
    }
    assert.ok(
      scanned.report.hits.some((hit) => hit.ruleId === item.ruleId),
      item.name,
    );
    for (const hit of scanned.report.hits) {
      assert.equal(JSON.stringify(hit).includes(item.secret), false, item.name);
    }
  }
  // CR/LF bounds the credential field so following headers/text stay intact.
  const multiLine =
    'Authorization: Digest username="user", response="secretvalue999"\r\nX-Other: keep-me\nNext: still-here';
  const multiScanned = scanString(multiLine, "composed.crlf-bound");
  assert.equal(multiScanned.report.redacted, true);
  assert.ok(
    multiScanned.report.hits.some((hit) => hit.ruleId === "authorization-header"),
  );
  assert.equal(multiScanned.value.includes("secretvalue999"), false);
  assert.equal(multiScanned.value.includes('username="user"'), false);
  assert.equal(multiScanned.value.includes("X-Other: keep-me"), true);
  assert.equal(multiScanned.value.includes("Next: still-here"), true);
  // Standalone scheme forms still redact fully.
  for (const sample of ["Bearer plainsecrettokenvalue999", "Basic dXNlcjpwYXNz"]) {
    const scanned = scanString(sample, "standalone");
    assert.equal(scanned.report.redacted, true, sample);
    assert.equal(scanned.value.includes("plainsecrettokenvalue999"), false);
    assert.equal(scanned.value.includes("dXNlcjpwYXNz"), false);
  }
});

test("token-assignment consumes quoted multiword values through the matching quote", () => {
  const secret = "correct horse battery staple";
  // password="alpha \"beta\" gamma" — embedded quotes do not close the boundary.
  const escapedDoubleSecret = "alpha \\\"beta\\\" gamma";
  // password='alpha \'beta\' gamma' — same law for single quotes.
  const escapedSingleSecret = "alpha \\'beta\\' gamma";
  const unmatchedSecret = "alpha beta";
  const cases = [
    {
      name: "double-quoted-password",
      sample: `password="${secret}" keep-me`,
      secret,
      suffixes: ["horse battery staple", "battery staple", "staple"],
      preserve: "keep-me",
    },
    {
      name: "single-quoted-password",
      sample: `password='${secret}' keep-me`,
      secret,
      suffixes: ["horse battery staple", "battery staple", "staple"],
      preserve: "keep-me",
    },
    {
      name: "double-quoted-with-escaped-quotes",
      sample: `password="${escapedDoubleSecret}" keep-me`,
      secret: escapedDoubleSecret,
      // Naive close-on-first-quote leaks the embedded-quote tail.
      suffixes: ["beta\\\" gamma\"", "beta", "gamma"],
      preserve: "keep-me",
    },
    {
      name: "single-quoted-with-escaped-quotes",
      sample: `password='${escapedSingleSecret}' keep-me`,
      secret: escapedSingleSecret,
      suffixes: ["beta\\' gamma'", "beta", "gamma"],
      preserve: "keep-me",
    },
    {
      name: "unmatched-double-quoted-password",
      sample: `password="${unmatchedSecret}`,
      secret: unmatchedSecret,
      suffixes: ["alpha", "beta", unmatchedSecret],
      preserve: null,
    },
    {
      name: "unmatched-single-quoted-password",
      sample: `password='${unmatchedSecret}`,
      secret: unmatchedSecret,
      suffixes: ["alpha", "beta", unmatchedSecret],
      preserve: null,
    },
    {
      name: "unmatched-double-quoted-line-bounded",
      sample: `password="${unmatchedSecret}\nkeep-next-line`,
      secret: unmatchedSecret,
      suffixes: ["alpha", "beta", unmatchedSecret],
      preserve: "keep-next-line",
    },
  ];
  for (const item of cases) {
    const scanned = scanString(item.sample, `quoted-assign.${item.name}`);
    assert.equal(scanned.report.redacted, true, item.name);
    assert.ok(
      scanned.report.hits.some((hit) => hit.ruleId === "token-assignment"),
      item.name,
    );
    assert.equal(scanned.value.includes(item.secret), false, item.name);
    for (const suffix of item.suffixes) {
      assert.equal(
        scanned.value.includes(suffix),
        false,
        `${item.name} left suffix ${suffix}`,
      );
    }
    // Prefix-only redaction is the forbidden failure mode.
    assert.equal(
      scanned.value.includes(`[REDACTED] ${item.suffixes[0]}`),
      false,
      item.name,
    );
    if (item.preserve !== null) {
      assert.equal(
        scanned.value.includes(item.preserve),
        true,
        `${item.name} must preserve surrounding non-secret text`,
      );
    }
    for (const hit of scanned.report.hits) {
      assert.equal(JSON.stringify(hit).includes(item.secret), false, item.name);
    }
  }
  // Unquoted assignments still stop at the first whitespace boundary.
  const unquoted = scanString("password=correct keep-me", "quoted-assign.unquoted");
  assert.equal(unquoted.report.redacted, true);
  assert.equal(unquoted.value, "[REDACTED] keep-me");
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

const TERMINATING_TOOLS = [
  CODER_OUTPUT_TOOL_NAME,
  FIXER_OUTPUT_TOOL_NAME,
  REVIEWER_OUTPUT_TOOL_NAME,
  JUDGE_OUTPUT_TOOL_NAME,
  COLLECTOR_OUTPUT_TOOL,
] as const;

function collectorLegsOnlyArgs(receipt = minimalCollectorReceipt()) {
  return {
    legs: receipt.legs.map((leg) => ({
      legId: leg.legId,
      status: leg.status,
      rationale: leg.rationale,
      evidenceRefs: leg.evidenceRefs,
    })),
  };
}

function collectorBoundLifecycle(
  receipt: ReturnType<typeof minimalCollectorReceipt>,
  envelope: EnvelopeKind = "machine",
): string {
  return lifecycle(COLLECTOR_OUTPUT_TOOL, {
    envelope,
    callId: envelope === "machine" ? "col-m" : "col-s",
    details: receipt,
  });
}

function conflictDetailsFor(tool: string): unknown {
  if (tool === JUDGE_OUTPUT_TOOL_NAME) {
    return { judgeStatus: "continue", fix: { summary: "x" } };
  }
  if (tool === COLLECTOR_OUTPUT_TOOL) {
    return minimalCollectorReceipt({ targetHead: "b".repeat(40) });
  }
  return { status: "refused", report: "nope" };
}

const ENVELOPES: readonly EnvelopeKind[] = ["machine", "session"];

test("decoder accepts machine/JSON and session envelopes for each tool", () => {
  for (const tool of TERMINATING_TOOLS) {
    for (const envelope of ENVELOPES) {
      const text = lifecycle(tool, { envelope });
      assert.ok(
        decodeToolResultsFromEnvelope(text).length >= 1,
        `${tool} ${envelope} decodes`,
      );
      const extracted = extractAcceptedReceipt([text]);
      assert.ok(extracted.receipt, `${tool} ${envelope}`);
      assert.equal(extracted.receipt!.toolName, tool);
      assert.equal(
        extracted.auditObservation !== null,
        tool === JUDGE_OUTPUT_TOOL_NAME || tool === REVIEWER_OUTPUT_TOOL_NAME,
      );
    }
  }
});

test("acceptance matrix: exact lifecycle law for every terminating tool × envelope", () => {
  for (const tool of TERMINATING_TOOLS) {
    for (const envelope of ENVELOPES) {
      const cell = `${tool} ${envelope}`;
      const lawful = lifecycle(tool, { envelope });
      assert.ok(extractAcceptedReceipt([lawful]).receipt, `${cell} lawful`);

      // Replayed identical terminal is not acceptance.
      assert.equal(
        extractAcceptedReceipt([
          lifecycle(tool, { envelope, duplicateTerminal: true }),
        ]).receipt,
        null,
        `${cell} identical replay`,
      );

      // Substring / prefix / suffix / truncated acceptance text is not acceptance.
      for (const acceptedText of [
        `prefix ${ACCEPTED[tool]}`,
        `${ACCEPTED[tool]} suffix`,
        `embed ${ACCEPTED[tool]} embed`,
        ACCEPTED[tool]!.slice(0, -1),
      ]) {
        assert.equal(
          extractAcceptedReceipt([
            lifecycle(tool, { envelope, acceptedText }),
          ]).receipt,
          null,
          `${cell} text ${acceptedText}`,
        );
      }

      // Ordering: start-before-issued / terminal-before-start.
      assert.equal(
        extractAcceptedReceipt([
          lifecycle(tool, { envelope, startBeforeIssued: true }),
        ]).receipt,
        null,
        `${cell} start before issued`,
      );
      assert.equal(
        extractAcceptedReceipt([
          lifecycle(tool, { envelope, terminalBeforeStart: true }),
        ]).receipt,
        null,
        `${cell} terminal before start`,
      );

      // Conflict / error / orphan / missing phases.
      assert.equal(
        extractAcceptedReceipt([
          lifecycle(tool, {
            envelope,
            duplicateTerminal: true,
            conflictDetails: conflictDetailsFor(tool),
          }),
        ]).receipt,
        null,
        `${cell} conflict`,
      );
      assert.equal(
        extractAcceptedReceipt([
          lifecycle(tool, { envelope, isError: true }),
        ]).receipt,
        null,
        `${cell} error`,
      );
      assert.equal(
        extractAcceptedReceipt([
          lifecycle(tool, { envelope, omitIssued: true, omitStart: true }),
        ]).receipt,
        null,
        `${cell} orphan terminal`,
      );
      assert.equal(
        extractAcceptedReceipt([
          lifecycle(tool, { envelope, omitStart: true }),
        ]).receipt,
        null,
        `${cell} missing start`,
      );
      assert.equal(
        extractAcceptedReceipt([
          lifecycle(tool, { envelope, omitIssued: true }),
        ]).receipt,
        null,
        `${cell} missing issued`,
      );

      // Args mismatch between issued and start.
      if (tool === COLLECTOR_OUTPUT_TOOL) {
        const receipt = minimalCollectorReceipt();
        // Issued legs-only vs start empty-legs.
        const callId = envelope === "machine" ? "cm" : "cs";
        const legsOnly = collectorLegsOnlyArgs(receipt);
        const issued = envelope === "machine"
          ? {
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
          }
          : {
            type: "message",
            message: {
              role: "assistant",
              content: [{
                type: "toolCall",
                id: callId,
                name: COLLECTOR_OUTPUT_TOOL,
                arguments: legsOnly,
              }],
            },
          };
        const start = {
          type: "tool_execution_start",
          toolCallId: callId,
          toolName: COLLECTOR_OUTPUT_TOOL,
          args: { legs: [] },
        };
        const terminal = envelope === "machine"
          ? {
            type: "tool_execution_end",
            toolCallId: callId,
            toolName: COLLECTOR_OUTPUT_TOOL,
            isError: false,
            result: {
              content: [{ type: "text", text: ACCEPTED[COLLECTOR_OUTPUT_TOOL] }],
              details: receipt,
            },
          }
          : {
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: callId,
              toolName: COLLECTOR_OUTPUT_TOOL,
              isError: false,
              details: receipt,
              content: [{ type: "text", text: ACCEPTED[COLLECTOR_OUTPUT_TOOL] }],
            },
          };
        const mismatched = [issued, start, terminal]
          .map((line) => JSON.stringify(line))
          .join("\n");
        assert.equal(
          extractAcceptedReceipt([mismatched]).receipt,
          null,
          `${cell} issued/start args mismatch`,
        );
      } else {
        assert.equal(
          extractAcceptedReceipt([
            lifecycle(tool, { envelope, argsMismatch: true }),
          ]).receipt,
          null,
          `${cell} args mismatch`,
        );
      }

      // Unsupported tool name lookalike in this envelope.
      assert.equal(
        extractAcceptedReceipt([
          lifecycle("not_a_package_tool", {
            envelope,
            details: detailsFor(CODER_OUTPUT_TOOL_NAME),
            args: detailsFor(CODER_OUTPUT_TOOL_NAME),
            acceptedText: ACCEPTED[CODER_OUTPUT_TOOL_NAME]!,
          }),
        ]).receipt,
        null,
        `${cell} unsupported tool`,
      );
    }
  }

  // Unsupported envelope shapes / prose / bare lookalikes (global).
  assert.equal(extractAcceptedReceipt([""]).receipt, null);
  assert.equal(
    extractAcceptedReceipt([
      "assistant says {\"status\":\"completed\",\"report\":\"x\"}",
    ]).receipt,
    null,
  );
  // Bare machine terminal without lifecycle framing.
  assert.equal(
    extractAcceptedReceipt([
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: CODER_OUTPUT_TOOL_NAME,
        isError: false,
        result: {
          content: [{ type: "text", text: ACCEPTED[CODER_OUTPUT_TOOL_NAME] }],
          details: detailsFor(CODER_OUTPUT_TOOL_NAME),
        },
      }),
    ]).receipt,
    null,
  );
  // Bare session toolResult without lifecycle framing.
  assert.equal(
    extractAcceptedReceipt([
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "c1",
          toolName: CODER_OUTPUT_TOOL_NAME,
          isError: false,
          details: detailsFor(CODER_OUTPUT_TOOL_NAME),
          content: [{ type: "text", text: ACCEPTED[CODER_OUTPUT_TOOL_NAME] }],
        },
      }),
    ]).receipt,
    null,
  );
  // Legacy bare toolResult object (no envelope type).
  assert.equal(
    extractAcceptedReceipt([
      JSON.stringify({
        role: "toolResult",
        toolCallId: "c1",
        toolName: CODER_OUTPUT_TOOL_NAME,
        isError: false,
        details: detailsFor(CODER_OUTPUT_TOOL_NAME),
        content: [{ type: "text", text: ACCEPTED[CODER_OUTPUT_TOOL_NAME] }],
      }),
    ]).receipt,
    null,
  );

  // Multi-candidate ambiguity fails closed with extraction-failed for each envelope.
  for (const envelope of ENVELOPES) {
    const a = lifecycle(CODER_OUTPUT_TOOL_NAME, { envelope, callId: "a1" });
    const b = lifecycle(FIXER_OUTPUT_TOOL_NAME, { envelope, callId: "b1" });
    assert.throws(
      () => extractAcceptedReceipt([`${a}\n${b}`]),
      (error: unknown) =>
        error instanceof RecorderError && error.code === "extraction-failed",
      `${envelope} ambiguity`,
    );
  }
});

test("collector closed recursive receipt rejects extras and malformed descendants", () => {
  const base = minimalCollectorReceipt();
  assert.deepEqual(validateAcceptedCollectorReceipt(base), base);

  const generated = {
    legs: [{ legId: "l", status: "missing", rationale: "x", evidenceRefs: ["e"] }],
  };
  assert.throws(() => validateAcceptedCollectorReceipt(generated));

  // Extra keys at root and each recursive child shape.
  assert.throws(() => validateAcceptedCollectorReceipt({ ...base, extra: true }));
  assert.throws(() =>
    validateAcceptedCollectorReceipt({
      ...base,
      reports: [{ ...base.reports[0], extra: 1 }],
    })
  );
  assert.throws(() =>
    validateAcceptedCollectorReceipt({
      ...base,
      legs: [{ ...base.legs[0], unavailableScope: "target" }],
    })
  );
  assert.throws(() =>
    validateAcceptedCollectorReceipt({
      ...base,
      requestAttempts: [{
        attemptId: "a",
        legId: "leg-1",
        observedHead: "h",
        snapshotId: "s",
        marker: "m",
        body: "b",
        startedAt: "t",
        status: "started",
        forged: true,
      }],
    })
  );
  assert.throws(() =>
    validateAcceptedCollectorReceipt({
      ...base,
      snapshots: [{ ...base.snapshots[0], extraDiag: [] }],
    })
  );
  assert.throws(() =>
    validateAcceptedCollectorReceipt({
      ...base,
      evidenceRecords: [{ ...base.evidenceRecords[0], authorLogin: "x" }],
    })
  );

  // Malformed descendants previously passed through.
  assert.throws(() => validateAcceptedCollectorReceipt({ reports: [null] }));
  assert.throws(() => validateAcceptedCollectorReceipt({ ...base, legs: [null] }));
  assert.throws(() =>
    validateAcceptedCollectorReceipt({
      ...base,
      snapshots: [{ ...base.snapshots[0], pageDiagnostics: [{ not: "closed" }] }],
    })
  );
  assert.throws(() =>
    validateAcceptedCollectorReceipt({
      ...base,
      snapshots: [{ ...base.snapshots[0], pageDiagnostics: ["string-diag"] }],
    })
  );
  assert.throws(() =>
    validateAcceptedCollectorReceipt({
      ...base,
      requestAttempts: [["array-entry"]],
    })
  );
  assert.throws(() =>
    validateAcceptedCollectorReceipt({
      ...base,
      evidenceRecords: ["not-an-object"],
    })
  );

  // Generated legs-only details are issuance-only, never accepted terminals.
  assert.equal(
    extractAcceptedReceipt([
      machineLifecycle(COLLECTOR_OUTPUT_TOOL, generated, {
        acceptedText: ACCEPTED[COLLECTOR_OUTPUT_TOOL]!,
      }),
    ]).receipt,
    null,
  );

  // Production-shaped collector terminal remains accepted; legs-only args stay issuance-only.
  const receipt = minimalCollectorReceipt({
    snapshots: [{
      ...base.snapshots[0],
      pageDiagnostics: [{
        path: "/reviews",
        page: 1,
        status: 200,
        itemCount: 0,
      }],
    }],
  });
  const ok = extractAcceptedReceipt([collectorBoundLifecycle(receipt, "machine")]);
  assert.ok(ok.receipt);
  assert.equal(ok.receipt!.kind, "collector");
  assert.equal(ok.auditObservation, null);
  assert.throws(() => validateAcceptedCollectorReceipt(collectorLegsOnlyArgs(receipt)));
});

test("judge/reviewer audit observation requires a uniquely bound acceptance", () => {
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

  const reviewer = extractAcceptedReceipt([
    machineLifecycle(REVIEWER_OUTPUT_TOOL_NAME, { status: "completed", report: "ok" }),
  ]);
  assert.ok(reviewer.receipt);
  assert.ok(reviewer.auditObservation);
  assert.equal(reviewer.auditObservation!.toolName, REVIEWER_OUTPUT_TOOL_NAME);

  // coder never carries audit observation
  const coder = extractAcceptedReceipt([
    machineLifecycle(CODER_OUTPUT_TOOL_NAME, detailsFor(CODER_OUTPUT_TOOL_NAME)),
  ]);
  assert.ok(coder.receipt);
  assert.equal(coder.auditObservation, null);

  // Unbound / rejected / orphan Judge or Reviewer establish no audit observation.
  const unboundCases = [
    machineLifecycle(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" }, {
      omitIssued: true,
      omitStart: true,
    }),
    machineLifecycle(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" }, {
      isError: true,
    }),
    machineLifecycle(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" }, {
      acceptedText: `prefix ${ACCEPTED[JUDGE_OUTPUT_TOOL_NAME]}`,
    }),
    machineLifecycle(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" }, {
      duplicateTerminal: true,
    }),
    machineLifecycle(REVIEWER_OUTPUT_TOOL_NAME, { status: "completed", report: "ok" }, {
      omitStart: true,
    }),
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
  ];
  for (const envelope of unboundCases) {
    const extracted = extractAcceptedReceipt([envelope]);
    assert.equal(extracted.receipt, null);
    assert.equal(extracted.auditObservation, null);
  }
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
    const quotedAssign = `password="correct horse battery staple"`;
    const escapedQuotedAssign = `password="alpha \"beta\" gamma"`;
    const unmatchedQuotedAssign = `password="alpha beta`;
    const quotedAssignMarkers = [
      "correct horse battery staple",
      "horse battery staple",
      "battery staple",
      // Full escaped/unmatched values and meaningful tails — not bare hex-like
      // tokens (alpha/beta) that can appear inside sha256/oid digests.
      'alpha \"beta\" gamma',
      'beta\" gamma',
      'beta\" gamma"',
      "alpha beta",
      'password="alpha beta',
      'password=\"alpha beta',
    ] as const;
    const secretInputBody = `copied ${secrets.basic} and ${secrets.xoxb}\n`;
    const secretExhibitBody = `exhibit ${secrets.aiza}\n`;
    const secretReceipt = {
      status: "completed",
      report:
        `done ${secrets.bearer} ${secrets.assign} ${quotedAssign} ${escapedQuotedAssign} ${unmatchedQuotedAssign}`,
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
    // Quoted multiword assignment must not leave the full value or any
    // whitespace-delimited suffix in promoted docket / receipt / manifest / report.
    for (const file of walkFiles(dest)) {
      const text = readFileSync(file, "utf8");
      for (const marker of quotedAssignMarkers) {
        assert.equal(
          text.includes(marker),
          false,
          `promoted:${file} leaked quoted-assign marker ${marker}`,
        );
      }
    }
    for (const label of ["manifest", "receipt"] as const) {
      const text = JSON.stringify(
        label === "manifest" ? manifest : receipt,
      );
      for (const marker of quotedAssignMarkers) {
        assert.equal(
          text.includes(marker),
          false,
          `${label} leaked quoted-assign marker ${marker}`,
        );
      }
    }
    if (existsSync(join(dest, "redaction-report.json"))) {
      const reportText = readFileSync(join(dest, "redaction-report.json"), "utf8");
      for (const marker of quotedAssignMarkers) {
        assert.equal(
          reportText.includes(marker),
          false,
          `redaction-report leaked quoted-assign marker ${marker}`,
        );
      }
    }

    // --- Post-spawn / pre-promotion failure: public diagnostics + no final core ---
    // Declaration admission is before spawn, so force a promotion collision from the
    // child after tee capture (destination-exists), preserving secret-bearing diagnostics.
    const failDocket = "issues/10/apply/apply-matrix-fail";
    const failConfigPath = writeRecorderConfig(root, {
      archiveRepo: archive,
      cwd: root,
      docketId: failDocket,
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
    const collideScript = join(root, "collide-dest.mjs");
    writeFileSync(
      collideScript,
      `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dest = ${JSON.stringify(join(archive, ".ak/dockets", failDocket))};
process.stdout.write("diag-ok Authorization: Bearer plainsecrettokenvalue999 ${secrets.skAnt}\\n");
process.stderr.write("err ${secrets.basic}\\n");
mkdirSync(dest, { recursive: true });
writeFileSync(join(dest, "collision.txt"), "preexisting\\n");
process.exit(0);
`,
    );

    const fail = await runRecorderBin(
      ["--config", failConfigPath, "--", process.execPath, collideScript],
      { cwd: root, env: { ...process.env, AK_RECORDER_COUNTER: counter } },
    );
    assert.equal(fail.code, 125, fail.stderr);
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
    // Child-created collision dir may remain; Recorder must not leave a complete docket.
    assert.equal(
      existsSync(join(archive, ".ak/dockets", failDocket, "manifest.json")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("final scan closure keeps manifest hits identical to redaction-report and includes final-manifest secrets", async () => {
  const root = makeTempDir("ak-recorder-final-scan-");
  try {
    const archive = initGitRepo(join(root, "archive"));
    // Secret first becomes observable when archive identity is scanned into the
    // final manifest material (not only via pre-manifest leaf scans).
    const authority = commitFile(
      archive,
      "authority.md",
      "# authority Authorization: Bearer plainsecrettokenvalue999\n",
    );
    const task = commitFile(archive, "task.md", "# task\n");
    const script = writeCounterScript(root);
    const counter = join(root, "counter.txt");

    const hitConfig = writeRecorderConfig(root, {
      archiveRepo: archive,
      cwd: root,
      docketId: "issues/10/apply/apply-final-scan-hits",
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
        model: `model-with-${secrets.glpat}`,
        target: null,
      },
    });
    const hit = await runRecorderBin(
      [
        "--config",
        hitConfig,
        "--",
        process.execPath,
        script,
        "ok",
        "Authorization: Bearer plainsecrettokenvalue999",
      ],
      { cwd: root, env: { ...process.env, AK_RECORDER_COUNTER: counter } },
    );
    assert.equal(hit.code, 0, hit.stderr);
    const dest = join(
      archive,
      ".ak/dockets/issues/10/apply/apply-final-scan-hits",
    );
    const manifest = JSON.parse(
      readFileSync(join(dest, "manifest.json"), "utf8"),
    );
    assert.ok(Array.isArray(manifest.redaction.hits));
    assert.ok(manifest.redaction.hits.length > 0);
    assertNoRawSecret("final-manifest", JSON.stringify(manifest));
    assert.equal(existsSync(join(dest, "redaction-report.json")), true);
    const report = JSON.parse(
      readFileSync(join(dest, "redaction-report.json"), "utf8"),
    );
    assert.deepEqual(report.hits, manifest.redaction.hits);
    assertNoRawSecret("final-report", JSON.stringify(report));
    // Schema validation of the persisted final manifest.
    const { validatePublicManifest } = await import(
      "../src/recorder/manifest.ts"
    );
    validatePublicManifest(manifest);

    // Zero-hit control: no redaction-report.json and empty hits array.
    const cleanArchive = initGitRepo(join(root, "clean-archive"));
    const cleanAuth = commitFile(cleanArchive, "authority.md", "# authority\n");
    const cleanTask = commitFile(cleanArchive, "task.md", "# task\n");
    const zeroConfig = writeRecorderConfig(root, {
      archiveRepo: cleanArchive,
      cwd: root,
      docketId: "issues/10/apply/apply-final-scan-zero",
      authority: {
        repositoryRoot: cleanArchive,
        commit: cleanAuth.commit,
        path: cleanAuth.path,
        blobOid: cleanAuth.blobOid,
        sha256: cleanAuth.sha256,
      },
      task: {
        repositoryRoot: cleanArchive,
        commit: cleanTask.commit,
        path: cleanTask.path,
        blobOid: cleanTask.blobOid,
        sha256: cleanTask.sha256,
      },
    });
    const zero = await runRecorderBin(
      ["--config", zeroConfig, "--", process.execPath, script, "ok"],
      { cwd: root, env: { ...process.env, AK_RECORDER_COUNTER: counter } },
    );
    assert.equal(zero.code, 0, zero.stderr);
    const zeroDest = join(
      cleanArchive,
      ".ak/dockets/issues/10/apply/apply-final-scan-zero",
    );
    const zeroManifest = JSON.parse(
      readFileSync(join(zeroDest, "manifest.json"), "utf8"),
    );
    assert.deepEqual(zeroManifest.redaction.hits, []);
    assert.equal(existsSync(join(zeroDest, "redaction-report.json")), false);
    validatePublicManifest(zeroManifest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function readCounter(counterPath: string): number {
  if (!existsSync(counterPath)) return 0;
  return readFileSync(counterPath, "utf8").split("\n").filter(Boolean).length;
}

function assertNoSecretInTree(label: string, dir: string, markers: string[]): void {
  for (const file of walkFiles(dir)) {
    const text = readFileSync(file, "utf8");
    for (const marker of markers) {
      assert.equal(
        text.includes(marker),
        false,
        `${label} file ${file} leaked ${marker}`,
      );
    }
    assert.equal(
      file.includes("SUPERSECRET"),
      false,
      `${label} path leaked secret: ${file}`,
    );
    assert.equal(
      file.includes("sk-proj-ABCDEFGH"),
      false,
      `${label} path leaked provider token: ${file}`,
    );
  }
  // Directory names themselves must not carry the raw credential.
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (!existsSync(cur)) continue;
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      const abs = join(cur, ent.name);
      for (const marker of markers) {
        assert.equal(
          abs.includes(marker),
          false,
          `${label} path entry leaked ${marker}: ${abs}`,
        );
      }
      if (ent.isDirectory()) stack.push(abs);
    }
  }
}

function writeConfigWithMutations(
  dir: string,
  input: MinimalConfigInput,
  mutate: (cfg: Record<string, any>) => void,
): string {
  const path = writeRecorderConfig(dir, input);
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  mutate(cfg);
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
  return path;
}

test("credential-shaped structural metadata fails closed before stage/final path creation", async () => {
  const root = makeTempDir("ak-recorder-meta-cred-");
  try {
    const archive = initGitRepo(join(root, "archive"));
    const authority = commitFile(archive, "authority.md", "# authority\n");
    const task = commitFile(archive, "task.md", "# task\n");
    const script = writeCounterScript(root);
    const counter = join(root, "counter.txt");

    const providerId = secrets.skProj; // sk-proj-… grammar-valid id
    const providerTokenMarker = "sk-proj-ABCDEFGHijklmnop1234567890";
    const ghpId = "ghp_SUPERSECRETTOKENVALUE001";
    const markers = [providerTokenMarker, "SUPERSECRETTOKENVALUE001", ghpId];

    const baseInput: MinimalConfigInput = {
      archiveRepo: archive,
      cwd: root,
      docketId: "issues/10/apply/apply-meta-control",
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
    };

    // Clean control: ordinary ids and archive identity still succeed.
    const controlConfig = writeRecorderConfig(root, baseInput);
    const control = await runRecorderBin(
      ["--config", controlConfig, "--", process.execPath, script, "ok"],
      { cwd: root, env: { ...process.env, AK_RECORDER_COUNTER: counter } },
    );
    assert.equal(control.code, 0, control.stderr);
    assert.equal(
      existsSync(
        join(archive, ".ak/dockets/issues/10/apply/apply-meta-control/manifest.json"),
      ),
      true,
    );
    const spawnsAfterControl = readCounter(counter);
    assert.ok(spawnsAfterControl >= 1);

    const externalBody = "external body\n";
    const exhibitBody = "exhibit body\n";
    const externalPath = join(root, "ext-body.txt");
    const exhibitPath = join(root, "exh-body.txt");
    writeFileSync(externalPath, externalBody);
    writeFileSync(exhibitPath, exhibitBody);

    type Case = {
      name: string;
      mutate: (cfg: Record<string, any>) => void;
      secret: string;
    };
    const cases: Case[] = [
      {
        name: "git-reference-id-provider-token",
        secret: providerTokenMarker,
        mutate: (cfg) => {
          cfg.archive.docketId = "issues/10/apply/apply-meta-ref-id";
          cfg.declarations.gitReferences[0].id = providerId;
        },
      },
      {
        name: "external-input-id-ghp",
        secret: ghpId,
        mutate: (cfg) => {
          cfg.archive.docketId = "issues/10/apply/apply-meta-ext-id";
          cfg.declarations.externalInputs = [{
            id: ghpId,
            sourcePath: externalPath,
            sha256: sha256File(externalBody),
            kind: "input",
          }];
        },
      },
      {
        name: "exhibit-id-provider-token",
        secret: providerTokenMarker,
        mutate: (cfg) => {
          cfg.archive.docketId = "issues/10/apply/apply-meta-exh-id";
          cfg.declarations.exhibits = [{
            id: providerId,
            sourcePath: exhibitPath,
            sha256: sha256File(exhibitBody),
          }];
        },
      },
      {
        name: "archive-docketId-provider-token",
        secret: providerTokenMarker,
        mutate: (cfg) => {
          cfg.archive.docketId =
            `issues/10/apply/${providerId}`;
        },
      },
      {
        name: "archive-root-ghp",
        secret: ghpId,
        mutate: (cfg) => {
          cfg.archive.root = ghpId;
          cfg.archive.docketId = "issues/10/apply/apply-meta-root";
        },
      },
    ];

    for (const item of cases) {
      const beforeSpawns = readCounter(counter);
      const configPath = writeConfigWithMutations(
        root,
        {
          ...baseInput,
          docketId: `issues/10/apply/apply-meta-${item.name}`,
        },
        item.mutate,
      );
      const result = await runRecorderBin(
        ["--config", configPath, "--", process.execPath, script, "ok"],
        { cwd: root, env: { ...process.env, AK_RECORDER_COUNTER: counter } },
      );
      assert.equal(result.code, 125, `${item.name}: ${result.stderr}`);
      assert.equal(
        readCounter(counter),
        beforeSpawns,
        `${item.name} must not spawn child`,
      );

      const failureLine = result.stderr.trim().split("\n").at(-1)!;
      const failure = JSON.parse(failureLine);
      assert.equal(failure.recorder.status, "failed", item.name);
      assert.equal(failure.recorder.code, "invalid-config", item.name);
      assert.equal(failure.child.status, "not-spawned", item.name);
      assertNoRawSecret(`${item.name}-failure`, failureLine);
      assert.equal(failureLine.includes(item.secret), false, item.name);
      assert.equal(result.stderr.includes(item.secret), false, item.name);
      assert.equal(result.stdout.includes(item.secret), false, item.name);

      // No final docket core and no credential-shaped private stage/final paths.
      assertNoSecretInTree(item.name, archive, markers);
      assert.equal(
        existsSync(join(archive, ".ak/dockets", `issues/10/apply/${providerId}`)),
        false,
        item.name,
      );
      assert.equal(existsSync(join(archive, ghpId)), false, item.name);
      // No inputs/<credential> or exhibits/<credential> residue under work stage.
      if (existsSync(join(archive, ".ak/work"))) {
        assertNoSecretInTree(`${item.name}-work`, join(archive, ".ak/work"), markers);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("credential-shaped Judge toolCallId sanitizes through bound extract, audit, and promotion", async () => {
  // Coverage gap: matrix/e2e paths use Coder only and never require audit-observation.json.
  // Binding tests cover Judge/Reviewer acceptance but not credential-bearing call identity
  // through store/manifest promotion. toolCallId is itself credential-shaped here.
  const callId = "ghp_SUPERSECRETTOKENVALUE001";
  const rawMarker = "SUPERSECRETTOKENVALUE001";
  const details = { judgeStatus: "converged" as const };

  // Bound issuance → start → accepted terminal (not forged/bare).
  const boundEnvelope = lifecycle(JUDGE_OUTPUT_TOOL_NAME, {
    envelope: "machine",
    callId,
    details,
  });
  const extracted = extractAcceptedReceipt([boundEnvelope]);
  assert.ok(extracted.receipt, "Judge lifecycle must accept");
  assert.ok(extracted.auditObservation, "Judge must create audit observation");
  assert.equal(extracted.receipt!.kind, "judge");
  assert.equal(extracted.auditObservation!.auditPassed, true);
  // Outer toolCallId alone is enough to classify a sanitized derivative.
  assert.equal(
    extracted.artifactKind,
    "sanitizedDerivativeOfAcceptedReceipt",
    "credential-shaped toolCallId must classify as sanitized derivative",
  );
  assert.notEqual(extracted.receipt!.toolCallId, callId);
  assert.equal(
    extracted.receipt!.toolCallId.includes(rawMarker),
    false,
    "extraction must already return sanitized Receipt call identity",
  );
  assert.equal(
    extracted.receipt!.toolCallId,
    extracted.auditObservation!.toolCallId,
    "Receipt/audit join before store",
  );

  // storeGeneratedJson / final-scan path: same objects the production writer persists.
  const storedReceipt = scanJsonValue(
    {
      toolName: extracted.receipt!.toolName,
      toolCallId: extracted.receipt!.toolCallId,
      details: extracted.receipt!.details,
      artifactKind: extracted.artifactKind,
    },
    "receipt",
  );
  const storedAudit = scanJsonValue(
    extracted.auditObservation,
    "auditObservation",
  );
  assert.equal(
    JSON.stringify(storedReceipt.value).includes(rawMarker),
    false,
    "extracted/stored receipt must drop raw marker",
  );
  assert.equal(
    JSON.stringify(storedAudit.value).includes(rawMarker),
    false,
    "stored audit observation must drop raw marker",
  );
  assert.equal(
    (storedReceipt.value as { toolCallId: string }).toolCallId,
    (storedAudit.value as { toolCallId: string }).toolCallId,
    "Receipt/audit toolCallId remain joined after sanitization",
  );
  assert.notEqual(
    (storedReceipt.value as { toolCallId: string }).toolCallId,
    callId,
  );

  const root = makeTempDir("ak-recorder-audit-cred-");
  try {
    const archive = initGitRepo(join(root, "archive"));
    const authority = commitFile(archive, "authority.md", "# authority\n");
    const task = commitFile(archive, "task.md", "# task\n");
    const counter = join(root, "counter.txt");

    const events = [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: callId,
            name: JUDGE_OUTPUT_TOOL_NAME,
            arguments: details,
          }],
        },
      },
      {
        type: "tool_execution_start",
        toolCallId: callId,
        toolName: JUDGE_OUTPUT_TOOL_NAME,
        args: details,
      },
      {
        type: "tool_execution_end",
        toolCallId: callId,
        toolName: JUDGE_OUTPUT_TOOL_NAME,
        isError: false,
        result: {
          content: [{ type: "text", text: ACCEPTED[JUDGE_OUTPUT_TOOL_NAME] }],
          details,
        },
      },
    ];

    // --- Success: full production promotion with credential-bearing call id ---
    const okScript = join(root, "judge-cred-ok.mjs");
    writeFileSync(
      okScript,
      `const events = ${JSON.stringify(events)};
for (const event of events) process.stdout.write(JSON.stringify(event) + "\\n");
process.exit(0);
`,
    );
    const okConfig = writeRecorderConfig(root, {
      archiveRepo: archive,
      cwd: root,
      docketId: "issues/10/apply/apply-audit-cred-ok",
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
    const ok = await runRecorderBin(
      ["--config", okConfig, "--", process.execPath, okScript],
      { cwd: root, env: { ...process.env, AK_RECORDER_COUNTER: counter } },
    );
    assert.equal(ok.code, 0, ok.stderr);

    const dest = join(
      archive,
      ".ak/dockets/issues/10/apply/apply-audit-cred-ok",
    );
    assert.equal(existsSync(join(dest, "receipt.json")), true);
    assert.equal(existsSync(join(dest, "audit-observation.json")), true);
    assert.equal(existsSync(join(dest, "manifest.json")), true);
    assert.equal(existsSync(join(dest, "redaction-report.json")), true);

    for (const file of walkFiles(dest)) {
      const body = readFileSync(file, "utf8");
      assert.equal(
        body.includes(rawMarker),
        false,
        `final docket leaked raw marker: ${file}`,
      );
      assert.equal(
        body.includes(callId),
        false,
        `final docket leaked callId: ${file}`,
      );
    }

    const receipt = JSON.parse(readFileSync(join(dest, "receipt.json"), "utf8"));
    const audit = JSON.parse(
      readFileSync(join(dest, "audit-observation.json"), "utf8"),
    );
    const manifest = JSON.parse(
      readFileSync(join(dest, "manifest.json"), "utf8"),
    );
    const report = JSON.parse(
      readFileSync(join(dest, "redaction-report.json"), "utf8"),
    );

    assert.equal(receipt.toolName, JUDGE_OUTPUT_TOOL_NAME);
    assert.equal(audit.toolName, JUDGE_OUTPUT_TOOL_NAME);
    assert.equal(audit.auditPassed, true);
    assert.equal(
      receipt.artifactKind,
      "sanitizedDerivativeOfAcceptedReceipt",
      "promoted receipt.json must carry derivative artifactKind",
    );
    assert.equal(
      manifest.receipt.artifactKind,
      "sanitizedDerivativeOfAcceptedReceipt",
    );
    const receiptArtifact = manifest.artifacts.find(
      (artifact: { id: string }) => artifact.id === "receipt",
    );
    assert.ok(receiptArtifact, "manifest must list the receipt artifact");
    assert.equal(
      receiptArtifact.receiptArtifactKind,
      "sanitizedDerivativeOfAcceptedReceipt",
    );
    assert.equal(receiptArtifact.redactionStatus, "sanitized-derivative");
    assert.equal(receipt.toolCallId, audit.toolCallId);
    assert.equal(manifest.receipt.toolCallId, receipt.toolCallId);
    assert.equal(manifest.auditObservation.toolCallId, audit.toolCallId);
    assert.equal(
      manifest.receipt.toolCallId,
      manifest.auditObservation.toolCallId,
      "manifest Receipt/audit identity remains joined after sanitization",
    );
    assert.notEqual(receipt.toolCallId, callId);
    assert.equal(JSON.stringify(receipt).includes(rawMarker), false);
    assert.equal(JSON.stringify(audit).includes(rawMarker), false);
    assert.equal(JSON.stringify(manifest).includes(rawMarker), false);
    assert.equal(JSON.stringify(report).includes(rawMarker), false);

    assert.ok(Array.isArray(manifest.redaction.hits));
    assert.ok(manifest.redaction.hits.length > 0);
    assert.deepEqual(report.hits, manifest.redaction.hits);
    for (const hit of report.hits) {
      assert.deepEqual(
        Object.keys(hit).sort(),
        ["count", "location", "ruleId"],
      );
      assert.equal(typeof hit.ruleId, "string");
      assert.equal(typeof hit.location, "string");
      assert.equal(typeof hit.count, "number");
      assert.equal(JSON.stringify(hit).includes(rawMarker), false);
      assert.equal(JSON.stringify(hit).includes(callId), false);
    }
    const { validatePublicManifest } = await import(
      "../src/recorder/manifest.ts"
    );
    validatePublicManifest(manifest);

    // --- Failure: same credential-bearing lifecycle + destination collision ---
    const failDocket = "issues/10/apply/apply-audit-cred-fail";
    const failConfig = writeRecorderConfig(root, {
      archiveRepo: archive,
      cwd: root,
      docketId: failDocket,
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
    const failScript = join(root, "judge-cred-collide.mjs");
    writeFileSync(
      failScript,
      `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const events = ${JSON.stringify(events)};
for (const event of events) process.stdout.write(JSON.stringify(event) + "\\n");
const dest = ${JSON.stringify(join(archive, ".ak/dockets", failDocket))};
mkdirSync(dest, { recursive: true });
writeFileSync(join(dest, "collision.txt"), "preexisting\\n");
process.exit(0);
`,
    );
    const fail = await runRecorderBin(
      ["--config", failConfig, "--", process.execPath, failScript],
      { cwd: root, env: { ...process.env, AK_RECORDER_COUNTER: counter } },
    );
    assert.equal(fail.code, 125, fail.stderr);
    // Tee remains byte-exact (caller-owned), including the raw call identity.
    assert.equal(fail.stdout.includes(callId), true);
    const failureLine = fail.stderr.trim().split("\n").at(-1)!;
    const failure = JSON.parse(failureLine);
    assert.equal(failure.recorder.status, "failed");
    assert.equal(failureLine.includes(rawMarker), false);
    assert.equal(failureLine.includes(callId), false);
    assert.equal(JSON.stringify(failure).includes(rawMarker), false);
    assert.equal(JSON.stringify(failure).includes(callId), false);
    if (typeof failure.child.diagnostic === "string") {
      assert.equal(failure.child.diagnostic.includes(rawMarker), false);
      assert.equal(failure.child.diagnostic.includes(callId), false);
    }
    assert.equal(
      existsSync(join(archive, ".ak/dockets", failDocket, "manifest.json")),
      false,
      "collision must not publish a complete final docket",
    );
    assert.equal(
      existsSync(join(archive, ".ak/dockets", failDocket, "receipt.json")),
      false,
    );
    assert.equal(
      existsSync(
        join(archive, ".ak/dockets", failDocket, "audit-observation.json"),
      ),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("structural metadata gate preserves non-structural credential sanitization matrix", async () => {
  // Representative forms beyond provider-token ids: assignment + header ride the
  // existing non-structural scanner paths (argv/context, receipt, copied bytes,
  // provenance, manifest/report) and must still sanitize rather than reject config.
  const root = makeTempDir("ak-recorder-meta-nonstruct-");
  try {
    const archive = initGitRepo(join(root, "archive"));
    const authority = commitFile(archive, "authority.md", "# authority\n");
    const task = commitFile(archive, "task.md", "# task\n");
    const script = writeCounterScript(root);
    const counter = join(root, "counter.txt");

    const header = "Authorization: Bearer plainsecrettokenvalue999";
    const genericAuth = "Authorization: Token plainsecrettokenvalue999";
    // Parameterized Authorization must promote with no complete field or suffix left.
    const parameterizedAuth =
      'Authorization: Digest username="Mufasa", realm="testrealm@host.com", response="6629fae49393a05397450978507c4ef1"';
    const assign = secrets.assign;
    // Admitted external input carries a generic Authorization scheme so promotion
    // must consume scheme+credential atomically (no secret suffix left behind).
    const inputBody = `body ${assign}\n${genericAuth}\n${parameterizedAuth}\n`;
    const inputPath = join(root, "assign-input.txt");
    writeFileSync(inputPath, inputBody);

    const configPath = writeRecorderConfig(root, {
      archiveRepo: archive,
      cwd: root,
      docketId: "issues/10/apply/apply-meta-nonstruct",
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
        id: "assign-input",
        sourcePath: inputPath,
        sha256: sha256File(inputBody),
        kind: "input",
      }],
      provenance: {
        package: null,
        model: `model ${header}`,
        target: null,
      },
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
        JSON.stringify({
          status: "completed",
          report: `done ${assign} ${header}`,
        }),
        header,
      ],
      { cwd: root, env: { ...process.env, AK_RECORDER_COUNTER: counter } },
    );
    assert.equal(result.code, 0, result.stderr);
    const dest = join(
      archive,
      ".ak/dockets/issues/10/apply/apply-meta-nonstruct",
    );
    assert.equal(existsSync(join(dest, "manifest.json")), true);
    for (const file of walkFiles(dest)) {
      const text = readFileSync(file, "utf8");
      assertNoRawSecret(`nonstruct:${file}`, text);
      assert.equal(
        text.includes("[REDACTED] plainsecrettokenvalue999"),
        false,
        `nonstruct-suffix:${file}`,
      );
    }
    const promotedInput = readFileSync(join(dest, "inputs/assign-input"), "utf8");
    assert.equal(promotedInput.includes("supersecretvalue999"), false);
    assert.equal(promotedInput.includes("plainsecrettokenvalue999"), false);
    assert.equal(
      promotedInput.includes("[REDACTED] plainsecrettokenvalue999"),
      false,
    );
    assert.equal(
      promotedInput.includes("6629fae49393a05397450978507c4ef1"),
      false,
    );
    assert.equal(promotedInput.includes('username="Mufasa"'), false);
    assert.equal(
      promotedInput.includes('realm="testrealm@host.com"'),
      false,
    );
    assert.equal(
      promotedInput.includes(
        'response="6629fae49393a05397450978507c4ef1"',
      ),
      false,
    );
    for (const file of walkFiles(dest)) {
      const text = readFileSync(file, "utf8");
      assert.equal(
        text.includes("6629fae49393a05397450978507c4ef1"),
        false,
        `digest-param:${file}`,
      );
      assert.equal(
        text.includes('username="Mufasa"'),
        false,
        `digest-user:${file}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
