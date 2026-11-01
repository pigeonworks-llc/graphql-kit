// 架空ドメイン (図書館の貸出) の conformance。実在の製品と無関係な題材で、consumers が
// 約束している形 — **provider が型を変えると、壊れる使い手だけを名指しで赤にする** —
// が通ることを証明する (techne 抽出 3 点セットの 3 点目)。
//
// ここで確かめているのは「部品が動く」ことではなく、複数の使い手を抱えた provider が
// 型を変えた時に、照合が正しい相手だけを指すこと:
//   - 型を変える前は全員緑
//   - field を改名すると、その field を読む使い手だけが赤 (読まない使い手は緑のまま)
//   - 1 つの file が別の provider も叩いていても、その分は数えない (宣言で宛先を決める)

import { buildSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import { checkConsumerSource, type ConsumerSpec } from '../src/consumers/index.ts';

const before = buildSchema(`
  type Query { books(shelf: String): [Book!]! book(id: ID!): Book }
  type Book { id: ID! title: String! dueAt: String }
`);
// provider が dueAt を returnBy に改名した
const after = buildSchema(`
  type Query { books(shelf: String): [Book!]! book(id: ID!): Book }
  type Book { id: ID! title: String! returnBy: String }
`);

// 使い手 A: 返却期限を見る (TS の template literal)
const reminder: ConsumerSpec = {
  name: 'reminder',
  where: 'acme/reminder:src/due.ts',
  roots: ['books'],
  minOperations: 1,
};
const reminderSrc = 'export const DUE = `query { books(shelf: "a") { id dueAt } }`;';

// 使い手 B: 題名だけを見る。同じ file から別の provider (座席予約) も叩く (Python)
const shelfView: ConsumerSpec = {
  name: 'shelf-view',
  where: 'acme/shelf-view:shelf.py',
  roots: ['book'],
  minOperations: 1,
};
const shelfViewSrc = [
  'BOOK = """{ book(id: "1") { id title } }"""',
  'SEATS = """{ seats(room: "r") { number } }"""', // 別の provider 宛て — 数えない
].join('\n');

describe('consumers の conformance (架空: 図書館)', () => {
  it('型を変える前は全員緑', () => {
    expect(checkConsumerSource(reminder, reminderSrc, before)).toEqual([]);
    expect(checkConsumerSource(shelfView, shelfViewSrc, before)).toEqual([]);
  });

  it('field を改名すると、その field を読む使い手だけが名指しで赤', () => {
    const r = checkConsumerSource(reminder, reminderSrc, after);
    expect(r.join('\n')).toContain('reminder');
    expect(r.join('\n')).toContain('dueAt');
    // shelf-view は dueAt を読まないので緑のまま
    expect(checkConsumerSource(shelfView, shelfViewSrc, after)).toEqual([]);
  });

  it('別の provider 宛ての document (seats) は、この schema に無くても赤にしない', () => {
    // seats は この schema に無い root。宛先の宣言に入っていないので照合しない
    expect(checkConsumerSource(shelfView, shelfViewSrc, before)).toEqual([]);
  });
});
