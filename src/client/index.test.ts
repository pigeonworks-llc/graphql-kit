import { describe, expect, it, vi } from 'vitest';
import {
  createAuthedGraphQLClient,
  GraphQLClientError,
  graphqlRequest,
  type FetchLike,
} from './index.ts';

/** 呼ばれた (url, init) を記録しつつ固定の応答を返す fetch。 */
function stubFetch(
  response: Response | (() => Promise<Response>),
): { fetchImpl: FetchLike; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return typeof response === 'function' ? await response() : response;
  };
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bodyOf(init: RequestInit | undefined): { query: string; variables?: unknown } {
  return JSON.parse(String(init?.body)) as { query: string; variables?: unknown };
}

describe('graphqlRequest', () => {
  it('returns data and posts the query as JSON', async () => {
    const { fetchImpl, calls } = stubFetch(jsonResponse({ data: { ok: 1 } }));

    const data = await graphqlRequest<{ ok: number }>({
      endpoint: 'https://api.example/graphql',
      query: 'query { ok }',
      variables: { a: 1 },
      fetchImpl,
    });

    expect(data).toEqual({ ok: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.example/graphql');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(bodyOf(calls[0]?.init)).toEqual({ query: 'query { ok }', variables: { a: 1 } });
  });

  it('sends Authorization only when a token is given', async () => {
    const withToken = stubFetch(jsonResponse({ data: {} }));
    await graphqlRequest({
      endpoint: 'https://x/graphql',
      query: '{ a }',
      token: 'tok',
      fetchImpl: withToken.fetchImpl,
    });
    const headers = withToken.calls[0]?.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok');
    expect(headers['Content-Type']).toBe('application/json');

    const noToken = stubFetch(jsonResponse({ data: {} }));
    await graphqlRequest({ endpoint: 'https://x/graphql', query: '{ a }', fetchImpl: noToken.fetchImpl });
    expect((noToken.calls[0]?.init?.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('merges extra headers without dropping the bearer', async () => {
    const { fetchImpl, calls } = stubFetch(jsonResponse({ data: {} }));

    await graphqlRequest({
      endpoint: 'https://x/graphql',
      query: '{ a }',
      token: 'tok',
      headers: { 'X-Trace': 't-1' },
      fetchImpl,
    });

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['X-Trace']).toBe('t-1');
    expect(headers['Authorization']).toBe('Bearer tok');
  });

  it('passes credentials and signal through', async () => {
    const { fetchImpl, calls } = stubFetch(jsonResponse({ data: {} }));
    const controller = new AbortController();

    await graphqlRequest({
      endpoint: 'https://x/graphql',
      query: '{ a }',
      credentials: 'include',
      signal: controller.signal,
      fetchImpl,
    });

    expect(calls[0]?.init?.credentials).toBe('include');
    expect(calls[0]?.init?.signal).toBe(controller.signal);
  });

  it('calls onResponse before parsing, so a hook can throw its own error', async () => {
    const { fetchImpl } = stubFetch(new Response('nope', { status: 401 }));
    const onResponse = vi.fn(() => {
      throw new Error('custom-401');
    });

    await expect(
      graphqlRequest({ endpoint: 'https://x/graphql', query: '{ a }', onResponse, fetchImpl }),
    ).rejects.toThrow('custom-401');
    expect(onResponse).toHaveBeenCalledTimes(1);
  });

  it('throws GraphQLClientError with status on a non-2xx response', async () => {
    const { fetchImpl } = stubFetch(new Response('boom', { status: 503 }));

    const err = await graphqlRequest({
      endpoint: 'https://x/graphql',
      query: '{ a }',
      fetchImpl,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GraphQLClientError);
    expect((err as GraphQLClientError).status).toBe(503);
    expect((err as GraphQLClientError).message).toContain('503');
    expect((err as GraphQLClientError).message).toContain('boom');
  });

  it('throws GraphQLClientError when the body is not JSON', async () => {
    const { fetchImpl } = stubFetch(new Response('<html>', { status: 200 }));

    const err = await graphqlRequest({
      endpoint: 'https://x/graphql',
      query: '{ a }',
      fetchImpl,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GraphQLClientError);
    expect((err as GraphQLClientError).message).toBe('GraphQL response was not JSON');
  });

  it('carries every error and the first code on a graphql errors array', async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse({
        errors: [
          { message: 'first', extensions: { code: 'CONFLICT' } },
          { message: 'second' },
        ],
      }),
    );

    const err = await graphqlRequest({
      endpoint: 'https://x/graphql',
      query: '{ a }',
      fetchImpl,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GraphQLClientError);
    const gqlErr = err as GraphQLClientError;
    expect(gqlErr.message).toBe('first; second');
    expect(gqlErr.code).toBe('CONFLICT');
    expect(gqlErr.errors).toHaveLength(2);
    expect(gqlErr.status).toBe(200);
  });

  it('throws when the response has neither data nor errors', async () => {
    const { fetchImpl } = stubFetch(jsonResponse({}));

    await expect(
      graphqlRequest({ endpoint: 'https://x/graphql', query: '{ a }', fetchImpl }),
    ).rejects.toThrow('neither data nor errors');
  });

  it('works with a double that only implements json() (no text/clone)', async () => {
    // 消費側の test double は Response を完全には実装しないことがある (2026-10-11:
    // ある製品の同期テストが `{ok, status, json, text}` の object を返しており、
    // 当初の `text()` 先読みがそれを壊した)。本文の読み取りは json() を第一にする。
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ data: { ok: 1 } }) }) as unknown as Response;

    const data = await graphqlRequest<{ ok: number }>({
      endpoint: 'https://x/graphql',
      query: '{ ok }',
      fetchImpl,
    });

    expect(data).toEqual({ ok: 1 });
  });

  it('reports a non-JSON body with status when json() fails and clone exists', async () => {
    const { fetchImpl } = stubFetch(new Response('<html>502</html>', { status: 502 }));

    const err = await graphqlRequest({
      endpoint: 'https://x/graphql',
      query: '{ a }',
      fetchImpl,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GraphQLClientError);
    expect((err as GraphQLClientError).message).toContain('502');
    expect((err as GraphQLClientError).message).toContain('<html>');
  });

  it('accepts a service-binding style fetch (Request -> Response)', async () => {
    // Cloudflare の Service Binding は url 文字列でなく Request を受ける。
    // lib は CF を知らないので、consumer がこの形に包んで fetchImpl に渡す。
    const seen: Request[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const req = new Request(url, init);
      seen.push(req);
      return jsonResponse({ data: { viaBinding: true } });
    };

    const data = await graphqlRequest<{ viaBinding: boolean }>({
      endpoint: 'https://tenant-api.internal/tenant/graphql',
      query: '{ viaBinding }',
      token: 'jwt',
      fetchImpl,
    });

    expect(data).toEqual({ viaBinding: true });
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer jwt');
  });
});

describe('createAuthedGraphQLClient', () => {
  it('injects the token and posts to the resolved endpoint', async () => {
    const { fetchImpl, calls } = stubFetch(jsonResponse({ data: { me: 'u1' } }));
    const client = createAuthedGraphQLClient({
      endpoint: () => 'https://dyn.example/graphql',
      getToken: () => 'tok',
      fetchImpl,
    });

    const data = await client.request<{ me: string }>('query { me }', { x: 1 });

    expect(data).toEqual({ me: 'u1' });
    expect(calls[0]?.url).toBe('https://dyn.example/graphql');
    expect((calls[0]?.init?.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
  });

  it('supports an async token provider', async () => {
    const { fetchImpl, calls } = stubFetch(jsonResponse({ data: {} }));
    const client = createAuthedGraphQLClient({
      endpoint: 'https://x/graphql',
      getToken: async () => 'async-tok',
      fetchImpl,
    });

    await client.request('{ a }');
    expect((calls[0]?.init?.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer async-tok',
    );
  });

  it('throws UNAUTHENTICATED when the provider yields null (default requireToken)', async () => {
    const { fetchImpl, calls } = stubFetch(jsonResponse({ data: {} }));
    const client = createAuthedGraphQLClient({
      endpoint: 'https://x/graphql',
      getToken: () => null,
      fetchImpl,
    });

    const err = await client.request('{ a }').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphQLClientError);
    expect((err as GraphQLClientError).code).toBe('UNAUTHENTICATED');
    expect(calls).toHaveLength(0);
  });

  it('sends anonymously when requireToken is false', async () => {
    const { fetchImpl, calls } = stubFetch(jsonResponse({ data: {} }));
    const client = createAuthedGraphQLClient({
      endpoint: 'https://x/graphql',
      getToken: () => null,
      requireToken: false,
      fetchImpl,
    });

    await client.request('{ a }');
    expect(calls).toHaveLength(1);
    expect((calls[0]?.init?.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });
});
