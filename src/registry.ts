import { basename, dirname } from 'path';
import { parseFrontmatter } from './frontmatter.ts';
import { sanitizeMetadata } from './sanitize.ts';
import { toSkillSlug } from './slug.ts';
import type { BlobSkill, SkillSnapshotFile } from './blob.ts';
import type { ParsedSource } from './types.ts';

const DEFAULT_REGISTRY_URL = 'https://skills.parlance-labs.com';
const DEFAULT_REGISTRY_SOURCES = ['parlance-labs/private-skills'];

export class RegistryInstallError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'RegistryInstallError';
    this.status = status;
  }
}

interface RegistrySkillRecord {
  id: string;
  skillId: string;
  name: string;
  description: string;
  source: string;
  skillPath?: string;
}

interface RegistrySkillsResponse {
  skills?: RegistrySkillRecord[];
}

interface RegistryDownloadResponse {
  files?: SkillSnapshotFile[];
  hash?: string;
  skill?: RegistrySkillRecord;
}

export interface RegistryInstallResult {
  skills: BlobSkill[];
  registryUrl: string;
}

function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function getRegistryBaseUrl(): string {
  return (
    process.env.SKILLS_REGISTRY_URL ||
    process.env.SKILLS_API_URL ||
    DEFAULT_REGISTRY_URL
  ).replace(/\/+$/, '');
}

export function getRegistryToken(): string | null {
  return process.env.SKILLS_REGISTRY_TOKEN || process.env.SKILLS_API_TOKEN || null;
}

export function getRegistryAuthHeaders(): Record<string, string> {
  const token = getRegistryToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function isRegistryMediatedSource(ownerRepo: string): boolean {
  const source = ownerRepo.toLowerCase();
  const configuredSources = parseList(process.env.SKILLS_REGISTRY_SOURCES);
  const configured = new Set([...DEFAULT_REGISTRY_SOURCES, ...configuredSources]);
  if (configured.has('*') || configured.has(source)) return true;

  // In a managed private-registry environment, fail closed for GitHub sources
  // unless the operator explicitly narrows mediation with SKILLS_REGISTRY_SOURCES.
  if (
    configuredSources.length === 0 &&
    (getRegistryToken() || process.env.SKILLS_REGISTRY_URL || process.env.SKILLS_API_URL)
  ) {
    return true;
  }

  return false;
}

function isTwoPartOwnerRepo(ownerRepo: string): boolean {
  return /^[^/\s]+\/[^/\s]+$/.test(ownerRepo);
}

function isGitHubParsedSource(parsed: ParsedSource): boolean {
  if (parsed.type === 'github') return true;

  if (parsed.url.startsWith('git@github.com:')) return true;

  try {
    const url = new URL(parsed.url);
    return url.hostname === 'github.com';
  } catch {
    return false;
  }
}

export function isRegistryMediatedParsedSource(
  parsed: ParsedSource,
  ownerRepo: string | null
): ownerRepo is string {
  return (
    !!ownerRepo &&
    isTwoPartOwnerRepo(ownerRepo) &&
    isGitHubParsedSource(parsed) &&
    isRegistryMediatedSource(ownerRepo)
  );
}

function requireRegistryToken(ownerRepo: string): string {
  const token = getRegistryToken();
  if (token) return token;
  throw new RegistryInstallError(
    `Registry-mediated install for ${ownerRepo} requires SKILLS_REGISTRY_TOKEN. ` +
      `This source is not cloned directly from GitHub.`
  );
}

async function fetchRegistryJson<T>(path: string, ownerRepo: string): Promise<T> {
  const registryUrl = getRegistryBaseUrl();
  const token = requireRegistryToken(ownerRepo);
  const response = await fetch(`${registryUrl}${path}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.status === 401 || response.status === 403) {
    throw new RegistryInstallError(
      `Registry denied access to ${ownerRepo} (${response.status}). ` +
        `Check SKILLS_REGISTRY_TOKEN and the registry allowlist.`,
      response.status
    );
  }

  if (!response.ok) {
    throw new RegistryInstallError(
      `Registry request failed for ${ownerRepo}: ${response.status} ${response.statusText}`,
      response.status
    );
  }

  return (await response.json()) as T;
}

function subpathSelector(subpath?: string): string | undefined {
  if (!subpath) return undefined;
  const normalized = subpath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return undefined;
  if (basename(normalized).toLowerCase() === 'skill.md') {
    return basename(dirname(normalized));
  }
  return basename(normalized);
}

async function fetchRegistryRecords(
  ownerRepo: string,
  subpath?: string
): Promise<RegistrySkillRecord[]> {
  const data = await fetchRegistryJson<RegistrySkillsResponse>('/api/skills', ownerRepo);
  const source = ownerRepo.toLowerCase();
  const records = (data.skills ?? []).filter((skill) => skill.source?.toLowerCase() === source);

  const selector = subpathSelector(subpath);
  if (!selector) return records;

  const selectorSlug = toSkillSlug(selector);
  const narrowed = records.filter((record) => {
    const skillPath = record.skillPath?.toLowerCase();
    return (
      toSkillSlug(record.skillId) === selectorSlug ||
      (skillPath ? toSkillSlug(basename(dirname(skillPath))) === selectorSlug : false)
    );
  });

  return narrowed;
}

function skillMdContent(files: SkillSnapshotFile[]): string {
  return files.find((file) => file.path.toLowerCase() === 'skill.md')?.contents ?? '';
}

function toBlobSkill(
  record: RegistrySkillRecord,
  download: RegistryDownloadResponse
): BlobSkill | null {
  if (!Array.isArray(download.files) || typeof download.hash !== 'string') return null;

  const effectiveRecord = download.skill ?? record;
  const rawContent = skillMdContent(download.files);
  const data = (rawContent ? parseFrontmatter(rawContent).data : {}) as Record<string, unknown>;
  const metadata = data.metadata as Record<string, unknown> | undefined;
  const name =
    typeof data.name === 'string' && data.name.trim()
      ? sanitizeMetadata(data.name)
      : sanitizeMetadata(effectiveRecord.name);
  const description =
    typeof data.description === 'string' && data.description.trim()
      ? sanitizeMetadata(data.description)
      : sanitizeMetadata(effectiveRecord.description);

  return {
    name,
    description,
    path: effectiveRecord.skillId,
    rawContent,
    metadata,
    files: download.files,
    snapshotHash: download.hash,
    repoPath: effectiveRecord.skillPath ?? 'SKILL.md',
  };
}

export async function fetchRegistryInstall(
  ownerRepo: string,
  options: {
    subpath?: string;
    includeInternal?: boolean;
    skillFilter?: string | string[];
  } = {}
): Promise<RegistryInstallResult> {
  if (!isTwoPartOwnerRepo(ownerRepo)) {
    throw new RegistryInstallError(
      `Registry-mediated install requires a GitHub owner/repo source, got ${ownerRepo}.`
    );
  }

  const records = filterRegistryRecords(
    await fetchRegistryRecords(ownerRepo, options.subpath),
    options.skillFilter
  );
  if (records.length === 0) {
    throw new RegistryInstallError(`No registry skills found for ${ownerRepo}.`);
  }

  const [owner, repo] = ownerRepo.split('/');
  const downloads = await Promise.all(
    records.map(async (record) => {
      const path = [
        '/api/download',
        encodeURIComponent(owner!),
        encodeURIComponent(repo!),
        encodeURIComponent(record.skillId),
      ].join('/');
      const download = await fetchRegistryJson<RegistryDownloadResponse>(path, ownerRepo);
      return toBlobSkill(record, download);
    })
  );

  const skills = downloads.filter((skill): skill is BlobSkill => {
    if (!skill) return false;
    return options.includeInternal || skill.metadata?.internal !== true;
  });

  return { skills, registryUrl: getRegistryBaseUrl() };
}

function filterRegistryRecords(
  records: RegistrySkillRecord[],
  skillFilter?: string | string[]
): RegistrySkillRecord[] {
  const filters = (Array.isArray(skillFilter) ? skillFilter : skillFilter ? [skillFilter] : [])
    .map((s) => s.trim())
    .filter((s) => s && s !== '*');
  if (filters.length === 0) return records;

  const lowerFilters = filters.map((s) => s.toLowerCase());
  const slugFilters = filters.map((s) => toSkillSlug(s));

  return records.filter((record) => {
    const candidates = [
      record.skillId,
      record.name,
      record.skillPath ? basename(dirname(record.skillPath)) : '',
    ].filter(Boolean);

    return candidates.some((candidate) => {
      const lower = candidate.toLowerCase();
      const slug = toSkillSlug(candidate);
      return lowerFilters.includes(lower) || (slug !== '' && slugFilters.includes(slug));
    });
  });
}
