/**
 * #959: navigator prior advice stays on the host session via CLI resume.
 * Package only pins a host runId pointer — never a prose advice ledger.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createNativeNavigatorSessionFactory,
  isNavigatorResumePrincipalAbsence,
  NAVIGATOR_HOST_RUN_POINTER_ENTRY,
  readNavigatorHostRunPointer,
  runIdFromNavigatorDirectory,
} from "../../src/navigator-public-session.ts";
import type { PublicSummonResult } from "../../src/public-role-summons.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { seedGitRepository } from "../helpers/pi-test-harness.ts";

test("resume principal absence is only the structured CLI surfaces", () => {
  assert.equal(
    isNavigatorResumePrincipalAbsence({
      exitCode: 2,
      stderr: "role run Pi session principal is unavailable: abc",
    }),
    true,
  );
  assert.equal(
    isNavigatorResumePrincipalAbsence({
      exitCode: 2,
      stderr: "unknown role run id: abc",
    }),
    true,
  );
  assert.equal(
    isNavigatorResumePrincipalAbsence({
      exitCode: 1,
      stderr: "provider auth down",
    }),
    false,
    "auth/transport failures must not look like principal absence",
  );
  assert.equal(
    isNavigatorResumePrincipalAbsence({
      exitCode: 1,
      terminal: {
        roleOutcome: { kind: "failure", diagnostic: "quota", decisiveFacts: {} },
      } as never,
      stderr: "session principal is unavailable",
    }),
    false,
    "a finished failure terminal is never treated as absence",
  );
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
    const session = await createNativeNavigatorSessionFactory({ summonPublicRole: summon })({
      context: {
        cwd: root,
        runDirectory: join(root, ".ak-roles", "books", "probe", "unbound", "runs", "parent@coder"),
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

test("#959 non-absence resume failure stays unavailable — no catch-all fresh mint", async () => {
  await withTempRoot("navigator-host-resume-fail-", async (root) => {
    seedGitRepository(root);
    const runDirectory = join(root, ".ak-roles", "books", "probe", "unbound", "runs", "01navfail@navigator");
    await mkdir(join(runDirectory, "session"), { recursive: true });

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
        // Structured transport failure on resume — must NOT trigger a second mint.
        return {
          exitCode: 1,
          stderr: "provider auth down",
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

    const session = await createNativeNavigatorSessionFactory({ summonPublicRole: summon })({
      context: {
        cwd: root,
        runDirectory: join(root, ".ak-roles", "books", "probe", "unbound", "runs", "parent@coder"),
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
        assert.match(error.message, /no terminal|auth|provider/i);
        return true;
      },
    );
    assert.equal(calls, 2, "auth failure on resume must not open a third fresh mint");
    await session.dispose();
  });
});

test("#959 principal absence on resume may mint once", async () => {
  await withTempRoot("navigator-host-resume-absent-", async (root) => {
    seedGitRepository(root);
    const firstDir = join(root, ".ak-roles", "books", "probe", "unbound", "runs", "01navfirst@navigator");
    const mintedDir = join(root, ".ak-roles", "books", "probe", "unbound", "runs", "01navminted@navigator");
    await mkdir(join(firstDir, "session"), { recursive: true });
    await mkdir(join(mintedDir, "session"), { recursive: true });

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
          exitCode: 2,
          stderr: `role run Pi session principal is unavailable: ${options.resumeRunId}`,
        };
      }
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

    const session = await createNativeNavigatorSessionFactory({ summonPublicRole: summon })({
      context: {
        cwd: root,
        runDirectory: join(root, ".ak-roles", "books", "probe", "unbound", "runs", "parent@coder"),
      } as never,
      subject: "/work/subject-absent",
      tool: {
        name: "ak_navigator_prepare",
        async execute() {
          return { content: [{ type: "text", text: "ok" }], details: {} };
        },
      } as never,
    });

    await session.prompt("first-mint");
    assert.equal(calls, 1);
    assert.equal(readNavigatorHostRunPointer(session.entries() as readonly unknown[]), "01navfirst");

    await session.prompt("after-absence");
    assert.equal(calls, 3, "resume absence + one fresh mint");
    assert.equal(readNavigatorHostRunPointer(session.entries() as readonly unknown[]), "01navminted");
    await session.dispose();
  });
});
