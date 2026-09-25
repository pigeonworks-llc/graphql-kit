// クエリ文書の深さ・複雑さの上限判定。batching を切っていても、1 本の
// クエリで DB を殴り続けさせることはできる (Relay Connection の入れ子が典型)。
//
// depth の数え方は graphql-depth-limit と同じ: root の選択フィールドを 1 段目
// として数える (`{ me { id } }` = 2)。fragment は段数を増やさない。

import { parse, type DocumentNode, type OperationDefinitionNode, type SelectionSetNode } from 'graphql';

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

export type OperationDecision =
  | ({ allowed: true } & OperationMeasurement)
  | { allowed: false; status: 400; reason: OperationRejection; message: string };

export type OperationRejection = 'INVALID_QUERY' | 'TOO_DEEP' | 'TOO_COMPLEX';

function selectOperation(
  doc: DocumentNode,
  operationName?: string,
): OperationDefinitionNode | undefined {
  const operations = doc.definitions.filter(
    (def): def is OperationDefinitionNode => def.kind === 'OperationDefinition',
  );
  if (operations.length === 0) return undefined;
  if (operationName !== undefined) {
    return operations.find((op) => op.name?.value === operationName);
  }
  // 複数あるのに名前指定が無い場合も「解決できない」として undefined を返す。
  // GraphQL の仕様上どれを実行するか決まらない文書なので、呼ぶ側が 400 にする。
  return operations.length === 1 ? operations[0] : undefined;
}

/** 解析できない文書は例外を投げる (呼ぶ側が 400 に落とす) */
export function measureOperation(query: string, operationName?: string): OperationMeasurement {
  const doc = parse(query);
  const operation = selectOperation(doc, operationName);
  if (!operation) throw new Error('実行する operation を 1 つに特定できません');

  const counts = { depth: 0, complexity: 0 };
  const fragments = new Map(
    doc.definitions
      .filter((def) => def.kind === 'FragmentDefinition')
      .map((def) => [def.name.value, def.selectionSet] as const),
  );

  // 壊れた文書 (fragment の循環) でも止まるように訪問済みを持つ。
  const inPath = new Set<string>();

  const walk = (selectionSet: SelectionSetNode, level: number): void => {
    if (level > counts.depth) counts.depth = level;
    for (const selection of selectionSet.selections) {
      if (selection.kind === 'Field') {
        counts.complexity += 1;
        const child = selection.selectionSet;
        if (child) walk(child, level + 1);
        continue;
      }
      // FragmentSpread は段数を増やさない (展開先の中身が段を作る)
      if (selection.kind === 'FragmentSpread') {
        const name = selection.name.value;
        if (inPath.has(name)) continue;
        const target = fragments.get(name);
        if (!target) continue;
        inPath.add(name);
        walk(target, level);
        inPath.delete(name);
        continue;
      }
      walk(selection.selectionSet, level);
    }
  };

  walk(operation.selectionSet, 1);

  return {
    depth: counts.depth,
    complexity: counts.complexity,
    operationName: operation.name?.value ?? null,
  };
}

/** 解析失敗も投げずに 400 の判定として返す (入口なので例外を外に漏らさない) */
export function checkOperation(query: string, limits: OperationLimits): OperationDecision {
  let measured: OperationMeasurement;
  try {
    measured = measureOperation(query);
  } catch {
    return {
      allowed: false,
      status: 400,
      reason: 'INVALID_QUERY',
      message: 'クエリを解析できません',
    };
  }

  if (measured.depth > limits.maxDepth) {
    return {
      allowed: false,
      status: 400,
      reason: 'TOO_DEEP',
      message: `クエリの深さが上限 (${limits.maxDepth}) を超えています`,
    };
  }
  if (measured.complexity > limits.maxComplexity) {
    return {
      allowed: false,
      status: 400,
      reason: 'TOO_COMPLEX',
      message: `クエリの選択フィールド数が上限 (${limits.maxComplexity}) を超えています`,
    };
  }
  return { allowed: true, ...measured };
}
