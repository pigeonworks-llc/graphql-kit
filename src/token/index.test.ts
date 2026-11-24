import { describe, expect, it } from 'vitest';

import {
  bearer,
  d1RevocationStore,
  isRevoked,
  memoryRevocationStore,
  mintToken,
  verifyToken,
  type D1Like,
} from './index.ts';

const P = 'p'.repeat(32);
const now = new Date('2026-11-24T00:00:00Z');
const base = { prefix: 'demo', pepper: P, sub: 'device-1', scopes: ['records:read', 'records:write'], kind: 'device' };

describe('mintToken / verifyToken', () => {
  it('発行した鍵は検証でき、主体・scope・種類・期限が戻る', async () => {
    const { token, claims } = await mintToken({ ...base, label: 'iPhone', now });
    expect(token.startsWith('demo.v1.')).toBe(true);
    const got = await verifyToken(token, { prefix: 'demo', pepper: P, now });
    expect(got).toEqual(claims);
    expect(got).toMatchObject({ sub: 'device-1', scopes: ['records:read', 'records:write'], kind: 'device', label: 'iPhone' });
    expect(got!.exp - got!.iat).toBe(90 * 86_400);
  });

  it('prefix が違う面の鍵は通さない (別の面で出した鍵を流用させない)', async () => {
    const { token } = await mintToken({ ...base, now });
    expect(await verifyToken(token, { prefix: 'other', pepper: P, now })).toBeNull();
  });

  it('pepper が違えば null、payload を書き換えても null', async () => {
    const { token } = await mintToken({ ...base, now });
    expect(await verifyToken(token, { prefix: 'demo', pepper: 'o'.repeat(32), now })).toBeNull();
    const [a, b, , sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ s: 'admin', c: ['*'], k: 'human', i: 0, e: 9e9 }))
      .toString('base64url');
    expect(await verifyToken(`${a}.${b}.${forged}.${sig}`, { prefix: 'demo', pepper: P, now })).toBeNull();
  });

  it('期限を過ぎたら null。期限は 1〜365 日だけ出す', async () => {
    const { token } = await mintToken({ ...base, now, ttlDays: 30 });
    expect(await verifyToken(token, { prefix: 'demo', pepper: P, now: new Date('2026-12-23T00:00:00Z') })).not.toBeNull();
    expect(await verifyToken(token, { prefix: 'demo', pepper: P, now: new Date('2026-12-25T00:00:00Z') })).toBeNull();
    await expect(mintToken({ ...base, ttlDays: 400 })).rejects.toThrow('365');
    await expect(mintToken({ ...base, ttlDays: 0 })).rejects.toThrow();
  });

  it('未来に出た鍵は受けない (時計のずれは 60 秒まで。失効の世代を生き延びさせない)', async () => {
    const { token } = await mintToken({ ...base, now: new Date(now.getTime() + 120_000) });
    expect(await verifyToken(token, { prefix: 'demo', pepper: P, now })).toBeNull();
    const { token: near } = await mintToken({ ...base, now: new Date(now.getTime() + 30_000) });
    expect(await verifyToken(near, { prefix: 'demo', pepper: P, now })).not.toBeNull();
  });

  it('32 bytes 未満の pepper では発行も検証もしない', async () => {
    await expect(mintToken({ ...base, pepper: 'short' })).rejects.toThrow('32');
    const { token } = await mintToken({ ...base, now });
    expect(await verifyToken(token, { prefix: 'demo', pepper: 'short', now })).toBeNull();
  });

  it('非正規の base64url (末尾の余りビット) は null', async () => {
    const { token } = await mintToken({ ...base, now });
    const parts = token.split('.');
    const sig = parts[3]!;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = sig.at(-1)!;
    const twin = alphabet[alphabet.indexOf(last) | 1]!;
    expect(twin).not.toBe(last);
    expect(await verifyToken([...parts.slice(0, 3), sig.slice(0, -1) + twin].join('.'), { prefix: 'demo', pepper: P, now })).toBeNull();
  });

  it('主体・scope・prefix の形を確かめて出す (空・空白・重複は出さない)', async () => {
    await expect(mintToken({ ...base, sub: 'A B' })).rejects.toThrow('sub');
    await expect(mintToken({ ...base, scopes: [] })).rejects.toThrow('scope');
    await expect(mintToken({ ...base, scopes: ['a b'] })).rejects.toThrow('scope');
    await expect(mintToken({ ...base, scopes: ['x:read', 'x:read'] })).rejects.toThrow('scope');
    await expect(mintToken({ ...base, prefix: 'Demo.v1' })).rejects.toThrow('prefix');
    await expect(mintToken({ ...base, kind: '' })).rejects.toThrow('kind');
  });

  it('4 つに割れない・ゴミの文字列は null (投げない)', async () => {
    for (const bad of ['', 'demo', 'demo.v1', 'demo.v1.x', 'demo.v1.x.y.z', 'demo.v2.e30.AAAA', '….v1.a.b']) {
      expect(await verifyToken(bad, { prefix: 'demo', pepper: P, now })).toBeNull();
    }
  });
});

describe('失効 (revokedBefore)', () => {
  it('世代より前に出た鍵は拒む。後に出し直した鍵は通す', async () => {
    const store = memoryRevocationStore();
    const { claims: old } = await mintToken({ ...base, now });
    expect(await isRevoked(store, old)).toBe(false);
    await store.revoke('device-1', new Date(now.getTime() + 1000));
    expect(await isRevoked(store, old)).toBe(true);
    const { claims: fresh } = await mintToken({ ...base, now: new Date(now.getTime() + 5000) });
    expect(await isRevoked(store, fresh)).toBe(false);
  });

  it('失効は主体ごと (他の端末の鍵は生きたまま)', async () => {
    const store = memoryRevocationStore();
    await store.revoke('device-1', new Date(now.getTime() + 1000));
    const { claims } = await mintToken({ ...base, sub: 'device-2', now });
    expect(await isRevoked(store, claims)).toBe(false);
  });

  it('D1 の実装は表 token_revocations を読み書きする (世代は後退しない)', async () => {
    const rows = new Map<string, number>();
    const db: D1Like = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>() {
                expect(sql).toContain('SELECT revoked_before FROM token_revocations');
                const v = rows.get(String(args[0]));
                return (v === undefined ? null : { revoked_before: v }) as T | null;
              },
              async run() {
                expect(sql).toContain('INSERT INTO token_revocations');
                expect(sql).toContain('MAX(');
                const [sub, at] = args as [string, number];
                rows.set(sub, Math.max(rows.get(sub) ?? 0, at));
                return {};
              },
            };
          },
        };
      },
    };
    const store = d1RevocationStore(db);
    await store.revoke('device-1', new Date(now.getTime() + 1000));
    await store.revoke('device-1', now);
    expect(rows.get('device-1')).toBe(Math.floor(now.getTime() / 1000) + 1);
    const { claims } = await mintToken({ ...base, now });
    expect(await isRevoked(store, claims)).toBe(true);
  });
});

describe('bearer', () => {
  it('Authorization: Bearer の値だけを取り出す。無い・形が違えば null', () => {
    const req = (h?: string) => new Request('https://x/graphql', { headers: h ? { authorization: h } : {} });
    expect(bearer(req('Bearer abc.def'))).toBe('abc.def');
    expect(bearer(req('bearer abc'))).toBe('abc');
    expect(bearer(req('Basic abc'))).toBeNull();
    expect(bearer(req('Bearer '))).toBeNull();
    expect(bearer(req())).toBeNull();
  });
});
