import { makeExecutableSchema } from '@graphql-tools/schema';
import { buildSchema } from 'graphql';
import { createYoga } from 'graphql-yoga';
import { describe, expect, it } from 'vitest';

import { buildManifest, persistedPlugin, sha256Hex, validateManifest, type PersistedManifest } from './index.ts';

const sdl = `type Query { room(id: ID!): Room  rooms: [Room!]! }  type Room { id: ID!  name: String! }`;
// yoga と同じ graphql を使う (vitest の ESM と yoga の CJS で別の graphql を読むのを避ける。audit の試験と同じ)
const schema = makeExecutableSchema({
  typeDefs: sdl,
  resolvers: { Query: { room: (_: unknown, { id }: { id: string }) => ({ id, name: 'A' }), rooms: () => [{ id: '1', name: 'A' }] } },
});

const ROOM = 'query Room($id: ID!) { room(id: $id) { id name } }';
const ROOMS = 'query Rooms { rooms { id } }';

async function yogaWith(manifest: PersistedManifest, allowArbitrary: (req: Request) => boolean = () => false) {
  return createYoga({ schema, graphqlEndpoint: '/graphql', plugins: [persistedPlugin({ manifest, allowArbitrary })] });
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://x/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('buildManifest', () => {
  it('名前付きの操作 1 つの文書ごとに sha256 を鍵にする (本文はそのまま)', async () => {
    const m = await buildManifest([ROOM, ROOMS]);
    const h = await sha256Hex(ROOM);
    expect(m[h]).toEqual({ name: 'Room', document: ROOM });
    expect(Object.keys(m)).toHaveLength(2);
  });

  it('無名・2 つ以上の操作・壊れた文書・名前の重複は台帳にしない (投げる)', async () => {
    await expect(buildManifest(['{ rooms { id } }'])).rejects.toThrow('名前');
    await expect(buildManifest([`${ROOM} ${ROOMS}`])).rejects.toThrow('1 つ');
    await expect(buildManifest(['query {'])).rejects.toThrow();
    await expect(buildManifest([ROOMS, 'query Rooms { rooms { name } }'])).rejects.toThrow('Rooms');
  });
});

describe('validateManifest', () => {
  it('台帳の操作が schema に通らなければ名前と理由を返す (ci の gate)', async () => {
    const m = await buildManifest([ROOM, 'query Bad { nope }']);
    // validateManifest は kit と同じ graphql で作った schema を受ける (ビルドの script が buildSchema で読む形)
    const sdlSchema = buildSchema(sdl);
    const problems = validateManifest(sdlSchema, m);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^Bad: /);
    expect(validateManifest(sdlSchema, await buildManifest([ROOM]))).toEqual([]);
  });
});

describe('persistedPlugin', () => {
  it('登録した hash だけで実行できる (本文を送らなくてよい)', async () => {
    const m = await buildManifest([ROOM]);
    const yoga = await yogaWith(m);
    const res = await yoga.fetch(
      post({ variables: { id: '7' }, extensions: { persistedQuery: { version: 1, sha256Hash: await sha256Hex(ROOM) } } }),
    );
    expect(await res.json()).toEqual({ data: { room: { id: '7', name: 'A' } } });
  });

  it('登録の無い hash は実行しない (PERSISTED_QUERY_NOT_FOUND)', async () => {
    const yoga = await yogaWith(await buildManifest([ROOM]));
    const res = await yoga.fetch(post({ extensions: { persistedQuery: { version: 1, sha256Hash: 'a'.repeat(64) } } }));
    const body = (await res.json()) as { data?: unknown; errors: { extensions: { code: string } }[] };
    expect(body.data).toBeUndefined();
    expect(body.errors[0]?.extensions.code).toBe('PERSISTED_QUERY_NOT_FOUND');
  });

  it('本文を送る任意の問い合わせは、許した要求の他は実行しない (PERSISTED_QUERY_ONLY)', async () => {
    const yoga = await yogaWith(await buildManifest([ROOM]));
    const res = await yoga.fetch(post({ query: ROOMS }));
    const body = (await res.json()) as { data?: unknown; errors: { extensions: { code: string } }[] };
    expect(body.data).toBeUndefined();
    expect(body.errors[0]?.extensions.code).toBe('PERSISTED_QUERY_ONLY');
  });

  it('登録した本文と同じ文字列を送っても、hash が無ければ任意の問い合わせとして扱う (本文で台帳を回らせない)', async () => {
    const yoga = await yogaWith(await buildManifest([ROOMS]));
    const res = await yoga.fetch(post({ query: ROOMS }));
    expect(((await res.json()) as { errors: { extensions: { code: string } }[] }).errors[0]?.extensions.code).toBe(
      'PERSISTED_QUERY_ONLY',
    );
  });

  it('allowArbitrary が許した要求 (開発の鍵など) は本文を送れる', async () => {
    const yoga = await yogaWith(await buildManifest([ROOM]), (req) => req.headers.get('x-dev') === '1');
    const res = await yoga.fetch(post({ query: ROOMS }, { 'x-dev': '1' }));
    expect(await res.json()).toEqual({ data: { rooms: [{ id: '1' }] } });
  });

  it('hash と本文を両方送ったら、hash の本文で実行する (送られた本文は使わない)', async () => {
    const yoga = await yogaWith(await buildManifest([ROOMS]));
    const res = await yoga.fetch(
      post({ query: ROOM, variables: { id: '1' }, extensions: { persistedQuery: { version: 1, sha256Hash: await sha256Hex(ROOMS) } } }),
    );
    expect(await res.json()).toEqual({ data: { rooms: [{ id: '1' }] } });
  });

  it('知らない版・形の悪い hash は登録外と同じに扱う', async () => {
    const yoga = await yogaWith(await buildManifest([ROOM]));
    for (const pq of [{ version: 2, sha256Hash: await sha256Hex(ROOM) }, { version: 1, sha256Hash: 'XYZ' }, { version: 1 }]) {
      const res = await yoga.fetch(post({ extensions: { persistedQuery: pq } }));
      expect(((await res.json()) as { errors: { extensions: { code: string } }[] }).errors[0]?.extensions.code).toBe(
        'PERSISTED_QUERY_NOT_FOUND',
      );
    }
  });
});
