// 回数の制限。鍵 (主体) ごとに、窓 (既定 60 秒) の中で使った数を数え、超えたら断る。
//
// 決めていること:
// - 数える単位は「窓の始まりと、その窓で使った数」だけ (要求ごとの時刻を並べない)
// - 断った要求は数を使わない (断られた側が窓を埋めて、待っても通らない状態にしない)
// - 時計が窓の始まりより前に戻ったら数え直す (ずっと断り続けない)
// - cost を受ける。重い問い合わせ (http-gate の複雑さ) ほど多く数える
// - 数は Worker のメモリに置かない (isolate が入れ替わるたびに黙って無制限に戻る)。
//   本番は D1 (など永続する store) に置く。memory は試験と開発用
//
// 断りの形 (GraphQL に載せる時): refusal の RATE_LIMITED + retryAfterSeconds。
// 鍵の無い要求は呼ぶ側が接続元 (cf-connecting-ip) を鍵にして数える。

import type { D1Like } from '../d1.ts';

export interface RateLimit {
  readonly windowSeconds: number;
  readonly perWindow: number;
}

export type Spend =
  | { readonly ok: true; readonly remaining: number }
  | { readonly ok: false; readonly remaining: 0; readonly retryAfterSeconds: number };

export interface RateStore {
  /** key の窓で cost を使う。now は UNIX 秒 */
  spend(key: string, cost: number, limit: RateLimit, now: number): Promise<Spend>;
}

function checkArgs(cost: number, limit: RateLimit): void {
  if (!(Number.isInteger(cost) && cost >= 1)) throw new Error(`cost は 1 以上の整数: ${cost}`);
  if (!(Number.isInteger(limit.windowSeconds) && limit.windowSeconds >= 1)) throw new Error('windowSeconds は 1 以上の整数');
  if (!(Number.isInteger(limit.perWindow) && limit.perWindow >= 1)) throw new Error('perWindow は 1 以上の整数');
}

/** 窓が今を含んでいないか (始まってから窓の長さが経った、または時計が始まりより前) */
const expired = (start: number, now: number, limit: RateLimit) => now < start || now - start >= limit.windowSeconds;

/** 試験と開発用 (isolate が入れ替わると消える。本番で使わない) */
export function memoryRateStore(): RateStore {
  const rows = new Map<string, { start: number; used: number }>();
  return {
    async spend(key, cost, limit, now) {
      checkArgs(cost, limit);
      const row = rows.get(key);
      const fresh = row === undefined || expired(row.start, now, limit);
      const start = fresh ? now : row.start;
      const used = fresh ? 0 : row.used;
      if (used + cost > limit.perWindow) {
        if (fresh) rows.set(key, { start, used: 0 });
        return { ok: false, remaining: 0, retryAfterSeconds: start + limit.windowSeconds - now };
      }
      rows.set(key, { start, used: used + cost });
      return { ok: true, remaining: limit.perWindow - used - cost };
    },
  };
}

export type { D1Like };

/** 回数の表 (migration に足す)。1 鍵 1 行 */
export const RATE_SCHEMA = `CREATE TABLE IF NOT EXISTS rate_windows (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  used INTEGER NOT NULL
);`;

/**
 * D1 は非同期で、読んでから書くまでに別の要求が入れる。そこで 1 文の UPSERT で数を足し、
 * RETURNING した値で判定する (窓が切れていれば数え直す)。上限を超えたら足した分を戻す。
 * 戻すまでの間に来た要求は断られる側に倒れる (制限が効く側に倒すので安全)。
 */
export function d1RateStore(db: D1Like): RateStore {
  return {
    async spend(key, cost, limit, now) {
      checkArgs(cost, limit);
      const row = await db
        .prepare(
          `INSERT INTO rate_windows (key, window_start, used) VALUES (?1, ?2, ?3)
           ON CONFLICT (key) DO UPDATE SET
             window_start = CASE WHEN ?2 < window_start OR ?2 - window_start >= ?4 THEN ?2 ELSE window_start END,
             used = CASE WHEN ?2 < window_start OR ?2 - window_start >= ?4 THEN ?3 ELSE used + ?3 END
           RETURNING window_start, used`,
        )
        .bind(key, now, cost, limit.windowSeconds)
        .first<{ window_start: number; used: number }>();
      if (row === null) throw new Error('rate_windows の UPSERT が行を返さなかった');
      if (row.used > limit.perWindow) {
        await db
          .prepare('UPDATE rate_windows SET used = used - ?2 WHERE key = ?1 AND window_start = ?3')
          .bind(key, cost, row.window_start)
          .run();
        return { ok: false, remaining: 0, retryAfterSeconds: row.window_start + limit.windowSeconds - now };
      }
      return { ok: true, remaining: limit.perWindow - row.used };
    },
  };
}

/**
 * 設定 (env の 1 行) から窓の上限を読む。空なら既定、`0` / `off` なら数えない (null)。
 * 読めない値は投げる — 呼ぶ側が既定に戻して log する (黙って無制限にしない)。
 * 数の綴りは 10 進の数字だけ (`1e3` / `0x10` / `3.0` を受けない)
 */
export function rateFrom(raw: string | undefined, fallback: RateLimit): RateLimit | null {
  const v = (raw ?? '').trim();
  if (v === '') return fallback;
  if (v === '0' || v === 'off') return null;
  if (!/^[1-9][0-9]*$/.test(v)) throw new Error(`回数の上限は 1 以上の整数か 0 (off): ${JSON.stringify(raw)}`);
  return { windowSeconds: fallback.windowSeconds, perWindow: Number(v) };
}
