#!/usr/bin/env bash
#
# purity-check.sh — src/ に製品固有の語彙・依存が混ざっていないことを機械強制する。
#
# 対象 dir は GRAPHQL_KIT_SRC_DIR で上書き可。dir 不在は exit 2
# (silent green を許さない — gate 自体の誤設定を検出する。techne 還元規約 §検証機構の
# 負の複利「stale gate / silent green」)。
#
# 判定 3 軸 (techne 抽出 3 点セットの 2 点目):
#   name     — 製品名・repo 名。出所の説明は README / CATALOG に置き、src には残さない
#   domain   — 製品のドメイン語彙 (データ・用語)。架空 fixture も走査対象
#   depfree  — 外部依存は graphql / graphql-yoga / @graphql-tools のみ
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${GRAPHQL_KIT_SRC_DIR:-src}"
abs="${ROOT}/${SRC_DIR}"

if [[ ! -d "${abs}" ]]; then
	echo "✗ src dir not found: ${SRC_DIR} (gate 誤設定 — GRAPHQL_KIT_SRC_DIR を確認)" >&2
	exit 2
fi

GREP=/usr/bin/grep
fail=0

# 製品識別子。file:line を出す (prove-red が fixture 名を assert できる)
NAME_RE='order-base|eatreel|kai-mcp|\bkai\b|remote-pharmacy|\bplan7\b|\bgera\b|ゲルテック|PharmaKIOSK|YAKUREKI|OKUSURI'

# ドメイン語彙。製品のデータ・用語が漏れていればここで捕まる (xenia の FAQ 実データと同型)
DOMAIN_RE='薬剤師|処方箋|薬歴|服薬|受付機|調剤|患者|注文|献立|pharmac|kiosk|prescription|dispens'

# 出荷物 (dist に入る .ts) が import してよい外部依存。相対 import と node: builtin は通す。
# これ以外を足したくなったら、それは consumer 側の関心ではないか一度疑う。
ALLOWED_DEPS_RE='^(graphql|graphql-yoga|@graphql-tools/schema|@graphql-tools/utils)$'
# test は runner と補助 (schema 構築) を使ってよい。出荷物ではないため
ALLOWED_DEPS_TEST_RE='^(vitest|graphql|graphql-yoga|@graphql-tools/schema|@graphql-tools/utils)$'

check_pattern() {
	local label="$1" pattern="$2" hits
	hits="$("${GREP}" -rnE "${pattern}" "${abs}" --include='*.ts' || true)"
	if [[ -n "${hits}" ]]; then
		printf '✗ %s: 製品固有の記述が src に残っている\n%s\n' "${label}" "${hits}" >&2
		fail=1
	fi
}

check_pattern "purity-name" "${NAME_RE}"
check_pattern "purity-domain" "${DOMAIN_RE}"

# 依存の判定。file ごとに import 文と動的 import の specifier を集め、
# test かどうかで許可リストを変える (出荷物に test runner を混ぜない)。
while IFS= read -r file; do
	[[ -z "${file}" ]] && continue
	allowed_re="${ALLOWED_DEPS_RE}"
	case "${file}" in
	*.test.ts) allowed_re="${ALLOWED_DEPS_TEST_RE}" ;;
	esac
	# 引用符は ' と " の両方を受ける (gate が style に依存しない)
	specifiers="$(
		{
			"${GREP}" -oE "from ['\"][^'\"]+['\"]" "${file}" || true
			"${GREP}" -oE "import\(['\"][^'\"]+['\"]\)" "${file}" || true
		} | sed -E "s/^from ['\"]//; s/['\"]\)\$//; s/['\"]\$//" | sort -u
	)"
	while IFS= read -r spec; do
		[[ -z "${spec}" ]] && continue
		case "${spec}" in
		./* | ../* | node:*) continue ;;
		esac
		if ! printf '%s' "${spec}" | "${GREP}" -qE "${allowed_re}"; then
			printf '✗ purity-depfree: 許可されていない依存: %s (%s)\n' "${spec}" "${file#"${ROOT}/"}" >&2
			fail=1
		fi
	done <<<"${specifiers}"
done < <(find "${abs}" -name '*.ts' -type f | sort)

if [[ "${fail}" -ne 0 ]]; then
	exit 1
fi
echo "✓ graphql-kit purity OK"
