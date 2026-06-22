/**
 * Derive a skill's folder path from a path that points at (or ends with) its
 * `SKILL.md`. Returns `''` for a repo-root skill (the `SKILL.md` lives at the
 * repository root with no enclosing folder).
 *
 * This is the single source of truth for "strip the SKILL.md suffix to get the
 * folder" logic that several call sites previously re-implemented slightly
 * differently (GitHub tree-hash lookup, update-source URL building, blob
 * conversion). Behavior:
 *   - Backslashes are normalized to forward slashes (Windows lock paths).
 *   - The trailing `SKILL.md` segment is removed case-insensitively, whether or
 *     not it is preceded by a slash.
 *   - A single trailing slash is trimmed.
 *
 * Examples:
 *   "skills/my-skill/SKILL.md" -> "skills/my-skill"
 *   "skills\\my-skill\\SKILL.md" -> "skills/my-skill"
 *   "SKILL.md" -> ""
 *   "/SKILL.md" -> ""
 */
export function skillFolderFromMdPath(skillPath: string): string {
  let folder = skillPath.replace(/\\/g, '/');

  const lower = folder.toLowerCase();
  if (lower.endsWith('/skill.md')) {
    folder = folder.slice(0, -'/skill.md'.length);
  } else if (lower.endsWith('skill.md')) {
    folder = folder.slice(0, -'skill.md'.length);
  }

  if (folder.endsWith('/')) {
    folder = folder.slice(0, -1);
  }

  return folder;
}
