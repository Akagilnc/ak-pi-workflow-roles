/**
 * Shared Navigator public-seat fixture dispatch (#675).
 * Nested attendance summons the public navigator seat (ak_navigator_output).
 * One root helper: when the tool surface carries the public output tool,
 * return a deterministic advice receipt.
 */
import {
  fauxAssistantMessage,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai";

import { NAVIGATOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/navigator-output.ts";

export type NavigatorChildFixtureOptions = {
  readonly role?: string;
  readonly phase?: string | null;
  readonly reason?: string;
};

/** Deterministic public-seat advice for nested Navigator turns. */
export function navigatorPublicAdviceResponse(
  options: NavigatorChildFixtureOptions = {},
) {
  const role = options.role ?? "judge";
  const phase = options.phase === undefined ? null : options.phase;
  return fauxAssistantMessage(
    fauxToolCall(NAVIGATOR_OUTPUT_TOOL_NAME, {
      status: "advice",
      candidates: [{
        next: { role, phase },
        reason: options.reason ?? "fixture navigator public advice",
      }],
    }),
    { stopReason: "toolUse" },
  );
}

/**
 * If `context` is a public Navigator advice turn, return the fixture advice;
 * otherwise return undefined so the caller can dispatch its own seat response.
 */
export function navigatorChildOrUndefined(
  context: Context,
  options?: NavigatorChildFixtureOptions,
) {
  const names = context.tools?.map((tool) => tool.name) ?? [];
  if (!names.includes(NAVIGATOR_OUTPUT_TOOL_NAME)) return undefined;
  return navigatorPublicAdviceResponse(options);
}
