/**
 * Public missing-path tracer: production role-runtime envelope with a controllable
 * Collector clock so eligibility cutoff is reachable under the shared activation path.
 */
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { installRoleRuntime } from "../../extensions/role-runtime.ts";
import { collectorPublicTracerClock } from "./collector-controllable-clock.ts";

const fixturePath = fileURLToPath(import.meta.url);

export default function collectorMissingRuntime(pi: ExtensionAPI): void {
  installRoleRuntime(pi, {
    // globalThis-backed singleton — shared with the missing-provider fixture.
    createCollectorClock: () => collectorPublicTracerClock,
    // Tools register under this fixture path; bind isolation to the loaded entry.
    collectorPackageExtensionPath: fixturePath,
  });
}
