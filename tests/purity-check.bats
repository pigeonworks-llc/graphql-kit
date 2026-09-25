#!/usr/bin/env bats
#
# purity-check.sh — src/ が製品非依存であることを守る gate の検証。
# prove-red: 違反を注入して red になることを実証する (techne 還元規約
# 「gate を先に red で書く」— red にならない gate は残債を検出できていない)。
#
# 注意: 架空 fixture も走査対象 (製品のデータが package 内に残る形を捕まえたいため)。
# bats が注入する fixture は実行時に作って消す。
#

SCRIPT="${BATS_TEST_DIRNAME}/../scripts/purity-check.sh"
REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/.." && pwd)"

@test "is executable and has a bash shebang" {
  [ -f "$SCRIPT" ]
  head -1 "$SCRIPT" | grep -q "bash"
}

@test "current tree is green" {
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"purity OK"* ]]
}

@test "product name turns it red (prove-red)" {
  FIXTURE="$REPO_ROOT/src/_purity_violation_fixture.ts"
  printf 'export const origin = "order-base";\n' > "$FIXTURE"
  run bash "$SCRIPT"
  rm -f "$FIXTURE"
  [ "$status" -eq 1 ]
  [[ "$output" == *"_purity_violation_fixture"* ]]
}

@test "product domain vocabulary turns it red (prove-red)" {
  FIXTURE="$REPO_ROOT/src/_domain_violation_fixture.ts"
  printf 'export const label = "処方箋画像の取得";\n' > "$FIXTURE"
  run bash "$SCRIPT"
  rm -f "$FIXTURE"
  [ "$status" -eq 1 ]
  [[ "$output" == *"_domain_violation_fixture"* ]]
}

@test "unlisted external import turns it red (depfree、prove-red)" {
  FIXTURE="$REPO_ROOT/src/_depfree_violation_fixture.ts"
  printf 'import { z } from "zod";\nexport const x = z;\n' > "$FIXTURE"
  run bash "$SCRIPT"
  rm -f "$FIXTURE"
  [ "$status" -eq 1 ]
  [[ "$output" == *"zod"* ]]
}

@test "graphql import is allowed (この kit の正当な依存)" {
  FIXTURE="$REPO_ROOT/src/_allowed_dep_fixture.ts"
  printf 'import { parse } from "graphql";\nexport const p = parse;\n' > "$FIXTURE"
  run bash "$SCRIPT"
  rm -f "$FIXTURE"
  [ "$status" -eq 0 ]
}

@test "missing dir exits 2 (fail-loud、silent skip しない)" {
  GRAPHQL_KIT_SRC_DIR="src-does-not-exist" run bash "$SCRIPT"
  [ "$status" -eq 2 ]
}
