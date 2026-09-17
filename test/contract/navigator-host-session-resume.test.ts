/**
 * #959: navigator prior advice stays on the host session via CLI resume.
 * Package only pins a host runId pointer — never a prose advice ledger.
 * Fresh mint only after typed load says principal cannot reopen (CliUsageError).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createNativeNavigatorSessionFactory,
  NAVIGATOR_HOST_RUN_POINTER_ENTRY,
  readNavigatorHostRunPointer,
  runIdFromNavigatorDirectory,
} from "../../src/navigator-public-session.ts";
import type { PublicSummonResult } from "../../src/public-role-summons.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { seedGitRepository } from "../helpers/pi-test-harness.ts";

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
