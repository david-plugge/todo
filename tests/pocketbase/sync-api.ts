import { expect, type APIRequestContext } from '@playwright/test';

export async function bootstrapSyncGeneration(
  request: APIRequestContext,
  authorization: string,
): Promise<string> {
  const response = await request.get('/api/todo/pull', {
    headers: { Authorization: authorization },
  });
  expect(response.status()).toBe(200);
  const reset = await response.json();
  expect(reset).toMatchObject({ mode: 'reset' });
  expect(reset.generation).toEqual(expect.any(String));
  expect(reset.generation).not.toHaveLength(0);
  expect(reset.until).toEqual(expect.any(Number));
  return reset.generation;
}

export function syncHeaders(authorization: string, generation: string) {
  return {
    Authorization: authorization,
    'X-Todo-Sync-Generation': generation,
  };
}

export function changesPull(path: string, generation: string): string {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}generation=${encodeURIComponent(generation)}`;
}
