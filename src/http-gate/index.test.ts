import { describe, expect, it } from 'vitest';
import {
  ALLOWED_CONTENT_TYPES,
  decideGraphqlHttpMethod,
  isAllowedGraphqlContentType,
  rejectIfDisallowedContentType,
} from './index.ts';

// POST だけを通す。GET を許すと query string にクエリと変数が載り、
// アクセスログ・ブラウザ履歴・Referer に残る (セッション cookie を持つ
// リクエストで GET を許すと CSRF も成立しうる)。
describe('decideGraphqlHttpMethod', () => {
  it('allows POST', () => {
    expect(decideGraphqlHttpMethod('POST')).toEqual({ allowed: true });
  });

  it('rejects GET with 405 and an Allow header', () => {
    const d = decideGraphqlHttpMethod('GET');
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.status).toBe(405);
      expect(d.allow).toBe('POST');
    }
  });

  it('rejects other methods with 405', () => {
    for (const method of ['PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
      expect(decideGraphqlHttpMethod(method).allowed, method).toBe(false);
    }
  });

  it('is case-insensitive on the method name', () => {
    expect(decideGraphqlHttpMethod('post')).toEqual({ allowed: true });
  });
});

describe('isAllowedGraphqlContentType', () => {
  // これらは全て有効な JSON body。Content-Type を絞らないと、
  // text/plain で送られた body が「単純リクエスト」になり CORS preflight が
  // 発生せず、ブラウザ経由の cross-site 送信が通ってしまう。
  it.each([
    ['application/json', true],
    ['application/json; charset=utf-8', true],
    ['APPLICATION/JSON', true],
    ['application/graphql', true],
    ['application/graphql+json', true],
    ['text/plain', false],
    ['application/x-www-form-urlencoded', false],
    ['multipart/form-data; boundary=x', false],
    ['', false],
  ])('%s → %s', (contentType, expected) => {
    expect(isAllowedGraphqlContentType(contentType)).toBe(expected);
  });

  it('treats a missing Content-Type as not allowed', () => {
    expect(isAllowedGraphqlContentType(null)).toBe(false);
    expect(isAllowedGraphqlContentType(undefined)).toBe(false);
  });

  it('accepts every advertised type (一覧と判定がずれていない)', () => {
    for (const type of ALLOWED_CONTENT_TYPES) {
      expect(isAllowedGraphqlContentType(type), type).toBe(true);
    }
  });
});

describe('rejectIfDisallowedContentType', () => {
  it('returns null for an allowed type', () => {
    expect(rejectIfDisallowedContentType('application/json')).toBeNull();
  });

  it('returns 415 for a disallowed type', () => {
    const res = rejectIfDisallowedContentType('text/plain');
    expect(res?.status).toBe(415);
  });

  it('lets the consumer override the message (文言は transport の関心)', () => {
    const res = rejectIfDisallowedContentType('text/plain', 'Unsupported media type');
    expect(res?.message).toBe('Unsupported media type');
  });
});
