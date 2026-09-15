/**
 * Sole production fold of typed agent-start materials into provider-visible
 * system-prompt bytes. Pi adapter and Grok ACP adapter both call this at the
 * send boundary; structured materials stay the internal authority, this string
 * is the provider wire form (ADR 0073: 机器文本全中文，无英文键/JSON 外壳).
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Project one typed material to provider-visible Chinese text.
 * Prefers a pre-assembled `section` body (case-dossier pointer). Otherwise
 * emits neutral coordinate lines; skips internal discriminants (kind/frozenPath).
 */
function providerVisibleMaterial(material: unknown): string {
  if (typeof material === "string") return material;
  if (typeof material === "number" || typeof material === "boolean") {
    return String(material);
  }
  if (!isRecord(material)) return "";

  // Pre-assembled Chinese document wins (case-dossier freeze body).
  if (typeof material.section === "string" && material.section.trim() !== "") {
    return material.section.replace(/\n+$/u, "");
  }

  const lines: string[] = [];
  if (isRecord(material.sourceRun)) {
    const source = material.sourceRun;
    if (typeof source.runDirectory === "string") {
      lines.push(`来源目录：${source.runDirectory}`);
    }
    if (typeof source.runId === "string") {
      lines.push(`来源 runId：${source.runId}`);
    }
    if (typeof source.role === "string") {
      lines.push(`来源角色：${source.role}`);
    }
  }
  if (typeof material.sourceRunPath === "string") {
    lines.push(`父 run：${material.sourceRunPath}`);
  }
  if (typeof material.ticketNumber === "number") {
    lines.push(`票号：#${material.ticketNumber}`);
  }
  if (typeof material.name === "string") {
    lines.push(`引擎：${material.name}`);
  }
  if (typeof material.model === "string") {
    lines.push(`模型：${material.model}`);
  }
  if (typeof material.materialPath === "string") {
    lines.push(`手册：${material.materialPath}`);
  }
  return lines.join("\n");
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
