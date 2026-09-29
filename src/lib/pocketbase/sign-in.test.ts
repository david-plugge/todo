// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeOIDCSignIn, safeReturnTo } from './sign-in';

const pending = (returnTo = '/oauth/consent?request=abc') =>
  sessionStorage.setItem(
    'todo-oidc-pending',
    JSON.stringify({ state: 'expected-state', codeVerifier: 'verifier', returnTo }),
  );

const callback = (query: string) => new URL(`${location.origin}/auth/callback?${query}`);

function stubAuthResponse() {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          token: 'token',
          record: { id: 'user', collectionId: 'c', collectionName: 'todo_users' },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('safeReturnTo', () => {
  it('keeps same-origin paths and rejects everything else', () => {
    expect(safeReturnTo('/oauth/consent?request=abc')).toBe('/oauth/consent?request=abc');
    for (const unsafe of ['https://evil.example', '//evil.example', '/\\evil.example', 'evil']) {
      expect(safeReturnTo(unsafe)).toBe('/');
    }
  });
});

describe('completeOIDCSignIn', () => {
  it('exchanges the code with the stored verifier and resumes the original path', async () => {
    const fetch = stubAuthResponse();
    pending();
    await expect(completeOIDCSignIn(callback('code=abc&state=expected-state'))).resolves.toBe(
      '/oauth/consent?request=abc',
    );
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/collections/todo_users/auth-with-oauth2');
    expect(JSON.parse(String(init.body))).toMatchObject({
      provider: 'oidc',
      code: 'abc',
      codeVerifier: 'verifier',
      redirectURL: `${location.origin}/auth/callback`,
    });
    expect(JSON.parse(localStorage.getItem('todo-auth-v1') ?? '{}')).toMatchObject({
      token: 'token',
    });
  });

  it('rejects a foreign state without contacting the backend', async () => {
    const fetch = stubAuthResponse();
    pending();
    await expect(completeOIDCSignIn(callback('code=abc&state=forged'))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts each pending sign-in only once', async () => {
    stubAuthResponse();
    pending();
    await completeOIDCSignIn(callback('code=abc&state=expected-state'));
    await expect(completeOIDCSignIn(callback('code=abc&state=expected-state'))).rejects.toThrow();
  });

  it('rejects provider errors', async () => {
    const fetch = stubAuthResponse();
    pending();
    await expect(
      completeOIDCSignIn(callback('error=access_denied&state=expected-state')),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
