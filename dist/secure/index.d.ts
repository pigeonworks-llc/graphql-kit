import { type GraphQLSchema } from 'graphql';
import { type AuditSink } from '../audit/index.ts';
import { type OperationLimits } from '../http-gate/operation.ts';
import { type PersistedManifest } from '../persisted/index.ts';
import type { RateLimit, RateStore } from '../rate/index.ts';
import { type Claims, type RevocationStore } from '../token/index.ts';
export declare const ARBITRARY_SCOPE = "ops:arbitrary";
export interface SecureHandlerOptions {
    readonly schema: GraphQLSchema;
    /** 鍵の prefix (面の名前) */
    readonly prefix: string;
    /** 鍵の pepper。空・短いと全部 401 になる (黙って開かない) */
    readonly pepper: string;
    readonly revocations: RevocationStore;
    readonly rate: RateStore;
    /** null なら数えない */
    readonly rateLimit: RateLimit | null;
    readonly manifest: PersistedManifest;
    readonly limits: Omit<OperationLimits, 'operationName'>;
    readonly sink: AuditSink;
    readonly graphqlEndpoint?: string;
    readonly now?: () => Date;
    /** resolver の context に足すもの (env など)。principal は handler が入れる */
    readonly context?: (request: Request) => Record<string, unknown> | Promise<Record<string, unknown>>;
    readonly onAuditError?: (error: unknown) => void;
}
/** resolver の context に入る主体。鍵なしの @public 要求は null */
export interface SecureContext {
    readonly principal: Claims | null;
}
export declare function secureGraphqlHandler(options: SecureHandlerOptions): (request: Request) => Promise<Response>;
