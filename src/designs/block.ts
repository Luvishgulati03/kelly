/**
 * The designs block contract: a model reply ends with either a fenced ```designs block whose
 * body is a JSON array of ids (or `{ids:[...]}`), or a line matching `DESIGNS: id, id, id`.
 * Shared by the dashboard SSE loop and the Telegram bridge so both surfaces parse one grammar.
 */

const ID_PATTERN = /^dsg_[0-9a-f]{16}$/;

export interface ParsedDesignsBlock {
  /** Up to 8 valid design ids, in the order the model listed them, deduplicated. */
  ids: string[];
  /** The reply text with the block removed and trailing whitespace trimmed. */
  text: string;
}

function dedupeCap(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!ID_PATTERN.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 8) break;
  }
  return out;
}

export function parseDesignsBlock(text: string): ParsedDesignsBlock | undefined {
  const fenceMatch = text.match(/```designs\s*\n([\s\S]*?)```/);
  if (fenceMatch) {
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(fenceMatch[1].trim()) as unknown;
      if (Array.isArray(parsed)) ids = parsed.map(String);
      else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { ids?: unknown }).ids)) {
        ids = ((parsed as { ids: unknown[] }).ids).map(String);
      }
    } catch { /* not valid JSON; treat as no designs */ }
    const stripped = `${text.slice(0, fenceMatch.index)}${text.slice(fenceMatch.index! + fenceMatch[0].length)}`.trim();
    return { ids: dedupeCap(ids), text: stripped };
  }
  const lineMatch = text.match(/^DESIGNS:\s*(.+)$/m);
  if (lineMatch) {
    const ids = lineMatch[1].split(",").map((id) => id.trim()).filter(Boolean);
    const stripped = text.replace(lineMatch[0], "").trim();
    return { ids: dedupeCap(ids), text: stripped };
  }
  return undefined;
}
