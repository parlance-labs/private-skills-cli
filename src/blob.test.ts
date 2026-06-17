import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRepoTree, resetRepoTreeAuthState, tryBlobInstall } from './blob.ts';

function okTreeResponse(body: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  };
}

beforeEach(() => {
  resetRepoTreeAuthState();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchRepoTree', () => {
  it('propagates truncated flag from the GitHub response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okTreeResponse({ sha: 'abc', tree: [], truncated: true }))
    );

    const tree = await fetchRepoTree('owner/repo', 'main');
    expect(tree?.truncated).toBe(true);
  });

  it('defaults truncated to false when the field is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okTreeResponse({ sha: 'abc', tree: [] }))
    );

    const tree = await fetchRepoTree('owner/repo', 'main');
    expect(tree?.truncated).toBe(false);
  });

  it('sends current GitHub REST headers', async () => {
    const fetchMock = vi.fn(async () => okTreeResponse({ sha: 'abc', tree: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchRepoTree('owner/repo', 'main');

    const calls = fetchMock.mock.calls as unknown as Array<
      [string, { headers: Record<string, string> }]
    >;
    const headers = calls[0]![1].headers;
    expect(headers.Accept).toBe('application/vnd.github+json');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(headers['User-Agent']).toBe('skills-cli');
  });

  it('does not install from an incomplete tree listing', async () => {
    const fetchMock = vi.fn(async () =>
      okTreeResponse({
        sha: 'abc',
        truncated: true,
        tree: [{ path: 'skills/demo/SKILL.md', type: 'blob', sha: 'def' }],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(tryBlobInstall('owner/repo', { ref: 'main' })).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
