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
export declare function persistedPlugin(options: PersistedPluginOptions): Plugin;
