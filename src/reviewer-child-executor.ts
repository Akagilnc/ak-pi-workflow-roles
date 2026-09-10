/**
 * #836 删 8: Reviewer axis child executor deleted.
 * Parent seat invokes packaged code-review skill (skill-owned subagent).
 * Any call here is a programming error — mechanism must not run.
 */
import type { HostContext } from "./host-contracts.ts";
import type { AcceptedReviewerLeg } from "./reviewer-dispatch.ts";

export async function executeReviewerChild(
  _workspace: string,
  _leg: AcceptedReviewerLeg,
  _context: HostContext,
  _options?: unknown,
): Promise<never> {
  throw new Error(
    "#836: executeReviewerChild deleted — parent seat invokes code-review skill; code must not spawn reviewer children",
  );
}
