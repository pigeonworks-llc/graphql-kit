// 架空ドメイン (会議室予約) の conformance。実在の製品と無関係な題材で
// 3 module を組み合わせ、kit が約束している形が通ることを証明する
// (techne 抽出 3 点セットの 3 点目)。
//
// ここで確かめているのは「部品が動く」ことではなく「部品を組み合わせた時に
// 規約が守られる」こと: 入口で弾く / 断りは payload / 全操作が監査に残る。

import { makeExecutableSchema } from '@graphql-tools/schema';
import { createYoga } from 'graphql-yoga';
import { describe, expect, it } from 'vitest';
import { auditPlugin, createEphemeralAudit, type AuditSink } from '../src/audit/index.ts';
import {
  checkOperation,
  decideGraphqlHttpMethod,
  rejectIfDisallowedContentType,
} from '../src/http-gate/index.ts';
import { refusalSdl, refuse, resolveRefusedUnion, type Refused } from '../src/refusal/index.ts';

const LIMITS = { maxDepth: 5, maxComplexity: 50 };

const typeDefs = `
  ${refusalSdl(['ROOM_TAKEN'])}

  type Room {
    id: ID!
    name: String!
    capacity: Int!
  }

  type BookingSuccess {
    bookingId: ID!
    hour: Int!
  }

  union BookRoomPayload = BookingSuccess | Refused

  type Query {
    room(id: ID!): Room
  }

  type Mutation {
    bookRoom(roomId: ID!, hour: Int!): BookRoomPayload!
  }
`;

const ROOMS = new Map([['r-1', { id: 'r-1', name: 'Sakura', capacity: 8 }]]);
const BOOKED = new Set<string>();

const schema = makeExecutableSchema({
  typeDefs,
  resolvers: {
    // 成功側の payload は __typename を持たないので、union の解決は 1 行で宣言する
    BookRoomPayload: {
      __resolveType: resolveRefusedUnion({ 'Mutation.bookRoom': 'BookingSuccess' }),
    },
    Query: {
      room: (_root: unknown, args: { id: string }) => ROOMS.get(args.id) ?? null,
    },
    Mutation: {
      bookRoom: (_root: unknown, args: { roomId: string; hour: number }): BookingSuccessLike | Refused => {
        if (!ROOMS.has(args.roomId)) return refuse('NOT_FOUND');
        const key = `${args.roomId}@${args.hour}`;
        if (BOOKED.has(key)) return refuse('ROOM_TAKEN');
        BOOKED.add(key);
        return { bookingId: `b-${key}`, hour: args.hour };
      },
    },
  },
});

interface BookingSuccessLike {
  bookingId: string;
  hour: number;
}

/** 消費側が書く transport。http-gate の判定を Response に落とすだけ */
function makeHandler(options: { sink: AuditSink; actor?: string | null }) {
  const yoga = createYoga({
    schema,
    plugins: [
      auditPlugin({
        sink: options.sink,
        resolveActor: () => options.actor ?? null,
      }),
    ],
  });

  return async function handle(request: Request): Promise<Response> {
    const method = decideGraphqlHttpMethod(request.method);
    if (!method.allowed) {
      return new Response('Method Not Allowed', {
        status: method.status,
        headers: { Allow: method.allow },
      });
    }
    const badType = rejectIfDisallowedContentType(request.headers.get('content-type'));
    if (badType) return new Response(badType.message, { status: badType.status });

    if (request.method === 'POST') {
      const body = (await request.clone().json()) as { query?: string };
      if (typeof body.query === 'string') {
        const decision = checkOperation(body.query, LIMITS);
        if (!decision.allowed) {
          return Response.json({ errors: [{ message: decision.message }] }, { status: decision.status });
        }
      }
    }
    return yoga.fetch(request);
  };
}

function post(handle: (req: Request) => Promise<Response>, query: string, variables?: unknown) {
  return handle(
    new Request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    }),
  );
}

describe('conformance: 会議室予約 (架空ドメイン)', () => {
  it('GET は 405、text/plain は 415 (入口で弾く)', async () => {
    const { sink } = createEphemeralAudit();
    const handle = makeHandler({ sink, actor: 'u-1' });

    const get = await handle(new Request('http://localhost/graphql'));
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');

    const plain = await handle(
      new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: '{"query":"{ room(id:\\"r-1\\") { name } }"}',
      }),
    );
    expect(plain.status).toBe(415);
  });

  it('深すぎるクエリは 400 で、resolver は走らない', async () => {
    const { sink, reader } = createEphemeralAudit();
    const handle = makeHandler({ sink, actor: 'u-1' });

    const res = await post(handle, '{ a { b { c { d { e { f } } } } } }');
    expect(res.status).toBe(400);
    // 実行されていないので監査にも残らない (onExecute まで届いていない)
    expect(reader.records()).toHaveLength(0);
  });

  it('成功した mutation は payload で返り、errors[] は空', async () => {
    const { sink } = createEphemeralAudit();
    const handle = makeHandler({ sink, actor: 'u-1' });

    const res = await post(
      handle,
      'mutation Book { bookRoom(roomId: "r-1", hour: 10) { ... on BookingSuccess { bookingId hour } ... on Refused { reason } } }',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data?: { bookRoom?: { bookingId?: string } };
      errors?: unknown[];
    };
    expect(body.errors).toBeUndefined();
    expect(body.data?.bookRoom?.bookingId).toBe('b-r-1@10');
  });

  it('断りも HTTP 200 + payload (errors[] に出さない)', async () => {
    const { sink } = createEphemeralAudit();
    const handle = makeHandler({ sink, actor: 'u-1' });
    await post(handle, 'mutation { bookRoom(roomId: "r-1", hour: 11) { ... on BookingSuccess { bookingId } } }');

    const res = await post(
      handle,
      'mutation { bookRoom(roomId: "r-1", hour: 11) { ... on BookingSuccess { bookingId } ... on Refused { reason } } }',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data?: { bookRoom?: { reason?: string } };
      errors?: unknown[];
    };
    expect(body.errors).toBeUndefined();
    expect(body.data?.bookRoom?.reason).toBe('ROOM_TAKEN');
  });

  it('案件固有の断り理由 (extra) が閉じた列挙として機能する', async () => {
    const res = await post(
      makeHandler({ sink: createEphemeralAudit().sink, actor: 'u-1' }),
      'mutation { bookRoom(roomId: "nope", hour: 3) { ... on Refused { reason retryAfterSeconds } } }',
    );
    const body = (await res.json()) as { data?: { bookRoom?: Refused } };
    expect(body.data?.bookRoom?.reason).toBe('NOT_FOUND');
    // retryAfterSeconds は schema 上 nullable なので応答には null で現れる。
    // 「待っても直らない断りに秒数を入れない」ことは refuse() の側で担保する
    // (キーを作らない) — ここでは null であることを確かめる。
    expect(body.data?.bookRoom?.retryAfterSeconds ?? null).toBeNull();
  });

  it('閲覧 (query) も監査に残る', async () => {
    const { sink, reader } = createEphemeralAudit();
    const handle = makeHandler({ sink, actor: 'u-1' });
    await post(handle, 'query Look { room(id: "r-1") { name } }');

    expect(reader.records()).toHaveLength(1);
    expect(reader.records()[0]).toMatchObject({
      actor: 'u-1',
      operationType: 'query',
      operationName: 'Look',
      action: 'room',
    });
  });

  it('認証が無いリクエストも anonymous として記録される', async () => {
    const { sink, reader } = createEphemeralAudit();
    const handle = makeHandler({ sink, actor: null });
    await post(handle, '{ room(id: "r-1") { name } }');
    expect(reader.records()[0]?.actor).toBe('anonymous');
  });

  it('監査 sink が落ちても本業は成功する', async () => {
    const sink: AuditSink = {
      write: () => {
        throw new Error('audit store down');
      },
    };
    const res = await post(makeHandler({ sink, actor: 'u-1' }), '{ room(id: "r-1") { name } }');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { room?: { name?: string } } };
    expect(body.data?.room?.name).toBe('Sakura');
  });
});
