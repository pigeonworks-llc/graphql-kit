#!/usr/bin/env bats
#
# check-dist-fresh.sh — commit 済み dist が src と一致していることを守る gate の検証。
# dist を commit する理由は、consumer が SHA pin で取る時に build を持たないため。
# 鮮度が切れると「直したはずの修正が入っていない package」を配る (silent failure)。
#
# fixture は GRAPHQL_KIT_DIST_DIR で一時 dir に差し替える (working tree を汚さない)。
# 一時ファイルは teardown で消す。
#

SCRIPT="${BATS_TEST_DIRNAME}/../scripts/check-dist-fresh.sh"
REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/.." && pwd)"

setup() {
	TMP_DIST="$(mktemp -d)"
	cp -R "$REPO_ROOT/dist/." "$TMP_DIST/"
}

teardown() {
	rm -rf "$TMP_DIST"
}

@test "is executable and has a bash shebang" {
	[ -f "$SCRIPT" ]
	head -1 "$SCRIPT" | grep -q "bash"
}

@test "current tree is green (dist は src と一致している)" {
	run bash "$SCRIPT"
	[ "$status" -eq 0 ]
	[[ "$output" == *"dist fresh"* ]]
}

@test "a stale dist turns it red (prove-red)" {
	printf '\n// stale fixture\n' >>"$TMP_DIST/refusal/index.js"
	run env GRAPHQL_KIT_DIST_DIR="$TMP_DIST" bash "$SCRIPT"
	[ "$status" -eq 1 ]
	[[ "$output" == *"refusal/index.js"* ]]
}

@test "a missing dist file turns it red" {
	rm "$TMP_DIST/http-gate/operation.js"
	run env GRAPHQL_KIT_DIST_DIR="$TMP_DIST" bash "$SCRIPT"
	[ "$status" -eq 1 ]
}

@test "a missing dist dir exits 2 (fail-loud、silent green しない)" {
	run env GRAPHQL_KIT_DIST_DIR="$TMP_DIST/does-not-exist" bash "$SCRIPT"
	[ "$status" -eq 2 ]
	[[ "$output" == *"dist dir not found"* ]]
}

# build が通らない時は「判定不能」として exit 2 にする (鮮度の赤 = exit 1 と混同
# させない)。tsc の exit code をそのまま漏らすと、たまたま 1 なら「stale」と
# 誤って報告してしまう。
@test "a failing build exits 2 (判定不能 — 鮮度の赤と混同しない)" {
	run env GRAPHQL_KIT_TSCONFIG="$TMP_DIST/does-not-exist.json" bash "$SCRIPT"
	[ "$status" -eq 2 ]
	[[ "$output" == *"判定不能"* ]]
}
