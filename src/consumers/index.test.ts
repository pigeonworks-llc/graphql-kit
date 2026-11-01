import { buildSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import {
  checkConsumerSource,
  extractGraphqlDocuments,
  type ConsumerSpec,
} from './index.ts';

// repo の外の使い手を、実 file から抜き出した GraphQL で照合する核。
// 題材は架空 (図書館の貸出)。製品名・製品のドメイン語彙は使わない (purity gate)。
//
// 固定する性質:
//   1. 3 種の器 (backtick / 三重引用符 / shell の単一引用符) から抜く
//   2. GraphQL でない文字列 (JSON / f-string の二重波括弧 / 短い語) は抜かない
//   3. 宛先は宣言 (roots) で決める — query の中身から推さない
//   4. 宣言した root の引数・field の誤りは schema が赤にする
//   5. file が無い / 件数が下限未満は失敗 (skip しない)

const schema = buildSchema(`
  type Query {
    books(shelf: String, limit: Int): [Book!]!
    book(id: ID!): Book
    catalog(branch: String): [Book!]!
  }
  type Mutation { lend(id: ID!, until: String): Book }
  type Book { id: ID! title: String! dueAt: String }
`);

const spec = (over: Partial<ConsumerSpec> = {}): ConsumerSpec => ({
  name: 'reader',
  where: 'acme/reader:src/api.ts',
  roots: ['books', 'book', 'lend'],
  minOperations: 1,
  ...over,
});

describe('extractGraphqlDocuments', () => {
  it('backtick の query を抜く', () => {
    expect(extractGraphqlDocuments('const Q = `query { books { id } }`;')).toHaveLength(1);
  });

  it('三重引用符の shorthand を抜く (query と書かない形)', () => {
    const src = 'Q = """{ books(limit: 5) { id title } }"""';
    expect(extractGraphqlDocuments(src)).toHaveLength(1);
  });

  it('shell の単一引用符の query を抜く (変数だけを後から組む形)', () => {
    const src = "gql 'query($id:ID!){ book(id:$id){ id title } }' \"$vars\"";
    expect(extractGraphqlDocuments(src)).toHaveLength(1);
  });

  it('shell の単一引用符の JSON body は抜かない', () => {
    expect(extractGraphqlDocuments(`curl -d '{"query":"{ books { id } }"}'`)).toHaveLength(0);
  });

  it('JSON の dict と f-string の二重波括弧は抜かない', () => {
    const src = 'a = """{"k": 1}"""\nb = f"""{{ books }}"""\nconst c = `{"x": 2}`;';
    expect(extractGraphqlDocuments(src)).toHaveLength(0);
  });

  it('selection set の無い語は抜かない (doc comment の言及)', () => {
    expect(extractGraphqlDocuments('const s = `query books`; echo \'done\'')).toHaveLength(0);
  });

  it('同じ document を 2 回数えない', () => {
    const q = 'query { books { id } }';
    expect(extractGraphqlDocuments(`const a = \`${q}\`; const b = \`${q}\`;`)).toHaveLength(1);
  });
});

describe('checkConsumerSource', () => {
  it('schema に合う query は緑', () => {
    expect(checkConsumerSource(spec(), 'Q = """{ books(limit: 5) { id title } }"""', schema)).toEqual([]);
  });

  it('宣言した root の引数の誤りは赤 (存在しない引数を送る事故)', () => {
    const src = 'Q = """query { books(filter: {shelf: "a"}) { id } }"""';
    expect(checkConsumerSource(spec(), src, schema).join('\n')).toContain('filter');
  });

  it('宣言した root の中の field の誤りは赤', () => {
    const src = 'Q = """{ books { idd } }"""';
    expect(checkConsumerSource(spec(), src, schema).join('\n')).toContain('idd');
  });

  it('宣言していない root は当てない — 名前が別の provider と重なっても偽の赤を出さない', () => {
    // catalog はこの schema にも有るが、この使い手は別の provider の catalog を使っている
    // (引数が違う)。宛先を名前で推すと、この schema に当てて偽の赤になる。宣言で決める。
    const src = [
      'Q = """{ books { id } }"""',
      'O = """{ catalog(region: "x") { name } }"""',
    ].join('\n');
    expect(checkConsumerSource(spec({ roots: ['books'] }), src, schema)).toEqual([]);
  });

  it('宣言は宛先を決めるだけ — 宣言した root の引数を間違えたら別 provider 扱いで外れない', () => {
    // 宛先を「名前 + 引数」で推すと、引数の誤りは「別 provider 宛て」と見なされて黙って
    // 外れる。捕まえたい誤りそのものが緑になる。宣言なら外れない。
    const src = 'Q = """{ catalog(region: "x") { id } }"""';
    expect(checkConsumerSource(spec({ roots: ['catalog'] }), src, schema).join('\n')).toContain('region');
  });

  it('mutation も照合する', () => {
    const src = "gql 'mutation($id:ID!,$u:String){ lend(id:$id, until:$u){ id dueAt } }' \"$v\"";
    expect(checkConsumerSource(spec(), src, schema)).toEqual([]);
  });

  it('file が無いのは失敗であって skip ではない', () => {
    const errs = checkConsumerSource(spec(), null, schema);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('missing');
  });

  it('宛先の document が 0 件なら赤 (抽出が腐った / root を打ち間違えた)', () => {
    const errs = checkConsumerSource(spec(), 'no graphql here', schema);
    expect(errs.join('\n')).toContain('0');
  });

  it('件数が min_operations 未満なら赤 (false-green 防止)', () => {
    const src = 'Q = """{ books { id } }"""';
    expect(checkConsumerSource(spec({ minOperations: 3 }), src, schema).join('\n')).toContain('min_operations');
  });

  it('parse できない document は宛先が分からないので赤にする (黙って捨てない)', () => {
    const src = 'Q = """query { books( { id } }"""';
    expect(checkConsumerSource(spec(), src, schema).join('\n')).toContain('parse error');
  });
});
