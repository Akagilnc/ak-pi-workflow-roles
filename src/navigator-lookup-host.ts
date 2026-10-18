/**
 * 游奕使的非模型回合宿主（#1192 / ADR 0082「不适配者按类型开新管线」）。
 * 不起宿主会话、不调模型：按结构化的目标角色查 navigator-route-table，
 * 经提交账封一行，结算照常读账本。
 */
import { randomUUID } from "node:crypto";

import type { RoleTurnHost } from "./host-contracts.ts";
import { navigatorFullTable, navigatorRowsForRole } from "./navigator-route-table.ts";
import { PACKAGED_ROLE_REGISTRY, type PackagedRole } from "./packaged-role-registry.ts";
import { sealAcceptedSubmission } from "./submission-ledger.ts";

/** 记入 invocation 的宿主名：如实表明这一腿是查表，不冒用真实宿主。 */
export const NAVIGATOR_LOOKUP_HOST = "lookup" as const;

function targetRole(forRole: string): PackagedRole {
  const known = PACKAGED_ROLE_REGISTRY.find(({ role }) => role === forRole);
  if (known === undefined) throw new Error(`navigator lookup: unknown role ${forRole}`);
  return known.role;
}

export function createNavigatorLookupHost(): RoleTurnHost {
  return {
    async executeTurn(request) {
      const { activation } = request;
      if (activation.role !== "navigator") {
        throw new Error(`navigator lookup host cannot run ${activation.role}`);
      }
      const accepted = activation.forRole === undefined
        ? { byRole: navigatorFullTable() }
        : { byStatus: navigatorRowsForRole(targetRole(activation.forRole)) };
      sealAcceptedSubmission({
        runDirectory: request.runDirectory,
        cwd: request.cwd,
        home: request.home,
        role: "navigator",
        accepted,
        instruction: request.continuation.prompt,
        toolCallId: `navigator-lookup:${randomUUID()}`,
        ...(request.courtAttemptId === undefined ? {} : { courtAttemptId: request.courtAttemptId }),
      });
      return { code: 0, stderr: "", timedOut: false };
    },
  };
}
