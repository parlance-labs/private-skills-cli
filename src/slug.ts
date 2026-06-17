/**
 * Convert a skill identifier (directory name or frontmatter name) to a
 * URL-safe slug. Must match the registry's server-side toSkillSlug() exactly so
 * that the directory basename is a stable, canonical identifier across the CLI,
 * the registry index, and the download API.
 */
export function toSkillSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
