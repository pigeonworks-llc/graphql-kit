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
/** 文書中の operation を実行記録の形に落とす */
export function readOperations(document) {
    const operations = document.definitions.filter((def) => def.kind === 'OperationDefinition');
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
export function auditPlugin(options) {
    const now = options.now ?? (() => new Date());
    return {
        onExecute({ args }) {
            const operations = readOperations(args.document);
            if (operations.length === 0)
                return;
            let actor = 'anonymous';
            try {
                actor = options.resolveActor(args.contextValue) || 'anonymous';
            }
            catch (error) {
                // actor の解決に失敗しても記録は残す ('anonymous' として)
                options.onWriteError?.(error);
            }
            const at = now().toISOString();
            for (const operation of operations) {
                try {
                    const result = options.sink.write({ at, actor, ...operation });
                    // sink が async の場合、失敗は unhandled rejection にしない
                    if (result && typeof result.catch === 'function') {
                        void result.catch((error) => options.onWriteError?.(error));
                    }
                }
                catch (error) {
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
export function createEphemeralAudit() {
    const records = [];
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
