#!/usr/bin/env bash
#
# run-bats.sh — bats を回し、**0 件で緑にならない**ようにする。
#
# なぜ要るか: bats は対象が見つからない時 `1..0` を出して exit 0 する。
# path を間違えた瞬間に「gate を回している」表示だけが残り、prove-red も
# fail-loud も走らないまま緑になる (2026-09-25 に実際に踏んだ — tests/ にある
# のに scripts/tests/ を指していた)。件数の下限を機械で持つ。
#
# BATS_TESTS_DIR で対象 dir を差し替えられる (runner 自身のテストが使う)。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TESTS_DIR="${BATS_TESTS_DIR:-tests}"
MIN_TESTS="${BATS_MIN_TESTS:-1}"

# 絶対パス指定も受ける (runner 自身のテストが hermetic な dir を渡す)
case "${TESTS_DIR}" in
/*) tests_abs="${TESTS_DIR}" ;;
*) tests_abs="${ROOT}/${TESTS_DIR}" ;;
esac

if [[ ! -d "${tests_abs}" ]]; then
	echo "✗ bats 対象 dir が無い: ${TESTS_DIR} (gate 誤設定)" >&2
	exit 2
fi

set +e
output="$(cd "${ROOT}" && bats "${tests_abs}" 2>&1)"
rc=$?
set -e

printf '%s\n' "${output}"

if [[ "${rc}" -ne 0 ]]; then
	exit "${rc}"
fi

count="$(printf '%s\n' "${output}" | /usr/bin/grep -cE '^ok ' || true)"
if [[ "${count}" -lt "${MIN_TESTS}" ]]; then
	echo "✗ bats の実行件数が下限を下回った: ${count} < ${MIN_TESTS} (gate 誤設定 — ${TESTS_DIR} を確認)" >&2
	exit 2
fi

echo "✓ bats ${count} 件 green"
