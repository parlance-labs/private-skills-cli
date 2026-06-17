/**
 * Blob-based skill download utilities.
 *
 * Enables fast skill installation by fetching pre-built skill snapshots
 * from the skills.sh download API instead of cloning git repos.
 *
 * Flow:
 *   1. GitHub Trees API → discover SKILL.md locations
 *   2. raw.githubusercontent.com → fetch frontmatter to get skill names
 *   3. skills.sh/api/download → fetch full file contents from cached blob
 */

import { parseFrontmatter } from './frontmatter.ts';
import { sanitizeMetadata } from './sanitize.ts';
import { toSkillSlug } from './slug.ts';
import type { Skill } from './types.ts';
import { PRIORITY_SKILL_PREFIXES, SKIP_DIR_SET } from './skill-discovery-paths.ts';

// ─── Types ───

export interface SkillSnapshotFile {
  path: string;
  contents: string;
}

export interface SkillDownloadResponse {
  files: SkillSnapshotFile[];
  hash: string; // skillsComputedHash
}

/**
 * A skill resolved from blob storage, carrying file contents in memory
 * instead of referencing a directory on disk.
 */
export interface BlobSkill extends Skill {
  /** Files from the blob snapshot */
  files: SkillSnapshotFile[];
  /** skillsComputedHash from the blob snapshot */
  snapshotHash: string;
  /** Path of the SKILL.md within the repo (e.g., "skills/react-best-practices/SKILL.md") */
  repoPath: string;
}

// ─── Constants ───

const DOWNLOAD_BASE_URL = process.env.SKILLS_DOWNLOAD_URL || 'https://skills.parlance-labs.com';

// Repos that self-host their downloads on the blob fast-path
export const BLOB_ALLOWED_REPOS: Record<string, { downloadUrl: (slug: string) => string }> = {
  'zapier/connectors': {
    downloadUrl: (slug) =>
      `https://connectors-skills.zapier.com/download/${encodeURIComponent(slug)}/snapshot.json`,
  },
};

/** Timeout for individual HTTP fetches (ms) */
const FETCH_TIMEOUT = 10_000;

// ─── Slug computation ───

// toSkillSlug is shared with skills.ts via ./slug.ts so the directory basename
// is a canonical identifier across the CLI, registry index, and download API.
// Re-exported here for callers that import it from this module.
export { toSkillSlug };

/**
 * Derive a skill's canonical slug from its SKILL.md path. The directory basename
 * is the identifier the registry indexes and the download API is keyed by
 * (e.g. "skills/code-review/SKILL.md" → "code-review"), so the CLI must use it
 * too rather than slugifying the frontmatter name. Falls back to the frontmatter
 * name for a repo-root SKILL.md that has no enclosing folder.
 */
export function skillSlugFromMdPath(mdPath: string, fallbackName: string): string {
  const parts = mdPath.split('/');
  parts.pop(); // drop the trailing SKILL.md
  const folder = parts[parts.length - 1] ?? '';
  return toSkillSlug(folder) || toSkillSlug(fallbackName);
}

// ─── GitHub Trees API ───

export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
}

export interface RepoTree {
  sha: string;
  branch: string;
  tree: TreeEntry[];
  /**
   * GitHub caps recursive tree responses (~100k entries / 7MB) and sets this
   * flag when the listing is incomplete. A truncated tree may be missing
   * SKILL.md paths or folder entries, so callers must not treat it as the
   * authoritative file list (e.g. for deletion detection) and should fall
   * back to a clone where correctness matters.
   */
  truncated: boolean;
}

/**
 * Within-process memo: once we've discovered that the GitHub API has
 * rate-limited this IP, subsequent calls skip straight to the auth fallback
 * instead of burning round trips on requests guaranteed to 403.
 */
let _rateLimitedThisSession = false;

/** For tests only. */
export function resetRepoTreeAuthState(): void {
  _rateLimitedThisSession = false;
}

interface BranchFetchResult {
  tree: RepoTree | null;
  rateLimited: boolean;
}

async function fetchTreeBranch(
  ownerRepo: string,
  branch: string,
  token: string | null
): Promise<BranchFetchResult> {
  try {
    const url = `https://api.github.com/repos/${ownerRepo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'skills-cli',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    if (response.ok) {
      const data = (await response.json()) as {
        sha: string;
        tree: TreeEntry[];
        truncated?: boolean;
      };
      return {
        tree: { sha: data.sha, branch, tree: data.tree, truncated: data.truncated === true },
        rateLimited: false,
      };
    }

    // GitHub signals rate-limit with 403 + X-RateLimit-Remaining: 0.
    // (A bare 403 means permission denied, which is not retryable here.)
    const rateLimited =
      response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0';
    return { tree: null, rateLimited };
  } catch {
    return { tree: null, rateLimited: false };
  }
}

/**
 * Fetch the full recursive tree for a GitHub repo.
 * Returns the tree data including all entries, or null on failure.
 * Tries branches in order: ref (if specified), then main, then master.
 *
 * Authentication is lazy: by default the call goes out unauthenticated,
 * which is enough for the vast majority of users (60 req/hr per IP).
 * Only if GitHub responds with a rate-limit 403 do we ask the optional
 * `getToken` callback for a token and retry. This avoids invoking
 * `gh auth token` on every install, which corporate endpoint security
 * tools flag as suspicious credential extraction. See issue #523.
 */
export async function fetchRepoTree(
  ownerRepo: string,
  ref?: string,
  getToken?: () => string | null
): Promise<RepoTree | null> {
  const branches = ref ? [ref] : ['HEAD', 'main', 'master'];

  // Fast path: once we've seen a rate limit in this process, don't bother
  // retrying unauth on subsequent calls. Go straight to auth.
  if (_rateLimitedThisSession && getToken) {
    const token = getToken();
    if (!token) return null;
    for (const branch of branches) {
      const result = await fetchTreeBranch(ownerRepo, branch, token);
      if (result.tree) return result.tree;
    }
    return null;
  }

  // First pass: unauthenticated.
  for (const branch of branches) {
    const result = await fetchTreeBranch(ownerRepo, branch, null);
    if (result.tree) return result.tree;
    if (result.rateLimited) {
      // All branches share the same rate-limit bucket on this IP, so it's
      // pointless to keep trying other branches in this pass.
      _rateLimitedThisSession = true;
      break;
    }
  }

  // Unauthenticated requests failed (rate-limit, private repo 404/403, or
  // network error). Fall back to authenticated requests when a token
  // resolver is available.
  if (!getToken) return null;

  const token = getToken();
  if (!token) return null;

  for (const branch of branches) {
    const result = await fetchTreeBranch(ownerRepo, branch, token);
    if (result.tree) return result.tree;
  }
  return null;
}

/**
 * Extract the folder hash (tree SHA) for a specific skill path from a repo tree.
 * This replaces the per-skill GitHub API call previously done in fetchSkillFolderHash().
 */
export function getSkillFolderHashFromTree(tree: RepoTree, skillPath: string): string | null {
  let folderPath = skillPath.replace(/\\/g, '/');

  // Remove SKILL.md suffix to get folder path (case-insensitive)
  if (folderPath.toLowerCase().endsWith('/skill.md')) {
    folderPath = folderPath.slice(0, -9);
  } else if (folderPath.toLowerCase().endsWith('skill.md')) {
    folderPath = folderPath.slice(0, -8);
  }
  if (folderPath.endsWith('/')) {
    folderPath = folderPath.slice(0, -1);
  }

  // Root-level skill
  if (!folderPath) {
    return tree.sha;
  }

  const entry = tree.tree.find((e) => e.type === 'tree' && e.path === folderPath);
  return entry?.sha ?? null;
}

// ─── Skill discovery from tree ───

/**
 * Find all SKILL.md file paths in a repo tree.
 * Applies the same priority directory logic as discoverSkills().
 * If subpath is set, only searches within that subtree.
 */
export function findSkillMdPaths(tree: RepoTree, subpath?: string): string[] {
  // Find all blob entries whose basename is exactly SKILL.md (case-insensitive
  // about the casing, but matched on the full basename — not a suffix). Using
  // endsWith('skill.md') here would wrongly match "MYSKILL.md" / "NOT-A-SKILL.md".
  const allSkillMds = tree.tree
    .filter(
      (e) => e.type === 'blob' && (e.path.split('/').pop() ?? '').toLowerCase() === 'skill.md'
    )
    .map((e) => e.path);

  // Apply subpath filter
  const prefix = subpath ? (subpath.endsWith('/') ? subpath : subpath + '/') : '';
  const filtered = prefix
    ? allSkillMds.filter((p) => p.startsWith(prefix) || p === prefix + 'SKILL.md')
    : allSkillMds;

  if (filtered.length === 0) return [];

  // Check priority directories first (same order as discoverSkills).
  // Non-root prefixes also accept depth-2 paths so the blob fast path stays
  // in sync with the on-disk walk's catalog-layout discovery.
  const priorityResults: string[] = [];
  const seen = new Set<string>();
  const lowerSkillMdSet = new Set(filtered.map((p) => p.toLowerCase()));

  for (const priorityPrefix of PRIORITY_SKILL_PREFIXES) {
    const fullPrefix = prefix + priorityPrefix;
    const isContainer = priorityPrefix !== '';

    for (const skillMd of filtered) {
      // Check if this SKILL.md is directly inside the priority dir (one level deep)
      if (!skillMd.startsWith(fullPrefix)) continue;
      const rest = skillMd.slice(fullPrefix.length);

      // Direct SKILL.md in the priority dir (e.g., "skills/SKILL.md")
      if (rest.toLowerCase() === 'skill.md') {
        if (!seen.has(skillMd)) {
          priorityResults.push(skillMd);
          seen.add(skillMd);
        }
        continue;
      }

      // SKILL.md one level deep (e.g., "skills/react-best-practices/SKILL.md")
      const parts = rest.split('/');
      if (parts.length === 2 && parts[1]!.toLowerCase() === 'skill.md') {
        if (!seen.has(skillMd)) {
          priorityResults.push(skillMd);
          seen.add(skillMd);
        }
        continue;
      }

      // SKILL.md two levels deep under a known container prefix
      // (e.g., "skills/<category>/<skill>/SKILL.md"). Skip if the parent
      // child dir already has its own SKILL.md (no descent past), or if
      // any path segment is an ignored directory.
      if (
        isContainer &&
        parts.length === 3 &&
        parts[2]!.toLowerCase() === 'skill.md' &&
        !SKIP_DIR_SET.has(parts[0]!) &&
        !SKIP_DIR_SET.has(parts[1]!)
      ) {
        const parentSkillMd = `${fullPrefix}${parts[0]}/SKILL.md`.toLowerCase();
        if (!lowerSkillMdSet.has(parentSkillMd) && !seen.has(skillMd)) {
          priorityResults.push(skillMd);
          seen.add(skillMd);
        }
      }
    }
  }

  // If we found skills in priority dirs, return those
  if (priorityResults.length > 0) return priorityResults;

  // Fallback: return all SKILL.md files found (limited to 5 levels deep)
  return filtered.filter((p) => {
    const depth = p.split('/').length;
    return depth <= 6; // 5 levels + the SKILL.md file itself
  });
}

// ─── Fetching skill content ───

/**
 * Fetch a single SKILL.md from raw.githubusercontent.com to get frontmatter.
 * Returns the raw content string, or null on failure.
 */
async function fetchSkillMdContent(
  ownerRepo: string,
  branch: string,
  skillMdPath: string
): Promise<string | null> {
  try {
    const url = `https://raw.githubusercontent.com/${ownerRepo}/${branch}/${skillMdPath}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * Fetch a skill's full file contents from the skills.sh download API.
 * Returns the files array and content hash, or null on failure.
 */
async function fetchSkillDownload(
  source: string,
  slug: string
): Promise<SkillDownloadResponse | null> {
  try {
    const [owner, repo] = source.split('/');
    const defaultUrl = `${DOWNLOAD_BASE_URL}/api/download/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}/${encodeURIComponent(slug)}`;
    // Self-hosted repos build their own URL; otherwise fall back to the default.
    const selfHosted = BLOB_ALLOWED_REPOS[source.toLowerCase()]?.downloadUrl(slug);
    const url = selfHosted ?? defaultUrl;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!response.ok) return null;
    return (await response.json()) as SkillDownloadResponse;
  } catch {
    return null;
  }
}

// ─── Main entry point ───

export interface BlobInstallResult {
  skills: BlobSkill[];
  tree: RepoTree;
}

/**
 * Attempt to resolve skills from blob storage instead of cloning.
 *
 * Steps:
 *   1. Fetch repo tree from GitHub Trees API
 *   2. Discover SKILL.md paths from the tree
 *   3. Fetch SKILL.md content from raw.githubusercontent.com (for frontmatter/name)
 *   4. Compute slugs and fetch full snapshots from skills.sh download API
 *
 * Returns the resolved BlobSkills + tree data on success, or null on any failure
 * (the caller should fall back to git clone).
 *
 * @param ownerRepo - e.g., "vercel-labs/agent-skills"
 * @param options - subpath, skillFilter, ref, token
 */
export async function tryBlobInstall(
  ownerRepo: string,
  options: {
    subpath?: string;
    skillFilter?: string;
    ref?: string;
    getToken?: () => string | null;
    includeInternal?: boolean;
  } = {}
): Promise<BlobInstallResult | null> {
  // 1. Fetch the full repo tree
  const tree = await fetchRepoTree(ownerRepo, options.ref, options.getToken);
  if (!tree || tree.truncated) return null;

  // 2. Discover SKILL.md paths in the tree
  let skillMdPaths = findSkillMdPaths(tree, options.subpath);
  if (skillMdPaths.length === 0) return null;

  // 3. If a skill filter is set (owner/repo@skill-name), try to narrow down
  if (options.skillFilter) {
    const filterSlug = toSkillSlug(options.skillFilter);
    const filtered = skillMdPaths.filter((p) => {
      // Match by folder name — e.g., "skills/react-best-practices/SKILL.md"
      const parts = p.split('/');
      if (parts.length < 2) return false;
      const folderName = parts[parts.length - 2]!;
      return toSkillSlug(folderName) === filterSlug;
    });
    if (filtered.length > 0) {
      skillMdPaths = filtered;
    }
    // If no match by folder name, we'll try matching by frontmatter name below
  }

  // 4. Fetch SKILL.md content from raw.githubusercontent.com in parallel
  const mdFetches = await Promise.all(
    skillMdPaths.map(async (mdPath) => {
      const content = await fetchSkillMdContent(ownerRepo, tree.branch, mdPath);
      return { mdPath, content };
    })
  );

  // Parse frontmatter to get skill names
  const parsedSkills: Array<{
    mdPath: string;
    name: string;
    description: string;
    content: string;
    slug: string;
    metadata?: Record<string, unknown>;
  }> = [];

  for (const { mdPath, content } of mdFetches) {
    if (!content) continue;

    const { data } = parseFrontmatter(content);
    if (!data.name || !data.description) continue;
    if (typeof data.name !== 'string' || typeof data.description !== 'string') continue;

    // Skip internal skills unless explicitly requested
    const isInternal = (data.metadata as Record<string, unknown>)?.internal === true;
    if (isInternal && !options.includeInternal) continue;

    const safeName = sanitizeMetadata(data.name);
    const safeDescription = sanitizeMetadata(data.description);

    parsedSkills.push({
      mdPath,
      name: safeName,
      description: safeDescription,
      content,
      slug: skillSlugFromMdPath(mdPath, safeName),
      metadata: data.metadata as Record<string, unknown> | undefined,
    });
  }

  if (parsedSkills.length === 0) return null;

  // Apply skill filter by name if not already filtered by folder name
  let filteredSkills = parsedSkills;
  if (options.skillFilter) {
    const filterSlug = toSkillSlug(options.skillFilter);
    const nameFiltered = parsedSkills.filter((s) => s.slug === filterSlug);
    if (nameFiltered.length > 0) {
      filteredSkills = nameFiltered;
    }
    // If still no match, let the caller fall back to clone where
    // filterSkills() does fuzzy matching
    if (filteredSkills.length === 0) return null;
  }

  // 5. Fetch full snapshots from skills.sh download API in parallel
  const source = ownerRepo.toLowerCase();
  const downloads = await Promise.all(
    filteredSkills.map(async (skill) => {
      const download = await fetchSkillDownload(source, skill.slug);
      return { skill, download };
    })
  );

  // If ANY download failed, fall back to clone — we don't do partial blob installs
  const allSucceeded = downloads.every((d) => d.download !== null);
  if (!allSucceeded) return null;

  // 6. Convert to BlobSkill objects
  const blobSkills: BlobSkill[] = downloads.map(({ skill, download }) => {
    // Compute the folder path from the SKILL.md path (e.g., "skills/react-best-practices")
    const mdPathLower = skill.mdPath.toLowerCase();
    const folderPath = mdPathLower.endsWith('/skill.md')
      ? skill.mdPath.slice(0, -9)
      : mdPathLower === 'skill.md'
        ? ''
        : skill.mdPath.slice(0, -(1 + 'SKILL.md'.length));

    return {
      name: skill.name,
      description: skill.description,
      // BlobSkills don't have a disk path — set to empty string.
      // The installer uses the files array directly.
      path: '',
      rawContent: skill.content,
      metadata: skill.metadata,
      files: download!.files,
      snapshotHash: download!.hash,
      repoPath: skill.mdPath,
    };
  });

  return { skills: blobSkills, tree };
}
