import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  RoleTurnHost,
  RoleTurnRequest,
  RoleTurnResult,
} from "../../src/host-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import {
  dispatchPostAdmissionTurn,
  runPostAdmissionManualResume,
  runPostAdmissionOneShot,
  runPostAdmissionResumable,
  type PostAdmissionAdapters,
  type PostAdmissionEnv,
} from "../../src/public-cli/post-admission.ts";
import type { AdmittedDoctorInvocation } from "../../src/public-cli/invocation.ts";
import type { TerminalResult } from "../../src/public-cli/terminal.ts";

test("runPostAdmissionOneShot coordinates admitted -> lease -> running -> executeTurn -> settle -> terminal -> release", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ak-test-post-adm-"));
  try {
    const runDirectory = join(tempDir, "run");
    const sessionDir = join(runDirectory, "session");
    await mkdir(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, "session.jsonl");

    const authority = piDurablePrincipalAuthority;
    const principal = {
      sessionDirectory: sessionDir,
      sessionFile,
    } as never;

    const admitted: AdmittedDoctorInvocation = {
      role: "doctor",
      runId: "019f8c2a-7b3e-7d11-8a4f-1c2d3e4f5a6b",
      bookKey: "test-book",
      projectRoot: tempDir,
      instruction: "diagnose case",
      instructionEmpty: false,
      attachments: [],
      runDirectory,
      principal,
      admittedRequestPath: join(runDirectory, "admitted-request.json"),
      issueNumber: 123,
      caseRunsPath: join(tempDir, "case"),
      caseIdentity: {
        issueNumber: 123,
        runsPath: join(tempDir, "case"),
      },
    };

    let executed = false;
    const mockHost: RoleTurnHost = {
      async executeTurn(request: RoleTurnRequest): Promise<RoleTurnResult> {
        executed = true;
        return {
          code: 0,
          stderr: "turn stderr log",
          timedOut: false,
        };
      },
    };

    const env: PostAdmissionEnv = {
      home: tempDir,
      agentDir: join(tempDir, "agent"),
      packageRoot: tempDir,
      cwd: tempDir,
      roleTurnHost: mockHost,
      principalAuthority: authority,
    };

    let settled = false;
    const mockTerminal: TerminalResult = {
      roleOutcome: {
        kind: "accepted",
        role: "doctor",
        status: "completed",
        decisiveFacts: { doctorStatus: "completed" },
      },
      navigator: { disposition: "no-advice" },
      artifacts: [],
      runId: admitted.runId,
    };

    const adapters: PostAdmissionAdapters<AdmittedDoctorInvocation> = {
      trySettle: async (admittedDoc, auth) => {
        settled = true;
        return mockTerminal;
      },
      shouldPresentSettled: () => true,
    };

    let stdoutText = "";
    const io = {
      stdout: (text: string) => { stdoutText += text; },
      stderr: (_text: string) => {},
    };

    const turnRequest: RoleTurnRequest = {
      principal,
      activation: { role: "doctor", casePath: admitted.caseRunsPath },
      methods: [],
      continuation: { kind: "initial", prompt: "start" },
      cwd: tempDir,
      home: tempDir,
      agentDir: join(tempDir, "agent"),
      runDirectory,
    };

    const result = await runPostAdmissionOneShot({
      admitted,
      env,
      io,
      request: turnRequest,
      adapters,
    });

    assert.equal(executed, true, "host.executeTurn must be called");
    assert.equal(settled, true, "adapter.trySettle must be called");
    assert.equal(result.exitCode, 0, "completed doctor must exit 0");
    assert.deepEqual(result.terminal, mockTerminal);

    const runState = JSON.parse(await readFile(join(runDirectory, "run-state.json"), "utf8")) as { state: string };
    assert.equal(runState.state, "terminal", "run-state must transition to terminal");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runPostAdmissionOneShot handles execution throw as controlled failure", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ak-test-post-adm-err-"));
  try {
    const runDirectory = join(tempDir, "run");
    const sessionDir = join(runDirectory, "session");
    await mkdir(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, "session.jsonl");

    const authority = piDurablePrincipalAuthority;
    const principal = {
      sessionDirectory: sessionDir,
      sessionFile,
    } as never;

    const admitted: AdmittedDoctorInvocation = {
      role: "doctor",
      runId: "019f8c2a-7b3e-7d11-8a4f-1c2d3e4f5a6b",
      bookKey: "test-book",
      projectRoot: tempDir,
      instruction: "diagnose case",
      instructionEmpty: false,
      attachments: [],
      runDirectory,
      principal,
      admittedRequestPath: join(runDirectory, "admitted-request.json"),
      issueNumber: 123,
      caseRunsPath: join(tempDir, "case"),
      caseIdentity: {
        issueNumber: 123,
        runsPath: join(tempDir, "case"),
      },
    };

    const mockHost: RoleTurnHost = {
      async executeTurn(): Promise<RoleTurnResult> {
        throw new Error("host spawn failure");
      },
    };

    const env: PostAdmissionEnv = {
      home: tempDir,
      agentDir: join(tempDir, "agent"),
      packageRoot: tempDir,
      cwd: tempDir,
      roleTurnHost: mockHost,
      principalAuthority: authority,
    };

    const adapters: PostAdmissionAdapters<AdmittedDoctorInvocation> = {
      trySettle: async () => undefined,
      shouldPresentSettled: () => true,
    };

    let stdoutText = "";
    const io = {
      stdout: (text: string) => { stdoutText += text; },
      stderr: (_text: string) => {},
    };

    const turnRequest: RoleTurnRequest = {
      principal,
      activation: { role: "doctor", casePath: admitted.caseRunsPath },
      methods: [],
      continuation: { kind: "initial", prompt: "start" },
      cwd: tempDir,
      home: tempDir,
      agentDir: join(tempDir, "agent"),
      runDirectory,
    };

    const result = await runPostAdmissionOneShot({
      admitted,
      env,
      io,
      request: turnRequest,
      adapters,
    });

    assert.equal(result.exitCode, 1, "unhandled throw must exit 1");
    assert.equal(result.terminal?.roleOutcome.kind, "failure");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
