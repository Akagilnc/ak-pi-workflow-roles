/**
 * Shared pure renderer that folds typed agent-start reading materials into a
 * provider-visible systemPrompt string. Both the Pi adapter and the Grok ACP
 * adapter call this before the provider sees the prompt; the typed materials
 * are never asserted as free text by tests — the renderer is the single,
 * authoritative production input of the send path.
 */
export function renderAgentStartMaterials(body: string, materials: readonly unknown[]): string {
  if (materials.length === 0) return body;
  return `${body}\n\n<ak_agent_start_materials>\n${materials
    .map((material) => JSON.stringify(material))
    .join("\n\n")}\n</ak_agent_start_materials>`;
}
