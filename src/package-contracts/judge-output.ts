/** Package-owned Judge output leaf — no role registration surface. */

export const JUDGE_OUTPUT_TOOL_NAME = "ak_judge_output";
export const JUDGE_ACCEPTED_TEXT = "Judge verdict accepted";

export type JudgeClass = {
  name: string;
  owner: string;
  boundary: string;
  disposition: string;
};

export type JudgeVerdict =
  | { judgeStatus: "converged"; note?: string }
  | {
    judgeStatus: "continue";
    fix: { summary: string };
    classes: JudgeClass[];
    note?: string;
  }
  | {
    judgeStatus: "escalate";
    decisionGate: { question: string; options: string[] };
    note?: string;
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

export function validateAcceptedJudgeDetails(verdict: unknown): JudgeVerdict {
  if (!isRecord(verdict)) throw new Error("Judge verdict must be an object");
  if (
    verdict.note !== undefined &&
    (typeof verdict.note !== "string" || verdict.note.trim().length === 0)
  ) {
    throw new Error("Judge note must be a non-blank string when provided");
  }
  const withOptionalNote = (keys: string[]): string[] =>
    verdict.note === undefined ? keys : [...keys, "note"];
  const note = verdict.note === undefined ? {} : { note: verdict.note };
  const validClasses = (value: unknown): value is JudgeClass[] => {
    if (!Array.isArray(value) || value.length === 0) return false;
    const names = new Set<string>();
    return value.every((entry) => {
      if (!isRecord(entry) ||
        !hasExactKeys(entry, ["name", "owner", "boundary", "disposition"])) {
        return false;
      }
      for (const key of ["name", "owner", "boundary", "disposition"] as const) {
        if (typeof entry[key] !== "string" || entry[key].trim().length === 0) {
          return false;
        }
      }
      if ((entry.name as string).includes(",") || names.has(entry.name as string)) {
        return false;
      }
      names.add(entry.name as string);
      return true;
    });
  };

  if (verdict.judgeStatus === "converged") {
    if (!hasExactKeys(verdict, withOptionalNote(["judgeStatus"]))) {
      throw new Error("Judge converged forbids fix and decisionGate");
    }
    return { judgeStatus: "converged", ...note };
  }
  if (verdict.judgeStatus === "continue") {
    if (
      !hasExactKeys(verdict, withOptionalNote(["judgeStatus", "fix", "classes"])) ||
      !isRecord(verdict.fix) ||
      !hasExactKeys(verdict.fix, ["summary"]) ||
      typeof verdict.fix.summary !== "string" ||
      verdict.fix.summary.trim().length === 0 ||
      !validClasses(verdict.classes)
    ) {
      throw new Error("Judge continue requires fix.summary and nonempty unique comma-free classes");
    }
    return {
      judgeStatus: "continue",
      fix: { summary: verdict.fix.summary },
      classes: verdict.classes.map((entry) => ({ ...entry })),
      ...note,
    };
  }
  if (verdict.judgeStatus === "escalate") {
    const gate = verdict.decisionGate;
    if (
      !hasExactKeys(
        verdict,
        withOptionalNote(["judgeStatus", "decisionGate"]),
      ) ||
      !isRecord(gate) ||
      !hasExactKeys(gate, ["question", "options"]) ||
      typeof gate.question !== "string" ||
      gate.question.trim().length === 0 ||
      !Array.isArray(gate.options) ||
      gate.options.length === 0 ||
      !gate.options.every(
        (option) => typeof option === "string" && option.trim().length > 0,
      )
    ) {
      throw new Error(
        "Judge escalate requires only a non-blank decisionGate question and options",
      );
    }
    return {
      judgeStatus: "escalate",
      decisionGate: { question: gate.question, options: [...gate.options] },
      ...note,
    };
  }
  throw new Error("Judge verdict has an invalid status");
}
