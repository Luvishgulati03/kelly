import type { ApprovalItem } from "./types.ts";

/**
 * Prompts guide the model; the approval state check below is the enforcement
 * boundary for outbound actions.
 */
export const OUTBOUND_EMAIL_APPROVAL_GUARDRAIL =
  "Never send or reply to an email without Luvish's explicit approval. Drafting and saving are allowed; sending requires a separate approval action first.";

/**
 * Outbound integrations may only run after Henry atomically claims an action
 * that was already approved. Pending or merely proposed actions never reach
 * Gmail or GitHub.
 */
export function assertOutboundExecutionClaim(
  item: Pick<ApprovalItem, "kind" | "status">,
): void {
  if (item.status === "executing") return;
  throw new Error(
    `Blocked outbound action: ${item.kind} requires Luvish's explicit approval before execution (status: ${item.status})`,
  );
}
