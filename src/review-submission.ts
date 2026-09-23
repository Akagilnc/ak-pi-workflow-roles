/** One shared terminating receipt contract for review officers (#1028). */
import { Type } from "typebox";

import { openToolObject } from "./open-tool-schema.ts";
import { withTerminatingOutputDeclarations } from "./package-contracts/terminating-infrastructure.ts";

export const REVIEW_SUBMISSION_OUTPUT_TOOL_NAME = "ak_submission_output" as const;

/** Open receipt: the queue reads only status; all other submitted fields ride unchanged. */
export const reviewSubmissionSchema = withTerminatingOutputDeclarations(
  openToolObject(
    Type.Object({
      status: Type.Optional(Type.Unknown({
        description: "converged | continue | escalate — 非三态时请重读后重交，勿改标。",
      })),
    }),
  ),
);

export type ReviewSubmission = { readonly status?: unknown; readonly [key: string]: unknown };
