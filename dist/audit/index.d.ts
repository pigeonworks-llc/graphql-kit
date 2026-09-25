import type { DocumentNode } from 'graphql';
import type { Plugin } from 'graphql-yoga';
export interface AuditRecord {
    /** ISO 8601。sink が受け取る時刻でなく、判断に使った時刻 */
    at: string;
    /** 誰が。認証が無いリクエストは 'anonymous' (記録を落とさない) */
    actor: string;
    operationType: 'query' | 'mutation' | 'subscription';
    /** 無名 operation は '' */
    operationName: string;
    /** operation の root field。何をしたか 1 語 */
    action: string;
    /** 人が読む 1 行 ('mutation StartSession') */
    detail: string;
}
/** 追記だけ。update / delete を型として持たない */
export interface AuditSink {
    write(record: AuditRecord): void | Promise<void>;
}
export interface AuditOperation {
    operationType: 'query' | 'mutation' | 'subscription';
    operationName: string;
    action: string;
    detail: string;
}
export interface AuditPluginOptions {
    sink: AuditSink;
    /**
     * アクターの識別子 (利用者 ID など)。PII は入れない — 記録は長期保持され、
     * 参照範囲も広い。consumer は ID を返し、名前の解決は別の経路にする。
     */
    resolveActor: (context: unknown) => string | null | undefined;
    now?: () => Date;
    onWriteError?: (error: unknown) => void;
}
/** 文書中の operation を実行記録の形に落とす */
export declare function readOperations(document: DocumentNode): AuditOperation[];
export declare function auditPlugin(options: AuditPluginOptions): Plugin;
/**
 * 開発・テスト用の使い捨て sink。**本番で使わない** (プロセスが落ちれば消える —
 * 記録の保持が要件になる場面では必ず永続 sink を実装する)。
 * 戻り値の reader は配列のコピーを返すので、記録を外から書き換えられない。
 */
export declare function createEphemeralAudit(): {
    sink: AuditSink;
    reader: {
        records: () => AuditRecord[];
    };
};
