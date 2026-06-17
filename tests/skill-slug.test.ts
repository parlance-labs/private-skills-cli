/**
 * Unit tests for the canonical skill-slug helpers.
 *
 * The directory basename is the canonical identifier shared across the CLI, the
 * registry index, and the download API. These helpers must agree with the
 * registry's server-side slugging so installs/downloads/telemetry line up.
 */

import { describe, it, expect } from 'vitest';
import { toSkillSlug, skillSlugFromMdPath } from '../src/blob.ts';

describe('toSkillSlug', () => {
  it('lowercases and kebab-cases', () => {
    expect(toSkillSlug('Code Review')).toBe('code-review');
    expect(toSkillSlug('Code_Review')).toBe('code-review');
    expect(toSkillSlug('  My  Skill  ')).toBe('my-skill');
  });

  it('strips non-alphanumeric characters', () => {
    expect(toSkillSlug('C++ Tips!')).toBe('c-tips');
    expect(toSkillSlug('a/b/c')).toBe('abc');
  });

  it('collapses and trims dashes', () => {
    expect(toSkillSlug('--foo--bar--')).toBe('foo-bar');
  });
});

describe('skillSlugFromMdPath', () => {
  it('derives the slug from the enclosing directory, not the frontmatter name', () => {
    expect(skillSlugFromMdPath('skills/code-review/SKILL.md', 'My Cool Skill')).toBe('code-review');
  });

  it('slugifies a non-kebab directory name', () => {
    expect(skillSlugFromMdPath('skills/Code_Review/SKILL.md', 'fallback')).toBe('code-review');
  });

  it('falls back to the frontmatter name for a repo-root SKILL.md', () => {
    expect(skillSlugFromMdPath('SKILL.md', 'My Root Skill')).toBe('my-root-skill');
  });

  it('falls back to the frontmatter name when the path is empty', () => {
    expect(skillSlugFromMdPath('', 'Blob Skill')).toBe('blob-skill');
  });
});
