import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchSkillsAPI } from './find.ts';

function mockFetchOnce(payload: unknown, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok,
      json: async () => payload,
    }))
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SKILLS_REGISTRY_URL;
  delete process.env.SKILLS_API_URL;
  delete process.env.SKILLS_REGISTRY_TOKEN;
  delete process.env.SKILLS_API_TOKEN;
});

describe('searchSkillsAPI', () => {
  it('parses lastCommitDate and commitCount when present', async () => {
    mockFetchOnce({
      skills: [
        {
          id: 'code-review',
          name: 'Code Review',
          installs: 100,
          source: 'parlance-labs/skills',
          lastCommitDate: '2026-01-01T00:00:00Z',
          commitCount: 42,
        },
      ],
    });

    const results = await searchSkillsAPI('code');
    expect(results).toHaveLength(1);
    expect(results[0]!.lastCommitDate).toBe('2026-01-01T00:00:00Z');
    expect(results[0]!.commitCount).toBe(42);
  });

  it('leaves new fields undefined for older responses', async () => {
    mockFetchOnce({
      skills: [{ id: 'foo', name: 'Foo', installs: 5, source: 'a/b' }],
    });

    const results = await searchSkillsAPI('foo');
    expect(results).toHaveLength(1);
    expect(results[0]!.lastCommitDate).toBeUndefined();
    expect(results[0]!.commitCount).toBeUndefined();
  });

  it('ignores wrong-typed metadata fields', async () => {
    mockFetchOnce({
      skills: [
        {
          id: 'foo',
          name: 'Foo',
          installs: 5,
          source: 'a/b',
          lastCommitDate: 12345,
          commitCount: 'lots',
        },
      ],
    });

    const results = await searchSkillsAPI('foo');
    expect(results[0]!.lastCommitDate).toBeUndefined();
    expect(results[0]!.commitCount).toBeUndefined();
  });

  it('uses the configured registry URL and token for search', async () => {
    process.env.SKILLS_REGISTRY_URL = 'https://registry.example.com/';
    process.env.SKILLS_REGISTRY_TOKEN = 'secret-token';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ skills: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await searchSkillsAPI('code');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://registry.example.com/api/search?q=code&limit=10',
      { headers: { Authorization: 'Bearer secret-token' } }
    );
  });
});
