// 並びの順と組み合わせは conformance/secure-handler.test.ts。ここは単体の約束だけ。

import { makeExecutableSchema } from '@graphql-tools/schema';
import { describe, expect, it } from 'vitest';

import { createEphemeralAudit } from '../audit/index.ts';
import { authzSdl } from '../authz/index.ts';
import { buildManifest, sha256Hex } from '../persisted/index.ts';
import { memoryRateStore } from '../rate/index.ts';
import { memoryRevocationStore, mintToken } from '../token/index.ts';
import { ARBITRARY_SCOPE, secureGraphqlHandler } from './index.ts';

const schema = makeExecutableSchema({
  typeDefs: `${authzSdl} type Query { me: String @auth(scopes: ["me:read"]) }`,
  resolvers: { Query: { me: () => 'm' } },
});
const ME = 'query Me { me }';

async function handler(pepper: string) {
  return secureGraphqlHandler({
    schema,
    prefix: 'demo',
    pepper,
    revocations: memoryRevocationStore(),
    rate: memoryRateStore(),
    rateLimit: null,
    manifest: await buildManifest([ME]),
    limits: { maxDepth: 5, maxComplexity: 50 },
    sink: createEphemeralAudit().sink,
  });
}

const req = (token: string, body: unknown) =>
  new Request('https://x/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

describe('secureGraphqlHandler (単体)', () => {
  it('pepper が短いと正しく出した鍵でも 401 (黙って開かない)', async () => {
    const { token } = await mintToken({ prefix: 'demo', pepper: 'p'.repeat(32), sub: 'u', scopes: ['me:read'], kind: 'cli' });
    const h = await handler('short');
    const res = await h(req(token, { extensions: { persistedQuery: { version: 1, sha256Hash: await sha256Hex(ME) } } }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('配列の本文 (batching) と JSON でない本文は 400 BAD_REQUEST', async () => {
    const pepper = 'p'.repeat(32);
    const { token } = await mintToken({ prefix: 'demo', pepper, sub: 'u', scopes: ['me:read'], kind: 'cli' });
    const h = await handler(pepper);
    const batch = await h(req(token, [{ query: ME }]));
    expect(batch.status).toBe(400);
    expect(((await batch.json()) as { errors: { extensions: { code: string } }[] }).errors[0]!.extensions.code).toBe('BAD_REQUEST');
    const broken = await h(
      new Request('https://x/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: '{',
      }),
    );
    expect(broken.status).toBe(400);
  });

  it('任意の本文を開ける scope の名前', () => {
    expect(ARBITRARY_SCOPE).toBe('ops:arbitrary');
  });
});
