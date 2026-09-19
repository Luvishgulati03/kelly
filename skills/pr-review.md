---
description: Review a GitHub pull request in six passes and stage the findings for approval.
---

# Kelly PR review skill

Use `kelly pr review <pr-number> --repo owner/repository` to inspect the full GitHub diff.
Run six separate passes — logic, safety, product thinking, query performance, consistency,
and surface — and produce actionable findings with exact file and line references.

Read the whole diff before writing anything. On a re-review, read the existing comments
first, skip findings already raised, and review newly changed paths.

The review is staged, never posted: findings land in the approval queue. Posting happens
only after the operator runs `kelly approve approve <id>` and then `kelly approve send <id>`.
Approval and sending are separate actions, and neither may be performed on the operator's
behalf.
