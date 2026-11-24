import { type GraphQLSchema } from 'graphql';
import type { Plugin } from 'graphql-yoga';
export interface PersistedEntry {
    readonly name: string;
    readonly document: string;
}
/** sha256 (16 進の小文字 64 字) → 操作 */
export type PersistedManifest = Readonly<Record<string, PersistedEntry>>;
export declare function sha256Hex(text: string): Promise<string>;
/** 文書の配列から台帳を作る。台帳にできない文書があれば投げる (ビルドで止める) */
export declare function buildManifest(documents: readonly string[]): Promise<Record<string, PersistedEntry>>;
/** 台帳の操作が schema に通るか。通らない操作を "名前: 理由" で返す (空なら緑) */
export declare function validateManifest(schema: GraphQLSchema, manifest: PersistedManifest): string[];
export interface PersistedPluginOptions {
    readonly manifest: PersistedManifest;
    /**
     * 本文を送る任意の問い合わせを許すか。既定は誰も許さない。
     * 開発の鍵 (scope "ops:arbitrary" など) だけに開ける時に使う。判定は要求ごと
     */
    readonly allowArbitrary?: (request: Request) => boolean | Promise<boolean>;
}
/** 要求の本文 (GraphQL over HTTP の JSON) */
export interface GraphqlParams {
    readonly query?: unknown;
    readonly operationName?: unknown;
    readonly variables?: unknown;
    readonly extensions?: unknown;
}
export type PersistedRejection = 'PERSISTED_QUERY_NOT_FOUND' | 'PERSISTED_QUERY_ONLY';
export type PersistedResolution = {
    readonly ok: true;
    readonly query: string;
    readonly operationName: string | undefined;
    readonly persisted: boolean;
} | {
    readonly ok: false;
    readonly code: PersistedRejection;
    readonly message: string;
};
/**
 * 要求の本文から、実行する本文を決める (yoga に渡す前に、深さや権限を本文で見るため)。
 * hash があれば台帳の本文 (送られた本文は使わない)。無ければ arbitrary が許す時だけ送られた本文
 */
export declare function resolvePersisted(params: GraphqlParams, manifest: PersistedManifest, arbitrary: boolean): PersistedResolution;
export declare function persistedPlugin(options: PersistedPluginOptions): Plugin;
