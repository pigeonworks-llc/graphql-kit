import { type DocumentNode, type GraphQLSchema } from 'graphql';
/** schema に足す directive の定義 */
export declare const authzSdl = "\ndirective @auth(scopes: [String!]!) on FIELD_DEFINITION\ndirective @public on FIELD_DEFINITION\n";
export declare const INTROSPECTION_SCOPE = "schema:read";
export interface AuthzTable {
    /** "Query.rooms" → 要る scope (全部要る)。@public は [] */
    readonly fields: Readonly<Record<string, readonly string[]>>;
    /** @auth も @public も無い root field (既定で閉じるので、起動を止める) */
    readonly missing: readonly string[];
}
export type AuthzDecision = {
    readonly ok: true;
    readonly fields: readonly string[];
} | {
    readonly ok: false;
    readonly denied: readonly {
        field: string;
        missing: readonly string[];
    }[];
};
/** schema の root field から権限の表を作る。@auth と @public を両方付けた・空の scopes は投げる */
export declare function scopesOf(schema: GraphQLSchema): AuthzTable;
/** 既定で閉じる: @auth も @public も無い root field があれば投げる (起動時に呼ぶ) */
export declare function assertAuthzTable(table: AuthzTable): void;
/** 鍵の scope で、この文書の選んだ操作を呼べるか */
export declare function authorize(document: DocumentNode, operationName: string | undefined, scopes: readonly string[], table: AuthzTable): AuthzDecision;
