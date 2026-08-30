/**
 * Single authority: refuse models.json writes that would poison the machine
 * agent dir (2026-08-29 faux-leak). Passwd/user-profile home — not process.env.HOME
 * (tests override HOME). Pure helper so fixtures and generated extensions share it.
 */
import { userInfo } from "node:os";
import { join, resolve, sep } from "node:path";

export type TestAgentDirErrorCode =
  | "AK_TEST_AGENT_DIR_REQUIRED"
  | "AK_TEST_AGENT_DIR_MACHINE";

export class TestAgentDirError extends Error {
  readonly code: TestAgentDirErrorCode;

  constructor(code: TestAgentDirErrorCode, message: string) {
    super(message);
    this.name = "TestAgentDirError";
    this.code = code;
  }
}

/** Real machine home via passwd/user profile — never process.env.HOME. */
export function realMachineHome(): string {
  return resolve(userInfo().homedir);
}

/** Real machine `~/.pi/agent`. */
export function realMachineAgentDir(): string {
  return resolve(realMachineHome(), ".pi", "agent");
}

/**
 * Fail closed before any test models.json write: agentDir must be explicit and
 * must not resolve to (or under) the machine agent dir.
 */
export function assertWritableTestAgentDir(
  agentDir: string | undefined | null,
): asserts agentDir is string {
  if (typeof agentDir !== "string" || agentDir.trim() === "") {
    throw new TestAgentDirError(
      "AK_TEST_AGENT_DIR_REQUIRED",
      "test agentDir must be explicitly provided (no silent HOME/agentDir fallback)",
    );
  }
  const resolved = resolve(agentDir);
  const machine = realMachineAgentDir();
  if (resolved === machine || resolved.startsWith(machine + sep)) {
    throw new TestAgentDirError(
      "AK_TEST_AGENT_DIR_MACHINE",
      `Refusing to write models.json to machine agentDir: ${agentDir}`,
    );
  }
}
