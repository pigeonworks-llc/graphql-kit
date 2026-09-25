// 監査ログ (誰がいつ何を見たか) を consumer のコードに書かせない yoga plugin。
//
// 必要な理由は「閲覧も記録する」が要件になる場面があること (規制産業の
// アクセスログ要件: ログイン時刻・アクセス時間・参照した情報が特定できること)。
// ただし**閲覧は mutation の副作用として残らない**ので、resolver に書かせると
// 必ず書き忘れる。実行の入口で一律に取る。
//
// 実装の分担:
// - この plugin がやること: 実行された operation を 1 行にし、actor を添えて sink に渡す。
//   閲覧 (query) も記録する。sink が落ちてもリクエストは成功させる (監査の失敗は
//   onWriteError で鳴らす — 本業を止めない。止めたい場合は sink 側で投げずに
//   別の gate にする)。
// - consumer がやること: sink の永続化 (Cloud SQL の append-only テーブル +
//   UPDATE/DELETE を禁止するトリガー、または BigQuery / ロック付きバケット)。
//   **この module は更新・削除の API を持たない** — 持てば log を消す経路になる。

import type { DocumentNode, OperationDefinitionNode } from 'graphql';
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
export function readOperations(document: DocumentNode): AuditOperation[] {
  const operations = document.definitions.filter(
    (def): def is OperationDefinitionNode => def.kind === 'OperationDefinition',
  );
  return operations.map((op) => {
    const operationName = op.name?.value ?? '';
    const firstSelection = op.selectionSet.selections[0];
    const action = firstSelection?.kind === 'Field' ? firstSelection.name.value : '';
    return {
      operationType: op.operation,
      operationName,
      action,
      detail: operationName ? `${op.operation} ${operationName}` : `${op.operation} ${action}`,
    };
  });
}

export function auditPlugin(options: AuditPluginOptions): Plugin {
  const now = options.now ?? (() => new Date());

  return {
    onExecute({ args }) {
      const operations = readOperations(args.document);
      if (operations.length === 0) return;

      let actor = 'anonymous';
      try {
        actor = options.resolveActor(args.contextValue) || 'anonymous';
      } catch (error) {
        // actor の解決に失敗しても記録は残す ('anonymous' として)
        options.onWriteError?.(error);
      }

      const at = now().toISOString();
      for (const operation of operations) {
        try {
          const result = options.sink.write({ at, actor, ...operation });
          // sink が async の場合、失敗は unhandled rejection にしない
          if (result && typeof (result as Promise<void>).catch === 'function') {
            void (result as Promise<void>).catch((error: unknown) =>
              options.onWriteError?.(error),
            );
          }
        } catch (error) {
          options.onWriteError?.(error);
        }
      }
    },
  };
}

/**
 * 開発・テスト用の使い捨て sink。**本番で使わない** (プロセスが落ちれば消える —
 * 記録の保持が要件になる場面では必ず永続 sink を実装する)。
 * 戻り値の reader は配列のコピーを返すので、記録を外から書き換えられない。
 */
export function createEphemeralAudit(): {
  sink: AuditSink;
  reader: { records: () => AuditRecord[] };
} {
  const records: AuditRecord[] = [];
  return {
    sink: {
      write: (record) => {
        records.push(record);
      },
    },
    reader: {
      records: () => [...records],
    },
  };
}
