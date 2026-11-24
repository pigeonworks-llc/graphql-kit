// 安全な GraphQL の面の入口。部品を決まった順に通し、Worker の fetch から 1 行で呼べるようにする。
//
//   入口 (POST / Content-Type) → 鍵 (検証 + 失効) → 登録した問い合わせ → 深さ・複雑さ
//   → 回数 (cost = 複雑さ) → 権限 (@auth) → 実行 (yoga, batching なし, maskedErrors) + 監査
//
// 順の理由:
// - 鍵を最初に見る: 鍵の無い要求に回数を使わせない (誰でも他人の窓を埋められない)。
//   ただし @public の操作だけの要求は鍵なしで通し、接続元 (cf-connecting-ip) で数える
// - 回数は複雑さを測った後: 重い問い合わせほど多く数えるため
// - 権限は実行の直前: 登録・深さで落ちる要求に表を引かせない。落ちたら resolver に届かない
//
// 断りの形 (入口の断りは HTTP status + GraphQL の封筒 errors[0].extensions.code):
//   405 / 415                     入口
//   401 UNAUTHENTICATED           鍵が無い・壊れている・失効した (理由は返さない)
//   400 BAD_REQUEST / PERSISTED_QUERY_NOT_FOUND / PERSISTED_QUERY_ONLY / INVALID_QUERY / TOO_DEEP / TOO_COMPLEX
//   429 RATE_LIMITED + Retry-After
//   403 PERMISSION_DENIED
// 業務の想定内の断り (NOT_FOUND / CONFLICT など) は今までどおり resolver が Refused payload で返す。
//
// 監査: 実行した操作は auditPlugin が記録する。権限で断った要求も 1 行残す
// (detail = "denied PERMISSION_DENIED: mutation BookRoom")。鍵の無い要求・入口の断りは残さない
// (誰のものとも言えず、量で sink を埋められるため)。
//
// 本文の任意の問い合わせは、鍵の scope に ARBITRARY_SCOPE ("ops:arbitrary") がある時だけ。

import { parse, type DocumentNode, type GraphQLSchema } from 'graphql';
import { createYoga } from 'graphql-yoga';

import { auditPlugin, readOperations, type AuditSink } from '../audit/index.ts';
import { assertAuthzTable, authorize, scopesOf } from '../authz/index.ts';
import { decideGraphqlHttpMethod, isAllowedGraphqlContentType } from '../http-gate/index.ts';
import { checkOperation, type OperationLimits } from '../http-gate/operation.ts';
import { resolvePersisted, type GraphqlParams, type PersistedManifest } from '../persisted/index.ts';
import type { RateLimit, RateStore } from '../rate/index.ts';
import { bearer, isRevoked, verifyToken, type Claims, type RevocationStore } from '../token/index.ts';

export const ARBITRARY_SCOPE = 'ops:arbitrary';

export interface SecureHandlerOptions {
  readonly schema: GraphQLSchema;
  /** 鍵の prefix (面の名前) */
  readonly prefix: string;
  /** 鍵の pepper。空・短いと全部 401 になる (黙って開かない) */
  readonly pepper: string;
  readonly revocations: RevocationStore;
  readonly rate: RateStore;
  /** null なら数えない */
  readonly rateLimit: RateLimit | null;
  readonly manifest: PersistedManifest;
  readonly limits: Omit<OperationLimits, 'operationName'>;
  readonly sink: AuditSink;
  readonly graphqlEndpoint?: string;
  readonly now?: () => Date;
  /** resolver の context に足すもの (env など)。principal は handler が入れる */
  readonly context?: (request: Request) => Record<string, unknown> | Promise<Record<string, unknown>>;
  readonly onAuditError?: (error: unknown) => void;
}

/** resolver の context に入る主体。鍵なしの @public 要求は null */
export interface SecureContext {
  readonly principal: Claims | null;
}

function refusal(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ errors: [{ message, extensions: { code } }] }, { status, headers });
}

const unauthenticated = () => refusal(401, 'UNAUTHENTICATED', '鍵が要ります', { 'WWW-Authenticate': 'Bearer' });

export function secureGraphqlHandler(options: SecureHandlerOptions): (request: Request) => Promise<Response> {
  const table = scopesOf(options.schema);
  assertAuthzTable(table);
  const now = options.now ?? (() => new Date());
  const endpoint = options.graphqlEndpoint ?? '/graphql';

  const yoga = createYoga<Record<string, unknown>>({
    schema: options.schema,
    graphqlEndpoint: endpoint,
    batching: false,
    maskedErrors: true,
    graphiql: false,
    landingPage: false,
    plugins: [
      auditPlugin({
        sink: options.sink,
        resolveActor: (ctx) => (ctx as SecureContext).principal?.sub ?? null,
        now,
        ...(options.onAuditError ? { onWriteError: options.onAuditError } : {}),
      }),
    ],
  });

  return async function handle(request: Request): Promise<Response> {
    // 1. 入口
    const method = decideGraphqlHttpMethod(request.method);
    if (!method.allowed) return new Response('Method Not Allowed', { status: 405, headers: { Allow: method.allow } });
    if (!isAllowedGraphqlContentType(request.headers.get('content-type'))) {
      return refusal(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type は application/json にしてください');
    }

    // 2. 鍵 (無ければ後で @public だけかを見る)
    const raw = bearer(request);
    let principal: Claims | null = null;
    if (raw !== null) {
      const claims = await verifyToken(raw, { prefix: options.prefix, pepper: options.pepper, now: now() });
      if (!claims || (await isRevoked(options.revocations, claims))) return unauthenticated();
      principal = claims;
    }

    // 3. 登録した問い合わせ
    let params: GraphqlParams;
    try {
      const body: unknown = await request.clone().json();
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return refusal(400, 'BAD_REQUEST', '本文は 1 つの JSON object (batching は受けない)');
      }
      params = body as GraphqlParams;
    } catch {
      return refusal(400, 'BAD_REQUEST', '本文を JSON として読めません');
    }
    const arbitrary = principal?.scopes.includes(ARBITRARY_SCOPE) ?? false;
    const resolved = resolvePersisted(params, options.manifest, arbitrary);
    if (!resolved.ok) {
      // 鍵なしで任意の本文を送った要求は、登録の断りより先に鍵の断りを返す
      return principal === null && resolved.code === 'PERSISTED_QUERY_ONLY'
        ? unauthenticated()
        : refusal(400, resolved.code, resolved.message);
    }

    // 4. 深さ・複雑さ
    const measured = checkOperation(resolved.query, { ...options.limits, operationName: resolved.operationName });
    if (!measured.allowed) return refusal(400, measured.reason, measured.message);
    let document: DocumentNode;
    try {
      document = parse(resolved.query);
    } catch {
      return refusal(400, 'INVALID_QUERY', 'クエリを解析できません');
    }

    // 鍵なしは @public の操作だけ
    const decision = authorize(document, resolved.operationName, principal?.scopes ?? [], table);
    if (principal === null && !decision.ok) return unauthenticated();

    // 5. 回数 (鍵があれば主体、無ければ接続元)
    if (options.rateLimit) {
      const key = principal ? `sub:${principal.sub}` : `ip:${request.headers.get('cf-connecting-ip') ?? 'unknown'}`;
      const spent = await options.rate.spend(
        key,
        Math.max(1, measured.complexity),
        options.rateLimit,
        Math.floor(now().getTime() / 1000),
      );
      if (!spent.ok) {
        return refusal(429, 'RATE_LIMITED', '回数の上限を超えました', { 'Retry-After': String(spent.retryAfterSeconds) });
      }
    }

    // 6. 権限
    if (!decision.ok) {
      await writeDenied(options, document, resolved.operationName, principal, now());
      return refusal(403, 'PERMISSION_DENIED', 'この鍵ではこの操作を呼べません');
    }

    // 7. 実行。本文は台帳の本文に差し替えて yoga に渡す
    const forwarded = new Request(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: resolved.query, operationName: resolved.operationName, variables: params.variables }),
    });
    const extra = options.context ? await options.context(request) : {};
    const context: Record<string, unknown> & SecureContext = { ...extra, principal };
    return yoga.fetch(forwarded, context);
  };
}

async function writeDenied(
  options: SecureHandlerOptions,
  document: DocumentNode,
  operationName: string | undefined,
  principal: Claims | null,
  at: Date,
): Promise<void> {
  const ops = readOperations(document).filter((o) => operationName === undefined || o.operationName === operationName);
  for (const op of ops) {
    try {
      await options.sink.write({
        at: at.toISOString(),
        actor: principal?.sub ?? 'anonymous',
        ...op,
        detail: `denied PERMISSION_DENIED: ${op.detail}`,
      });
    } catch (error) {
      options.onAuditError?.(error);
    }
  }
}
