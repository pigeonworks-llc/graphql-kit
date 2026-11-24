import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { d1RateStore, memoryRateStore, RATE_SCHEMA, rateFrom, type D1Like, type RateStore } from './index.ts';

const limit = { windowSeconds: 60, perWindow: 3 };

/** D1 と同じ口を node:sqlite で (SQL を実際に走らせて確かめる) */
function sqliteD1(): D1Like {
  const db = new DatabaseSync(':memory:');
  db.exec(RATE_SCHEMA);
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          const params = values as (string | number | null)[];
          return {
            async first<T>() {
              return (db.prepare(sql).get(...params) ?? null) as T | null;
            },
            async run() {
              db.prepare(sql).run(...params);
              return {};
            },
          };
        },
      };
    },
  };
}

const stores: [string, () => RateStore][] = [
  ['memory', () => memoryRateStore()],
  ['d1 (node:sqlite)', () => d1RateStore(sqliteD1())],
];

describe.each(stores)('RateStore %s', (_name, make) => {
  it('窓の中で上限まで通し、超えたら断る。断る時は窓が変わるまでの秒を返す', async () => {
    const s = make();
    const t = 1_000;
    expect(await s.spend('k', 1, limit, t)).toEqual({ ok: true, remaining: 2 });
    expect(await s.spend('k', 1, limit, t + 1)).toEqual({ ok: true, remaining: 1 });
    expect(await s.spend('k', 1, limit, t + 2)).toEqual({ ok: true, remaining: 0 });
    expect(await s.spend('k', 1, limit, t + 10)).toEqual({ ok: false, remaining: 0, retryAfterSeconds: 50 });
  });

  it('断った要求は数を使わない (待てば通る)', async () => {
    const s = make();
    for (let i = 0; i < 3; i++) await s.spend('k', 1, limit, 1_000);
    for (let i = 0; i < 5; i++) expect((await s.spend('k', 1, limit, 1_030)).ok).toBe(false);
    expect(await s.spend('k', 1, limit, 1_060)).toEqual({ ok: true, remaining: 2 });
  });

  it('重い要求は多く数える。1 回で上限を超える要求は断る', async () => {
    const s = make();
    expect(await s.spend('k', 2, limit, 1_000)).toEqual({ ok: true, remaining: 1 });
    expect((await s.spend('k', 2, limit, 1_001)).ok).toBe(false);
    expect(await s.spend('k', 1, limit, 1_002)).toEqual({ ok: true, remaining: 0 });
    expect((await s.spend('fresh', 4, limit, 1_000)).ok).toBe(false);
  });

  it('鍵ごとに別に数える', async () => {
    const s = make();
    for (let i = 0; i < 3; i++) await s.spend('a', 1, limit, 1_000);
    expect((await s.spend('a', 1, limit, 1_000)).ok).toBe(false);
    expect((await s.spend('b', 1, limit, 1_000)).ok).toBe(true);
  });

  it('時計が窓の始まりより前に戻ったら数え直す (ずっと断り続けない)', async () => {
    const s = make();
    for (let i = 0; i < 3; i++) await s.spend('k', 1, limit, 1_000);
    expect(await s.spend('k', 1, limit, 900)).toEqual({ ok: true, remaining: 2 });
  });
});

describe('rateFrom', () => {
  it('空は既定、0 / off は数えない、1 以上の整数だけを数として読む', () => {
    expect(rateFrom(undefined, { windowSeconds: 60, perWindow: 300 })).toEqual({ windowSeconds: 60, perWindow: 300 });
    expect(rateFrom(' 120 ', { windowSeconds: 60, perWindow: 300 })).toEqual({ windowSeconds: 60, perWindow: 120 });
    expect(rateFrom('0', { windowSeconds: 60, perWindow: 300 })).toBeNull();
    expect(rateFrom('off', { windowSeconds: 60, perWindow: 300 })).toBeNull();
    for (const bad of ['1e3', '0x10', '3.0', '-1', 'abc']) {
      expect(() => rateFrom(bad, { windowSeconds: 60, perWindow: 300 })).toThrow();
    }
  });
});
