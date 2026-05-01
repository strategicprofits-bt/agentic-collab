# Deployment Gate Markers

This directory holds clearance marker files for the deployment gate hook.

## How it works

1. **Brienne** writes `brienne-cleared` after safety review passes
2. **Roz** writes `roz-cleared` after QA review passes
3. **DrRobby** approves push — the PreToolUse hook checks for both files
4. On successful push, both markers are **consumed** (deleted)

## Writing markers

Agents create markers via collab or direct file write:

```bash
# Brienne clears safety
touch agent-team/data/gates/brienne-cleared

# Roz clears QA
touch agent-team/data/gates/roz-cleared
```

## Hook location

`~/.claude/hooks/deployment-gate.sh` — fires on `git push`, `gh pr create`, `gh pr merge`.
