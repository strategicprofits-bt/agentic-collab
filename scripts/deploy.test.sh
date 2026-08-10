#!/usr/bin/env bash
# Safe-path tests for scripts/deploy.sh — exercises arg-parsing + guard behavior
# only (never invokes docker/systemctl). Run: bash scripts/deploy.test.sh
set -uo pipefail
cd "$(dirname "$0")/.."
DEPLOY="scripts/deploy.sh"
pass=0; fail=0
check() { # desc  expected_exit  args...
  local desc="$1" want="$2"; shift 2
  bash "$DEPLOY" "$@" >/dev/null 2>&1; local got=$?
  if [[ "$got" == "$want" ]]; then echo "ok   - $desc (exit $got)"; pass=$((pass+1))
  else echo "FAIL - $desc (want exit $want, got $got)"; fail=$((fail+1)); fi
}

bash -n "$DEPLOY" && echo "ok   - syntax valid" && pass=$((pass+1)) || { echo "FAIL - syntax"; fail=$((fail+1)); }
check "--dry-run touches nothing, exits 0"        0 --dry-run
check "--ref HEAD passes guard then dry-run"      0 --ref HEAD --dry-run
check "--ref <wrong> REFUSES (die, exit 1)"       1 --ref 0000000000000000000000000000000000000000 --dry-run
check "unknown arg exits 2"                       2 --bogus
check "--no-proxy + --dry-run exits 0"            0 --no-proxy --dry-run

echo "--- $pass passed, $fail failed ---"
[[ "$fail" == 0 ]]
