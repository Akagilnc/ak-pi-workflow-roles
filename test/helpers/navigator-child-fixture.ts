/**
 * Shared Navigator institutional-child fixture dispatch (#590).
 * One root helper: when the tool surface carries NAVIGATOR_PREPARE_TOOL_NAME,
 * return a deterministic prepare response so provider fixtures that predate
 * the host-neutral Navigator child still queue enough responses.
 */
import {
  fauxAssistantMessage,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai";

import { NAVIGATOR_PREPARE_TOOL_NAME } from "../../src/navigator-attendance.ts";

export type NavigatorChildFixtureOptions = {
  readonly role?: string;
  readonly phase?: string | null;
  readonly reason?: string;
};

/** Deterministic prepare response for institutional Navigator child turns. */
export function navigatorPrepareFixtureResponse(
  options: NavigatorChildFixtureOptions = {},
) {
  const role = options.role ?? "judge";
  const phase = options.phase === undefined ? null : options.phase;
  return fauxAssistantMessage(
    fauxToolCall(NAVIGATOR_PREPARE_TOOL_NAME, {
      candidates: [{
        next: { role, phase },
        reason: options.reason ?? "fixture navigator child prepare",
      }],
    }),
    { stopReason: "toolUse" },
  );
}

/**
 * If `context` is a Navigator prepare turn, return the fixture prepare response;
 * otherwise return undefined so the caller can dispatch its own seat response.
 */
export function navigatorChildOrUndefined(
  context: Context,
  options?: NavigatorChildFixtureOptions,
) {
  const names = context.tools?.map((tool) => tool.name) ?? [];
  if (!names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) return undefined;
  return navigatorPrepareFixtureResponse(options);
}
