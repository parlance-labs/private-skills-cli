import { describe, it, expect } from 'vitest';
import { skillFolderFromMdPath } from './skill-path.ts';

describe('skillFolderFromMdPath', () => {
  it('strips a nested SKILL.md suffix', () => {
    expect(skillFolderFromMdPath('skills/my-skill/SKILL.md')).toBe('skills/my-skill');
  });

  it('normalizes Windows separators', () => {
    expect(skillFolderFromMdPath('skills\\my-skill\\SKILL.md')).toBe('skills/my-skill');
  });

  it('returns empty string for a repo-root SKILL.md', () => {
    expect(skillFolderFromMdPath('SKILL.md')).toBe('');
    expect(skillFolderFromMdPath('/SKILL.md')).toBe('');
  });

  it('is case-insensitive about the SKILL.md basename', () => {
    expect(skillFolderFromMdPath('skills/my-skill/skill.md')).toBe('skills/my-skill');
    expect(skillFolderFromMdPath('skills/my-skill/Skill.MD')).toBe('skills/my-skill');
  });

  it('trims a trailing slash when no SKILL.md suffix is present', () => {
    expect(skillFolderFromMdPath('skills/my-skill/')).toBe('skills/my-skill');
    expect(skillFolderFromMdPath('skills/my-skill')).toBe('skills/my-skill');
  });

  it('handles deep nested catalog layouts', () => {
    expect(skillFolderFromMdPath('skills/category/my-skill/SKILL.md')).toBe(
      'skills/category/my-skill'
    );
  });
});
