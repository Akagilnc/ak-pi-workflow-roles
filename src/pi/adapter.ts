import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OpenControlledHostSession, RoleHost } from "../host-contracts.ts";
import { openInProcessAgentSession } from "./in-process-session.ts";

/** Pi composition boundary. Role modules only consume the host-neutral projection. */
export function createPiRoleHost(pi: ExtensionAPI): RoleHost {
  return pi as unknown as RoleHost;
}

/** Pi implementation of the controlled internal-session contract. */
export const openPiControlledSession = openInProcessAgentSession as OpenControlledHostSession;
