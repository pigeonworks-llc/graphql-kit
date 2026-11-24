import { buildSchema } from 'graphql';
import { describe, expect, it } from 'vitest';

import { buildManifest } from '../persisted/index.ts';
import { findRefused, operationTools } from './index.ts';

// 架空ドメイン (会議室予約)
const schema = buildSchema(`
  enum Size { SMALL LARGE }
  input CreateRoomInput { name: String!  capacity: Int!  size: Size  tags: [String!]  open: Boolean }
  type Refused { reason: String!  retryAfterSeconds: Int }
  type Room { id: ID!  name: String! }
  union RoomPayload = Room | Refused
  type Query { room(id: ID!): Room  rooms(first: Int = 20, after: String): [Room!]! }
  type Mutation { createRoom(input: CreateRoomInput!): RoomPayload! }
`);

const GET = '# 会議室を id で 1 件取る\nquery GetRoom($id: ID!) { room(id: $id) { id name } }\n';
const LIST = '# 会議室を並べる\n# 続きは after\nquery ListRooms($first: Int = 20, $after: String) { rooms(first: $first, after: $after) { id } }\n';
const CREATE = '# 会議室を 1 件作る\nmutation CreateRoom($input: CreateRoomInput!) { createRoom(input: $input) { ... on Room { id } ... on Refused { reason } } }\n';

describe('operationTools', async () => {
  const manifest = await buildManifest([GET, LIST, CREATE]);
  const tools = operationTools(schema, manifest);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  it('台帳の操作ごとに 1 つ。名前・hash・種類・説明 (先頭の # 行をつないだもの)', () => {
    expect(tools.map((t) => t.name)).toEqual(['CreateRoom', 'GetRoom', 'ListRooms']);
    expect(byName.GetRoom).toMatchObject({ kind: 'query', description: '会議室を id で 1 件取る' });
    expect(byName.ListRooms!.description).toBe('会議室を並べる 続きは after');
    expect(byName.CreateRoom!.kind).toBe('mutation');
    expect(manifest[byName.GetRoom!.hash]!.name).toBe('GetRoom');
  });

  it('変数を JSON Schema にする。非 null は required、既定値は default', () => {
    expect(byName.GetRoom!.inputSchema).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    });
    expect(byName.ListRooms!.inputSchema).toEqual({
      type: 'object',
      properties: { first: { type: 'integer', default: 20 }, after: { type: 'string' } },
      additionalProperties: false,
    });
  });

  it('input object・enum・リスト・真偽を schema から展開する', () => {
    expect(byName.CreateRoom!.inputSchema).toEqual({
      type: 'object',
      properties: {
        input: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            capacity: { type: 'integer' },
            size: { type: 'string', enum: ['SMALL', 'LARGE'] },
            tags: { type: 'array', items: { type: 'string' } },
            open: { type: 'boolean' },
          },
          required: ['name', 'capacity'],
          additionalProperties: false,
        },
      },
      required: ['input'],
      additionalProperties: false,
    });
  });

  it('説明の無い操作は作らない (AI が tool を選べない)', async () => {
    const m = await buildManifest(['query NoDoc { rooms { id } }']);
    expect(() => operationTools(schema, m)).toThrow('NoDoc');
  });

  it('schema に無い型の変数は投げる (台帳と schema のずれ)', async () => {
    const m = await buildManifest(['# x\nquery Ghost($x: GhostInput!) { rooms { id } }']);
    expect(() => operationTools(schema, m)).toThrow('GhostInput');
  });
});

describe('findRefused', () => {
  it('結果の中の Refused (reason を持つ object) を探す。無ければ null', () => {
    expect(findRefused({ createRoom: { reason: 'NOT_FOUND', retryAfterSeconds: null } })).toEqual({
      field: 'createRoom',
      reason: 'NOT_FOUND',
      retryAfterSeconds: null,
    });
    expect(findRefused({ createRoom: { id: '1' } })).toBeNull();
    expect(findRefused({ room: null })).toBeNull();
    expect(findRefused(null)).toBeNull();
  });
});
