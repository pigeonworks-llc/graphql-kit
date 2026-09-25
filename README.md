# @pigeonworks-llc/graphql-kit

> **License**: Apache-2.0. Originally created by 合同会社 Pigeonworks (池淵峻一)。
> コードは自由に利用・改変・再配布できます。fork 時は名称 (graphql-kit) を変更してください (商標)。
> (POL-OSS-001, 2026-07-24)

GraphQL の面を作る時に毎回同じ判断を書き直さないための 3 つの部品。

| package | 何を固定するか | 出所 |
|---|---|---|
| `./http-gate` | `/graphql` の HTTP 入口 (POST のみ / Content-Type の限定 / 深さ・複雑さの上限) | 別々の案件で独立に同じ判断が出た |
| `./refusal` | 断りは payload の union で返す (errors[] に出さない)。理由は閉じた列挙 | 複数案件で形が割れていたのを 1 つにする |
| `./audit` | 実行された operation を一律に記録する yoga plugin (閲覧も記録する) | アクセスログ要件のある案件 |

## なぜ 3 つとも要るか

**入口**: GET を許すとクエリと変数がクエリ文字列に載り、アクセスログ・ブラウザ履歴・
Referer に残る (セッション cookie を持つブラウザからの GET は CSRF も成立しうる)。
Content-Type を絞らないと `text/plain` の body が「単純リクエスト」になり CORS
preflight が発生せず、cross-site からの送信が通る。batching を切っていても 1 本の
クエリで DB を殴り続けさせることはできる (Relay Connection の入れ子が典型)。

**断り**: `errors[]` と payload の両方に失敗を出すと、client は 2 経路を持つことになり、
片方だけ実装した client が黙って壊れる。`errors[]` は想定外 (resolver の例外) だけに
残し、想定内の断りは必ず payload で返す。HTTP は 200。断りの理由を閉じた列挙に
するのは、画面と agent に文言でなくコードで分岐させるため。

**監査**: 閲覧は mutation の副作用として残らないので、resolver に書かせると必ず
書き忘れる。実行の入口で一律に取る。永続化は sink に任せ、`AuditSink` に
**更新・削除の API を持たせない** (持てばログを消す経路になる)。

## 使い方

### http-gate

```ts
import { decideGraphqlHttpMethod, rejectIfDisallowedContentType, checkOperation } from '@pigeonworks-llc/graphql-kit/http-gate';

const method = decideGraphqlHttpMethod(request.method);
if (!method.allowed) {
  return new Response('Method Not Allowed', { status: method.status, headers: { Allow: method.allow } });
}
const badType = rejectIfDisallowedContentType(request.headers.get('content-type'));
if (badType) return new Response(badType.message, { status: badType.status });
```

`checkOperation(query, { maxDepth, maxComplexity })` は判定だけを返す (Response を
組むのは transport の関心なので)。解析失敗も例外を投げずに `INVALID_QUERY` / 400 を返す。

depth の数え方は graphql-depth-limit と同じ (`{ me { id } }` = 2)。fragment は
段数を増やさない。壊れた文書 (fragment の循環) でも停止する。

### refusal

```ts
import { refusalSdl, refuse, resolveRefusedUnion } from '@pigeonworks-llc/graphql-kit/refusal';

const typeDefs = `
  ${refusalSdl(['MISMATCH'])}          // 案件固有の理由は extra で足す
  type BookingSuccess { bookingId: ID! }
  union BookRoomPayload = BookingSuccess | Refused
`;

const resolvers = {
  BookRoomPayload: { __resolveType: resolveRefusedUnion({ 'Mutation.bookRoom': 'BookingSuccess' }) },
  Mutation: {
    bookRoom: () => (taken ? refuse('CONFLICT') : { bookingId: 'b-1' }),
  },
};
```

`resolveRefusedUnion` が要るのは、graphql-js が union の実体を `__typename` で
決めるため。`refuse()` は `__typename` を持つが**成功側の payload は普通持たない**
ので、成功側の型名を 1 行宣言する。成功側 resolver が業務の値をそのまま返せる。

`retryAfterSeconds` は渡した時だけキーができる (0 は「待たなくてよい」であって欠落ではない)。
`RETRYABLE_REASONS` (RATE_LIMITED / UPSTREAM_FAILED / OVER_CAPACITY) にだけ添える。

### audit

```ts
import { auditPlugin, createEphemeralAudit } from '@pigeonworks-llc/graphql-kit/audit';
import { createYoga } from 'graphql-yoga';

const yoga = createYoga({
  schema,
  plugins: [
    auditPlugin({
      sink,                                   // 本番は永続 sink を実装する
      resolveActor: (ctx) => ctx.session?.userId ?? null,
      onWriteError: (e) => logger.error(e),   // sink が落ちてもリクエストは成功させる
    }),
  ],
});
```

記録は `{ at, actor, operationType, operationName, action, detail }`。認証が無い
リクエストも `anonymous` として残す (記録を落とさない)。actor は**識別子**にする —
記録は長期保持され参照範囲も広いので PII を入れない。

sink の実装は consumer 側の仕事: 追記専用のテーブル (UPDATE/DELETE を禁止する
トリガー・権限) やロック付きバケット。`createEphemeralAudit()` は開発・テスト用で、
プロセスが落ちれば消える。

## 開発

```bash
npm ci
npm run ci        # purity → prove-red (bats) → typecheck → test → build → check:fresh
npm run build     # dist/ を出す
```

**`dist/` は commit する。** consumer は SHA pin で取るので build を持たない
(gate-kit と同じ型)。鮮度が切れると「直したはずの修正が入っていない package」を
配る — 使う側からは正常に見える。`npm run check:fresh`
(`scripts/check-dist-fresh.sh`) が src から一時 outDir に build し直して比較する。

そのため `tsconfig.build.json` は sourceMap / declarationMap を出さない。map は
outDir からの相対で sources を書くので、別 outDir に出すと絶対パスが混ざって
byte 一致せず、gate が常時 red になる。加えて公開物の `files` は dist だけなので
map の sources (`../../src/…`) は同梱されず、consumer 側では dead link になる。

### 抽出 3 点セット (techne 還元規約)

1. **descriptor 注入** — 製品固有値は消費側から注入する。`refusalSdl(extra)` の
   理由、`auditPlugin` の sink と actor、`checkOperation` の上限がそれにあたる。
2. **purity gate** — `scripts/purity-check.sh`。`src/` を 3 軸で機械判定する:
   name (製品名) / domain (製品のドメイン語彙) / depfree (許可依存は graphql 系のみ)。
   対象 dir 不在は exit 2 (silent green を許さない)。
3. **架空 fixture conformance** — `conformance/room-booking.test.ts`。会議室予約という
   実在製品と無関係な題材で 3 部品を組み合わせ、入口で弾く / 断りは payload /
   全操作が監査に残る、を確かめる。

**手順: gate を先に red で書く。** この repo でもその順で作った — purity gate を
先に走らせ、`src/` に残っていた出所のコメント (製品名) とドメイン語彙で red に
なることを確認してから、README (出所はここに書く) と架空 fixture へ移した。

`scripts/run-bats.sh` は bats が **0 件で緑になる**のを防ぐ (件数の下限を持つ)。
実際に踏んだ: `tests/` にあるのに `scripts/tests/` を指しており、`1..0` で
exit 0 していた。

## 関連

- 目録と還元規約: [pigeonworks-llc/techne](https://github.com/pigeonworks-llc/techne) (private)
- CI gate の配線検査: [pigeonworks-llc/gate-kit](https://github.com/pigeonworks-llc/gate-kit) (private)
