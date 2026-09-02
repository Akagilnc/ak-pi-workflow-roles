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

/**
 * Operator's real machine home (passwd/user profile) — never process.env.HOME.
 * When the #604 test user-profile preload is active, AK_TEST_REAL_MACHINE_HOME
 * holds the pre-patch passwd home so this guard still protects the operator tree
 * while packageMachineHome follows the temporary profile.
 */
export function realMachineHome(): string {
  const preserved = process.env.AK_TEST_REAL_MACHINE_HOME;
  if (typeof preserved === "string" && preserved.length > 0) {
    return resolve(preserved);
  }
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
