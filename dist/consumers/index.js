// repo の外の使い手 (consumer) を、その実 file から抜き出した GraphQL で照合する核。
//
// なぜ lib に置くか: 同じ核 (使い手の source から GraphQL を抜き、schema に validate する)
// が 3 つの repo で独立に書かれ、抽出の仕方と宛先の決め方が少しずつずれていた。差は
// 抽出する器の種類と、宛先の決め方だけで、どちらもここで 1 つに揃えられる。
//
// 守る向き: **provider が consumer を守る**。provider の CI がこの核を呼び、型を変えた
// PR が、壊れる使い手を名指しで赤にする。consumer 側に schema の写しを置かない。
//
// この lib が持たないもの (consumer 側の関心):
//   - 使い手の file をどこから読むか (git の origin/main など)。ここは source の文字列を受け取る
//   - 台帳の形式 (yaml / JSON) と、その検証。ここは検証済みの ConsumerSpec を受け取る
//
// 宛先は **宣言** (ConsumerSpec.roots) で決める。query の中身から推さない:
//   - root field の名前で推すと、別の provider と名前が重なった時に偽の赤になる
//   - 名前 + 引数で推すと、引数を間違えた document が「別 provider 宛て」と見なされて
//     **黙って外れる** — 捕まえたい誤りそのものが緑になる
// 宣言で宛先を決めれば、宣言した root の引数・field の誤りは schema が赤にする。
import { Kind, parse, validate } from 'graphql';
// 器ごとに「どこから GraphQL と見なすか」を変える。
//   backtick / 三重引用符: `query|mutation` 始まり、または shorthand の `{ field`
//   shell の単一引用符: `query|mutation` 始まり**だけ**。shell では JSON body
//     (`'{"query":...}'`) が単一引用符に入るので、shorthand を許すと JSON を拾う
const KEYWORD_START = /^\s*(?:query|mutation)\b/;
const SHORTHAND_START = /^\s*\{\s*[_A-Za-z][_0-9A-Za-z]*\b/;
const CONTAINERS = [
    { re: /`([^`]*)`/g, shorthand: true },
    { re: /"""([\s\S]*?)"""/g, shorthand: true },
    { re: /'([^']*)'/g, shorthand: false },
];
/** source から GraphQL document を抜き出す (同じ document は 1 つにする)。 */
export function extractGraphqlDocuments(sourceText) {
    const seen = new Set();
    const docs = [];
    for (const { re, shorthand } of CONTAINERS) {
        for (const m of sourceText.matchAll(re)) {
            const body = m[1] ?? '';
            const isKeyword = KEYWORD_START.test(body);
            const isShorthand = shorthand && SHORTHAND_START.test(body);
            if (!isKeyword && !isShorthand)
                continue;
            // selection set が要る。shorthand は 2 段目の `{` も要る (`{ x }` だけは抜かない)
            const opens = (body.match(/\{/g) ?? []).length;
            if (opens < 1 || (isShorthand && !isKeyword && opens < 2))
                continue;
            if (seen.has(body))
                continue;
            seen.add(body);
            docs.push(body);
        }
    }
    return docs;
}
/** document の最上位の field 名 (fragment は数えない)。 */
function docRootFields(ast) {
    const out = [];
    for (const def of ast.definitions) {
        if (def.kind !== Kind.OPERATION_DEFINITION)
            continue;
        for (const sel of def.selectionSet.selections) {
            if (sel.kind === Kind.FIELD)
                out.push(sel.name.value);
        }
    }
    return out;
}
/** この使い手がこの provider に対して使う document か (宣言した root を 1 つでも持つ)。 */
export function isForProvider(ast, declaredRoots) {
    return docRootFields(ast).some((f) => declaredRoots.has(f));
}
/** エラー行の見出し。 */
export function operationLabel(doc) {
    const m = /^\s*(query|mutation)(?:\s+(\w+))?/.exec(doc);
    if (m)
        return `${m[1]} ${m[2] ?? '<anonymous>'}`;
    const f = /^\s*\{\s*(\w+)/.exec(doc);
    return f ? `{ ${f[1]} … }` : '<unknown operation>';
}
/**
 * 1 つの使い手の source を schema に照らす。`sourceText === null` は file が無い —
 * 失敗であって skip ではない。人が読むエラー行を返す (空 = 契約を満たす)。
 * 純粋: I/O も process.exit もしない。
 */
export function checkConsumerSource(consumer, sourceText, schema) {
    if (sourceText === null) {
        return [`${consumer.name} — consumer file missing: ${consumer.where} (動いた / 消えた? 台帳を直す)`];
    }
    const errors = [];
    const roots = new Set(consumer.roots);
    const mine = [];
    for (const doc of extractGraphqlDocuments(sourceText)) {
        let ast;
        try {
            ast = parse(doc);
        }
        catch (e) {
            // parse できない document は宛先が分からない。黙って捨てずに赤にする
            const msg = e instanceof Error ? e.message : String(e);
            errors.push(`${consumer.name} ${operationLabel(doc)} — parse error: ${msg}`);
            continue;
        }
        if (isForProvider(ast, roots))
            mine.push({ doc, ast });
    }
    if (mine.length === 0) {
        errors.push(`${consumer.name} — ${consumer.where} からこの provider 宛ての GraphQL を 0 件しか抜けなかった ` +
            '(抽出が腐った / もう呼んでいない / root field を打ち間違えた)');
    }
    else if (mine.length < consumer.minOperations) {
        errors.push(`${consumer.name} — ${consumer.where} からこの provider 宛てを ${mine.length} 件抜けたが ` +
            `min_operations は ${consumer.minOperations} (false-green 防止)`);
    }
    for (const { doc, ast } of mine) {
        for (const err of validate(schema, ast)) {
            errors.push(`${consumer.name} ${operationLabel(doc)} — ${err.message}`);
        }
    }
    return errors;
}
