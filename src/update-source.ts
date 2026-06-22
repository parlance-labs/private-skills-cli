import { skillFolderFromMdPath } from './skill-path.ts';

export interface UpdateSourceEntry {
  source: string;
  sourceUrl: string;
  ref?: string;
  skillPath?: string;
}

export interface LocalUpdateSourceEntry {
  source: string;
  ref?: string;
  skillPath?: string;
}

export function formatSourceInput(sourceUrl: string, ref?: string): string {
  if (!ref) {
    return sourceUrl;
  }
  return `${sourceUrl}#${ref}`;
}

/**
 * Whether a skill folder can be safely appended to the given source as a
 * subpath. Only true for sources the source-parser can resolve as a
 * GitHub/GitLab tree URL — owner/repo shorthand or an HTTPS URL on those
 * hosts. Full SSH URLs (`git@host:owner/repo.git`) and generic Git URLs
 * (anything ending in `.git`, or hosts other than github.com/gitlab.com)
 * cannot have a subpath appended without producing an unclonable URL.
 */
function supportsAppendedSubpath(source: string): boolean {
  if (source.startsWith('git@')) return false;
  if (source.endsWith('.git')) return false;
  if (source.startsWith('http://') || source.startsWith('https://')) {
    try {
      const host = new URL(source).hostname;
      return host === 'github.com' || host === 'gitlab.com';
    } catch {
      return false;
    }
  }
  return true;
}

function appendFolderAndRef(source: string, skillPath: string, ref?: string): string {
  if (!supportsAppendedSubpath(source)) {
    return formatSourceInput(source, ref);
  }
  const folder = skillFolderFromMdPath(skillPath);
  const withFolder = folder ? `${source}/${folder}` : source;
  return ref ? `${withFolder}#${ref}` : withFolder;
}

/**
 * Build the source argument for `skills add` during update.
 * Uses shorthand form for path-targeted updates to avoid branch/path ambiguity.
 */
export function buildUpdateInstallSource(entry: UpdateSourceEntry): string {
  if (!entry.skillPath) {
    return formatSourceInput(entry.sourceUrl, entry.ref);
  }
  return appendFolderAndRef(entry.source, entry.skillPath, entry.ref);
}

/**
 * Build the source argument for `skills add` during project-level update.
 * Local lock entries don't carry `sourceUrl`, so we fall back to the bare
 * `source` identifier when no `skillPath` is available.
 */
export function buildLocalUpdateSource(entry: LocalUpdateSourceEntry): string {
  if (!entry.skillPath) {
    return formatSourceInput(entry.source, entry.ref);
  }
  return appendFolderAndRef(entry.source, entry.skillPath, entry.ref);
}
