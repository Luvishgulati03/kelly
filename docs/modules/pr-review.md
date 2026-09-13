# Module: engineering and pull-request workflow

Henry can work inside a local checkout with `task`, review GitHub pull requests, and
stage an approval-gated merge plan. The workflow is deliberately explicit:

1. Inspect the repository and PR, including the full diff.
2. Run the project check supplied by the operator.
3. Review six passes: logic, safety, product, query performance, consistency, and surface.
4. Revalidate the exact PR head SHA.
5. Stage a merge approval. Nothing is merged at this point.
6. After explicit approval, merge with the selected method and run the verification command.
7. If verification fails, stage a separate approval to create a GitHub revert PR.

## Commands

```bash
henry task "fix the issue, test it, and summarize the changed files" --cwd /path/to/repo
henry pr review 123 --repo owner/repository --cwd /path/to/repo
henry pr merge 123 --repo owner/repository --cwd /path/to/repo \
  --check "npm test" --verify "npm run build" --method squash
henry approve list
henry approve approve <id>
henry approve send <id>
```

The old `henry review <target>` alias remains available. `--check` and `--verify`
cannot contain shell operators. A production smoke test can be used as `--verify`,
but the operator must provide the command and credentials/environment. Henry must
not claim production verification from a local test.

GitHub cannot safely erase a merged commit from production. The rollback capability
therefore creates a revert PR, preserving an auditable change and the normal review
gate. It does not silently revert production.
