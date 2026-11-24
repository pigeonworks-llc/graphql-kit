// secureGraphqlHandler の conformance (架空ドメイン: 会議室予約)。
//
// 確かめるのは「部品を決まった順に通した時に、決まりが守られる」こと:
//   入口 → 鍵 → 登録した問い合わせ → 深さ・複雑さ → 回数 → 権限 → 実行 (監査)
// - 鍵の無い要求は回数を使わない (誰でも窓を埋められない)
// - 登録外の hash・権限の無い要求は yoga (resolver) に届かない
// - 権限で落ちた要求も監査に残る
// - 断りは client の GraphQLClientError で status と code の両方が取れる

import { makeExecutableSchema } from '@graphql-tools/schema';
import { describe, expect, it } from 'vitest';

import { createEphemeralAudit } from '../src/audit/index.ts';
import { authzSdl } from '../src/authz/index.ts';
import { GraphQLClientError, graphqlRequest } from '../src/client/index.ts';
import { buildManifest, sha256Hex } from '../src/persisted/index.ts';
import { memoryRateStore } from '../src/rate/index.ts';
import { refusalSdl } from '../src/refusal/index.ts';
import { secureGraphqlHandler, type SecureHandlerOptions } from '../src/secure/index.ts';
import { memoryRevocationStore, mintToken } from '../src/token/index.ts';

const PEPPER = 'p'.repeat(32);
const NOW = new Date('2026-11-24T00:00:00Z');

const typeDefs = `
  ${authzSdl}
  ${refusalSdl()}
  type Room { id: ID! name: String! }
  type Query {
    health: String @public
    room(id: ID!): Room @auth(scopes: ["rooms:read"])
  }
  type Mutation {
    bookRoom(id: ID!): Room @auth(scopes: ["rooms:write"])
  }
`;

const ROOM = 'query Room($id: ID!) { room(id: $id) { id name } }';
const BOOK = 'mutation BookRoom($id: ID!) { bookRoom(id: $id) { id } }';
const HEALTH = 'query Health { health }';
const DEEP = 'query Deep { room(id: "1") { id name } }';

async function setup(over: Partial<SecureHandlerOptions> = {}) {
  const calls: string[] = [];
  const schema = makeExecutableSchema({
    typeDefs,
    resolvers: {
      Query: {
        health: () => 'ok',
        room: (_: unknown, a: { id: string }) => {
          calls.push(`room:${a.id}`);
          return { id: a.id, name: 'A' };
        },
      },
      Mutation: {
        bookRoom: (_: unknown, a: { id: string }) => {
          calls.push(`book:${a.id}`);
          return { id: a.id, name: 'A' };
        },
      },
    },
  });
  const manifest = await buildManifest([ROOM, BOOK, HEALTH, DEEP]);
  const audit = createEphemeralAudit();
  const revocations = memoryRevocationStore();
  const rate = memoryRateStore();
  const handle = secureGraphqlHandler({
    schema,
    prefix: 'rooms',
    pepper: PEPPER,
    revocations,
    rate,
    rateLimit: { windowSeconds: 60, perWindow: 20 },
    manifest,
    limits: { maxDepth: 5, maxComplexity: 50 },
    sink: audit.sink,
    now: () => NOW,
    ...over,
  });
  const key = async (scopes: string[], sub = 'cli-1') =>
    (await mintToken({ prefix: 'rooms', pepper: PEPPER, sub, scopes, kind: 'cli', now: NOW })).token;
  return { handle, calls, audit, revocations, key };
}

async function call(
  handle: (r: Request) => Promise<Response>,
  document: string,
  opts: { token?: string; variables?: Record<string, unknown>; raw?: boolean; ip?: string } = {},
) {
  const body = opts.raw
    ? { query: document, variables: opts.variables }
    : { variables: opts.variables, extensions: { persistedQuery: { version: 1, sha256Hash: await sha256Hex(document) } } };
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.ip) headers['cf-connecting-ip'] = opts.ip;
  const res = await handle(new Request('https://x/graphql', { method: 'POST', headers, body: JSON.stringify(body) }));
  const json = (await res.json()) as { data?: unknown; errors?: { extensions?: { code?: string } }[] };
  return { status: res.status, json, code: json.errors?.[0]?.extensions?.code, retryAfter: res.headers.get('retry-after') };
}

describe('secureGraphqlHandler: 並びの順と断り', () => {
  it('scope の合う鍵 + 登録した hash だけが実行に届く', async () => {
    const { handle, calls, key } = await setup();
    const r = await call(handle, ROOM, { token: await key(['rooms:read']), variables: { id: '1' } });
    expect(r).toMatchObject({ status: 200, json: { data: { room: { id: '1', name: 'A' } } } });
    expect(calls).toEqual(['room:1']);
  });

  it('鍵が無い・壊れている・失効した → 401 UNAUTHENTICATED (@public だけは鍵なしで通る)', async () => {
    const { handle, calls, key, revocations } = await setup();
    expect(await call(handle, ROOM, { variables: { id: '1' } })).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(await call(handle, ROOM, { token: 'rooms.v1.x.y', variables: { id: '1' } })).toMatchObject({ status: 401 });
    const token = await key(['rooms:read']);
    await revocations.revoke('cli-1', new Date(NOW.getTime() + 1000));
    expect(await call(handle, ROOM, { token, variables: { id: '1' } })).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(await call(handle, HEALTH)).toMatchObject({ status: 200, json: { data: { health: 'ok' } } });
    expect(calls).toEqual([]);
  });

  it('登録外の hash・本文の任意の問い合わせ → 400、resolver に届かない', async () => {
    const { handle, calls, key } = await setup();
    const token = await key(['rooms:read']);
    expect(await call(handle, 'query Other { room(id: "9") { id } }', { token })).toMatchObject({
      status: 400,
      code: 'PERSISTED_QUERY_NOT_FOUND',
    });
    expect(await call(handle, 'query Other { room(id: "9") { id } }', { token, raw: true })).toMatchObject({
      status: 400,
      code: 'PERSISTED_QUERY_ONLY',
    });
    expect(calls).toEqual([]);
  });

  it('scope "ops:arbitrary" の鍵だけ本文を送れる (それでも深さ・権限は見る)', async () => {
    const { handle, calls, key } = await setup();
    const dev = await key(['rooms:read', 'ops:arbitrary']);
    const r = await call(handle, 'query Any { room(id: "2") { id } }', { token: dev, raw: true });
    expect(r).toMatchObject({ status: 200, json: { data: { room: { id: '2' } } } });
    expect(await call(handle, 'mutation M { bookRoom(id: "2") { id } }', { token: dev, raw: true })).toMatchObject({
      status: 403,
      code: 'PERMISSION_DENIED',
    });
    expect(calls).toEqual(['room:2']);
  });

  it('scope が足りない → 403 PERMISSION_DENIED、resolver に届かず、監査には断りとして残る', async () => {
    const { handle, calls, key, audit } = await setup();
    const r = await call(handle, BOOK, { token: await key(['rooms:read']), variables: { id: '1' } });
    expect(r).toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(calls).toEqual([]);
    expect(audit.reader.records()).toEqual([
      expect.objectContaining({ actor: 'cli-1', operationType: 'mutation', operationName: 'BookRoom', action: 'bookRoom' }),
    ]);
    expect(audit.reader.records()[0]!.detail).toBe('denied PERMISSION_DENIED: mutation BookRoom');
  });

  it('実行した操作は監査に残り、actor は鍵の sub', async () => {
    const { handle, key, audit } = await setup();
    await call(handle, BOOK, { token: await key(['rooms:write'], 'ai-7'), variables: { id: '3' } });
    expect(audit.reader.records()).toEqual([
      expect.objectContaining({ actor: 'ai-7', operationName: 'BookRoom', detail: 'mutation BookRoom' }),
    ]);
  });

  it('深さ・複雑さの上限 → 400 TOO_DEEP / TOO_COMPLEX', async () => {
    const { handle, key } = await setup({ limits: { maxDepth: 1, maxComplexity: 50 } });
    expect(await call(handle, DEEP, { token: await key(['rooms:read']) })).toMatchObject({ status: 400, code: 'TOO_DEEP' });
  });

  it('回数の上限 → 429 RATE_LIMITED + Retry-After。鍵ごとに数え、鍵の無い要求は窓を使わない', async () => {
    const { handle, key } = await setup({ rateLimit: { windowSeconds: 60, perWindow: 4 } });
    const a = await key(['rooms:read'], 'a');
    // 鍵なしの 401 は回数を使わない
    for (let i = 0; i < 10; i++) await call(handle, ROOM, { variables: { id: '1' } });
    // ROOM の複雑さは 3 (room / id / name)。窓は 4 なので 1 回で 3 使い、2 回目で超える
    expect((await call(handle, ROOM, { token: a, variables: { id: '1' } })).status).toBe(200);
    const limited = await call(handle, ROOM, { token: a, variables: { id: '1' } });
    expect(limited).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect(Number(limited.retryAfter)).toBeGreaterThan(0);
    const b = await key(['rooms:read'], 'b');
    expect((await call(handle, ROOM, { token: b, variables: { id: '1' } })).status).toBe(200);
  });

  it('鍵なしで断った要求は、同じ接続元の窓を使わない (401 を連打されても @public は通る)', async () => {
    const { handle } = await setup({ rateLimit: { windowSeconds: 60, perWindow: 1 } });
    for (let i = 0; i < 10; i++) {
      expect((await call(handle, ROOM, { variables: { id: '1' }, ip: '198.51.100.7' })).status).toBe(401);
    }
    expect((await call(handle, HEALTH, { ip: '198.51.100.7' })).status).toBe(200);
  });

  it('@public の鍵なし要求は接続元で数える', async () => {
    const { handle } = await setup({ rateLimit: { windowSeconds: 60, perWindow: 1 } });
    expect((await call(handle, HEALTH, { ip: '192.0.2.1' })).status).toBe(200);
    expect((await call(handle, HEALTH, { ip: '192.0.2.1' })).status).toBe(429);
    expect((await call(handle, HEALTH, { ip: '192.0.2.2' })).status).toBe(200);
  });

  it('GET は 405、text/plain は 415 (鍵を見る前に弾く)', async () => {
    const { handle } = await setup();
    const get = await handle(new Request('https://x/graphql'));
    expect(get.status).toBe(405);
    const plain = await handle(new Request('https://x/graphql', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }));
    expect(plain.status).toBe(415);
  });

  it('client から見ると、断りは GraphQLClientError の status と code で分けられる', async () => {
    const { handle, key } = await setup();
    const fetchImpl = (input: string, init?: RequestInit) => handle(new Request(input, init));
    const err = await graphqlRequest({
      endpoint: 'https://x/graphql',
      query: BOOK,
      variables: { id: '1' },
      token: await key(['rooms:read']),
      fetchImpl,
      extensions: { persistedQuery: { version: 1, sha256Hash: await sha256Hex(BOOK) } },
      omitQuery: true,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphQLClientError);
    expect(err).toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
  });

  it('@auth の書き忘れがある schema では作れない (既定で閉じる)', () => {
    const schema = makeExecutableSchema({ typeDefs: `${authzSdl} type Query { open: Int }` });
    expect(() =>
      secureGraphqlHandler({
        schema,
        prefix: 'rooms',
        pepper: PEPPER,
        revocations: memoryRevocationStore(),
        rate: memoryRateStore(),
        rateLimit: null,
        manifest: {},
        limits: { maxDepth: 5, maxComplexity: 50 },
        sink: createEphemeralAudit().sink,
      }),
    ).toThrow('Query.open');
  });
});
