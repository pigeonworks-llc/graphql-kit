// 「失敗は errors[] でなく payload の union で返す」形の 1 箇所化。
//
// なぜ union か: errors[] と payload の両方に失敗を出すと、client は
// 「payload を見る経路」と「errors[] を見る経路」の 2 本を持つことになり、
// 片方だけ実装した client が黙って壊れる。errors[] は想定外 (resolver の例外)
// だけに残し、想定内の断りは必ず payload で返す。HTTP は 200。
//
// なぜ規約が要るか: この形は複数の案件で独立に現れたが、payload の一部を
// union にするか interface にするかが揃っていなかった。断りは client から見れば
// 同じ形である方が良い — 理由の列挙と生成を 1 つにする。
import { GraphQLEnumType } from 'graphql';
/**
 * 基底の断り理由。transport に依らず必要なものだけを置く。
 * 案件固有の理由 (照合の不一致 等) は消費側が extra で足す。
 */
export const BASE_FAILURE_REASONS = [
    'UNAUTHENTICATED',
    'PERMISSION_DENIED',
    'NOT_FOUND',
    'VALIDATION',
    'INVALID_STATE',
    'CONFLICT',
    'RATE_LIMITED',
    'UPSTREAM_FAILED',
    'OVER_CAPACITY',
];
/** retryAfterSeconds を添えて返す理由。他の理由では待っても直らない */
export const RETRYABLE_REASONS = ['RATE_LIMITED', 'UPSTREAM_FAILED', 'OVER_CAPACITY'];
const REASON_DESCRIPTIONS = {
    UNAUTHENTICATED: '認証が無い・切れている。再ログインで直る',
    PERMISSION_DENIED: '認証はあるが権限が足りない。role ごとに断る',
    NOT_FOUND: '対象が存在しない (権限が無い場合も存在を漏らさないためこれで返す)',
    VALIDATION: '入力が不正。message にどの入力かを書く',
    INVALID_STATE: '現在の状態では操作できない (状態機械の外からの遷移)',
    CONFLICT: '同時更新・重複。同じ操作の繰り返しで直る場合がある',
    RATE_LIMITED: '回数制限。retryAfterSeconds を添える',
    UPSTREAM_FAILED: '外部連携が失敗。再送の対象。retryAfterSeconds を添えてよい',
    OVER_CAPACITY: '同時数の上限。retryAfterSeconds を添えてよい',
};
const EXTRA_REASON_PATTERN = /^[A-Z][A-Z0-9_]*$/;
function mergeReasons(extra) {
    const merged = [...BASE_FAILURE_REASONS];
    for (const reason of extra) {
        if (!EXTRA_REASON_PATTERN.test(reason)) {
            throw new Error(`断り理由は SCREAMING_SNAKE_CASE にしてください: ${reason}`);
        }
        if (!merged.includes(reason))
            merged.push(reason);
    }
    return merged;
}
/** 消費側 schema に埋め込むための FailureReason enum (extra を含む) */
export function buildFailureReasonEnum(extra = []) {
    const values = {};
    for (const reason of mergeReasons(extra)) {
        const description = REASON_DESCRIPTIONS[reason];
        values[reason] = description ? { value: reason, description } : { value: reason };
    }
    return new GraphQLEnumType({
        name: 'FailureReason',
        description: '断りの理由。閉じた列挙。画面と agent は文言でなくこれで分岐する',
        values,
    });
}
/**
 * enum + type Refused の SDL。schema-first (makeExecutableSchema) の
 * typeDefs に文字列連結で入れる。extra は案件固有の理由。
 */
export function refusalSdl(extra = []) {
    const values = mergeReasons(extra)
        .map((reason) => {
        const description = REASON_DESCRIPTIONS[reason];
        return description ? `  """${description}"""\n  ${reason}` : `  ${reason}`;
    })
        .join('\n');
    return `
"""断りの理由。閉じた列挙。画面と agent は文言でなくこれで分岐する"""
enum FailureReason {
${values}
}

"""
断り。どの mutation でも同じ形。
retryAfterSeconds は RETRYABLE_REASONS のときだけ入る (0 は「待たなくてよい」)。
"""
type Refused {
  reason: FailureReason!
  retryAfterSeconds: Int
}
`.trim();
}
/** 断りを組む。retryAfterSeconds を渡さなければ key 自体を作らない */
export function refuse(reason, options = {}) {
    const refused = { __typename: 'Refused', reason };
    if (options.retryAfterSeconds !== undefined) {
        refused.retryAfterSeconds = options.retryAfterSeconds;
    }
    return refused;
}
/** union の分岐。client / 消費側 resolver の両方から使う */
export function isRefused(value) {
    return (typeof value === 'object' &&
        value !== null &&
        value.__typename === 'Refused');
}
/**
 * 断りを含む payload の union の resolveType。
 *
 * graphql-js は union の実体を `__typename` で決める (無ければ各型の isTypeOf を
 * 順に試す)。Refused は refuse() が `__typename` を持つが、**成功側の payload は
 * 普通それを持たない** ので、成功側にも `__typename` を書かせるか、resolveType を
 * 与えるかのどちらかが要る。後者を選ぶのは、成功側の resolver が業務の値を
 * そのまま返せるようにするため (`__typename` を足すために object を組み直さない)。
 *
 * `successTypes` は 'Mutation.bookRoom' → 'BookRoomSuccess' の対応。型ごとに 1 行。
 * 宣言が無いフィールドは null を返す (当て推量で解決しない — 解決できない時は
 * graphql が「resolveType が解決できない」と loud に落とす)。
 */
export function resolveRefusedUnion(successTypes) {
    return (value, _context, info) => {
        if (isRefused(value))
            return 'Refused';
        if (value === null || value === undefined)
            return null;
        const explicit = value.__typename;
        if (typeof explicit === 'string')
            return explicit;
        const parent = info?.parentType?.name;
        const field = info?.fieldName;
        if (!parent || !field)
            return null;
        return successTypes[`${parent}.${field}`] ?? null;
    };
}
