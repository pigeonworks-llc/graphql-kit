export type MethodDecision = {
    allowed: true;
} | {
    allowed: false;
    status: 405;
    allow: 'POST';
};
/** 受理する Content-Type。application/graphql+json は legacy client 用 */
export declare const ALLOWED_CONTENT_TYPES: readonly ["application/json", "application/graphql", "application/graphql+json"];
export declare const DEFAULT_METHOD_MESSAGE = "Method Not Allowed";
export declare const DEFAULT_CONTENT_TYPE_MESSAGE: string;
/** POST だけを通す。他の method は 405 + `Allow: POST` */
export declare function decideGraphqlHttpMethod(method: string): MethodDecision;
/** `application/json; charset=utf-8` のようなパラメータ付きも受ける */
export declare function isAllowedGraphqlContentType(contentType: string | null | undefined): boolean;
/** 通してよければ null、弾くなら 415 と client に返す文言 */
export declare function rejectIfDisallowedContentType(contentType: string | null | undefined, message?: string): {
    status: 415;
    message: string;
} | null;
export * from './operation.ts';
