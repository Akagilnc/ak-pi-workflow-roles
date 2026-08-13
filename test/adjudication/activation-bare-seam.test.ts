import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  ActivationGitRepositoryRequiredError,
  createRoleRuntimeExtension,
  type ActivationTraceRecord,
  type ToolExecutionObservationRecord,
} from "../../src/role-runtime.ts";
import {
  activationBookKeyFor,
  activationExtensionContext,
  machineLedgerHome,
  persistActivationSessionFile,
  readAcceptedActivationFacts,
  seedGitRepository,
  withActivationHome,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";

const originalExitCode = process.exitCode;
afterEach(() => { process.exitCode = originalExitCode; });

type CapturedExtensionHandler = (
  event: Record<string, unknown>,
  ctx: ExtensionContext,
) => unknown;

/**
 * Adjudication-local handler capture for bare-seam topology/failure paths that
 * ordinary withInProcessPi + ExtensionRunner cannot reach. Not a shared harness.
 */
function captureExtensionHandlers(
  install: (pi: ExtensionAPI) => void,
  options: {
    getFlag?: (name: string) => unknown;
  } = {},
): {
  handlers: Map<string, CapturedExtensionHandler[]>;
} {
  const handlers = new Map<string, CapturedExtensionHandler[]>();
  const tools = new Map<string, { name: string }>();
  let activeTools: string[] = [];
  const pi = {
    registerFlag() {},
    registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
    setActiveTools(names: string[]) { activeTools = [...names]; },
    getActiveTools() { return [...activeTools]; },
    getAllTools() { return [...tools.values()]; },
    getCommands() { return []; },
    getFlag(name: string) { return options.getFlag?.(name); },
    on(name: string, handler: CapturedExtensionHandler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  install(pi);
  return { handlers };
}

/**
 * Judge-only failure/trace probe — topology/failure path that withInProcessPi cannot
 * inject (custom activationTraceWriter + mode exit-code).
 */
function runtimeHarness(options: {
  activate?: () => Promise<string>;
  clock?: () => string;
  writeTrace?: (record: ActivationTraceRecord) => void | Promise<void>;
  mode?: ExtensionContext["mode"];
  home: string;
}) {
  type Handler = (event: { reason?: string; systemPrompt?: string }, ctx: ExtensionContext) => unknown;
  const traces: ActivationTraceRecord[] = [];
  let aborts = 0;
  const { handlers } = captureExtensionHandlers(
    (pi) => createRoleRuntimeExtension({
      loadJudgeSoul: options.activate ?? (async () => { throw new TypeError("soul unavailable"); }),
      transcriptFromContext: () => "", auditSoulCompliance: async () => ({ status: "pass" }),
      activationClock: options.clock ?? (() => "2025-01-01T00:00:00.000Z"),
      activationTraceWriter: options.writeTrace ?? ((record) => { traces.push(record); }),
    })(pi),
    { getFlag: (name) => name === "ak-role" ? "judge" : undefined },
  );
  const ctx = activationExtensionContext({
    cwd: options.home,
    mode: options.mode ?? "print",
    abort() { aborts++; },
  });
  const handler = (name: string): Handler => {
    const found = handlers.get(name)?.[0];
    assert.ok(found, `missing ${name} handler`);
    return found as Handler;
  };
  return { handler, traces, ctx, aborts: () => aborts };
}

test("non-git cwd and durable session rejection classes fail before model dispatch with zero accepted facts", async () => {
  // Topology/failure probe: custom session principals and non-git cwd are unreachable via
  // withInProcessPi's fixed durable-session opt-in.
  await withHermeticHome({ prefix: "ak-act-nongit-" }, async ({ home }) => {
    process.exitCode = undefined;
    let aborts = 0;
    let soulLoads = 0;
    const judgeDeps = () => ({
      loadJudgeSoul: async () => { soulLoads += 1; return "LAW"; },
      transcriptFromContext: () => "",
      auditSoulCompliance: async () => ({ status: "pass" as const }),
      activationTraceWriter: () => {},
    });
    const { handlers } = captureExtensionHandlers(
      (pi) => createRoleRuntimeExtension(judgeDeps())(pi),
      { getFlag: (name) => name === "ak-role" ? "judge" : undefined },
    );
    // Hermetic home is intentionally not a git repo (generic withHermeticHome has no git substrate).
    // Pre-create a ledger session so non-git fails on book-key, not session placement.
    const bookKey = activationBookKeyFor(home);
    const ctx = activationExtensionContext({
      cwd: home,
      home,
      bookKey,
      abort() { aborts++; },
    });
    await assert.rejects(async () => handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx), (error: unknown) => {
      assert.ok(error instanceof ActivationGitRepositoryRequiredError);
      assert.equal(error.code, "AK_ACTIVATION_GIT_REPOSITORY_REQUIRED");
      assert.ok(error.cause !== undefined, "original git cause must be retained");
      return true;
    });
    assert.equal(soulLoads, 0, "activation stage must not run before book-key resolution");
    assert.equal(readAcceptedActivationFacts(home, bookKey).length, 0);
    assert.equal(aborts, 1);
    assert.equal(process.exitCode, 1);

    seedGitRepository(home);

    async function rejectSessionClass(
      label: string,
      sessionFile: string | null,
      requireCause = false,
    ): Promise<void> {
      process.exitCode = undefined;
      aborts = 0;
      soulLoads = 0;
      const beforeFacts = readAcceptedActivationFacts(home, bookKey).length;
      const { handlers: roleHandlers } = captureExtensionHandlers(
        (pi) => createRoleRuntimeExtension(judgeDeps())(pi),
        { getFlag: (name) => name === "ak-role" ? "judge" : undefined },
      );
      const rejectCtx = activationExtensionContext({
        cwd: home,
        home,
        bookKey,
        sessionFile,
        abort() { aborts++; },
      });
      await assert.rejects(
        async () => roleHandlers.get("session_start")?.[0]?.({ reason: "startup" }, rejectCtx),
        (error: unknown) => {
          assert.ok(error instanceof Error, `${label} must throw Error`);
          if (requireCause) assert.ok(error.cause !== undefined, `${label} must retain original cause`);
          return true;
        },
      );
      assert.equal(soulLoads, 0, `${label}: activation stage must not run`);
      assert.equal(readAcceptedActivationFacts(home, bookKey).length, beforeFacts, `${label}: zero facts`);
      assert.equal(aborts, 1, `${label}: abort once`);
      assert.equal(process.exitCode, 1, `${label}: nonzero exit`);
    }

    // Missing getSessionFile principal (empty / --no-session).
    await rejectSessionClass("missing principal", null);

    // Fabricated path under the book: neither file nor parent session-dir exists.
    await rejectSessionClass(
      "missing file",
      join(machineLedgerHome(home), "books", bookKey, "runs", "no-such", "missing.jsonl"),
      true,
    );

    // Deferred path: parent session-dir exists but file is absent and no live header — reject.
    const deferredDir = join(machineLedgerHome(home), "books", bookKey, "runs", "deferred-only");
    mkdirSync(deferredDir, { recursive: true });
    await rejectSessionClass("deferred missing file", join(deferredDir, "session.jsonl"), true);

    // Directory masquerading as the session file principal.
    const dirPrincipal = join(machineLedgerHome(home), "books", bookKey, "runs", "dir-principal");
    mkdirSync(dirPrincipal, { recursive: true });
    await rejectSessionClass("directory principal", dirPrincipal);

    // Relative path rejected (must be absolute — placement under the book is sitian's job).
    await rejectSessionClass("relative path", "relative/session.jsonl");

    // Outside-home /tmp pointer with no file: still rejected (cannot materialize outside home).
    await rejectSessionClass("outside-home /tmp", join(tmpdir(), "ak-act-outside-session.jsonl"));

    // Consumer-repository pointer with no file: still rejected (cannot materialize outside home).
    await rejectSessionClass("consumer repository", join(home, "repo-session.jsonl"));

    // Symlink escape is no longer an activation rejection class (ADR 0065 / #221):
    // record-placement enforcement moved to createRecordSession. An existing regular
    // file principal is admitted even when realpath leaves the book.
  });
});

test("append failure preserves original cause and aborts nonzero", async () => {
  // Topology probe: book-dir chmod errno path is clearer at the handler seam than full Pi bind.
  await withActivationHome({ prefix: "ak-act-append-" }, async ({ home }) => {
    process.exitCode = undefined;
    const bookKey = activationBookKeyFor(home);
    // Persist the durable session principal, then lock the book dir so O_APPEND fails.
    const sessionFile = persistActivationSessionFile({ home, bookKey, cwd: home });
    const bookDir = join(machineLedgerHome(home), "books", bookKey);
    chmodSync(bookDir, 0o555);
    let aborts = 0;
    try {
      const { handlers } = captureExtensionHandlers(
        (pi) => createRoleRuntimeExtension({
          loadJudgeSoul: async () => "LAW",
          transcriptFromContext: () => "",
          auditSoulCompliance: async () => ({ status: "pass" }),
          activationTraceWriter: () => {},
        })(pi),
        { getFlag: (name) => name === "ak-role" ? "judge" : undefined },
      );
      const ctx = activationExtensionContext({
        cwd: home,
        home,
        bookKey,
        sessionFile,
        abort() { aborts++; },
      });
      await assert.rejects(async () => handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx), (error: unknown) => {
        assert.ok(error instanceof Error);
        const codes: string[] = [];
        let current: unknown = error;
        const seen = new Set<unknown>();
        while (current !== null && typeof current === "object" && !seen.has(current)) {
          seen.add(current);
          if ("code" in current && typeof (current as { code: unknown }).code === "string") {
            codes.push((current as { code: string }).code);
          }
          current = "cause" in current ? (current as { cause: unknown }).cause : undefined;
        }
        assert.ok(
          codes.includes("EACCES") || codes.includes("EPERM"),
          `append failure must retain typed errno cause, got codes=${codes.join(",") || "none"}`,
        );
        return true;
      });
      assert.equal(aborts, 1);
      assert.equal(process.exitCode, 1);
    } finally {
      chmodSync(bookDir, 0o755);
    }
  });
});

test("failed trace emission cannot mask the activation cause or skip termination", async () => {
  await withActivationHome({ prefix: "ak-act-trace-" }, async ({ home }) => {
    const activationError = new TypeError("soul unavailable");
    const traceError = new Error("trace unavailable");
    let writes = 0;
    const h = runtimeHarness({
      home,
      activate: async () => { throw activationError; },
      writeTrace: async () => { if (++writes === 1) throw traceError; },
    });
    await assert.rejects(
      async () => h.handler("session_start")({}, h.ctx),
      (error: unknown) => error instanceof AggregateError && error.errors[0] === activationError && error.errors[1] === traceError,
    );
    assert.equal(h.aborts(), 1);
    assert.equal(process.exitCode, 1);
  });
});

for (const [mode, expected] of [["print", 1], ["json", 1], ["tui", undefined], ["rpc", undefined]] as const) {
  test(`activation failure applies ${mode} exit-code policy`, async () => {
    await withActivationHome({ prefix: `ak-act-mode-${mode}-` }, async ({ home }) => {
      process.exitCode = undefined;
      const h = runtimeHarness({ home, mode });
      await assert.rejects(async () => h.handler("session_start")({}, h.ctx));
      assert.equal(process.exitCode, expected);
    });
  });
}

test("shared role runtime registers tool observation only after admitted activation and never writes stdout", async () => {
  // Pre/post-admission observation ordering needs a custom writer on the same handler set;
  // withInProcessPi cannot inject toolExecutionObservationWriter between events this tightly.
  await withActivationHome({ prefix: "ak-act-obs-" }, async ({ home }) => {
    const observations: ToolExecutionObservationRecord[] = [];
    const { handlers } = captureExtensionHandlers(
      (pi) => createRoleRuntimeExtension({
        loadJudgeSoul: async () => "LAW",
        transcriptFromContext: () => "",
        auditSoulCompliance: async () => ({ status: "pass" }),
        activationClock: () => "2025-01-01T00:00:00.000Z",
        activationTraceWriter: () => {},
        toolExecutionObservationWriter: (record) => { observations.push(record); },
      })(pi),
      { getFlag: (name) => name === "ak-role" ? "judge" : undefined },
    );

    const startHandler = handlers.get("tool_execution_start")?.[0];
    const updateHandler = handlers.get("tool_execution_update")?.[0];
    const endHandler = handlers.get("tool_execution_end")?.[0];
    assert.ok(startHandler && updateHandler && endHandler);

    await startHandler({ toolCallId: "pre", toolName: "bash" }, activationExtensionContext({ cwd: home }));
    await updateHandler({ toolCallId: "pre", toolName: "bash", partialResult: { content: [{ type: "text", text: "x" }] } }, activationExtensionContext({ cwd: home }));
    await endHandler({ toolCallId: "pre", toolName: "bash", isError: false }, activationExtensionContext({ cwd: home }));
    assert.equal(observations.length, 0);

    const sessionStart = handlers.get("session_start")?.[0];
    assert.ok(sessionStart);
    await sessionStart({ reason: "startup" }, activationExtensionContext({ cwd: home }));
    assert.equal(readAcceptedActivationFacts(home, activationBookKeyFor(home)).length, 1);

    await startHandler({ toolCallId: "post", toolName: "bash" }, activationExtensionContext({ cwd: home }));
    await updateHandler({ toolCallId: "post", toolName: "bash", partialResult: { content: [] } }, activationExtensionContext({ cwd: home }));
    await updateHandler({ toolCallId: "post", toolName: "bash", partialResult: { content: [{ type: "text", text: "hello" }] } }, activationExtensionContext({ cwd: home }));
    await endHandler({ toolCallId: "post", toolName: "bash", isError: true }, activationExtensionContext({ cwd: home }));
    assert.deepEqual(observations.map((record) => ({
      event: record.event,
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      role: record.role,
      ...(record.event === "tool_execution_end" ? { isError: record.isError } : {}),
    })), [
      { event: "tool_execution_start", toolCallId: "post", toolName: "bash", role: "judge" },
      { event: "tool_execution_update", toolCallId: "post", toolName: "bash", role: "judge" },
      { event: "tool_execution_end", toolCallId: "post", toolName: "bash", role: "judge", isError: true },
    ]);
  });
});
