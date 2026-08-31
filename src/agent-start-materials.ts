/**
 * Sole production fold of typed agent-start materials into provider-visible
 * system-prompt bytes. Pi adapter and Grok ACP adapter both call this at the
 * send boundary; structured materials are the authority, this string is the
 * provider wire form.
 */
export function renderAgentStartMaterials(
  body: string,
  materials: readonly unknown[],
): string {
  if (materials.length === 0) return body;
  return [body, ...materials.map((material) => JSON.stringify(material))].join("\n\n");
}
