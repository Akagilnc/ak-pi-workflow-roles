/**
 * Sole production fold of typed agent-start materials into provider-visible
 * system-prompt bytes. Pi adapter and Grok ACP adapter both call this at the
 * send boundary; structured materials stay the internal authority, this string
 * is the provider wire form (ADR 0073: 机器文本全中文，无英文键/JSON 外壳).
 *
 * Producers own the Chinese face: a string material, or a record with pre-assembled
 * `section` (case-dossier freeze, notary/engine/inspector bindings). No generic
 * field whitelist and no JSON shell.
 */

function providerVisibleMaterial(material: unknown): string {
  if (typeof material === "string") return material;
  if (
    material !== null
    && typeof material === "object"
    && !Array.isArray(material)
    && typeof (material as { section?: unknown }).section === "string"
  ) {
    return (material as { section: string }).section.replace(/\n+$/u, "");
  }
  return "";
}

export function renderAgentStartMaterials(
  body: string,
  materials: readonly unknown[],
): string {
  if (materials.length === 0) return body;
  const visible = materials
    .map(providerVisibleMaterial)
    .filter((text) => text.length > 0);
  if (visible.length === 0) return body;
  return [body, ...visible].join("\n\n");
}
