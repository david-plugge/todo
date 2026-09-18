import { expect, test, type APIRequestContext } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { authorize, beginOAuth, resource } from './oauth-helpers';
async function login(request: APIRequestContext) {
  return (
    await (
      await request.post('/api/collections/todo_users/auth-with-password', {
        data: { identity: 'oauth-user@example.test', password: 'test-password-12345!' },
      })
    ).json()
  ).token as string;
}
async function probe(request: APIRequestContext, token: string) {
  return request.post('/api/todo/mcp', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-11-25',
    },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
}

test('official SDK discovers OAuth, registers, opens browser consent and connects with PKCE', async ({
  page,
}) => {
  let clientInfo: OAuthClientInformationMixed | undefined;
  let tokens: OAuthTokens | undefined;
  let verifier = '',
    authorizationURL = '';
  const state = crypto.randomUUID();
  const provider: OAuthClientProvider = {
    redirectUrl: 'http://127.0.0.1:9876/callback',
    clientMetadata: {
      client_name: 'Browser test agent',
      redirect_uris: ['http://127.0.0.1:9876/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'tasks:read tasks:write',
    },
    state: () => state,
    clientInformation: () => clientInfo,
    saveClientInformation: (value) => {
      clientInfo = value;
    },
    tokens: () => tokens,
    saveTokens: (value) => {
      tokens = value;
    },
    redirectToAuthorization: (value) => {
      authorizationURL = value.href;
    },
    saveCodeVerifier: (value) => {
      verifier = value;
    },
    codeVerifier: () => verifier,
  };
  const first = new Client({ name: 'OAuth browser test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(resource), {
    authProvider: provider,
  });
  await expect(first.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
  expect(authorizationURL).toContain('/api/oauth/authorize');
  let callbackURL = '';
  await page.route('http://127.0.0.1:9876/callback?*', async (route) => {
    callbackURL = route.request().url();
    await route.fulfill({ body: 'OAuth completed', contentType: 'text/html' });
  });
  await page.goto(authorizationURL);
  await expect(page.getByRole('heading', { name: 'Agent verbinden' })).toBeVisible();
  await expect(page.getByText('Browser test agent', { exact: true })).toBeVisible();
  await page.getByLabel('E-Mail', { exact: true }).fill('oauth-user@example.test');
  await page.getByLabel('Passwort', { exact: true }).fill('test-password-12345!');
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
  await page.getByRole('button', { name: 'Zugriff erlauben', exact: true }).click();
  await expect.poll(() => callbackURL).toContain('code=');
  const callback = new URL(callbackURL);
  expect(callback.searchParams.get('state')).toBe(state);
  await transport.finishAuth(callback.searchParams.get('code')!);
  const client = new Client({ name: 'Authenticated browser test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(resource), { authProvider: provider }),
  );
  expect((await client.listTools()).tools).toHaveLength(8);
  await client.close();
  await first.close();
});

test('tokens rotate, old access is invalidated and refresh replay revokes the grant family', async ({
  request,
}) => {
  const flow = await authorize(request, await login(request));
  expect((await probe(request, flow.tokens.access_token)).status()).toBe(200);
  const form = {
    grant_type: 'refresh_token',
    refresh_token: flow.tokens.refresh_token,
    client_id: flow.client.client_id,
    resource,
  };
  const refreshed = await request.post('/api/oauth/token', { form });
  expect(refreshed.status()).toBe(200);
  const next = await refreshed.json();
  expect(next.refresh_token).not.toBe(flow.tokens.refresh_token);
  expect((await probe(request, flow.tokens.access_token)).status()).toBe(401);
  expect((await probe(request, next.access_token)).status()).toBe(200);
  expect((await request.post('/api/oauth/token', { form })).status()).toBe(400);
  expect((await probe(request, next.access_token)).status()).toBe(401);
  expect(
    (
      await request.post('/api/oauth/token', {
        form: { ...form, refresh_token: next.refresh_token },
      })
    ).status(),
  ).toBe(400);
});

test('code binds PKCE, client, redirect and resource; invalid attempts never consume a valid code', async ({
  request,
}) => {
  const pbToken = await login(request);
  const flow = await beginOAuth(request);
  const approved = await (
    await request.post('/api/oauth/consent', {
      headers: { Authorization: pbToken },
      data: { request: flow.requestId, approve: true },
    })
  ).json();
  const form = {
    grant_type: 'authorization_code',
    code: new URL(approved.redirect).searchParams.get('code')!,
    client_id: flow.client.client_id,
    redirect_uri: flow.client.redirect_uris[0],
    code_verifier: flow.verifier,
    resource,
  };
  for (const override of [
    { code_verifier: 'a'.repeat(43) },
    { client_id: 'wrong' },
    { redirect_uri: 'http://127.0.0.1:9876/other' },
    { resource: 'https://other.invalid/mcp' },
  ]) {
    expect(
      (await request.post('/api/oauth/token', { form: { ...form, ...override } })).status(),
    ).toBe(400);
  }
  const good = await request.post('/api/oauth/token', { form });
  expect(good.status()).toBe(200);
  const tokens = await good.json();
  expect((await request.post('/api/oauth/token', { form })).status()).toBe(400);
  expect((await probe(request, tokens.access_token)).status()).toBe(401);
  expect(
    (
      await request.post('/api/oauth/consent', {
        headers: { Authorization: pbToken },
        data: { request: flow.requestId, approve: true },
      })
    ).status(),
  ).toBe(400);
});

test('read-only grants cannot write, normal PB tokens cannot access MCP, and account revocation works', async ({
  request,
}) => {
  const pbToken = await login(request);
  expect((await probe(request, pbToken)).status()).toBe(401);
  const flow = await authorize(request, pbToken, 'tasks:read');
  const client = new Client({ name: 'Read-only test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: { headers: { Authorization: `Bearer ${flow.tokens.access_token}` } },
    }),
  );
  const read = await client.callTool({ name: 'list_tasks', arguments: {} });
  expect(read.isError).not.toBe(true);
  const write = await client.callTool({
    name: 'create_task',
    arguments: { title: 'Forbidden', mutationId: crypto.randomUUID() },
  });
  expect(write.isError).toBe(true);
  const connections = await (
    await request.get('/api/oauth/connections', { headers: { Authorization: pbToken } })
  ).json();
  expect(connections.items.length).toBeGreaterThan(0);
  for (const connection of connections.items)
    await request.post(`/api/oauth/connections/${connection.id}/revoke`, {
      headers: { Authorization: pbToken },
    });
  expect((await probe(request, flow.tokens.access_token)).status()).toBe(401);
  await client.close();
});

test('authorization rejects unsafe redirects, missing PKCE and unwanted origins; denial issues no code', async ({
  request,
}) => {
  for (const uri of [
    'https://good.invalid/cb#fragment',
    'javascript:alert(1)',
    'http://external.invalid/cb',
    'https://user:pass@example.com/cb',
  ]) {
    expect(
      (await request.post('/api/oauth/register', { data: { redirect_uris: [uri] } })).status(),
    ).toBe(400);
  }
  const flow = await beginOAuth(request);
  for (const override of [
    { code_challenge_method: 'plain' },
    { code_challenge: '' },
    { redirect_uri: 'https://attacker.invalid' },
  ]) {
    const query = new URLSearchParams(flow.params);
    for (const [k, v] of Object.entries(override)) query.set(k, v);
    expect((await request.get(`/api/oauth/authorize?${query}`, { maxRedirects: 0 })).status()).toBe(
      400,
    );
  }
  expect(
    (
      await request.post('/api/oauth/consent', { data: { request: flow.requestId, approve: true } })
    ).status(),
  ).toBe(401);
  const pbToken = await login(request);
  expect(
    (
      await request.post('/api/oauth/consent', {
        headers: { Authorization: pbToken, Origin: 'https://attacker.invalid' },
        data: { request: flow.requestId, approve: true },
      })
    ).status(),
  ).toBe(403);
  const denied = await (
    await request.post('/api/oauth/consent', {
      headers: { Authorization: pbToken },
      data: { request: flow.requestId, approve: false },
    })
  ).json();
  const callback = new URL(denied.redirect);
  expect(callback.searchParams.get('error')).toBe('access_denied');
  expect(callback.searchParams.has('code')).toBe(false);
  expect(callback.searchParams.get('state')).toBe(flow.params.get('state'));
});
