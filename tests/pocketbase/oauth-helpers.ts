import { createHash, randomBytes } from 'node:crypto';
import { expect, type APIRequestContext } from '@playwright/test';
export const resource = 'http://127.0.0.1:8091/api/todo/mcp';
export async function beginOAuth(request: APIRequestContext, scope = 'tasks:read tasks:write') {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const registration = await request.post('/api/oauth/register', {
    data: {
      client_name: 'Integration test agent',
      redirect_uris: ['http://127.0.0.1:9876/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
  });
  expect(registration.status()).toBe(201);
  const client = await registration.json();
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: randomBytes(16).toString('hex'),
    resource,
    scope,
  });
  const authorization = await request.get(`/api/oauth/authorize?${params}`, { maxRedirects: 0 });
  expect(authorization.status()).toBe(302);
  const consentURL = authorization.headers().location;
  return {
    client,
    verifier,
    params,
    consentURL,
    requestId: new URL(consentURL).searchParams.get('request')!,
  };
}
export async function authorize(request: APIRequestContext, pbToken: string, scope?: string) {
  const flow = await beginOAuth(request, scope);
  const approved = await request.post('/api/oauth/consent', {
    headers: { Authorization: pbToken },
    data: { request: flow.requestId, approve: true },
  });
  expect(approved.status()).toBe(200);
  const callback = new URL((await approved.json()).redirect);
  expect(callback.searchParams.get('state')).toBe(flow.params.get('state'));
  const form = {
    grant_type: 'authorization_code',
    code: callback.searchParams.get('code')!,
    client_id: flow.client.client_id,
    redirect_uri: flow.client.redirect_uris[0],
    code_verifier: flow.verifier,
    resource,
  };
  const response = await request.post('/api/oauth/token', { form });
  expect(response.status()).toBe(200);
  return { ...flow, form, tokens: await response.json() };
}
