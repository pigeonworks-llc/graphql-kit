import { type GraphQLSchema } from 'graphql';
import type { PersistedManifest } from '../persisted/index.ts';
export type JsonSchema = {
    type?: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array';
    properties?: Record<string, JsonSchema>;
    required?: string[];
    additionalProperties?: boolean;
    items?: JsonSchema;
    enum?: string[];
    default?: unknown;
    description?: string;
};
export interface OperationTool {
    readonly name: string;
    readonly description: string;
    /** extensions.persistedQuery.sha256Hash に入れる値 */
    readonly hash: string;
    readonly kind: 'query' | 'mutation';
    readonly inputSchema: JsonSchema & {
        type: 'object';
    };
}
export declare function operationTools(schema: GraphQLSchema, manifest: PersistedManifest): OperationTool[];
export interface FoundRefusal {
    readonly field: string;
    readonly reason: string;
    readonly retryAfterSeconds: number | null;
}
/**
 * 結果の root field の中の Refused (業務の断り) を探す。HTTP は 200 なので throw にならない —
 * tool の結果を isError にするか、CLI の exit を変えるのに使う
 */
export declare function findRefused(data: unknown): FoundRefusal | null;
