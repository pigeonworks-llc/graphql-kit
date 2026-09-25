import { GraphQLEnumType } from 'graphql';
/**
 * 基底の断り理由。transport に依らず必要なものだけを置く。
 * 案件固有の理由 (照合の不一致 等) は消費側が extra で足す。
 */
export declare const BASE_FAILURE_REASONS: readonly ["UNAUTHENTICATED", "PERMISSION_DENIED", "NOT_FOUND", "VALIDATION", "INVALID_STATE", "CONFLICT", "RATE_LIMITED", "UPSTREAM_FAILED", "OVER_CAPACITY"];
export type BaseFailureReason = (typeof BASE_FAILURE_REASONS)[number];
/** retryAfterSeconds を添えて返す理由。他の理由では待っても直らない */
export declare const RETRYABLE_REASONS: readonly ["RATE_LIMITED", "UPSTREAM_FAILED", "OVER_CAPACITY"];
/** 消費側 schema に埋め込むための FailureReason enum (extra を含む) */
export declare function buildFailureReasonEnum(extra?: readonly string[]): GraphQLEnumType;
/**
 * enum + type Refused の SDL。schema-first (makeExecutableSchema) の
 * typeDefs に文字列連結で入れる。extra は案件固有の理由。
 */
export declare function refusalSdl(extra?: readonly string[]): string;
/** resolver が返す値。__typename を自分で持つので union の resolveType が要らない */
export interface Refused {
    __typename: 'Refused';
    reason: string;
    retryAfterSeconds?: number;
}
/** 断りを組む。retryAfterSeconds を渡さなければ key 自体を作らない */
export declare function refuse(reason: BaseFailureReason | (string & {}), options?: {
    retryAfterSeconds?: number;
}): Refused;
/** union の分岐。client / 消費側 resolver の両方から使う */
export declare function isRefused(value: unknown): value is Refused;
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
export declare function resolveRefusedUnion(successTypes: Record<string, string>): (value: unknown, _context?: unknown, info?: {
    parentType?: {
        name?: string;
    };
    fieldName?: string;
}) => string | null;
