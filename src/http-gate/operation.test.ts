import { describe, expect, it } from 'vitest';
import { checkOperation, measureOperation } from './operation.ts';

// depth = selection set の入れ子の深さ、complexity = 選択フィールドの総数。
// 引数による重み付けはしない (上限の目的は「1 リクエストで DB を殴り続けさせない」
// ことであって、正確なコスト見積ではない)。重み付けは消費側で complexity を
// 見て足せばよいが、その時点で「数え方が 2 つある」状態になるので入れない。

const LIMITS = { maxDepth: 5, maxComplexity: 50 };

describe('measureOperation', () => {
  // depth は「選択フィールドの入れ子の段数」。root の直下が 1 段目
  // (graphql-depth-limit と同じ数え方)。fragment は段数を増やさない。
  it('counts a flat query as depth 2', () => {
    const m = measureOperation('{ me { id } }');
    expect(m.depth).toBe(2);
    expect(m.complexity).toBe(2);
  });

  // 以下は架空ドメインの fixture (会議室予約)。実在の製品の schema を持ち込まない
  it('counts nesting depth', () => {
    const m = measureOperation('{ room { bookings { id } } }');
    expect(m.depth).toBe(3);
    expect(m.complexity).toBe(3);
  });

  it('counts selected fields as complexity', () => {
    // room / name / bookings / edges / node / id = 6
    const m = measureOperation('{ room { name bookings { edges { node { id } } } } }');
    expect(m.depth).toBe(5);
    expect(m.complexity).toBe(6);
  });

  it('follows inline fragments without adding a level', () => {
    const m = measureOperation('{ node(id: "1") { ... on Room { name } } }');
    expect(m.depth).toBe(2);
    expect(m.complexity).toBe(2);
  });

  it('follows named fragments', () => {
    const m = measureOperation(`
      query Q { room { ...RoomFields } }
      fragment RoomFields on Room { name floor }
    `);
    expect(m.depth).toBe(2);
    expect(m.complexity).toBe(3);
  });

  it('does not recurse forever on a fragment cycle (壊れた文書でも止まる)', () => {
    const m = measureOperation(`
      query Q { store { ...A } }
      fragment A on Store { ...B }
      fragment B on Store { ...A }
    `);
    expect(Number.isFinite(m.depth)).toBe(true);
    expect(Number.isFinite(m.complexity)).toBe(true);
  });

  it('returns the operation name when there is one', () => {
    expect(measureOperation('query StartSession { me { id } }').operationName).toBe('StartSession');
    expect(measureOperation('{ me { id } }').operationName).toBeNull();
  });

  it('picks the named operation out of a multi-operation document', () => {
    const m = measureOperation('query A { me { id } } query B { store { name } }', 'B');
    expect(m.operationName).toBe('B');
    expect(m.complexity).toBe(2);
  });

  it('throws on a syntax error (呼ぶ側が 400 に落とす)', () => {
    expect(() => measureOperation('{ me { ')).toThrow();
  });

  it('throws when a named operation does not exist', () => {
    expect(() => measureOperation('query A { me { id } }', 'Z')).toThrow();
  });
});

describe('checkOperation', () => {
  it('allows an operation inside the limits', () => {
    const d = checkOperation('{ store { name } }', LIMITS);
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.depth).toBe(2);
      expect(d.complexity).toBe(2);
    }
  });

  it('rejects an operation deeper than maxDepth', () => {
    // depth 6 > maxDepth 5
    const d = checkOperation('{ a { b { c { d { e { f } } } } } }', LIMITS);
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toBe('TOO_DEEP');
      expect(d.status).toBe(400);
    }
  });

  it('rejects an operation with more fields than maxComplexity', () => {
    const wide = `{ store { ${Array.from({ length: 60 }, (_, i) => `f${i}`).join(' ')} } }`;
    const d = checkOperation(wide, LIMITS);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('TOO_COMPLEX');
  });

  it('rejects a syntax error with 400 instead of throwing', () => {
    const d = checkOperation('{ me { ', LIMITS);
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toBe('INVALID_QUERY');
      expect(d.status).toBe(400);
      expect(d.message.length).toBeGreaterThan(0);
    }
  });

  it('rejects an unnamed multi-operation document (batching off の前提)', () => {
    const d = checkOperation('query A { me { id } } query B { me { id } }', LIMITS);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('INVALID_QUERY');
  });
});
