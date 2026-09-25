import { buildSchema, GraphQLEnumType, parse } from 'graphql';
import { describe, expect, it } from 'vitest';
import {
  BASE_FAILURE_REASONS,
  buildFailureReasonEnum,
  isRefused,
  refusalSdl,
  refuse,
  resolveRefusedUnion,
  RETRYABLE_REASONS,
} from './index.ts';

// 「失敗は GraphQL の errors[] でなく payload の union で返す」形を 1 箇所に固定する。
// errors[] に出すのは想定外 (例外) だけ。両方に出すと client が 2 経路を持つことになり、
// 片方だけ実装した client が黙って壊れる。

describe('refuse', () => {
  it('builds a refusal with only a reason', () => {
    expect(refuse('NOT_FOUND')).toEqual({ __typename: 'Refused', reason: 'NOT_FOUND' });
  });

  it('adds retryAfterSeconds when given', () => {
    expect(refuse('UPSTREAM_FAILED', { retryAfterSeconds: 30 })).toEqual({
      __typename: 'Refused',
      reason: 'UPSTREAM_FAILED',
      retryAfterSeconds: 30,
    });
  });

  it('keeps retryAfterSeconds = 0 (0 は「待たなくてよい」であって欠落ではない)', () => {
    const r = refuse('RATE_LIMITED', { retryAfterSeconds: 0 });
    expect('retryAfterSeconds' in r).toBe(true);
    expect(r.retryAfterSeconds).toBe(0);
  });

  it('omits retryAfterSeconds when absent (union の選択はフィールドの有無で揺らさない)', () => {
    expect('retryAfterSeconds' in refuse('PERMISSION_DENIED')).toBe(false);
  });

  it('is recognizable by the discriminant', () => {
    expect(isRefused(refuse('INVALID_STATE'))).toBe(true);
    expect(isRefused({ ok: true })).toBe(false);
    expect(isRefused(null)).toBe(false);
  });
});

describe('reason catalog', () => {
  it('is a non-empty list of SCREAMING_SNAKE_CASE names', () => {
    expect(BASE_FAILURE_REASONS.length).toBeGreaterThan(0);
    for (const reason of BASE_FAILURE_REASONS) {
      expect(reason, reason).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(BASE_FAILURE_REASONS).size).toBe(BASE_FAILURE_REASONS.length);
  });

  it('covers the 4 reasons every transport needs', () => {
    for (const required of ['UNAUTHENTICATED', 'PERMISSION_DENIED', 'NOT_FOUND', 'RATE_LIMITED']) {
      expect(BASE_FAILURE_REASONS as readonly string[]).toContain(required);
    }
  });

  it('keeps RETRYABLE_REASONS a subset of the catalog', () => {
    expect(RETRYABLE_REASONS.length).toBeGreaterThan(0);
    for (const reason of RETRYABLE_REASONS) {
      expect(BASE_FAILURE_REASONS as readonly string[]).toContain(reason);
    }
  });
});

describe('refusalSdl', () => {
  const sdl = refusalSdl();

  it('is valid SDL that declares Refused and the reason enum', () => {
    const schema = buildSchema(`scalar Unused\n${sdl}`);
    const enumType = schema.getType('FailureReason');
    expect(enumType).toBeInstanceOf(GraphQLEnumType);
    expect(schema.getType('Refused')).toBeDefined();
  });

  it('declares the enum it generated, not a second copy', () => {
    const schema = buildSchema(`scalar Unused\n${sdl}`);
    const enumType = schema.getType('FailureReason') as GraphQLEnumType;
    const declared = enumType.getValues().map((v) => v.name);
    for (const reason of BASE_FAILURE_REASONS) {
      expect(declared, reason).toContain(reason);
    }
  });

  it('maps generated values to their own names (no silent renaming)', () => {
    const schema = buildSchema(`scalar Unused\n${refusalSdl(['NOT_FOUND', 'UPSTREAM_FAILED'])}`);
    const enumType = schema.getType('FailureReason') as GraphQLEnumType;
    expect(enumType.getValue('NOT_FOUND')?.value).toBe('NOT_FOUND');
  });

  it('keeps extra reasons in the order given, appended after the base', () => {
    const sdlWithExtras = refusalSdl(['MISMATCH']);
    const schema = buildSchema(`scalar Unused\n${sdlWithExtras}`);
    const declared = (schema.getType('FailureReason') as GraphQLEnumType)
      .getValues()
      .map((v) => v.name);
    expect(declared.indexOf('MISMATCH')).toBeGreaterThan(declared.indexOf('NOT_FOUND'));
    expect(declared).toContain('NOT_FOUND');
  });

  it('ignores an extra reason already in the base (重複定義で SDL を壊さない)', () => {
    const sdlWithDup = refusalSdl(['NOT_FOUND']);
    const schema = buildSchema(`scalar Unused\n${sdlWithDup}`);
    const declared = (schema.getType('FailureReason') as GraphQLEnumType)
      .getValues()
      .map((v) => v.name);
    expect(declared.filter((n) => n === 'NOT_FOUND')).toHaveLength(1);
  });

  it('is parseable as a fragment target (Refused を union に入れられる)', () => {
    const full = `
      scalar Unused
      type Mutation { doIt: DoItPayload }
      type DoItSuccess { ok: Boolean! }
      union DoItPayload = DoItSuccess | Refused
      ${sdl}
    `;
    const schema = buildSchema(full);
    expect(schema.getType('DoItPayload')).toBeDefined();
    expect(() => parse('{ __typename }')).not.toThrow();
  });
});

describe('resolveRefusedUnion', () => {
  // graphql-js は union の値を __typename で解決する。Refused は refuse() が
  // __typename を持つが、成功側の payload は持たないのが普通なので、
  // 成功側の型名を型ごとに 1 回書くだけで済むようにする。
  const info = { parentType: { name: 'Mutation' }, fieldName: 'bookRoom' };
  const otherInfo = { parentType: { name: 'Mutation' }, fieldName: 'other' };
  const resolve = resolveRefusedUnion({ 'Mutation.bookRoom': 'BookRoomSuccess' });

  it('returns Refused for a refusal', () => {
    expect(resolve(refuse('NOT_FOUND'), {}, info)).toBe('Refused');
  });

  it('returns the success type name for a matching payload', () => {
    expect(resolve({ bookingId: 'b-1' }, {}, info)).toBe('BookRoomSuccess');
  });

  it('honours an explicit __typename on the success side', () => {
    expect(resolve({ __typename: 'BookRoomSuccess', bookingId: 'b-1' }, {}, info)).toBe(
      'BookRoomSuccess',
    );
  });

  it('returns null for a field without a declared success type (黙って当てにいかない)', () => {
    expect(resolve({ bookingId: 'b-1' }, {}, otherInfo)).toBeNull();
  });

  it('returns null when there is nothing to resolve', () => {
    expect(resolve(null, {}, info)).toBeNull();
    expect(resolve(undefined, {}, info)).toBeNull();
  });
});

describe('buildFailureReasonEnum', () => {
  it('returns a GraphQLEnumType usable in a schema', () => {
    const built = buildFailureReasonEnum(['MISMATCH']);
    expect(built).toBeInstanceOf(GraphQLEnumType);
    expect(built.getValues().map((v) => v.name)).toContain('MISMATCH');
    expect(built.getValues().map((v) => v.name)).toContain('NOT_FOUND');
  });
});
