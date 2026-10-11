// GraphQL over HTTP の**呼ぶ側**の核。1 回の POST と、その上の「認証付き client」。
//
// なぜ lib に置くか: 同じ POST 核 (Content-Type / Bearer / `{data,errors}` の展開) が
// 7 つの repo で独立に書かれていた。差は 3 点だけで、いずれも引数で吸収できる —
//   1. エラー型        → GraphQLClientError 1 つに寄せ、code で分岐させる
//   2. fetch の実体    → fetchImpl 注入 (Cloudflare Service Binding はここで包む)
//   3. 失敗の扱い      → 既定は throw。握り潰す caller は try/catch で包む
//
// server 側 (http-gate / refusal) とは直交する。refusal が定める「断りは payload の
// union で返す」のうち、ここが扱うのは `errors[]` に載って届いた分 (想定外) だけ。
// payload union の中身は呼び出し側の型が知っている。
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
export class GraphQLClientError extends Error {
    status;
    code;
    errors;
    constructor(message, options = {}) {
        super(message);
        this.name = 'GraphQLClientError';
        this.status = options.status;
        this.code = options.code;
        this.errors = options.errors ?? [];
    }
}
/** `errors[]` を 1 つの message にする。2 件目以降も残す (最初の 1 件で捨てない)。 */
function joinMessages(errors) {
    return errors.map((e) => e.message).join('; ');
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
export async function graphqlRequest(init) {
    const { endpoint, query, variables, token, credentials, headers, onResponse, signal, fetchImpl, } = init;
    const doFetch = fetchImpl ?? ((input, requestInit) => fetch(input, requestInit));
    const requestHeaders = { 'Content-Type': 'application/json' };
    if (token)
        requestHeaders['Authorization'] = `Bearer ${token}`;
    for (const [key, value] of Object.entries(headers ?? {}))
        requestHeaders[key] = value;
    const requestInit = {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({ query, variables }),
    };
    if (credentials)
        requestInit.credentials = credentials;
    if (signal)
        requestInit.signal = signal;
    const res = await doFetch(endpoint, requestInit);
    await onResponse?.(res);
    const text = await res.text().catch(() => '');
    let json;
    try {
        json = JSON.parse(text);
    }
    catch {
        json = undefined;
    }
    if (!res.ok) {
        // gate が 400 / 415 を GraphQL の封筒 (errors[]) で返す実装がある。status だけで
        // 打ち切ると code が消え、呼び出し側が理由で分岐できなくなる。
        const errors = json?.errors;
        if (errors !== undefined && errors.length > 0) {
            throw new GraphQLClientError(joinMessages(errors), {
                status: res.status,
                code: errors[0]?.extensions?.code,
                errors,
            });
        }
        throw new GraphQLClientError(`GraphQL request failed: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`, { status: res.status });
    }
    if (json === undefined) {
        throw new GraphQLClientError('GraphQL response was not JSON', { status: res.status });
    }
    const errors = json.errors;
    if (errors !== undefined && errors.length > 0) {
        throw new GraphQLClientError(joinMessages(errors), {
            status: res.status,
            code: errors[0]?.extensions?.code,
            errors,
        });
    }
    if (json.data === undefined) {
        throw new GraphQLClientError('GraphQL response had neither data nor errors', {
            status: res.status,
        });
    }
    return json.data;
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
export function createAuthedGraphQLClient(opts) {
    const resolveEndpoint = typeof opts.endpoint === 'function' ? opts.endpoint : () => opts.endpoint;
    return {
        async request(query, variables) {
            const token = await opts.getToken();
            if (opts.requireToken !== false && !token) {
                throw new GraphQLClientError('Not authenticated', { code: 'UNAUTHENTICATED' });
            }
            return graphqlRequest({
                endpoint: resolveEndpoint(),
                query,
                variables,
                token,
                credentials: opts.credentials,
                headers: opts.headers,
                onResponse: opts.onResponse,
                signal: opts.signal,
                fetchImpl: opts.fetchImpl,
            });
        },
    };
}
