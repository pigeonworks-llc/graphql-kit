export interface Claims {
    /** 主体。失効と監査の単位 */
    readonly sub: string;
    /** この鍵で許すこと ("records:write" など)。どの操作に何が要るかは ./authz が決める */
    readonly scopes: readonly string[];
    readonly kind: string;
    readonly label?: string;
    /** 発行時刻 (UNIX 秒) */
    readonly iat: number;
    /** 期限 (UNIX 秒) */
    readonly exp: number;
}
export declare const MIN_PEPPER_BYTES = 32;
export declare const DEFAULT_TTL_DAYS = 90;
export declare const MAX_TTL_DAYS = 365;
/** 発行時刻が先に進んでいてよい幅 (秒) */
export declare const MAX_CLOCK_SKEW_SECONDS = 60;
export interface MintInput {
    /** 面の名前 (英小文字と数字、16 字まで)。鍵の頭に付く */
    readonly prefix: string;
    readonly pepper: string;
    readonly sub: string;
    readonly scopes: readonly string[];
    readonly kind: string;
    readonly label?: string;
    readonly ttlDays?: number;
    readonly now?: Date;
}
export declare function mintToken(input: MintInput): Promise<{
    token: string;
    claims: Claims;
}>;
/** 署名・期限・形を見る。失効は見ない (isRevoked と組む)。通らなければ null */
export declare function verifyToken(token: string, opts: {
    prefix: string;
    pepper: string;
    now?: Date;
}): Promise<Claims | null>;
/** 主体ごとの失効の世代。revokedBefore (UNIX 秒) 以前に出た鍵を拒む */
export interface RevocationStore {
    revokedBefore(sub: string): Promise<number | null>;
    /** at までに出た sub の鍵をすべて失効させる。世代は後退しない */
    revoke(sub: string, at?: Date): Promise<void>;
}
export declare function isRevoked(store: RevocationStore, claims: Claims): Promise<boolean>;
/** 試験と、失効を持たなくてよい開発用 */
export declare function memoryRevocationStore(): RevocationStore;
/** D1 (と同じ形の SQLite) の最小の口。@cloudflare/workers-types に依らない */
export interface D1Like {
    prepare(sql: string): {
        bind(...values: unknown[]): {
            first<T>(): Promise<T | null>;
            run(): Promise<unknown>;
        };
    };
}
/** 失効の表 (migration に足す)。1 主体 1 行 */
export declare const REVOCATION_SCHEMA = "CREATE TABLE IF NOT EXISTS token_revocations (\n  sub TEXT PRIMARY KEY,\n  revoked_before INTEGER NOT NULL\n);";
export declare function d1RevocationStore(db: D1Like): RevocationStore;
/** Authorization: Bearer <token> の token。無い・形が違えば null */
export declare function bearer(request: Request): string | null;
