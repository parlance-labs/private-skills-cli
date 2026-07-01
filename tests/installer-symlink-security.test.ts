/**
 * Regression tests for CWE-59 symlink dereference prevention.
 * Verifies that copyDirectory (installer.ts) rejects symlinks escaping the
 * source skill directory, handles cycles, and copies safe symlinks correctly.
 */

import { describe, expect, it } from 'vitest';
import {
  access,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installSkillForAgent } from '../src/installer.ts';

async function makeSkillDir(root: string, name: string): Promise<string> {
  const dir = join(root, 'source-skill');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n`, 'utf-8');
  return dir;
}

describe('symlink security (CWE-59)', () => {
  it('skips symlinks escaping the skill directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symlink-sec-'));
    const projectDir = join(root, 'project');
    await mkdir(projectDir, { recursive: true });

    // Create a sensitive file outside the skill
    const secretFile = join(root, 'secret.txt');
    await writeFile(secretFile, 'SECRET_DATA', 'utf-8');

    const skillDir = await makeSkillDir(root, 'leak-skill');
    // Attacker symlink: leak -> ../../secret.txt (escapes skill dir)
    await symlink(secretFile, join(skillDir, 'leak'));

    try {
      const result = await installSkillForAgent(
        { name: 'leak-skill', description: 'test', path: skillDir },
        'codex',
        { cwd: projectDir, mode: 'copy', global: false }
      );

      expect(result.success).toBe(true);

      const installedDir = join(projectDir, '.agents/skills', 'leak-skill');
      // SKILL.md should be copied
      await expect(readFile(join(installedDir, 'SKILL.md'), 'utf-8')).resolves.toContain(
        'leak-skill'
      );
      // The escaping symlink must NOT be present
      await expect(access(join(installedDir, 'leak'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('copies safe symlinks to files within the skill as regular files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symlink-sec-'));
    const projectDir = join(root, 'project');
    await mkdir(projectDir, { recursive: true });

    const skillDir = await makeSkillDir(root, 'safe-link-skill');
    await writeFile(join(skillDir, 'real.txt'), 'REAL_CONTENT', 'utf-8');
    // Safe symlink within skill dir
    await symlink(join(skillDir, 'real.txt'), join(skillDir, 'link.txt'));

    try {
      const result = await installSkillForAgent(
        { name: 'safe-link-skill', description: 'test', path: skillDir },
        'codex',
        { cwd: projectDir, mode: 'copy', global: false }
      );

      expect(result.success).toBe(true);

      const installedDir = join(projectDir, '.agents/skills', 'safe-link-skill');
      // link.txt should exist as a regular file (not a symlink)
      const stats = await lstat(join(installedDir, 'link.txt'));
      expect(stats.isSymbolicLink()).toBe(false);
      expect(stats.isFile()).toBe(true);
      // Contents should match
      await expect(readFile(join(installedDir, 'link.txt'), 'utf-8')).resolves.toBe('REAL_CONTENT');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips nested escaping symlinks inside a symlinked directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symlink-sec-'));
    const projectDir = join(root, 'project');
    await mkdir(projectDir, { recursive: true });

    // Sensitive file
    const secretFile = join(root, 'secret.txt');
    await writeFile(secretFile, 'NESTED_SECRET', 'utf-8');

    const skillDir = await makeSkillDir(root, 'nested-leak-skill');
    // Real subdirectory with an escaping symlink inside
    const subDir = join(skillDir, 'docs');
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, 'readme.txt'), 'README', 'utf-8');
    await symlink(secretFile, join(subDir, 'leak'));

    // Symlink to the subdirectory (still inside skill dir, so it passes containment)
    await symlink(subDir, join(skillDir, 'docs-link'));

    try {
      const result = await installSkillForAgent(
        { name: 'nested-leak-skill', description: 'test', path: skillDir },
        'codex',
        { cwd: projectDir, mode: 'copy', global: false }
      );

      expect(result.success).toBe(true);

      const installedDir = join(projectDir, '.agents/skills', 'nested-leak-skill');
      // docs-link should be copied (as a directory)
      const docsLinkDir = join(installedDir, 'docs-link');
      const stats = await lstat(docsLinkDir);
      expect(stats.isDirectory()).toBe(true);
      // readme.txt should be there
      await expect(readFile(join(docsLinkDir, 'readme.txt'), 'utf-8')).resolves.toBe('README');
      // The nested escaping symlink must NOT be present
      await expect(access(join(docsLinkDir, 'leak'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('copies both symlinks pointing to the same contained directory (diamond)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symlink-sec-'));
    const projectDir = join(root, 'project');
    await mkdir(projectDir, { recursive: true });

    const skillDir = await makeSkillDir(root, 'diamond-skill');
    const subDir = join(skillDir, 'shared');
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, 'data.txt'), 'SHARED_DATA', 'utf-8');

    // Two symlinks pointing to the same contained directory
    await symlink(subDir, join(skillDir, 'link1'));
    await symlink(subDir, join(skillDir, 'link2'));

    try {
      const result = await installSkillForAgent(
        { name: 'diamond-skill', description: 'test', path: skillDir },
        'codex',
        { cwd: projectDir, mode: 'copy', global: false }
      );

      expect(result.success).toBe(true);

      const installedDir = join(projectDir, '.agents/skills', 'diamond-skill');
      // Both links should be copied
      await expect(readFile(join(installedDir, 'link1', 'data.txt'), 'utf-8')).resolves.toBe(
        'SHARED_DATA'
      );
      await expect(readFile(join(installedDir, 'link2', 'data.txt'), 'utf-8')).resolves.toBe(
        'SHARED_DATA'
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('handles symlink cycles without creating deep directory trees', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symlink-sec-'));
    const projectDir = join(root, 'project');
    await mkdir(projectDir, { recursive: true });

    const skillDir = await makeSkillDir(root, 'cycle-skill');
    // loop -> . (self-referencing cycle)
    await symlink('.', join(skillDir, 'loop'));

    try {
      const result = await installSkillForAgent(
        { name: 'cycle-skill', description: 'test', path: skillDir },
        'codex',
        { cwd: projectDir, mode: 'copy', global: false }
      );

      expect(result.success).toBe(true);

      const installedDir = join(projectDir, '.agents/skills', 'cycle-skill');
      await expect(readFile(join(installedDir, 'SKILL.md'), 'utf-8')).resolves.toContain(
        'cycle-skill'
      );

      // loop should either not exist or be a flat directory — no deep nesting
      const entries = await readdir(installedDir);
      expect(entries).not.toContain('loop');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips broken symlinks without failing the install', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symlink-sec-'));
    const projectDir = join(root, 'project');
    await mkdir(projectDir, { recursive: true });

    const skillDir = await makeSkillDir(root, 'broken-skill');
    // Broken symlink pointing to nonexistent target
    await symlink(join(root, 'nonexistent'), join(skillDir, 'broken'));
    await writeFile(join(skillDir, 'good.txt'), 'GOOD', 'utf-8');

    try {
      const result = await installSkillForAgent(
        { name: 'broken-skill', description: 'test', path: skillDir },
        'codex',
        { cwd: projectDir, mode: 'copy', global: false }
      );

      expect(result.success).toBe(true);

      const installedDir = join(projectDir, '.agents/skills', 'broken-skill');
      // good.txt should still be copied
      await expect(readFile(join(installedDir, 'good.txt'), 'utf-8')).resolves.toBe('GOOD');
      // broken symlink should not be present
      await expect(access(join(installedDir, 'broken'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
