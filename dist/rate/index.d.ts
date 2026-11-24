import type { D1Like } from '../d1.ts';
export interface RateLimit {
    readonly windowSeconds: number;
    readonly perWindow: number;
}
export type Spend = {
    readonly ok: true;
    readonly remaining: number;
} | {
    readonly ok: false;
    readonly remaining: 0;
    readonly retryAfterSeconds: number;
};
export interface RateStore {
    /** key の窓で cost を使う。now は UNIX 秒 */
    spend(key: string, cost: number, limit: RateLimit, now: number): Promise<Spend>;
}
/** 試験と開発用 (isolate が入れ替わると消える。本番で使わない) */
export declare function memoryRateStore(): RateStore;
export type { D1Like };
/** 回数の表 (migration に足す)。1 鍵 1 行 */
export declare const RATE_SCHEMA = "CREATE TABLE IF NOT EXISTS rate_windows (\n  key TEXT PRIMARY KEY,\n  window_start INTEGER NOT NULL,\n  used INTEGER NOT NULL\n);";
/**
 * D1 は非同期で、読んでから書くまでに別の要求が入れる。そこで 1 文の UPSERT で数を足し、
 * RETURNING した値で判定する (窓が切れていれば数え直す)。上限を超えたら足した分を戻す。
 * 戻すまでの間に来た要求は断られる側に倒れる (制限が効く側に倒すので安全)。
 */
export declare function d1RateStore(db: D1Like): RateStore;
/**
 * 設定 (env の 1 行) から窓の上限を読む。空なら既定、`0` / `off` なら数えない (null)。
 * 読めない値は投げる — 呼ぶ側が既定に戻して log する (黙って無制限にしない)。
 * 数の綴りは 10 進の数字だけ (`1e3` / `0x10` / `3.0` を受けない)
 */
export declare function rateFrom(raw: string | undefined, fallback: RateLimit): RateLimit | null;
