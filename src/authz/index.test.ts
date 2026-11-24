import { buildSchema, parse } from 'graphql';
import { describe, expect, it } from 'vitest';

import { assertAuthzTable, authorize, authzSdl, INTROSPECTION_SCOPE, scopesOf } from './index.ts';

// 架空ドメイン (会議室予約)
const schema = buildSchema(`
  ${authzSdl}
  type Room { id: ID! name: String! }
  type Query {
    health: String @public
    room(id: ID!): Room @auth(scopes: ["rooms:read"])
    rooms: [Room!]! @auth(scopes: ["rooms:read"])
  }
  type Mutation {
    bookRoom(id: ID!): Room @auth(scopes: ["rooms:write"])
    renameRoom(id: ID!, name: String!): Room @auth(scopes: ["rooms:write", "rooms:admin"])
  }
`);

const table = scopesOf(schema);
const ask = (query: string, scopes: readonly string[], operationName?: string) =>
  authorize(parse(query), operationName, scopes, table);

describe('scopesOf', () => {
  it('root field ごとに要る scope を @auth から読む。@public は空の配列', () => {
    expect(table.fields).toEqual({
      'Query.health': [],
      'Query.room': ['rooms:read'],
      'Query.rooms': ['rooms:read'],
      'Mutation.bookRoom': ['rooms:write'],
      'Mutation.renameRoom': ['rooms:write', 'rooms:admin'],
    });
    expect(table.missing).toEqual([]);
  });

  it('@auth も @public も無い root field は missing に出す (既定で閉じる)', () => {
    const open = scopesOf(buildSchema(`${authzSdl} type Query { a: Int @public  b: Int }`));
    expect(open.missing).toEqual(['Query.b']);
    expect(() => assertAuthzTable(open)).toThrow('Query.b');
    expect(() => assertAuthzTable(table)).not.toThrow();
  });

  it('@auth と @public を両方付けた・空の scopes は誤り', () => {
    expect(() => scopesOf(buildSchema(`${authzSdl} type Query { a: Int @public @auth(scopes: ["x:read"]) }`))).toThrow(
      'Query.a',
    );
    expect(() => scopesOf(buildSchema(`${authzSdl} type Query { a: Int @auth(scopes: []) }`))).toThrow('Query.a');
  });
});

describe('authorize', () => {
  it('要る scope を全部持っていれば通す。@public は鍵の scope に依らず通す', () => {
    expect(ask('{ room(id: "1") { id } }', ['rooms:read'])).toEqual({ ok: true, fields: ['Query.room'] });
    expect(ask('{ health }', [])).toEqual({ ok: true, fields: ['Query.health'] });
  });

  it('足りない scope と、それを要る field を返す', () => {
    expect(ask('mutation { renameRoom(id: "1", name: "B") { id } }', ['rooms:write'])).toEqual({
      ok: false,
      denied: [{ field: 'Mutation.renameRoom', missing: ['rooms:admin'] }],
    });
  });

  it('1 つの文書の中で許されない root field が 1 つでもあれば全体を拒む (alias を使っても)', () => {
    const r = ask('{ a: room(id: "1") { id }  b: health }', []);
    expect(r).toEqual({ ok: false, denied: [{ field: 'Query.room', missing: ['rooms:read'] }] });
  });

  it('fragment の中の root field も数える', () => {
    const r = ask('query Q { ...F } fragment F on Query { rooms { id } }', []);
    expect(r).toEqual({ ok: false, denied: [{ field: 'Query.rooms', missing: ['rooms:read'] }] });
  });

  it('introspection (__schema / __type) は schema:read が要る。__typename は誰でもよい', () => {
    expect(ask('{ __schema { types { name } } }', ['rooms:read'])).toEqual({
      ok: false,
      denied: [{ field: 'Query.__schema', missing: [INTROSPECTION_SCOPE] }],
    });
    expect(ask('{ __type(name: "Room") { name } }', [INTROSPECTION_SCOPE]).ok).toBe(true);
    expect(ask('{ __typename }', []).ok).toBe(true);
  });

  it('表に無い root field は拒む (schema と表がずれていても開かない)', () => {
    const r = authorize(parse('{ ghost }'), undefined, ['rooms:read'], { fields: {}, missing: [] });
    expect(r).toEqual({ ok: false, denied: [{ field: 'Query.ghost', missing: ['(未登録)'] }] });
  });

  it('operationName で選んだ操作だけを見る。決まらない文書は拒む', () => {
    const doc = 'query A { health } mutation B { bookRoom(id: "1") { id } }';
    expect(ask(doc, [], 'A').ok).toBe(true);
    expect(ask(doc, [], 'B').ok).toBe(false);
    expect(ask(doc, [])).toEqual({ ok: false, denied: [{ field: '(操作)', missing: ['(操作が決まらない)'] }] });
  });
});
