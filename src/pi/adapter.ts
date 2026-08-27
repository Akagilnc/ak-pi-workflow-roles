import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RoleHost } from "../host-contracts.ts";

/** Pi composition boundary. Each consumed capability is adapted explicitly. */
export function createPiRoleHost(pi: ExtensionAPI): RoleHost {
  return {
    registerFlag: (name, definition) => pi.registerFlag(name, definition),
    getFlag: (name) => pi.getFlag(name),
    registerTool: (tool) => pi.registerTool(tool),
    getAllTools: () => pi.getAllTools(),
    setActiveTools: (names) => pi.setActiveTools(names),
    getActiveTools: () => pi.getActiveTools(),
    on: pi.on,
    getCommands: () => pi.getCommands(),
  };
}
