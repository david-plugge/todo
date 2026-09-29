import PocketBase, { BaseAuthStore, LocalAuthStore } from 'pocketbase';

/** The backend enables exactly one of these, decided by its deployment config. */
export type SignInMethod = { kind: 'password' } | { kind: 'oidc'; displayName: string };

interface PendingSignIn {
  state: string;
  codeVerifier: string;
  returnTo: string;
}

const provider = 'oidc';
const pendingKey = 'todo-oidc-pending';
const callbackPath = '/auth/callback';
const requestOptions = () => ({ requestKey: null, signal: AbortSignal.timeout(10_000) });

function isolatedUsers() {
  return new PocketBase(location.origin, new BaseAuthStore()).collection('todo_users');
}

async function oidcProvider() {
  const methods = await isolatedUsers().listAuthMethods(requestOptions());
  return methods.oauth2.enabled
    ? methods.oauth2.providers.find((candidate) => candidate.name === provider)
    : undefined;
}

export async function loadSignInMethod(): Promise<SignInMethod> {
  const oidc = await oidcProvider();
  return oidc ? { kind: 'oidc', displayName: oidc.displayName } : { kind: 'password' };
}

/** Only same-origin paths may be resumed; anything else falls back to the start page. */
export function safeReturnTo(value: string) {
  return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/';
}

function callbackURL() {
  return location.origin + callbackPath;
}

/** A redirect instead of a popup keeps sign-in working in installed PWAs. */
export async function startOIDCSignIn(returnTo: string) {
  // Fetched per attempt so every redirect carries a fresh state and PKCE verifier.
  const oidc = await oidcProvider();
  if (!oidc) throw new Error('OIDC sign-in is not configured');
  const pending: PendingSignIn = {
    state: oidc.state,
    codeVerifier: oidc.codeVerifier,
    returnTo: safeReturnTo(returnTo),
  };
  sessionStorage.setItem(pendingKey, JSON.stringify(pending));
  location.assign(oidc.authURL + encodeURIComponent(callbackURL()));
}

/** Completes the redirect and returns the path the sign-in was started from. */
export async function completeOIDCSignIn(callback: URL) {
  const raw = sessionStorage.getItem(pendingKey);
  // One attempt per stored state: a reloaded or replayed callback cannot reuse it.
  sessionStorage.removeItem(pendingKey);
  if (!raw) throw new Error('No pending OIDC sign-in');
  const pending = JSON.parse(raw) as PendingSignIn;
  const code = callback.searchParams.get('code');
  if (callback.searchParams.get('error') || !code) throw new Error('OIDC sign-in was rejected');
  if (callback.searchParams.get('state') !== pending.state) {
    throw new Error('OIDC sign-in state does not match');
  }
  await new PocketBase(location.origin, new LocalAuthStore('todo-auth-v1'))
    .collection('todo_users')
    .authWithOAuth2Code(provider, code, pending.codeVerifier, callbackURL(), {}, requestOptions());
  return safeReturnTo(pending.returnTo);
}
