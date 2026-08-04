import type {
  AcceptedActivationFact,
  ActivationCorrelationIdentity,
  ActivationSessionPointer,
} from "../../src/activation-ledger.ts";

/** Injectable activation-ledger deps so factory tests stay off the real git/home path. */
export function testActivationLedgerDeps(options: {
  bookKey?: string;
  correlation?: ActivationCorrelationIdentity;
  session?: ActivationSessionPointer;
  facts?: AcceptedActivationFact[];
  appendError?: Error;
} = {}) {
  const facts = options.facts ?? [];
  return {
    facts,
    deps: {
      resolveActivationBookKey: async () => options.bookKey ?? "test-book",
      resolveActivationCorrelation: async () =>
        options.correlation ?? ({ kind: "absent" } as const),
      resolveActivationSessionPointer: async () =>
        options.session ?? ({
          kind: "session-directory" as const,
          path: "/tmp/test-session",
        }),
      appendActivationLedgerFact: async (fact: AcceptedActivationFact) => {
        if (options.appendError !== undefined) throw options.appendError;
        facts.push(fact);
      },
    },
  };
}
