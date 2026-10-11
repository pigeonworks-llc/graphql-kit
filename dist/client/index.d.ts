/** GraphQL の応答封筒。`extensions.code` は resolver が付ける機械可読な理由。 */
export interface GraphQLResponse<T> {
    data?: T;
    errors?: GraphQLClientErrorPayload[];
}
/** `errors[]` の 1 要素。message は人向け、extensions.code は分岐用。 */
export interface GraphQLClientErrorPayload {
    message: string;
    extensions?: {
        code?: string;
    } & Record<string, unknown>;
}
/**
 * 呼び出しが失敗したことを表す唯一のエラー型。
 *
 * **code で分岐する** — 文言で分岐させない (refusal と同じ理由)。`code` は
 * `errors[0].extensions.code` の写しで、複数 error がある場合は最初のもの。
 * 全量は `errors` に残す (join した message だけでは 2 件目以降が消える)。
 *
 * `status` は非 2xx で落ちた時だけ入る。GraphQL の `errors[]` は HTTP 200 で来るので、
 * `status === 200` なら「transport は成功、実行が失敗」を意味する。
 */
export declare class GraphQLClientError extends Error {
    readonly status: number | undefined;
    readonly code: string | undefined;
    readonly errors: readonly GraphQLClientErrorPayload[];
    constructor(message: string, options?: {
        status?: number;
        code?: string;
        errors?: readonly GraphQLClientErrorPayload[];
    });
}
/** token を返す注入点。同期・非同期どちらも許容 (null は未認証)。 */
export type TokenProvider = () => Promise<string | null> | string | null;
/** fetch の差し替え点。Cloudflare の Service Binding もこの形で渡す。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface GraphQLRequestInit {
    /** 完全な URL。 */
    endpoint: string;
    query: string;
    variables?: Record<string, unknown>;
    /** 指定時 `Authorization: Bearer <token>` を付与。null / undefined なら付けない。 */
    token?: string | null;
    /** cookie 認証用 (例: "include")。Bearer と併用も可。 */
    credentials?: 'omit' | 'same-origin' | 'include';
    /** 追加 header。Service Binding の Host 指定などに使う。 */
    headers?: Record<string, string>;
    /** 応答を parse する前に呼ぶフック (例: 401 で独自例外を投げる)。 */
    onResponse?: (res: Response) => void | Promise<void>;
    /** 停滞した相手に引きずられないための上限。 */
    signal?: AbortSignal;
    /** テスト / 別ランタイム用の fetch 差し替え。既定は global fetch。 */
    fetchImpl?: FetchLike;
}
/**
 * 1 回の GraphQL POST。`{data, errors}` を展開し、`data` を返す。
 *
 * 失敗はすべて `GraphQLClientError` に統一する (例外の型を 2 本にしない):
 * - 非 2xx           → status 付き。**body が GraphQL の封筒なら `errors[]` も拾う**
 *                      (gate が 400 / 415 を `errors[]` で返す実装があり、status で
 *                      打ち切ると code が消える)。封筒でなければ body を 200 字まで
 * - JSON でない body → status 付き (parse 失敗を素の SyntaxError で漏らさない)
 * - `errors[]` あり  → code / errors 付き (HTTP は 200 のことが多い)
 * - `data` が無い    → 空応答。`undefined` を返すと、呼び出し側の分割代入が
 *                      静かに undefined になる (silent failure)
 */
export declare function graphqlRequest<T>(init: GraphQLRequestInit): Promise<T>;
export interface AuthedGraphQLClientOptions {
    /** 文字列、または呼び出し時に解決する resolver (origin が動的な場合に使う)。 */
    endpoint: string | (() => string);
    /** token 取得。null を返すと (requireToken の既定 true で) 例外になる。 */
    getToken: TokenProvider;
    /** false にすると token が null でも投げず、無認証で送る。既定 true。 */
    requireToken?: boolean;
    credentials?: 'omit' | 'same-origin' | 'include';
    headers?: Record<string, string>;
    onResponse?: (res: Response) => void | Promise<void>;
    signal?: AbortSignal;
    fetchImpl?: FetchLike;
}
export interface AuthedGraphQLClient {
    request<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
}
/**
 * token 注入式の認証付き client。
 *
 * endpoint は**呼び出しごとに解決する** ので、`() => getOrigin() + '/graphql'` の
 * ような動的な origin にも対応する (起動時に固定できない runtime がある)。
 *
 * token が無い時に投げるのは `GraphQLClientError` であって素の `Error` ではない —
 * caller が「認証が無い」を transport の失敗と同じ型・同じ code で扱えるようにする。
 */
export declare function createAuthedGraphQLClient(opts: AuthedGraphQLClientOptions): AuthedGraphQLClient;
