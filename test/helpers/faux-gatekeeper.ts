import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

export function fauxGatekeeper(
  calls: Array<{ tool?: string; args?: object | undefined; text?: string }>,
  seen: string[],
) {
  return async (_model: any, context: any) => {
    seen.push(context.systemPrompt);
    const next = calls.shift();
    if (!next) throw new Error("unexpected child turn");
    if (next.text !== undefined) return fauxAssistantMessage(next.text);
    // Missing args: emit a toolCall with arguments: undefined (Pi pre-execute reject path).
    if (next.args === undefined) {
      return fauxAssistantMessage(
        { type: "toolCall", id: `call-${seen.length}`, name: next.tool!, arguments: undefined as never },
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage(
      fauxToolCall(next.tool!, next.args, { id: `call-${seen.length}` }),
      { stopReason: "toolUse" },
    );
  };
}
