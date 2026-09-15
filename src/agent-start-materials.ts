/**
 * Sole production fold of typed agent-start materials into provider-visible
 * system-prompt bytes. Pi adapter and Grok ACP adapter both call this at the
 * send boundary; structured materials are the authority, this string is the
 * provider wire form.
 *
 * Case-dossier pointer (`kind: "case-dossier-pointer"`) carries a pre-assembled
 * `section` string from the attachment face. Every other material keeps the
 * BASE JSON projection — never duck-type on `section` alone (#858).
 */

function providerVisibleMaterial(material: unknown): string {
  if (typeof material === "string") return material;
  if (
    material !== null
    && typeof material === "object"
    && !Array.isArray(material)
    && (material as { kind?: unknown }).kind === "case-dossier-pointer"
    && typeof (material as { section?: unknown }).section === "string"
    && (material as { section: string }).section.trim() !== ""
  ) {
    return (material as { section: string }).section.replace(/\n+$/u, "");
  }
  return JSON.stringify(material);
}

export function renderAgentStartMaterials(
  body: string,
  materials: readonly unknown[],
): string {
  if (materials.length === 0) return body;
  return [body, ...materials.map(providerVisibleMaterial)].join("\n\n");
}
