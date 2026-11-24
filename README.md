# @pigeonworks-llc/graphql-kit

> **License**: Apache-2.0. Originally created by 合同会社 Pigeonworks (池淵峻一)。
> コードは自由に利用・改変・再配布できます。fork 時は名称 (graphql-kit) を変更してください (商標)。
> (POL-OSS-001, 2026-07-24)

GraphQL の面を作る時に毎回同じ判断を書き直さないための 5 つの部品。

| package | 何を固定するか | 出所 |
|---|---|---|
| `./http-gate` | `/graphql` の HTTP 入口 (POST のみ / Content-Type の限定 / 深さ・複雑さの上限) | 別々の案件で独立に同じ判断が出た |
| `./refusal` | 断りは payload の union で返す (errors[] に出さない)。理由は閉じた列挙 | 複数案件で形が割れていたのを 1 つにする |
| `./audit` | 実行された operation を一律に記録する yoga plugin (閲覧も記録する) | アクセスログ要件のある案件 |
| `./client` | **呼ぶ側**の核 (POST + Bearer + `{data,errors}` の展開)。エラーは 1 型に統一 | 同じ POST 核が 7 repo で独立に書かれていた |
| `./token` | 鍵の発行と検査 (HMAC、期限必須、主体ごとの失効、scope を焼き込む) | 同じ形の鍵が 3 repo で別々に書かれていた |
| `./persisted` | 登録した問い合わせ (hash) だけを通す yoga plugin と台帳の作成・検査 | 任意の問い合わせで大量に引き出す・schema を探るのを塞ぐ。MCP の tool = 1 つの登録した操作 |
| `./rate` | 鍵ごとの回数の制限 (固定窓、cost、断った要求は数えない)。D1 と memory | 暴走した AI を 1 分で止める |
| `./consumers` | repo の外の**使い手**を、その実 file から抜いた GraphQL で照合する核 (provider が使い手を守る) | 同じ核が aiq / dandori / plan7 で独立に書かれ、宛先の決め方がずれていた (2026-11-01) |

`./client` だけは server 側と向きが逆で、`http-gate` / `refusal` が定めた規約を
**client 側から守る**ために要る — 断りは payload (HTTP 200) なので throw にならない、
gate が 400 / 415 を GraphQL の封筒で返した時は status と code の両方が残る、など。

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

### token

```ts
import { bearer, d1RevocationStore, isRevoked, mintToken, verifyToken } from '@pigeonworks-llc/graphql-kit/token';

// 発行 (手元の script。pepper は sops から env で渡し、表示しない)
const { token } = await mintToken({
  prefix: 'rooms', pepper: env.TOKEN_PEPPER, sub: 'cli-1', scopes: ['rooms:read'], kind: 'cli', ttlDays: 90,
});

// 検査 (Worker の入口)
const raw = bearer(request);
const claims = raw && (await verifyToken(raw, { prefix: 'rooms', pepper: env.TOKEN_PEPPER }));
if (!claims || (await isRevoked(d1RevocationStore(env.DB), claims))) return new Response('', { status: 401 });
```

形は `<prefix>.v1.<payload>.<sig>`。決めてあること:

- **prefix は面ごと**。pepper を共有していても、別の面で出した鍵は通らない
- **期限は必須** (既定 90 日・最長 365 日)。期限の無い鍵は出さない
- **失効は主体 (`sub`) ごとの世代**。`revoke(sub)` より前に出た鍵を拒む (`REVOCATION_SCHEMA` を migration に足す)。
  全失効は pepper を回す
- **未来に出た鍵は受けない** (60 秒まで)。iat を先に名乗って失効を生き延びるのを防ぐ
- pepper は 32 bytes 以上 (足りなければ発行は投げ、検証は全部拒む)。base64url は正規形だけ
- 検証の失敗理由は返さない (`null` だけ)
- `scopes` は鍵が許すことを列べるだけ。**どの操作に何の scope が要るかは面の側** (schema) が決める

### persisted

```ts
import { buildManifest, persistedPlugin, validateManifest } from '@pigeonworks-llc/graphql-kit/persisted';

// ビルド時 (script): operations/*.graphql を読んで台帳 (JSON) にし、schema に通るかを ci で見る
const manifest = await buildManifest(documents);          // 名前付きの操作 1 つの文書だけ
const problems = validateManifest(buildSchema(sdl), manifest);

// 実行時 (Worker): JSON を import して plugin に渡す (fs を使わない)
createYoga({ schema, plugins: [persistedPlugin({ manifest, allowArbitrary: (req) => isDevKey(req) })] });
```

呼ぶ側は本文でなく `extensions.persistedQuery: { version: 1, sha256Hash }` を送る (Apollo APQ と同じ封筒)。

- 登録の無い hash → `PERSISTED_QUERY_NOT_FOUND`。本文の任意の問い合わせ → `PERSISTED_QUERY_ONLY` (どちらも実行しない)
- **登録は自動にしない**。台帳と同じ本文を送っても hash が無ければ任意の問い合わせとして扱う
- hash と本文を両方送ったら hash の本文で実行する (送られた本文で差し替えさせない)
- 任意の問い合わせを開けるのは `allowArbitrary` が許した要求だけ (既定は誰も通さない)
- yoga 公式の persisted-operations plugin は最新版が yoga 6 を要求するため使わず、`onParams` の 1 hook で書いた

### rate

```ts
import { d1RateStore, rateFrom } from '@pigeonworks-llc/graphql-kit/rate';

const limit = rateFrom(env.RATE_LIMIT_PER_MIN, { windowSeconds: 60, perWindow: 300 }); // null = 数えない
const spent = limit && (await d1RateStore(env.DB).spend(claims.sub, cost, limit, Math.floor(Date.now() / 1000)));
if (spent && !spent.ok) return refuse('RATE_LIMITED', { retryAfterSeconds: spent.retryAfterSeconds });
```

- 数える単位は「窓の始まりと使った数」だけ。**断った要求は数を使わない** (待てば通る)
- 時計が窓の始まりより前に戻ったら数え直す。cost で重い問い合わせを多く数える
- D1 版は 1 文の UPSERT + RETURNING で数え、超えたら戻す (読んでから書く間に別の要求が入れない形)。`RATE_SCHEMA` を migration に足す
- 数を Worker のメモリに置かない (isolate が入れ替わるたびに黙って無制限に戻る)。memory 版は試験用

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

### client

```ts
import { graphqlRequest, createAuthedGraphQLClient, GraphQLClientError } from '@pigeonworks-llc/graphql-kit/client';

// 1 回の POST
const data = await graphqlRequest<{ me: { id: string } }>({
  endpoint: 'https://api.example/graphql',
  query: 'query { me { id } }',
  token,                       // 省略すると無認証
});

// 「認証必須」を束ねる。endpoint を関数にすると動的 origin にも対応する
const client = createAuthedGraphQLClient({
  endpoint: () => `${getOrigin()}/graphql`,
  getToken: async () => session.load(),
});
await client.request('mutation { ... }');
```

`GraphQLClientError` 1 型に寄せ、**`code` で分岐する** (文言では分岐しない)。
`status` / `code` / `errors[]` をそのまま持つ:

| 起きたこと | status | code |
|---|---|---|
| 非 2xx (transport) | 5xx / 4xx | — (封筒なら errors[0] の code) |
| gate が 400 / 415 を封筒で返した | 400 / 415 | errors[0].extensions.code |
| resolver が `errors[]` を返した (HTTP 200) | 200 | errors[0].extensions.code |
| `data` も `errors` も無い | 200 | — |
| token が無い (`createAuthedGraphQLClient`) | — | `UNAUTHENTICATED` |

**fetch は注入する。** Cloudflare の Service Binding (`env.X.fetch(Request)`) は
`fetchImpl` に包んで渡す — lib は Cloudflare を知らない。

```ts
fetchImpl: (url, init) => env.TENANT_API.fetch(new Request(url, init)),
```

**失敗を握り潰す caller は自分で包む。** event emitter のように「sink が落ちても
本業は止めない」consumer は `try { await graphqlRequest(...) } catch { log(...) }` を
書く。lib が握り潰すかどうかを決めると、握り潰しが既定になって気付けなくなる。

### consumers

**provider が使い手を守る**ための核。provider の CI が使い手の実 file を読み、中の
GraphQL を抜き出して schema に validate する。型を変えた PR が、壊れる使い手だけを
名指しで赤にする — 使い手側に schema の写しを置かない。

```ts
import { checkConsumerSource, type ConsumerSpec } from '@pigeonworks-llc/graphql-kit/consumers';

const spec: ConsumerSpec = {
  name: 'weekly-review',
  where: 'owner/repo:path/to/file.py',
  roots: ['nodes'],      // この使い手がこの provider で使う root field (宛先の宣言)
  minOperations: 2,      // この provider 宛ての件数の下限
};
const errors = checkConsumerSource(spec, sourceText /* 読めなければ null */, schema);
```

**lib が持たないもの** (descriptor 注入 — 使い手側の関心):

- 使い手の file をどこから読むか。各 repo は `git show origin/main:<path>` で読む
  (作業ツリーは stale な checkout のことがある)。読む git には `GIT_*` を落とした env を
  渡す — pre-push が `GIT_DIR` を渡すと別の repo を読む (2026-11-01 に実際に踏んだ)
- 台帳の形式 (yaml / JSON) とその検証。lib は検証済みの `ConsumerSpec` を受け取る

**宛先は宣言 (`roots`) で決める。query の中身から推さない。** 1 つの file が複数の
provider を叩くので宛先を決める必要があるが、推すとどの規則も「捕まえたい誤り」で
騙される (実測):

| 推し方 | 起きること |
|---|---|
| root field の名前で推す | 名前が別 provider と重なると (例: `roadmap`) 偽の赤 |
| 名前 + 引数で推す | 引数を間違えた document が「別 provider 宛て」と見なされ**黙って外れる** |

宣言なら、宣言した root の引数・field の誤りは schema が赤にする。

**抽出する器**: backtick / Python の三重引用符 / shell の単一引用符 (変数だけを後から
組む `gql 'query(...){...}' "$vars"` の形)。shell の単一引用符は `query|mutation`
始まりだけを拾う — JSON body (`'{"query":...}'`) を拾わないため。

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
   全操作が監査に残る、を確かめる。`./consumers` は `conformance/library-consumers.test.ts`
   (図書館の貸出) で、field を改名すると読む使い手だけが名指しで赤になる、を確かめる。

**手順: gate を先に red で書く。** この repo でもその順で作った — purity gate を
先に走らせ、`src/` に残っていた出所のコメント (製品名) とドメイン語彙で red に
なることを確認してから、README (出所はここに書く) と架空 fixture へ移した。

`scripts/run-bats.sh` は bats が **0 件で緑になる**のを防ぐ (件数の下限を持つ)。
実際に踏んだ: `tests/` にあるのに `scripts/tests/` を指しており、`1..0` で
exit 0 していた。

## 関連

- 目録と還元規約: [pigeonworks-llc/techne](https://github.com/pigeonworks-llc/techne) (private)
- CI gate の配線検査: [pigeonworks-llc/gate-kit](https://github.com/pigeonworks-llc/gate-kit) (private)
