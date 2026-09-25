#!/usr/bin/env bats
#
# run-bats.sh — bats を 0 件で緑にしないための runner の検証。
# fixture は hermetic な一時 dir に置き、BATS_TESTS_DIR で差し替える
# (tests/ 自身を再帰的に回して無限ループにならないようにする)。
#

SCRIPT="${BATS_TEST_DIRNAME}/../scripts/run-bats.sh"

setup() {
  TMPDIR_FIXTURE="$(mktemp -d)"
}

teardown() {
  rm -rf "$TMPDIR_FIXTURE"
}

# BATS_MIN_TESTS は npm script が外から立てる (ci では 7)。fixture は
# 明示的に 1 を渡す — 環境から漏れて来た値で結果が変わらないようにする。
@test "reports green with the test count when tests pass" {
  printf '#!/usr/bin/env bats\n@test "passes" { true; }\n' > "$TMPDIR_FIXTURE/one.bats"
  run env BATS_TESTS_DIR="$TMPDIR_FIXTURE" BATS_MIN_TESTS=1 bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"bats 1 件 green"* ]]
}

@test "exits 2 when zero tests are discovered (silent green を許さない)" {
  run env BATS_TESTS_DIR="$TMPDIR_FIXTURE" BATS_MIN_TESTS=1 bash "$SCRIPT"
  [ "$status" -eq 2 ]
  [[ "$output" == *"下限を下回った"* ]]
}

@test "exits 2 when the count is below the floor even if all pass" {
  printf '#!/usr/bin/env bats\n@test "passes" { true; }\n' > "$TMPDIR_FIXTURE/one.bats"
  run env BATS_TESTS_DIR="$TMPDIR_FIXTURE" BATS_MIN_TESTS=5 bash "$SCRIPT"
  [ "$status" -eq 2 ]
}

@test "propagates the failure exit when a test fails" {
  printf '#!/usr/bin/env bats\n@test "fails" { false; }\n' > "$TMPDIR_FIXTURE/bad.bats"
  run env BATS_TESTS_DIR="$TMPDIR_FIXTURE" bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [ "$status" -ne 2 ]
}
