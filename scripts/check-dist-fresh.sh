#!/usr/bin/env bash
#
# check-dist-fresh.sh — commit 済み dist が src と一致していることを機械強制する。
#
# なぜ dist を commit するか: consumer は SHA pin で取るので build を持たない
# (gate-kit と同じ型)。鮮度が切れると「直したはずの修正が入っていない package」を
# 配る — 利用側からは正常に見える silent failure。
#
# 一時 outDir に build して比較する (working tree の dist を書き換えない)。
# この比較が成立する前提として tsconfig.build.json は sourceMap / declarationMap を
# 出さない: map は outDir からの相対で sources を書くため、別 outDir に出すと
# sources に絶対パスが入り byte 一致しない (gate が原理的に常時 red になる)。
# 加えて公開物の files は dist のみなので、map の sources (../../src/…) は同梱されず
# consumer 側では dead link になる — 出しても誰も使えない。
#
# exit: 0 = fresh / 1 = stale / 2 = 判定不能 (gate 誤設定・build 失敗)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${GRAPHQL_KIT_DIST_DIR:-${ROOT}/dist}"
TSCONFIG="${GRAPHQL_KIT_TSCONFIG:-${ROOT}/tsconfig.build.json}"
TMP_OUT="$(mktemp -d)"

# shellcheck disable=SC2329  # trap EXIT から間接的に呼ばれる
cleanup() { rm -rf "${TMP_OUT}"; }
trap cleanup EXIT

if [[ ! -d "${DIST_DIR}" ]]; then
	echo "✗ dist dir not found: ${DIST_DIR} (gate 誤設定 — npm run build を実行したか確認)" >&2
	exit 2
fi

if ! git -C "${ROOT}" ls-files --error-unmatch dist >/dev/null 2>&1; then
	echo "✗ dist が git 管理下にない (gate は意味を持たない — .gitignore を確認)" >&2
	exit 2
fi

# tsc の exit code をそのまま漏らさない: 設定不正でも 1 を返すため、そのまま
# 通すと「stale (exit 1)」と誤って報告する (test: a failing build exits 2)。
if ! (cd "${ROOT}" && npx tsc -p "${TSCONFIG}" --outDir "${TMP_OUT}") >/dev/null; then
	echo "✗ build が通らない (判定不能 — 鮮度を判定できない。tsconfig と src を確認)" >&2
	exit 2
fi

diff_log="${TMP_OUT}/../dist-diff.txt"
if diff -rq "${DIST_DIR}" "${TMP_OUT}" >"${diff_log}" 2>&1; then
	echo "✓ graphql-kit dist fresh"
	exit 0
fi

echo "✗ dist が src と一致していない — npm run build して commit する" >&2
echo "  (tsc は outDir の古い出力を消さない。使わなくなった file — 例えば .map — が" >&2
echo "   dist に残っていると差分に出続けるので、その場合は消してから build し直す)" >&2
/usr/bin/sed 's/^/  /' "${diff_log}" >&2
exit 1
