// 鍵 (token) の発行と検査。HMAC 署名なので、サーバ側に鍵の表を持たない。
//
// 形: <prefix>.v1.<payload_b64url>.<sig_b64url>
//   sig = HMAC-SHA256(pepper, "<prefix>.v1." + payload_b64url)
//   payload = { s: sub, c: scopes[], k: kind, l?: label, i: iat, e: exp }
//
// 決めていること (別々の面で同じ判断を書き直さないため):
// - prefix は面ごとに変える。別の面で出した鍵は、pepper が同じでも通らない
// - 期限は必ず持つ (既定 90 日・最長 365 日)。期限の無い鍵は出さない
// - 失効は主体 (sub) ごとの世代。revokedBefore より前に出た鍵を拒む。全失効は pepper を回す
// - 未来に出た鍵は受けない (時計のずれは 60 秒まで)。iat を先に名乗って失効を生き延びさせない
// - pepper は 32 bytes 以上。足りなければ発行は投げ、検証は全部拒む (黙って弱い鍵を通さない)
// - base64url は正規形だけ。同じ bytes になる別の綴りを拒む
// - 検証が失敗した理由は返さない (null だけ)。理由は攻撃の手がかりになる
// - Web Crypto だけを使う (Workers / Node / Bun で同じ)
//
// kind は鍵を使う者の種類 (human / ai / cli / device など、面が決める)。
// 要求の body で名乗らせず、鍵に焼き込む。

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

export const MIN_PEPPER_BYTES = 32;
export const DEFAULT_TTL_DAYS = 90;
export const MAX_TTL_DAYS = 365;
/** 発行時刻が先に進んでいてよい幅 (秒) */
export const MAX_CLOCK_SKEW_SECONDS = 60;

const PREFIX_RE = /^[a-z][a-z0-9]{0,15}$/;
const SUB_RE = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}$/;
const SCOPE_RE = /^[a-z][a-z0-9_.-]*(:[a-z0-9_.*-]+)*$/;
const KIND_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_SCOPES = 32;
const te = new TextEncoder();
const td = new TextDecoder();

function b64u(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64u(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    // 正規形だけを受ける (末尾の余りビットが違う別の文字列が同じ bytes になるのを拒む)
    return b64u(bytes) === s ? bytes : null;
  } catch {
    return null;
  }
}

async function hmac(pepper: string, msg: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', te.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, te.encode(msg)));
}

/** 長さが同じなら内容に依らず同じ時間で比べる */
function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

const pepperOk = (p: string) => te.encode(p).length >= MIN_PEPPER_BYTES;
const toSec = (d: Date) => Math.floor(d.getTime() / 1000);

function scopesOk(scopes: unknown): scopes is string[] {
  return (
    Array.isArray(scopes) &&
    scopes.length > 0 &&
    scopes.length <= MAX_SCOPES &&
    scopes.every((s) => typeof s === 'string' && SCOPE_RE.test(s)) &&
    new Set(scopes).size === scopes.length
  );
}

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

export async function mintToken(input: MintInput): Promise<{ token: string; claims: Claims }> {
  if (!pepperOk(input.pepper)) throw new Error(`pepper は ${MIN_PEPPER_BYTES} bytes 以上`);
  if (!PREFIX_RE.test(input.prefix)) throw new Error(`prefix が不正 (英小文字と数字、16 字まで): ${input.prefix}`);
  if (!SUB_RE.test(input.sub)) throw new Error(`sub が不正: ${input.sub}`);
  if (!scopesOk(input.scopes)) throw new Error(`scope が不正 (1〜${MAX_SCOPES} 個、重複なし、"name:action" の形)`);
  if (!KIND_RE.test(input.kind)) throw new Error(`kind が不正: ${input.kind}`);
  if (input.label !== undefined && (input.label.length === 0 || input.label.length > 64)) {
    throw new Error('label は 1〜64 字');
  }
  const ttl = input.ttlDays ?? DEFAULT_TTL_DAYS;
  if (!(ttl > 0 && ttl <= MAX_TTL_DAYS)) throw new Error(`期限は 1〜${MAX_TTL_DAYS} 日`);
  const iat = toSec(input.now ?? new Date());
  const claims: Claims = {
    sub: input.sub,
    scopes: [...input.scopes],
    kind: input.kind,
    ...(input.label !== undefined ? { label: input.label } : {}),
    iat,
    exp: iat + Math.round(ttl * 86_400),
  };
  const wire = {
    s: claims.sub,
    c: claims.scopes,
    k: claims.kind,
    ...(claims.label !== undefined ? { l: claims.label } : {}),
    i: claims.iat,
    e: claims.exp,
  };
  const body = `${input.prefix}.v1.${b64u(te.encode(JSON.stringify(wire)))}`;
  return { token: `${body}.${b64u(await hmac(input.pepper, body))}`, claims };
}

/** 署名・期限・形を見る。失効は見ない (isRevoked と組む)。通らなければ null */
export async function verifyToken(
  token: string,
  opts: { prefix: string; pepper: string; now?: Date },
): Promise<Claims | null> {
  if (!pepperOk(opts.pepper) || !PREFIX_RE.test(opts.prefix)) return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== opts.prefix || parts[1] !== 'v1') return null;
  const sig = unb64u(parts[3]!);
  if (sig === null || !same(sig, await hmac(opts.pepper, `${opts.prefix}.v1.${parts[2]}`))) return null;
  const raw = unb64u(parts[2]!);
  if (raw === null) return null;
  let o: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(td.decode(raw));
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    o = v as Record<string, unknown>;
  } catch {
    return null;
  }
  const { s, c, k, l, i, e } = o;
  if (typeof s !== 'string' || !SUB_RE.test(s)) return null;
  if (!scopesOk(c)) return null;
  if (typeof k !== 'string' || !KIND_RE.test(k)) return null;
  if (l !== undefined && (typeof l !== 'string' || l.length === 0 || l.length > 64)) return null;
  if (!Number.isInteger(i) || !Number.isInteger(e)) return null;
  const iat = i as number;
  const exp = e as number;
  if (!(exp > iat && exp - iat <= MAX_TTL_DAYS * 86_400)) return null;
  const nowSec = (opts.now ?? new Date()).getTime() / 1000;
  if (nowSec >= exp) return null;
  if (iat > nowSec + MAX_CLOCK_SKEW_SECONDS) return null;
  return { sub: s, scopes: c, kind: k, ...(typeof l === 'string' ? { label: l } : {}), iat, exp };
}

/** 主体ごとの失効の世代。revokedBefore (UNIX 秒) 以前に出た鍵を拒む */
export interface RevocationStore {
  revokedBefore(sub: string): Promise<number | null>;
  /** at までに出た sub の鍵をすべて失効させる。世代は後退しない */
  revoke(sub: string, at?: Date): Promise<void>;
}

export async function isRevoked(store: RevocationStore, claims: Claims): Promise<boolean> {
  const before = await store.revokedBefore(claims.sub);
  return before !== null && claims.iat <= before;
}

/** 試験と、失効を持たなくてよい開発用 */
export function memoryRevocationStore(): RevocationStore {
  const gens = new Map<string, number>();
  return {
    async revokedBefore(sub) {
      return gens.get(sub) ?? null;
    },
    async revoke(sub, at = new Date()) {
      gens.set(sub, Math.max(gens.get(sub) ?? 0, toSec(at)));
    },
  };
}

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
export const REVOCATION_SCHEMA = `CREATE TABLE IF NOT EXISTS token_revocations (
  sub TEXT PRIMARY KEY,
  revoked_before INTEGER NOT NULL
);`;

export function d1RevocationStore(db: D1Like): RevocationStore {
  return {
    async revokedBefore(sub) {
      const row = await db
        .prepare('SELECT revoked_before FROM token_revocations WHERE sub = ?')
        .bind(sub)
        .first<{ revoked_before: number }>();
      return row?.revoked_before ?? null;
    },
    async revoke(sub, at = new Date()) {
      await db
        .prepare(
          `INSERT INTO token_revocations (sub, revoked_before) VALUES (?, ?)
           ON CONFLICT (sub) DO UPDATE SET revoked_before = MAX(revoked_before, excluded.revoked_before)`,
        )
        .bind(sub, toSec(at))
        .run();
    },
  };
}

/** Authorization: Bearer <token> の token。無い・形が違えば null */
export function bearer(request: Request): string | null {
  const h = request.headers.get('authorization');
  if (h === null) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1]! : null;
}
