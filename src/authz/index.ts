// 操作ごとの権限。schema の root field に要る scope を書き、鍵の scope と突き合わせる。
//
//   type Query    { rooms: [Room!]! @auth(scopes: ["rooms:read"])   health: String @public }
//   type Mutation { bookRoom(...): BookRoomPayload! @auth(scopes: ["rooms:write"]) }
//
// 決めていること:
// - **既定で閉じる**。@auth も @public も無い root field は表の missing に出し、assertAuthzTable が
//   起動を止める (書き忘れた field が誰にでも開く状態を作らない)
// - 見るのは root field だけ (Query / Mutation / Subscription の直下)。中の field ごとの権限は持たない —
//   「この鍵でこの操作を呼べるか」を入口で決め、行ごとの可否 (所有者など) は resolver が決める
// - 1 つの文書に許されない root field が 1 つでもあれば全体を拒む (一部だけ実行しない)
// - introspection (__schema / __type) は scope "schema:read" が要る。__typename は誰でもよい
// - 表に無い root field (schema と表がずれた) は拒む
//
// 断りの形: 権限は業務の想定内の断り (Refused payload) ではなく入口の断り。HTTP 403 +
// errors[0].extensions.code = PERMISSION_DENIED で返す (secure-handler が組む)。
// 鍵が無い 401 と同じ段で止めるので、resolver に届かない。

import {
  Kind,
  type DocumentNode,
  type FieldNode,
  type GraphQLField,
  type GraphQLObjectType,
  type GraphQLSchema,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from 'graphql';

/** schema に足す directive の定義 */
export const authzSdl = `
directive @auth(scopes: [String!]!) on FIELD_DEFINITION
directive @public on FIELD_DEFINITION
`;

export const INTROSPECTION_SCOPE = 'schema:read';

export interface AuthzTable {
  /** "Query.rooms" → 要る scope (全部要る)。@public は [] */
  readonly fields: Readonly<Record<string, readonly string[]>>;
  /** @auth も @public も無い root field (既定で閉じるので、起動を止める) */
  readonly missing: readonly string[];
}

export type AuthzDecision =
  | { readonly ok: true; readonly fields: readonly string[] }
  | { readonly ok: false; readonly denied: readonly { field: string; missing: readonly string[] }[] };

function directiveArgs(field: GraphQLField<unknown, unknown>, name: string) {
  return field.astNode?.directives?.find((d) => d.name.value === name);
}

/** schema の root field から権限の表を作る。@auth と @public を両方付けた・空の scopes は投げる */
export function scopesOf(schema: GraphQLSchema): AuthzTable {
  const fields: Record<string, string[]> = {};
  const missing: string[] = [];
  const roots = [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()].filter(
    (t): t is GraphQLObjectType => t != null,
  );
  for (const type of roots) {
    for (const field of Object.values(type.getFields())) {
      const key = `${type.name}.${field.name}`;
      const auth = directiveArgs(field, 'auth');
      const pub = directiveArgs(field, 'public');
      if (auth && pub) throw new Error(`${key}: @auth と @public は両方付けない`);
      if (pub) {
        fields[key] = [];
        continue;
      }
      if (!auth) {
        missing.push(key);
        continue;
      }
      const arg = auth.arguments?.find((a) => a.name.value === 'scopes')?.value;
      const scopes =
        arg?.kind === Kind.LIST ? arg.values.flatMap((v) => (v.kind === Kind.STRING ? [v.value] : [])) : [];
      if (scopes.length === 0) throw new Error(`${key}: @auth(scopes:) が空 (誰でもよいなら @public)`);
      fields[key] = scopes;
    }
  }
  return { fields, missing };
}

/** 既定で閉じる: @auth も @public も無い root field があれば投げる (起動時に呼ぶ) */
export function assertAuthzTable(table: AuthzTable): void {
  if (table.missing.length > 0) {
    throw new Error(`@auth か @public が無い root field: ${table.missing.join(', ')}`);
  }
}

const ROOT_TYPE: Record<OperationDefinitionNode['operation'], string> = {
  query: 'Query',
  mutation: 'Mutation',
  subscription: 'Subscription',
};

function pickOperation(document: DocumentNode, operationName: string | undefined) {
  const ops = document.definitions.filter((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION);
  if (operationName !== undefined) return ops.find((o) => o.name?.value === operationName);
  return ops.length === 1 ? ops[0] : undefined;
}

/** 選んだ操作の root field (fragment の中も、alias を外して) */
function rootFields(document: DocumentNode, op: OperationDefinitionNode): FieldNode[] {
  const fragments = new Map(
    document.definitions.flatMap((d) => (d.kind === Kind.FRAGMENT_DEFINITION ? [[d.name.value, d.selectionSet] as const] : [])),
  );
  const out: FieldNode[] = [];
  const seen = new Set<string>();
  const walk = (set: SelectionSetNode) => {
    for (const sel of set.selections) {
      if (sel.kind === Kind.FIELD) out.push(sel);
      else if (sel.kind === Kind.INLINE_FRAGMENT) walk(sel.selectionSet);
      else if (!seen.has(sel.name.value)) {
        seen.add(sel.name.value);
        const target = fragments.get(sel.name.value);
        if (target) walk(target);
      }
    }
  };
  walk(op.selectionSet);
  return out;
}

/** 鍵の scope で、この文書の選んだ操作を呼べるか */
export function authorize(
  document: DocumentNode,
  operationName: string | undefined,
  scopes: readonly string[],
  table: AuthzTable,
): AuthzDecision {
  const op = pickOperation(document, operationName);
  if (!op) return { ok: false, denied: [{ field: '(操作)', missing: ['(操作が決まらない)'] }] };
  const have = new Set(scopes);
  const root = ROOT_TYPE[op.operation];
  const fields: string[] = [];
  const denied: { field: string; missing: string[] }[] = [];
  for (const node of rootFields(document, op)) {
    const name = node.name.value;
    if (name === '__typename') continue;
    const key = `${root}.${name}`;
    if (fields.includes(key) || denied.some((d) => d.field === key)) continue;
    const need = name === '__schema' || name === '__type' ? [INTROSPECTION_SCOPE] : table.fields[key];
    if (need === undefined) {
      denied.push({ field: key, missing: ['(未登録)'] });
      continue;
    }
    const lacking = need.filter((s) => !have.has(s));
    if (lacking.length > 0) denied.push({ field: key, missing: lacking });
    else fields.push(key);
  }
  return denied.length > 0 ? { ok: false, denied } : { ok: true, fields };
}
