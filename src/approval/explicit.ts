import type { ApprovalItem } from "../types.ts";

type ExplicitApprovalRuntime = {
  approvals: { list(status?: ApprovalItem["status"]): Promise<ApprovalItem[]> };
  approve(id: string): Promise<void>;
  executeApproval(id: string): Promise<string>;
};

/** Local approval grammar: exact IDs/bodies, or contextual approval for the current staged tweet. */
export function explicitApprovalTarget(input: string): { id?: string; body?: string; contextual?: boolean } | undefined {
  const text = input.trim();
  const byId = text.match(/^(?:i\s+)?(?:explicitly\s+)?approve\s+([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\s*[.!]?$/i);
  if (byId) return { id: byId[1] };
  const byBody = text.match(/^(?:i\s+)?(?:explicitly\s+)?approve\s*:\s*(.+?)\s*[.!]?$/is);
  if (byBody) {
    const body = byBody[1].trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
    return body ? { body } : undefined;
  }
  if (/^(?:i\s+)?(?:explicitly\s+)?approve\s+(?:it|this|that)(?:\s+(?:tweet|post))?[.!]?$/i.test(text)) return { contextual: true };
  if (/^(?:please\s+)?(?:tweet|post)\s+(?:this|that|it)(?:\s*(?:[-—–:]|and)?\s*(?:it(?:'s| is)|this is)?\s*approved)?[.!]?$/i.test(text)) return { contextual: true };
  return undefined;
}

/** Execute an exact approval, or contextual approval for the single pending tweet. */
export async function executeExplicitApproval(runtime: ExplicitApprovalRuntime, input: string): Promise<string | undefined> {
  const target = explicitApprovalTarget(input);
  if (!target) return undefined;
  const pending = await runtime.approvals.list("pending");
  const matches = target.id
    ? pending.filter((candidate) => candidate.id === target.id)
    : target.body
      ? pending.filter((candidate) => candidate.body.trim() === target.body)
      : pending.filter((candidate) => candidate.kind === "social.x-post");
  if (!matches.length) return target.contextual ? "No pending tweet matches that approval." : "No pending action matches that exact approval.";
  if (matches.length > 1) return target.contextual ? "More than one tweet is pending; approve the exact tweet or use its ID." : "That text matches more than one pending action; approve by its ID instead.";
  await runtime.approve(matches[0].id);
  return runtime.executeApproval(matches[0].id);
}
