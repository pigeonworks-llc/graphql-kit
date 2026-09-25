export interface OperationLimits {
    maxDepth: number;
    maxComplexity: number;
}
export interface OperationMeasurement {
    /** 選択フィールドの入れ子の段数 */
    depth: number;
    /** 選択フィールドの総数 (fragment の展開を含む) */
    complexity: number;
    /** 文書に operation が 1 つだけならその名前。無名なら null */
    operationName: string | null;
}
export type OperationDecision = ({
    allowed: true;
} & OperationMeasurement) | {
    allowed: false;
    status: 400;
    reason: OperationRejection;
    message: string;
};
export type OperationRejection = 'INVALID_QUERY' | 'TOO_DEEP' | 'TOO_COMPLEX';
/** 解析できない文書は例外を投げる (呼ぶ側が 400 に落とす) */
export declare function measureOperation(query: string, operationName?: string): OperationMeasurement;
/** 解析失敗も投げずに 400 の判定として返す (入口なので例外を外に漏らさない) */
export declare function checkOperation(query: string, limits: OperationLimits): OperationDecision;
