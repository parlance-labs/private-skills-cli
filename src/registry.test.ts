import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchRegistryInstall,
  getRegistryBaseUrl,
  isRegistryMediatedParsedSource,
  isRegistryMediatedSource,
  RegistryInstallError,
} from './registry.ts';
import { getOwnerRepo, parseSource } from './source-parser.ts';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.SKILLS_REGISTRY_URL;
  delete process.env.SKILLS_API_URL;
  delete process.env.SKILLS_REGISTRY_TOKEN;
  delete process.env.SKILLS_API_TOKEN;
  delete process.env.SKILLS_REGISTRY_SOURCES;
});

describe('getRegistryBaseUrl', () => {
  it('uses SKILLS_REGISTRY_URL before the legacy SKILLS_API_URL', () => {
    process.env.SKILLS_REGISTRY_URL = 'https://registry.example.com/';
    process.env.SKILLS_API_URL = 'https://legacy.example.com/';

    expect(getRegistryBaseUrl()).toBe('https://registry.example.com');
  });
});

describe('isRegistryMediatedSource', () => {
  it('defaults parlance-labs/private-skills to registry-mediated', () => {
    expect(isRegistryMediatedSource('parlance-labs/private-skills')).toBe(true);
    expect(isRegistryMediatedSource('vercel-labs/agent-skills')).toBe(false);
  });

  it('supports configured registry-mediated sources', () => {
    process.env.SKILLS_REGISTRY_SOURCES = 'acme/private-skills';
    expect(isRegistryMediatedSource('acme/private-skills')).toBe(true);
  });

  it('mediates all GitHub sources when registry auth is configured and no source list narrows it', () => {
    process.env.SKILLS_REGISTRY_TOKEN = 'secret-token';

    expect(isRegistryMediatedSource('acme/runtime-added-source')).toBe(true);
    expect(isRegistryMediatedSource('vercel-labs/agent-skills')).toBe(true);
  });

  it('respects an explicit registry source list even when a registry token is configured', () => {
    process.env.SKILLS_REGISTRY_TOKEN = 'secret-token';
    process.env.SKILLS_REGISTRY_SOURCES = 'acme/private-skills';

    expect(isRegistryMediatedSource('parlance-labs/private-skills')).toBe(true);
    expect(isRegistryMediatedSource('acme/private-skills')).toBe(true);
    expect(isRegistryMediatedSource('vercel-labs/agent-skills')).toBe(false);
  });
});

describe('isRegistryMediatedParsedSource', () => {
  function mediated(input: string): boolean {
    const parsed = parseSource(input);
    return isRegistryMediatedParsedSource(parsed, getOwnerRepo(parsed));
  }

  it('mediates GitHub shorthand, HTTPS, and SSH forms for configured sources', () => {
    expect(mediated('parlance-labs/private-skills')).toBe(true);
    expect(mediated('https://github.com/parlance-labs/private-skills')).toBe(true);
    expect(mediated('git@github.com:parlance-labs/private-skills.git')).toBe(true);
  });

  it('mediates SSH URLs with non-lowercase github.com host', () => {
    process.env.SKILLS_REGISTRY_TOKEN = 'secret-token';

    expect(mediated('git@GitHub.com:attacker/evil.git')).toBe(true);
    expect(mediated('git@GITHUB.COM:attacker/evil.git')).toBe(true);
    expect(mediated('git@Github.Com:attacker/evil.git')).toBe(true);
  });

  it('mediates ssh:// URLs with non-lowercase github.com host', () => {
    process.env.SKILLS_REGISTRY_TOKEN = 'secret-token';

    expect(mediated('ssh://git@GitHub.COM/attacker/evil.git')).toBe(true);
  });

  it('mediates GitHub SSH-over-443 host (ssh.github.com)', () => {
    process.env.SKILLS_REGISTRY_TOKEN = 'secret-token';

    expect(mediated('git@ssh.github.com:attacker/evil.git')).toBe(true);
    expect(mediated('ssh://git@ssh.github.com:443/attacker/evil.git')).toBe(true);
  });

  it('mediates trailing-dot FQDN variants of github.com', () => {
    process.env.SKILLS_REGISTRY_TOKEN = 'secret-token';

    expect(mediated('git@github.com.:attacker/evil.git')).toBe(true);
    expect(mediated('https://github.com./attacker/evil.git')).toBe(true);
  });

  it('mediates URLs with uppercase schemes', () => {
    process.env.SKILLS_REGISTRY_TOKEN = 'secret-token';

    expect(mediated('SSH://git@github.com/attacker/evil.git')).toBe(true);
    expect(mediated('HTTPS://github.com/attacker/evil.git')).toBe(true);
  });

  it('mediates trailing-slash GitHub URLs that bypass parseSource canonicalization', () => {
    process.env.SKILLS_REGISTRY_TOKEN = 'secret-token';

    expect(mediated('https://GITHUB.COM/attacker/evil/')).toBe(true);
    expect(mediated('https://github.com./attacker/evil/')).toBe(true);
    expect(mediated('git@github.com.:attacker/evil/')).toBe(true);
    expect(mediated('git@GITHUB.COM:attacker/evil/')).toBe(true);
    expect(mediated('ssh://git@github.com:22/attacker/evil/')).toBe(true);
    expect(mediated('ssh://git@ssh.github.com:443/attacker/evil/')).toBe(true);
  });

  it('mediates trailing /.git suffix variants (normalizeRepoPath idempotence)', () => {
    process.env.SKILLS_REGISTRY_TOKEN = 'secret-token';

    expect(mediated('https://GITHUB.COM/attacker/evil/.git')).toBe(true);
    expect(mediated('git@github.com.:attacker/evil/.git')).toBe(true);
    expect(mediated('ssh://git@ssh.github.com:443/attacker/evil/.git')).toBe(true);

    // Verify getOwnerRepo normalizes correctly
    expect(getOwnerRepo(parseSource('https://GITHUB.COM/attacker/evil/.git'))).toBe(
      'attacker/evil'
    );
    expect(getOwnerRepo(parseSource('git@GITHUB.COM:attacker/evil/.git'))).toBe('attacker/evil');
  });

  it('does not mediate non-GitHub git hosts', () => {
    process.env.SKILLS_REGISTRY_TOKEN = 'secret-token';

    expect(mediated('git@gitlab.com:owner/repo.git')).toBe(false);
    expect(mediated('https://example.com/owner/repo.git')).toBe(false);
  });

  it('does not intercept GitLab sources when wildcard registry mediation is enabled', () => {
    process.env.SKILLS_REGISTRY_SOURCES = '*';

    expect(mediated('https://gitlab.com/parlance-labs/private-skills')).toBe(false);
  });
});

describe('fetchRegistryInstall', () => {
  it('requires a CLI registry token', async () => {
    await expect(fetchRegistryInstall('parlance-labs/private-skills')).rejects.toBeInstanceOf(
      RegistryInstallError
    );
  });

  it('rejects registry sources that are not GitHub owner/repo shaped', async () => {
    await expect(fetchRegistryInstall('group/subgroup/repo')).rejects.toThrow(
      'Registry-mediated install requires a GitHub owner/repo source'
    );
  });

  it('fetches authorized snapshots and converts them to installable skills', async () => {
    process.env.SKILLS_REGISTRY_URL = 'https://registry.example.com';
    process.env.SKILLS_REGISTRY_TOKEN = 'secret-token';

    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer secret-token' });

      if (url === 'https://registry.example.com/api/skills') {
        return new Response(
          JSON.stringify({
            skills: [
              {
                id: 'parlance-labs/private-skills/code-review',
                skillId: 'code-review',
                name: 'Code Review',
                description: 'Review code',
                source: 'parlance-labs/private-skills',
                skillPath: 'skills/code-review/SKILL.md',
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (
        url === 'https://registry.example.com/api/download/parlance-labs/private-skills/code-review'
      ) {
        return new Response(
          JSON.stringify({
            hash: 'snapshot-hash',
            skill: {
              id: 'parlance-labs/private-skills/code-review',
              skillId: 'code-review',
              name: 'Code Review',
              description: 'Review code',
              source: 'parlance-labs/private-skills',
              skillPath: 'skills/code-review/SKILL.md',
            },
            files: [
              {
                path: 'SKILL.md',
                contents: '---\nname: Code Review\ndescription: Review code\n---\nBody\n',
              },
            ],
          }),
          { status: 200 }
        );
      }

      return new Response('{}', { status: 404 });
    });
    global.fetch = fetchMock as typeof fetch;

    const result = await fetchRegistryInstall('parlance-labs/private-skills');

    expect(result.registryUrl).toBe('https://registry.example.com');
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({
      name: 'Code Review',
      description: 'Review code',
      path: 'code-review',
      snapshotHash: 'snapshot-hash',
      repoPath: 'skills/code-review/SKILL.md',
    });
  });

  it('does not fall back to every registry skill when a subpath selector misses', async () => {
    process.env.SKILLS_REGISTRY_URL = 'https://registry.example.com';
    process.env.SKILLS_REGISTRY_TOKEN = 'secret-token';

    global.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          skills: [
            {
              id: 'parlance-labs/private-skills/code-review',
              skillId: 'code-review',
              name: 'Code Review',
              description: 'Review code',
              source: 'parlance-labs/private-skills',
              skillPath: 'skills/code-review/SKILL.md',
            },
          ],
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    await expect(
      fetchRegistryInstall('parlance-labs/private-skills', {
        subpath: 'skills/not-a-real-skill',
      })
    ).rejects.toThrow('No registry skills found for parlance-labs/private-skills.');
  });

  it('downloads only records matching the requested skill filter', async () => {
    process.env.SKILLS_REGISTRY_URL = 'https://registry.example.com';
    process.env.SKILLS_REGISTRY_TOKEN = 'secret-token';

    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url === 'https://registry.example.com/api/skills') {
        return new Response(
          JSON.stringify({
            skills: [
              {
                id: 'parlance-labs/private-skills/code-review',
                skillId: 'code-review',
                name: 'Code Review',
                description: 'Review code',
                source: 'parlance-labs/private-skills',
                skillPath: 'skills/code-review/SKILL.md',
              },
              {
                id: 'parlance-labs/private-skills/prompt-engineering',
                skillId: 'prompt-engineering',
                name: 'Prompt Engineering',
                description: 'Write prompts',
                source: 'parlance-labs/private-skills',
                skillPath: 'skills/prompt-engineering/SKILL.md',
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (
        url === 'https://registry.example.com/api/download/parlance-labs/private-skills/code-review'
      ) {
        return new Response(
          JSON.stringify({
            hash: 'snapshot-hash',
            files: [
              {
                path: 'SKILL.md',
                contents: '---\nname: Code Review\ndescription: Review code\n---\nBody\n',
              },
            ],
          }),
          { status: 200 }
        );
      }

      return new Response('{}', { status: 500 });
    });
    global.fetch = fetchMock as typeof fetch;

    const result = await fetchRegistryInstall('parlance-labs/private-skills', {
      skillFilter: 'code-review',
    });

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.name).toBe('Code Review');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain(
      'https://registry.example.com/api/download/parlance-labs/private-skills/prompt-engineering'
    );
  });
});
