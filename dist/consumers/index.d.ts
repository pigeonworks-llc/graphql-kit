import { type DocumentNode, type GraphQLSchema } from 'graphql';
/** 1 つの使い手。consumer 側が自分の台帳を検証してから渡す。 */
export interface ConsumerSpec {
    /** エラー行に出す名前。 */
    name: string;
    /** エラー行に出す所在 (例 `owner/repo:path`)。読むのは consumer 側。 */
    where: string;
    /** この使い手がこの provider で使う root field (宛先の宣言)。 */
    roots: string[];
    /** この provider 宛ての document の件数の下限 (抽出が腐った時の false-green 防止)。 */
    minOperations: number;
}
/** source から GraphQL document を抜き出す (同じ document は 1 つにする)。 */
export declare function extractGraphqlDocuments(sourceText: string): string[];
/** この使い手がこの provider に対して使う document か (宣言した root を 1 つでも持つ)。 */
export declare function isForProvider(ast: DocumentNode, declaredRoots: ReadonlySet<string>): boolean;
/** エラー行の見出し。 */
export declare function operationLabel(doc: string): string;
/**
 * 1 つの使い手の source を schema に照らす。`sourceText === null` は file が無い —
 * 失敗であって skip ではない。人が読むエラー行を返す (空 = 契約を満たす)。
 * 純粋: I/O も process.exit もしない。
 */
export declare function checkConsumerSource(consumer: ConsumerSpec, sourceText: string | null, schema: GraphQLSchema): string[];
