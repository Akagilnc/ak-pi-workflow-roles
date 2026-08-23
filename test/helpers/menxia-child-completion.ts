import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

export function menxiaChildCompletion(
  calls: Array<{ tool?: string; args?: object; text?: string }>,
  seen: string[],
) {
  return async (_model: any, context: any) => {
    seen.push(context.systemPrompt);
    const next = calls.shift();
    if (!next) throw new Error("unexpected child turn");
    if (next.text !== undefined) return fauxAssistantMessage(next.text);
    return fauxAssistantMessage(
      fauxToolCall(next.tool!, next.args!, { id: `call-${seen.length}` }),
      { stopReason: "toolUse" },
    );
  };
}
