// /graphql の HTTP 入口で、framework に届く前に弾く判定。純関数だけを置く
// (Request / Response を組み立てるのは消費側 = transport の関心)。
//
// 理由 (別々の案件で独立に同じ判断が出た):
// - GET を許すとクエリと変数がクエリ文字列に載り、アクセスログ・ブラウザ履歴・
//   Referer に残る。セッション cookie を持つブラウザからの GET は CSRF も成立しうる。
// - Content-Type を絞らないと、text/plain の body が「単純リクエスト」になって
//   CORS preflight が発生せず、cross-site からの送信が通ってしまう。
/** 受理する Content-Type。application/graphql+json は legacy client 用 */
export const ALLOWED_CONTENT_TYPES = [
    'application/json',
    'application/graphql',
    'application/graphql+json',
];
export const DEFAULT_METHOD_MESSAGE = 'Method Not Allowed';
export const DEFAULT_CONTENT_TYPE_MESSAGE = `Content-Type は ${ALLOWED_CONTENT_TYPES.join(' / ')} のいずれかにしてください`;
/** POST だけを通す。他の method は 405 + `Allow: POST` */
export function decideGraphqlHttpMethod(method) {
    if (method.toUpperCase() === 'POST')
        return { allowed: true };
    return { allowed: false, status: 405, allow: 'POST' };
}
/** `application/json; charset=utf-8` のようなパラメータ付きも受ける */
export function isAllowedGraphqlContentType(contentType) {
    if (!contentType)
        return false;
    const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
    return ALLOWED_CONTENT_TYPES.includes(mime);
}
/** 通してよければ null、弾くなら 415 と client に返す文言 */
export function rejectIfDisallowedContentType(contentType, message = DEFAULT_CONTENT_TYPE_MESSAGE) {
    if (isAllowedGraphqlContentType(contentType))
        return null;
    return { status: 415, message };
}
export * from "./operation.js";
