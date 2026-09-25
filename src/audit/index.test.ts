import { parse } from 'graphql';
import { createYoga } from 'graphql-yoga';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { describe, expect, it } from 'vitest';
import {
  auditPlugin,
  createEphemeralAudit,
  readOperations,
  type AuditRecord,
  type AuditSink,
} from './index.ts';

// 「誰がいつ何を見たか」を consumer のコードに書かせない形。
// append-only は書き込み API に削除・更新が無いことで担保し、永続化は sink に任せる
// (業務側ロールに DELETE 権限を与えない設計は consumer の DB 側の仕事)。

const AT = new Date('2026-09-25T12:00:00.000Z');

function collectingSink(): { sink: AuditSink; written: AuditRecord[] } {
  const written: AuditRecord[] = [];
  return {
    written,
    sink: {
      write: async (record) => {
        written.push(record);
      },
    },
  };
}

describe('readOperations', () => {
  it('reads the operation type, name and root field of a mutation', () => {
    const ops = readOperations(parse('mutation StartSession { startSession { ok } }'));
    expect(ops).toEqual([
      {
        operationType: 'mutation',
        operationName: 'StartSession',
        action: 'startSession',
        detail: 'mutation StartSession',
      },
    ]);
  });

  it('falls back to the root field when the operation is anonymous', () => {
    const ops = readOperations(parse('{ store { name } }'));
    expect(ops[0]?.operationName).toBe('');
    expect(ops[0]?.action).toBe('store');
    expect(ops[0]?.detail).toBe('query store');
  });

  it('reads subscriptions', () => {
    const ops = readOperations(parse('subscription { sessionChanged { id } }'));
    expect(ops[0]?.operationType).toBe('subscription');
    expect(ops[0]?.action).toBe('sessionChanged');
  });

  it('lists every operation in a multi-operation document', () => {
    const ops = readOperations(parse('query A { me { id } } mutation B { endSession { ok } }'));
    expect(ops.map((o) => o.action)).toEqual(['me', 'endSession']);
  });
});

describe('createEphemeralAudit', () => {
  it('exposes a write-only sink and a read-only reader', () => {
    const { sink, reader } = createEphemeralAudit();
    expect(Object.keys(sink)).toEqual(['write']);
    expect(Object.keys(reader)).toEqual(['records']);
  });

  it('records what the sink was given, in order', async () => {
    const { sink, reader } = createEphemeralAudit();
    await sink.write({ at: AT.toISOString(), actor: 'ph-1', action: 'a', operationType: 'query', operationName: '', detail: 'query a' });
    await sink.write({ at: AT.toISOString(), actor: 'ph-1', action: 'b', operationType: 'mutation', operationName: '', detail: 'mutation b' });
    expect(reader.records().map((r) => r.action)).toEqual(['a', 'b']);
  });

  it('does not hand out the live array (記録は外から書き換えられない)', async () => {
    const { sink, reader } = createEphemeralAudit();
    await sink.write({ at: AT.toISOString(), actor: 'ph-1', action: 'a', operationType: 'query', operationName: '', detail: 'query a' });
    const got = reader.records() as AuditRecord[];
    got.length = 0;
    expect(reader.records()).toHaveLength(1);
  });
});

describe('auditPlugin', () => {
  function makeServer(options: { sink: AuditSink; actor?: string | null }) {
    const schema = makeExecutableSchema({
      typeDefs: `
        type Query { store: Store! }
        type Store { name: String! }
        type Mutation { endSession: Boolean! }
      `,
      resolvers: {
        Query: { store: () => ({ name: 'x' }) },
        Mutation: { endSession: () => true },
      },
    });
    return createYoga({
      schema,
      plugins: [
        auditPlugin({
          sink: options.sink,
          resolveActor: () => options.actor ?? null,
          now: () => AT,
        }),
      ],
    });
  }

  async function post(server: ReturnType<typeof makeServer>, query: string) {
    return server.fetch('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    });
  }

  it('records a query (閲覧も記録する — 厚労省 7.0 版 3-1)', async () => {
    const { sink, written } = collectingSink();
    await post(makeServer({ sink, actor: 'ph-1' }), 'query List { store { name } }');

    expect(written).toEqual([
      {
        at: AT.toISOString(),
        actor: 'ph-1',
        operationType: 'query',
        operationName: 'List',
        action: 'store',
        detail: 'query List',
      },
    ]);
  });

  it('records a mutation', async () => {
    const { sink, written } = collectingSink();
    await post(makeServer({ sink, actor: 'ph-1' }), 'mutation End { endSession }');
    expect(written[0]?.operationType).toBe('mutation');
    expect(written[0]?.action).toBe('endSession');
  });

  it('marks an unknown actor as anonymous (actor が無いリクエストも記録は残す)', async () => {
    const { sink, written } = collectingSink();
    await post(makeServer({ sink, actor: null }), '{ store { name } }');
    expect(written[0]?.actor).toBe('anonymous');
  });

  it('records one row per operation (batching off でも文書に 2 本あれば 2 行)', async () => {
    const { sink, written } = collectingSink();
    await post(
      makeServer({ sink, actor: 'ph-1' }),
      'query A { store { name } } mutation B { endSession }',
    );
    // operationName を指定しない multi-operation 文書は実行されない (400) ので 0 行
    expect(written).toHaveLength(0);
  });

  it('never fails the request when the sink throws (監査の失敗で本業を止めない)', async () => {
    const sink: AuditSink = {
      write: async () => {
        throw new Error('audit store down');
      },
    };
    const res = await post(makeServer({ sink, actor: 'ph-1' }), '{ store { name } }');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { store?: { name?: string } } };
    expect(body.data?.store?.name).toBe('x');
  });

  it('reports the sink failure to the caller (黙って捨てない)', async () => {
    const errors: unknown[] = [];
    const sink: AuditSink = {
      write: async () => {
        throw new Error('audit store down');
      },
    };
    const schema = makeExecutableSchema({
      typeDefs: 'type Query { store: String! }',
      resolvers: { Query: { store: () => 'x' } },
    });
    const server = createYoga({
      schema,
      plugins: [
        auditPlugin({
          sink,
          resolveActor: () => 'ph-1',
          now: () => AT,
          onWriteError: (error) => errors.push(error),
        }),
      ],
    });
    await server.fetch('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ store }' }),
    });
    expect(errors).toHaveLength(1);
  });
});
