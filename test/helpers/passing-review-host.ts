import type { RoleTurnHost } from "../../src/host-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { loadPublicCliConfig, savePublicCliConfig, setPersistentSeatConfig } from "../../src/public-cli/config.ts";
import { AUDITOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/auditor-output.ts";
import { INSPECTOR_OUTPUT_TOOL_NAME } from "../../src/inspector-contracts.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { packageRoot } from "./pi-test-harness.ts";
import { roleTurnHostFromLegacyPiRunner, scriptedTerminatingToolSession } from "./role-turn-host-fixture.ts";

const officers = {
  auditor: AUDITOR_OUTPUT_TOOL_NAME,
  inspector: INSPECTOR_OUTPUT_TOOL_NAME,
  notary: NOTARY_OUTPUT_TOOL_NAME,
} as const;

/** Only for public-entry tests whose subject is the parent role, not reviewer behavior. */
export async function configurePassingReviewSeats(home: string): Promise<void> {
  let config = await loadPublicCliConfig(home);
  const seat = { provider: "test", model: "caller-seat", thinking: "high" } as const;
  for (const role of Object.keys(officers) as (keyof typeof officers)[]) {
    if (config.seats[role] === undefined) config = setPersistentSeatConfig(config, role, seat);
  }
  await savePublicCliConfig(config, home);
}

export function withPassingReviewHost(parent: RoleTurnHost): RoleTurnHost {
  const review = roleTurnHostFromLegacyPiRunner({
    packageRoot, principalAuthority: piDurablePrincipalAuthority,
    piRunner: async (args, options) => {
      const role = args[args.indexOf("--ak-role") + 1] as keyof typeof officers;
      const toolName = officers[role];
      if (toolName === undefined) throw new Error(`unexpected reviewer role: ${role}`);
      return scriptedTerminatingToolSession({ role, toolName, details: { status: "converged" } })(args, options);
    },
  });
  return {
    executeTurn: (request) => request.activation.role in officers
      ? review.executeTurn(request)
      : parent.executeTurn(request),
  };
}
