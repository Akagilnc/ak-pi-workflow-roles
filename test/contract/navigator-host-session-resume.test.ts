/**
 * #959: navigator prior advice stays on the host session via CLI resume.
 * Package only pins a host runId pointer — never a prose advice ledger.
 * Fresh mint only after typed load says principal cannot reopen (CliUsageError).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createNavigatorAttendance } from "../../src/navigator-attendance.ts";
import {
  createNativeNavigatorSessionFactory,
  NAVIGATOR_HOST_RUN_POINTER_ENTRY,
  readNavigatorHostRunPointer,
  runIdFromNavigatorDirectory,
} from "../../src/navigator-public-session.ts";
import { renderSystemPromptOverride } from "../../src/prepared-role-turn.ts";
import type { PublicSummonResult } from "../../src/public-role-summons.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { packageRoot, seedGitRepository } from "../helpers/pi-test-harness.ts";

test("runId is derived from navigator run directory basename", () => {
  assert.equal(runIdFromNavigatorDirectory("/book/runs/01abc@navigator"), "01abc");
  assert.equal(runIdFromNavigatorDirectory("/book/runs/01abc@judge"), undefined);
});

test("#959 second attendance prompt resumes the pinned host runId", async () => {
  await withTempRoot("navigator-host-resume-", async (root) => {
    seedGitRepository(root);
    await mkdir(join(root, ".ak-roles"), { recursive: true });
    await writeFile(
      join(root, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ seats: { navigator: { provider: "provider", model: "model" } } }, null, 2)}\n`,
    );

    const runDirectory = join(root, ".ak-roles", "books", "probe", "unbound", "runs", "01navhost@navigator");
    await mkdir(join(runDirectory, "session"), { recursive: true });
    // Materialize a principal file so typed loadResumable path can succeed if used;
    // this case injects summon and forces resumable via first mint pointer only.
    await writeFile(
      join(runDirectory, "session", "session.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "01navhost", timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`,
    );

    const summons: Array<{ resumeRunId?: string; argv: readonly string[] }> = [];
    let call = 0;
    const summon = async (options: {
      readonly role: "navigator";
      readonly argv: readonly string[];
      readonly cwd: string;
      readonly home?: string;
      readonly resumeRunId?: string;
    }): Promise<PublicSummonResult> => {
      summons.push({
        argv: options.argv,
        ...(options.resumeRunId === undefined ? {} : { resumeRunId: options.resumeRunId }),
      });
      call += 1;
      if (call === 1) {
        assert.equal(options.resumeRunId, undefined, "first prompt mints");
        return {
          exitCode: 0,
          runDirectory,
          terminal: {
            roleOutcome: {
              kind: "accepted",
              payloads: [{ prose: "第一次建议" }],
            },
          } as never,
        };
      }
      assert.equal(options.resumeRunId, "01navhost", "second prompt must CLI-resume the pinned run");
      return {
        exitCode: 0,
        runDirectory,
        terminal: {
          roleOutcome: {
            kind: "accepted",
            payloads: [{ prose: "第二次建议" }],
          },
        } as never,
      };
    };

    const prepared: string[] = [];
    const parentRun = join(root, ".ak-roles", "books", "probe", "unbound", "runs", "parent@coder");
    await mkdir(join(parentRun, "session"), { recursive: true });

    const session = await createNativeNavigatorSessionFactory({
      summonPublicRole: summon,
      // Second prompt: treat pinned run as resumable without going through disk load.
      hostRunResumable: async (_home, runId) => runId === "01navhost",
    })({
      context: {
        cwd: root,
        runDirectory: parentRun,
        sessionManager: undefined,
      } as never,
      subject: "/work/subject-resume",
      tool: {
        name: "ak_navigator_prepare",
        async execute(_id: string, value: { prose?: string }) {
          prepared.push(String(value.prose ?? ""));
          return { content: [{ type: "text", text: "ok" }], details: value };
        },
      } as never,
    });

    await session.prompt("materials-one");
    assert.equal(prepared[0], "第一次建议");
    assert.equal(
      readNavigatorHostRunPointer(session.entries() as readonly unknown[]),
      "01navhost",
    );
    assert.ok(
      (session.entries() as readonly unknown[]).some(
        (entry) =>
          typeof entry === "object"
          && entry !== null
          && (entry as { customType?: string }).customType === NAVIGATOR_HOST_RUN_POINTER_ENTRY,
      ),
    );

    await session.prompt("materials-two");
    assert.equal(prepared[1], "第二次建议");
    assert.equal(summons.length, 2);
    assert.equal(summons[0]?.resumeRunId, undefined);
    assert.equal(summons[1]?.resumeRunId, "01navhost");
    await session.dispose();
  });
});

test("#959 non-resumable preflight mints once; resume transport failure does not remint", async () => {
  await withTempRoot("navigator-host-resume-fail-", async (root) => {
    seedGitRepository(root);
    const runDirectory = join(root, ".ak-roles", "books", "probe", "unbound", "runs", "01navfail@navigator");
    await mkdir(join(runDirectory, "session"), { recursive: true });
    const parentRun = join(root, ".ak-roles", "books", "probe", "unbound", "runs", "parent@coder");
    await mkdir(join(parentRun, "session"), { recursive: true });

    let calls = 0;
    const summon = async (options: {
      readonly role: "navigator";
      readonly argv: readonly string[];
      readonly cwd: string;
      readonly home?: string;
      readonly resumeRunId?: string;
    }): Promise<PublicSummonResult> => {
      calls += 1;
      if (options.resumeRunId !== undefined) {
        return {
          exitCode: 1,
          stderr: "provider auth down",
          terminal: {
            roleOutcome: {
              kind: "failure",
              diagnostic: "provider auth down",
              decisiveFacts: {},
            },
          } as never,
        };
      }
      return {
        exitCode: 0,
        runDirectory,
        terminal: {
          roleOutcome: {
            kind: "accepted",
            payloads: [{ prose: "ok" }],
          },
        } as never,
      };
    };

    const session = await createNativeNavigatorSessionFactory({
      summonPublicRole: summon,
      hostRunResumable: async () => true,
    })({
      context: {
        cwd: root,
        runDirectory: parentRun,
      } as never,
      subject: "/work/subject-fail",
      tool: {
        name: "ak_navigator_prepare",
        async execute() {
          return { content: [{ type: "text", text: "ok" }], details: {} };
        },
      } as never,
    });

    await session.prompt("first");
    assert.equal(calls, 1);
    await assert.rejects(
      () => session.prompt("second"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /auth|provider/i);
        return true;
      },
    );
    assert.equal(calls, 2, "auth failure on resume must not open a third fresh mint");
    await session.dispose();
  });
});

test("#959 dispose during resume preflight must not start summon", async () => {
  // Legal HostContext.signal absence. First prompt pins a host run; second blocks in
  // hostRunResumable; dispose before release must close admission — summon never starts
  // (ADR 0018 / #959 continue: preflight race, not only late side effects).
  await withTempRoot("navigator-host-dispose-preflight-", async (root) => {
    seedGitRepository(root);
    const firstDir = join(root, ".ak-roles", "books", "probe", "unbound", "runs", "01navpre1@navigator");
    await mkdir(join(firstDir, "session"), { recursive: true });
    const parentRun = join(root, ".ak-roles", "books", "probe", "unbound", "runs", "parent@coder");
    await mkdir(join(parentRun, "session"), { recursive: true });

    let releasePreflight: (() => void) | undefined;
    const preflightGate = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    let preflightChecks = 0;
    let summonCalls = 0;
    let prepared = 0;
    const summon = async (): Promise<PublicSummonResult> => {
      summonCalls += 1;
      return {
        exitCode: 0,
        runDirectory: firstDir,
        terminal: {
          roleOutcome: {
            kind: "accepted",
            payloads: [{ prose: `summon-${summonCalls}` }],
          },
        } as never,
      };
    };

    const session = await createNativeNavigatorSessionFactory({
      summonPublicRole: summon,
      hostRunResumable: async () => {
        preflightChecks += 1;
        if (preflightChecks === 1) {
          await preflightGate;
          return true;
        }
        return false;
      },
    })({
      context: {
        cwd: root,
        runDirectory: parentRun,
        // No signal — legal HostContext; factory must still refuse post-dispose summon.
      } as never,
      subject: "/work/subject-dispose-preflight",
      tool: {
        name: "ak_navigator_prepare",
        async execute() {
          prepared += 1;
          return { content: [{ type: "text", text: "ok" }], details: {} };
        },
      } as never,
    });

    await session.prompt("pin-host-run");
    assert.equal(summonCalls, 1);
    const pinned = readNavigatorHostRunPointer(session.entries() as readonly unknown[]);
    assert.equal(pinned, "01navpre1");

    const secondPrompt = session.prompt("blocked-in-preflight");
    // Let the second prompt reach hostRunResumable before dispose.
    for (let i = 0; i < 20 && preflightChecks < 1; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(preflightChecks, 1, "second prompt must enter resumable preflight");
    assert.equal(summonCalls, 1, "summon must not start while preflight is gated");

    await session.dispose();
    releasePreflight?.();
    await secondPrompt;

    assert.equal(summonCalls, 1, "dispose during preflight must not start a new summon");
    assert.equal(
      readNavigatorHostRunPointer(session.entries() as readonly unknown[]),
      pinned,
      "blocked second prompt must not rewrite host-run pointer after dispose",
    );
    assert.equal(prepared, 1, "only the first live prompt may prepare");
    assert.equal(
      (session.entries() as readonly unknown[]).filter(
        (entry) =>
          typeof entry === "object"
          && entry !== null
          && (entry as { customType?: string }).customType === NAVIGATOR_HOST_RUN_POINTER_ENTRY,
      ).length,
      1,
    );
  });
});

test("#959 typed non-resumable preflight allows one fresh mint", async () => {
  await withTempRoot("navigator-host-resume-absent-", async (root) => {
    seedGitRepository(root);
    const firstDir = join(root, ".ak-roles", "books", "probe", "unbound", "runs", "01navfirst@navigator");
    const mintedDir = join(root, ".ak-roles", "books", "probe", "unbound", "runs", "01navminted@navigator");
    await mkdir(join(firstDir, "session"), { recursive: true });
    await mkdir(join(mintedDir, "session"), { recursive: true });
    const parentRun = join(root, ".ak-roles", "books", "probe", "unbound", "runs", "parent@coder");
    await mkdir(join(parentRun, "session"), { recursive: true });

    let calls = 0;
    let allowResume = false;
    const summon = async (options: {
      readonly role: "navigator";
      readonly argv: readonly string[];
      readonly cwd: string;
      readonly home?: string;
      readonly resumeRunId?: string;
    }): Promise<PublicSummonResult> => {
      calls += 1;
      assert.equal(
        options.resumeRunId,
        undefined,
        "when preflight says non-resumable, summon must mint without resumeRunId",
      );
      const runDirectory = calls === 1 ? firstDir : mintedDir;
      return {
        exitCode: 0,
        runDirectory,
        terminal: {
          roleOutcome: {
            kind: "accepted",
            payloads: [{ prose: `mint-${calls}` }],
          },
        } as never,
      };
    };

    const session = await createNativeNavigatorSessionFactory({
      summonPublicRole: summon,
      hostRunResumable: async () => allowResume,
    })({
      context: {
        cwd: root,
        runDirectory: parentRun,
      } as never,
      subject: "/work/subject-absent",
      tool: {
        name: "ak_navigator_prepare",
        async execute() {
          return { content: [{ type: "text", text: "ok" }], details: {} };
        },
      } as never,
    });

    allowResume = false;
    await session.prompt("first-mint");
    assert.equal(calls, 1);
    assert.equal(readNavigatorHostRunPointer(session.entries() as readonly unknown[]), "01navfirst");

    // Pinned run is no longer resumable (typed preflight false) → one fresh mint.
    allowResume = false;
    await session.prompt("after-absence");
    assert.equal(calls, 2, "non-resumable preflight → single fresh mint");
    assert.equal(readNavigatorHostRunPointer(session.entries() as readonly unknown[]), "01navminted");
    await session.dispose();
  });
});

test("fresh navigator settlement keeps subject and authority on the nest base", async () => {
  await withTempRoot("navigator-work-base-", async (root) => {
    seedGitRepository(root);
    await mkdir(join(root, ".ak-roles"), { recursive: true });
    await writeFile(
      join(root, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ seats: { navigator: { provider: "provider", model: "model" } } }, null, 2)}\n`,
    );
    const parentRun = join(root, ".ak-roles", "books", "probe", "unbound", "runs", "parent@coder");
    await mkdir(join(parentRun, "session"), { recursive: true });
    const authority = "authority-token-9f3c";
    const subject = "task-bytes-9f3c";
    const subjectKey = `${join(root, ".ak/work")}#ad-hoc`;
    const summons: string[] = [];
    const nav = createNavigatorAttendance({
      context: {
        cwd: root,
        home: root,
        runDirectory: parentRun,
      } as never,
      role: "coder",
      phase: "apply",
      subjectKey,
      subject,
      authority,
      createSession: createNativeNavigatorSessionFactory({
        summonPublicRole: async (options) => {
          summons.push(options.argv[0] ?? "");
          return {
            exitCode: 0,
            runDirectory: join(root, ".ak-roles", "books", "probe", "unbound", "runs", "01navbase@navigator"),
            terminal: {
              roleOutcome: { kind: "accepted", payloads: [{ prose: "下一步" }] },
            },
          } as never;
        },
        hostRunResumable: async () => false,
      }),
      onEvent: () => {},
    });

    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.equal(summons.length, 2);
    for (const argv of summons) {
      assert.equal(argv.includes(authority), false);
      assert.equal(argv.includes(subject), false);
      const fed = JSON.parse(argv) as { workContextPath?: string; subjectKey?: string };
      assert.equal(fed.subjectKey, subjectKey);
      assert.equal(typeof fed.workContextPath, "string");
      const stored = JSON.parse(await readFile(fed.workContextPath ?? "", "utf8")) as {
        subject: string;
        authority: string;
      };
      assert.equal(stored.subject, subject);
      assert.equal(stored.authority, authority);
    }

    const delivered = summons[0] ?? "";
    const runDirectory = join(root, ".ak-roles", "books", "probe", "unbound", "runs", "01navdeliver@navigator");
    await mkdir(join(runDirectory, "session"), { recursive: true });
    const prepared = await prepareRoleEnvelope({
      request: {
        principal: fixturePrincipal(join(runDirectory, "session")),
        activation: { role: "navigator" },
        methods: [],
        continuation: { kind: "initial", prompt: delivered },
        cwd: root,
        home: root,
        agentDir: join(root, "agent"),
        runDirectory,
      },
      dependencies: createRoleRuntimeDependencies(packageRoot),
      socketPath: join(root, "mcp.sock"),
    });
    try {
      assert.equal(prepared.prompt, delivered);
      const modelInput = renderSystemPromptOverride(prepared.systemPrompt);
      assert.equal(modelInput.includes(subject), true);
      assert.equal(modelInput.includes(authority), true);
    } finally {
      await prepared.dispose?.();
    }
    await nav.dispose();
  });
});
