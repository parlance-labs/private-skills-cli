import { describe, expect, it } from 'vitest';
import { access, lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installBlobSkillForAgent,
  installRemoteSkillForAgent,
  installWellKnownSkillForAgent,
} from '../src/installer.ts';
import type { RemoteSkill } from '../src/types.ts';
import type { WellKnownSkill } from '../src/providers/wellknown.ts';

async function makeProjectDir(): Promise<{ root: string; projectDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'installer-variants-'));
  const projectDir = join(root, 'project');
  await mkdir(projectDir, { recursive: true });
  return { root, projectDir };
}

function makeRemoteSkill(installName: string): RemoteSkill {
  return {
    name: installName,
    description: 'test',
    content: `---\nname: ${installName}\ndescription: test\n---\n`,
    installName,
    sourceUrl: 'https://example.com/SKILL.md',
    providerId: 'test',
    sourceIdentifier: 'test/example',
  };
}

describe('installer variants', () => {
  it('preserves remote project installs for non-universal agents without config dirs', async () => {
    const { root, projectDir } = await makeProjectDir();

    try {
      const result = await installRemoteSkillForAgent(
        makeRemoteSkill('remote-skill'),
        'claude-code',
        {
          cwd: projectDir,
          mode: 'symlink',
          global: false,
        }
      );

      expect(result.success).toBe(true);
      expect(result.skipped).toBeUndefined();

      const agentDir = join(projectDir, '.claude', 'skills', 'remote-skill');
      expect((await lstat(agentDir)).isSymbolicLink()).toBe(true);
      await expect(readFile(join(agentDir, 'SKILL.md'), 'utf-8')).resolves.toContain(
        'name: remote-skill'
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves blob project skip behavior for non-universal agents without config dirs', async () => {
    const { root, projectDir } = await makeProjectDir();

    try {
      const result = await installBlobSkillForAgent(
        {
          installName: 'blob-skill',
          files: [
            { path: 'SKILL.md', contents: '---\nname: blob-skill\ndescription: test\n---\n' },
          ],
        },
        'claude-code',
        { cwd: projectDir, mode: 'symlink', global: false }
      );

      expect(result.success).toBe(true);
      expect(result.skipped).toBe(true);
      await expect(access(join(projectDir, '.claude'))).rejects.toThrow();
      await expect(
        readFile(join(projectDir, '.agents', 'skills', 'blob-skill', 'SKILL.md'), 'utf-8')
      ).resolves.toContain('name: blob-skill');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes well-known file maps and skips paths outside the skill directory', async () => {
    const { root, projectDir } = await makeProjectDir();
    const skill: WellKnownSkill = {
      ...makeRemoteSkill('well-known-skill'),
      providerId: 'well-known',
      sourceIdentifier: 'wellknown/example.com',
      files: new Map([
        ['SKILL.md', '---\nname: well-known-skill\ndescription: test\n---\n'],
        ['nested/README.md', '# nested\n'],
        ['../escape.txt', 'nope\n'],
      ]),
      indexEntry: {
        name: 'well-known-skill',
        type: 'skill-md',
        description: 'test',
        url: 'https://example.com/SKILL.md',
        digest: 'sha256:test',
      },
    };

    try {
      const result = await installWellKnownSkillForAgent(skill, 'codex', {
        cwd: projectDir,
        mode: 'copy',
        global: false,
      });

      expect(result.success).toBe(true);
      const installDir = join(projectDir, '.agents', 'skills', 'well-known-skill');
      await expect(readFile(join(installDir, 'nested', 'README.md'), 'utf-8')).resolves.toBe(
        '# nested\n'
      );
      await expect(access(join(projectDir, '.agents', 'skills', 'escape.txt'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
