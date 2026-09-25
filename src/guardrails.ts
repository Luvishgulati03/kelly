import type { ApprovalItem } from "./types.ts";

/**
 * Prompts guide the model; the approval state check below is the enforcement
 * boundary for outbound actions.
 */
export const OUTBOUND_EMAIL_APPROVAL_GUARDRAIL =
  "Never send or reply to an email without the owner's explicit approval. Drafting and saving are allowed; sending requires a separate approval action first.";

/**
 * Outbound integrations may only run after Henry atomically claims an action
 * that was already approved. Pending or merely proposed actions never reach
 * Gmail or GitHub.
 */
export function assertOutboundExecutionClaim(
  item: Pick<ApprovalItem, "kind" | "status">,
): void {
  assertNotPublicTurn();
  if (item.status === "executing") return;
  throw new Error(
    `Blocked outbound action: ${item.kind} requires the owner's explicit approval before execution (status: ${item.status})`,
  );
}

/**
 * THE PUBLIC RAIL. A turn answering an anonymous visitor on Kelly's public Explore page
 * (src/public/) runs its provider child with KELLY_PUBLIC_TURN=1, on top of having no tools at
 * all (src/providers/public-sandbox.ts). Every approval, claim, execution, send, quote export and
 * CLI entry point refuses while it is set, so even a provider regression that handed the model a
 * shell could not approve, send, or act as the owner. The HENRY_ spelling is honoured too because
 * this repository's runtime is shared by both profiles.
 */
export const PUBLIC_TURN_ENV = "KELLY_PUBLIC_TURN";

export const PUBLIC_TURN_REFUSAL =
  "Approvals, sends, exports, and every other owner action are disabled during a public visitor turn.";

export function isPublicTurn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PUBLIC_TURN_ENV] === "1" || env.HENRY_PUBLIC_TURN === "1";
}

export function assertNotPublicTurn(env: NodeJS.ProcessEnv = process.env): void {
  if (isPublicTurn(env)) throw new Error(PUBLIC_TURN_REFUSAL);
}
