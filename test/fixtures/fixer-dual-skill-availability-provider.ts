import { fauxAssistantMessage, fauxProvider, type Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Real Pi-loader tracer: the first prompt is plain; later turns are native skills. */
export default function fixerDualSkillAvailabilityProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    api: "ak-fixer-dual-skill-availability",
    provider: "ak-fixer-dual-skill-availability",
    tokenSize: { min: 1000, max: 1000 },
  });
  faux.setResponses([
    fauxAssistantMessage("first prompt observed", { stopReason: "stop" }),
    fauxAssistantMessage("diagnosing-bugs observed", { stopReason: "stop" }),
    fauxAssistantMessage("tdd observed", { stopReason: "stop" }),
  ]);
  const model = faux.getModel();
  const provider: Provider = {
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Fixer dual-skill availability fixture",
        async resolve() {
          return { auth: { apiKey: "offline" } };
        },
      },
    },
    getModels() {
      return [model];
    },
  };
  pi.registerProvider(provider);
}
