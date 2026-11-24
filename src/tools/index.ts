// 登録した問い合わせ (persisted の台帳) を、MCP の tool / CLI のサブコマンドの形にする。
//
// 1 つの登録した操作 = 1 つの tool。tool の名前は操作の名前、説明は操作の本文の先頭の # 行、
// 入力は操作の変数を schema で展開した JSON Schema (MCP の tools/list にそのまま出せる形)。
// 呼ぶ側は tool の hash を extensions.persistedQuery.sha256Hash に入れて送る (本文は送らない)。
//
// 決めていること:
// - 説明の無い操作は tool にしない (投げる)。AI は説明で tool を選ぶので、無いと選べない
// - 入力は additionalProperties: false (知らない引数を黙って捨てない)
// - 台帳の変数の型が schema に無ければ投げる (台帳と schema のずれを起動時に止める)
// - 表は実行時に台帳と schema から作る。生成器が写しを書かないので、操作を足しても表がずれない

import {
  isEnumType,
  isInputObjectType,
  isListType,
  isNonNullType,
  isScalarType,
  Kind,
  parse,
  typeFromAST,
  valueFromASTUntyped,
  type GraphQLInputType,
  type GraphQLSchema,
  type OperationDefinitionNode,
} from 'graphql';

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
  readonly inputSchema: JsonSchema & { type: 'object' };
}

const SCALARS: Record<string, JsonSchema['type']> = {
  ID: 'string',
  String: 'string',
  Int: 'integer',
  Float: 'number',
  Boolean: 'boolean',
};

function inputSchemaOf(type: GraphQLInputType, seen: Set<string>): JsonSchema {
  const inner = isNonNullType(type) ? type.ofType : type;
  if (isListType(inner)) return { type: 'array', items: inputSchemaOf(inner.ofType, seen) };
  if (isEnumType(inner)) return { type: 'string', enum: inner.getValues().map((v) => v.name) };
  if (isScalarType(inner)) {
    const t = SCALARS[inner.name];
    // 独自の scalar は文字列として受ける (形は server が確かめる)
    return t ? { type: t } : { type: 'string', description: `${inner.name} (独自の scalar)` };
  }
  if (isInputObjectType(inner)) {
    if (seen.has(inner.name)) return { type: 'object', description: `${inner.name} (再帰は展開しない)` };
    const next = new Set(seen).add(inner.name);
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const f of Object.values(inner.getFields())) {
      properties[f.name] = inputSchemaOf(f.type, next);
      if (isNonNullType(f.type) && f.defaultValue === undefined) required.push(f.name);
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
  }
  return { type: 'string' };
}

/** 本文の先頭の # 行 (連続する分) を 1 行につなぐ */
function descriptionOf(document: string): string {
  const lines: string[] = [];
  for (const line of document.split('\n')) {
    const m = /^#\s?(.*)$/.exec(line);
    if (!m) break;
    if (m[1]!.trim()) lines.push(m[1]!.trim());
  }
  return lines.join(' ');
}

export function operationTools(schema: GraphQLSchema, manifest: PersistedManifest): OperationTool[] {
  const tools: OperationTool[] = [];
  for (const [hash, entry] of Object.entries(manifest)) {
    const op = parse(entry.document).definitions.find(
      (d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION,
    );
    if (!op) throw new Error(`${entry.name}: 操作が無い`);
    if (op.operation === 'subscription') throw new Error(`${entry.name}: subscription は tool にしない`);
    const description = descriptionOf(entry.document);
    if (!description) throw new Error(`${entry.name}: 説明 (本文の先頭の # 行) が無い。AI が tool を選べない`);
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const v of op.variableDefinitions ?? []) {
      const type = typeFromAST(schema, v.type) as GraphQLInputType | undefined;
      if (!type) throw new Error(`${entry.name}: 変数 $${v.variable.name.value} の型 ${getTypeName(v.type)} が schema に無い`);
      const s = inputSchemaOf(type, new Set());
      if (v.defaultValue) s.default = valueFromASTUntyped(v.defaultValue);
      properties[v.variable.name.value] = s;
      if (isNonNullType(type) && !v.defaultValue) required.push(v.variable.name.value);
    }
    tools.push({
      name: entry.name,
      description,
      hash,
      kind: op.operation,
      inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
    });
  }
  return tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function getTypeName(node: Parameters<typeof typeFromAST>[1]): string {
  return node.kind === Kind.NAMED_TYPE ? node.name.value : getTypeName(node.type);
}

export interface FoundRefusal {
  readonly field: string;
  readonly reason: string;
  readonly retryAfterSeconds: number | null;
}

/**
 * 結果の root field の中の Refused (業務の断り) を探す。HTTP は 200 なので throw にならない —
 * tool の結果を isError にするか、CLI の exit を変えるのに使う
 */
export function findRefused(data: unknown): FoundRefusal | null {
  if (typeof data !== 'object' || data === null) return null;
  for (const [field, value] of Object.entries(data as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const { reason, retryAfterSeconds } = value as Record<string, unknown>;
    if (typeof reason === 'string') {
      return { field, reason, retryAfterSeconds: typeof retryAfterSeconds === 'number' ? retryAfterSeconds : null };
    }
  }
  return null;
}
