// 登録した問い合わせ (persisted operations) だけを通す。
//
// なぜ: 任意の問い合わせを受けると、1 本のクエリで多くの行を引き出す (mass exfiltration)、
// 重い入れ子で DB を殴る、schema を探る、ができる。MCP / CLI / アプリが送るのは決まった操作なので、
// 決まった操作だけを台帳にし、hash で呼ばせる。AI にとっても「tool = 1 つの登録した操作」で済む。
//
// 形は Apollo の APQ と同じ封筒 (extensions.persistedQuery.{version: 1, sha256Hash}) で受ける。
// ただし**登録は自動にしない** (APQ のように本文を送れば登録される、は台帳の意味を無くす)。
//
// 決めていること:
// - 台帳は「名前付きの操作を 1 つ持つ文書」の配列から作る (無名・複数・名前の重複は作らない)
// - hash が台帳に無ければ実行しない (PERSISTED_QUERY_NOT_FOUND)
// - 本文 (query) を送る任意の問い合わせは、allowArbitrary が許した要求だけ (既定は誰も通さない)。
//   台帳と同じ本文でも hash が無ければ任意の問い合わせとして扱う (本文の一致で台帳を回らせない)
// - hash と本文を両方送ったら hash の本文を使う (送られた本文で差し替えさせない)
// - fs を使わない。台帳は JSON にして import する (Workers で動く)
//
// yoga の公式 plugin (@graphql-yoga/plugin-persisted-operations) を使わない理由: 最新版が
// graphql-yoga 6 を要求し、この kit の peer (yoga 5) と合わない。働きは onParams の 1 hook で足りる。

import { GraphQLError, parse, validate, type GraphQLSchema, type OperationDefinitionNode } from 'graphql';
import type { Plugin } from 'graphql-yoga';

export interface PersistedEntry {
  readonly name: string;
  readonly document: string;
}

/** sha256 (16 進の小文字 64 字) → 操作 */
export type PersistedManifest = Readonly<Record<string, PersistedEntry>>;

const HASH_RE = /^[0-9a-f]{64}$/;

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 文書の配列から台帳を作る。台帳にできない文書があれば投げる (ビルドで止める) */
export async function buildManifest(documents: readonly string[]): Promise<Record<string, PersistedEntry>> {
  const out: Record<string, PersistedEntry> = {};
  const names = new Set<string>();
  for (const document of documents) {
    const ops = parse(document).definitions.filter(
      (d): d is OperationDefinitionNode => d.kind === 'OperationDefinition',
    );
    if (ops.length !== 1) throw new Error(`1 つの文書に操作は 1 つ (${ops.length} 個あった)`);
    const name = ops[0]!.name?.value;
    if (!name) throw new Error('操作に名前が要る (台帳の鍵と MCP の tool 名になる)');
    if (names.has(name)) throw new Error(`操作の名前が重複している: ${name}`);
    names.add(name);
    out[await sha256Hex(document)] = { name, document };
  }
  return out;
}

/** 台帳の操作が schema に通るか。通らない操作を "名前: 理由" で返す (空なら緑) */
export function validateManifest(schema: GraphQLSchema, manifest: PersistedManifest): string[] {
  const problems: string[] = [];
  for (const { name, document } of Object.values(manifest)) {
    for (const e of validate(schema, parse(document))) problems.push(`${name}: ${e.message}`);
  }
  return problems;
}

export interface PersistedPluginOptions {
  readonly manifest: PersistedManifest;
  /**
   * 本文を送る任意の問い合わせを許すか。既定は誰も許さない。
   * 開発の鍵 (scope "ops:arbitrary" など) だけに開ける時に使う。判定は要求ごと
   */
  readonly allowArbitrary?: (request: Request) => boolean | Promise<boolean>;
}

const refuse = (code: string, message: string) => ({
  errors: [new GraphQLError(message, { extensions: { code } })],
});

function persistedHash(extensions: unknown): string | null | undefined {
  if (typeof extensions !== 'object' || extensions === null) return undefined;
  const pq = (extensions as Record<string, unknown>).persistedQuery;
  if (pq === undefined) return undefined;
  if (typeof pq !== 'object' || pq === null) return null;
  const { version, sha256Hash } = pq as Record<string, unknown>;
  return version === 1 && typeof sha256Hash === 'string' && HASH_RE.test(sha256Hash) ? sha256Hash : null;
}

/**
 * 断った時に params に入れる本文。yoga は setResult の後も残りの onParams (本文の有無の検査) を
 * 走らせるので、本文の無い要求が BAD_REQUEST で上書きされないよう、形だけの本文を入れる。
 * result があれば yoga は実行しないので、この本文が実行されることはない
 */
const REFUSED_PLACEHOLDER = '{ __typename }';

export function persistedPlugin(options: PersistedPluginOptions): Plugin {
  return {
    async onParams({ params, request, setParams, setResult }) {
      const deny = (code: string, message: string) => {
        setParams({ query: REFUSED_PLACEHOLDER });
        setResult(refuse(code, message));
      };
      const hash = persistedHash(params.extensions);
      if (hash !== undefined) {
        const entry = hash === null ? undefined : options.manifest[hash];
        if (!entry) {
          deny('PERSISTED_QUERY_NOT_FOUND', '登録されていない操作です');
          return;
        }
        setParams({ ...params, query: entry.document, operationName: entry.name });
        return;
      }
      if (options.allowArbitrary && (await options.allowArbitrary(request))) return;
      deny('PERSISTED_QUERY_ONLY', '登録した操作だけを受けます (extensions.persistedQuery.sha256Hash)');
    },
  };
}
