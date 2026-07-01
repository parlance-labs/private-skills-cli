import { join, normalize, resolve, sep } from 'path';
import { mkdtemp, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const DEFAULT_CLONE_TIMEOUT_MS = 300_000; // 5 minutes
const CLONE_TIMEOUT_MS = (() => {
  const raw = process.env.SKILLS_CLONE_TIMEOUT_MS;
  if (!raw) return DEFAULT_CLONE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CLONE_TIMEOUT_MS;
})();
const execFileAsync = promisify(execFile);

interface GitHubRepoInfo {
  owner: string;
  repo: string;
  slug: string;
  sshUrl: string;
}

export class GitCloneError extends Error {
  readonly url: string;
  readonly isTimeout: boolean;
  readonly isAuthError: boolean;

  constructor(message: string, url: string, isTimeout = false, isAuthError = false) {
    super(message);
    this.name = 'GitCloneError';
    this.url = url;
    this.isTimeout = isTimeout;
    this.isAuthError = isAuthError;
  }
}

export function parseGitHubRepoUrl(url: string): GitHubRepoInfo | null {
  const sshMatch = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    const owner = sshMatch[1]!;
    const repo = sshMatch[2]!;
    return {
      owner,
      repo,
      slug: `${owner}/${repo}`,
      sshUrl: `git@github.com:${owner}/${repo}.git`,
    };
  }

  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'github.com') return null;

    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
    if (!match) return null;

    const owner = match[1]!;
    const repo = match[2]!;
    return {
      owner,
      repo,
      slug: `${owner}/${repo}`,
      sshUrl: `git@github.com:${owner}/${repo}.git`,
    };
  } catch {
    return null;
  }
}

export function isGitHubHttpsCloneUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com';
  } catch {
    return false;
  }
}

export function isGitHubSsoAuthError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('saml sso') ||
    lower.includes('enforced sso') ||
    lower.includes('enabled or enforced saml') ||
    lower.includes('re-authorize the oauth application')
  );
}

function isAuthFailure(message: string): boolean {
  return (
    message.includes('Authentication failed') ||
    message.includes('could not read Username') ||
    message.includes('Permission denied') ||
    message.includes('Repository not found') ||
    message.includes('requested URL returned error: 403') ||
    isGitHubSsoAuthError(message)
  );
}

const GIT_LFS_CONFIG = [
  'filter.lfs.required=false',
  'filter.lfs.smudge=',
  'filter.lfs.clean=',
  'filter.lfs.process=',
];

/**
 * Allowed URL schemes for git clone. Rejects dangerous transports
 * like ext:: (arbitrary command execution) and fd:: / file:: (local access).
 */
const ALLOWED_URL_PATTERNS: RegExp[] = [
  /^https:\/\//i,
  /^http:\/\//i,
  /^git:\/\//i,
  /^ssh:\/\//i,
  /^git@[^:-][^:]*:.+/i, // SSH shorthand: git@host:owner/repo (reject dash-leading hosts)
];

/**
 * Validate that a URL is safe to pass to `git clone`.
 * Rejects ext:: (RCE via external transport), file::/fd:: (local access),
 * any other `<transport>::` remote-helper form, and URLs starting with `-`
 * (argument injection).
 */
export function assertSafeGitUrl(url: string): void {
  if (url.startsWith('-')) {
    throw new Error(
      `Refusing to clone: URL starts with '-' which would be interpreted as a git option. ` +
        `Use an absolute URL (e.g. https://...) instead.`
    );
  }

  // Reject any <transport>:: remote-helper scheme (ext::, file::, fd::, etc.)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*::/.test(url)) {
    throw new Error(
      `Refusing to clone: URL uses a git remote-helper transport ('${url.split('::')[0]}::'). ` +
        `Only https://, http://, git://, ssh://, and git@host:path URLs are allowed.`
    );
  }

  const isAllowed = ALLOWED_URL_PATTERNS.some((pattern) => pattern.test(url));
  if (!isAllowed) {
    throw new Error(
      `Refusing to clone: unsupported URL scheme in '${url}'. ` +
        `Only https://, http://, git://, ssh://, and git@host:path URLs are allowed.`
    );
  }

  // For ssh:// URLs, reject dash-leading hostnames (CVE-2017-1000117 class)
  if (/^ssh:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname.startsWith('-')) {
        throw new Error(
          `Refusing to clone: ssh:// URL has a dash-leading hostname '${parsed.hostname}'. ` +
            `This could be used for SSH option injection.`
        );
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Refusing to clone')) throw e;
      // URL parse failure on an already-allowed pattern is fine — git will reject it
    }
  }
}

function gitEnv(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_PROTOCOL_FROM_USER: '0',
    ...extraEnv,
  };
}

function execErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const details = error as Error & {
    killed?: unknown;
    signal?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  const message =
    details.killed === true && details.signal === 'SIGTERM'
      ? `Command timed out after ${Math.round(CLONE_TIMEOUT_MS / 1000)}s: ${error.message}`
      : error.message;
  const output = [details.stderr, details.stdout]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n');

  return output ? `${message}\n${output}` : message;
}

async function ensureGitAvailable(url: string): Promise<void> {
  try {
    await execFileAsync('git', ['--version'], {
      timeout: 5000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new GitCloneError(
        `Git is required to clone repositories, but the 'git' executable was not found on PATH.\n` +
          `  - macOS: install Xcode Command Line Tools with 'xcode-select --install', or install Git with Homebrew\n` +
          `  - Windows: install Git for Windows and enable adding Git to PATH\n` +
          `  - Linux: install Git with your distro package manager, for example 'apt install git' or 'dnf install git'\n` +
          `  - Then verify with: git --version`,
        url,
        false,
        false
      );
    }

    throw error;
  }
}

async function gitClone(
  url: string,
  tempDir: string,
  cloneOptions: string[],
  extraEnv?: NodeJS.ProcessEnv
): Promise<void> {
  // When git-lfs is NOT installed, GIT_LFS_SKIP_SMUDGE has no effect:
  // git sees `filter=lfs` in .gitattributes, tries to run
  // `git-lfs filter-process`, and aborts checkout. Per-clone config disables
  // that filter so skill text files can still be read from the clone.
  const configArgs = [
    ...GIT_LFS_CONFIG.flatMap((config) => ['-c', config]),
    '-c',
    'protocol.ext.allow=never',
    '-c',
    'protocol.fd.allow=never',
    '-c',
    'protocol.file.allow=never',
  ];

  try {
    await execFileAsync('git', [...configArgs, 'clone', ...cloneOptions, '--', url, tempDir], {
      timeout: CLONE_TIMEOUT_MS,
      env: gitEnv(extraEnv),
    });
  } catch (error) {
    throw new Error(execErrorMessage(error));
  }
}

async function resetTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  await mkdir(dir, { recursive: true });
}

async function tryGhClone(repo: GitHubRepoInfo, tempDir: string, ref?: string): Promise<boolean> {
  let cloneTarget = repo.slug;

  try {
    const { stdout, stderr } = await execFileAsync('gh', ['auth', 'status', '-h', 'github.com'], {
      timeout: 5000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const statusOutput = `${stdout}${stderr}`;
    if (/Git operations protocol:\s+ssh/i.test(statusOutput)) {
      cloneTarget = repo.sshUrl;
    }
  } catch {
    return false;
  }

  const gitFlags = ref ? ['--depth=1', '--branch', ref] : ['--depth=1'];
  await execFileAsync('gh', ['repo', 'clone', cloneTarget, tempDir, '--', ...gitFlags], {
    timeout: CLONE_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return true;
}

function buildGitHubAuthError(url: string, repo: GitHubRepoInfo | null, message: string): string {
  if (repo && isGitHubSsoAuthError(message)) {
    return (
      `GitHub blocked HTTPS access to ${url} because the organization enforces SAML SSO.\n` +
      `  skills tried your existing git credentials and available fallbacks, but none succeeded.\n` +
      `  - Re-authorize your GitHub credentials/app for that org's SSO policy\n` +
      `  - Or rerun with SSH: npx skills add ${repo.sshUrl}\n` +
      `  - Verify access with: gh auth status -h github.com or ssh -T git@github.com`
    );
  }

  if (repo) {
    return (
      `Authentication failed for ${url}.\n` +
      `  - For private repos, ensure you have access\n` +
      `  - Retry with SSH: npx skills add ${repo.sshUrl}\n` +
      `  - Check access with: gh auth status -h github.com or ssh -T git@github.com`
    );
  }

  return (
    `Authentication failed for ${url}.\n` +
    `  - For private repos, ensure you have access\n` +
    `  - For SSH: Check your keys with 'ssh -T git@github.com'\n` +
    `  - For HTTPS: Run 'gh auth login' or configure git credentials`
  );
}

export async function cloneRepo(url: string, ref?: string): Promise<string> {
  assertSafeGitUrl(url);
  await ensureGitAvailable(url);

  const tempDir = await mkdtemp(join(tmpdir(), 'skills-'));
  const cloneOptions = ref ? ['--depth', '1', '--branch', ref] : ['--depth', '1'];
  const repo = parseGitHubRepoUrl(url);

  try {
    await gitClone(url, tempDir, cloneOptions);
    return tempDir;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTimeout = errorMessage.includes('block timeout') || errorMessage.includes('timed out');
    const isAuthError = isAuthFailure(errorMessage);

    if (isTimeout) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      const seconds = Math.round(CLONE_TIMEOUT_MS / 1000);
      throw new GitCloneError(
        `Clone timed out after ${seconds}s. Common causes:\n` +
          `  - Large repository: raise the timeout with SKILLS_CLONE_TIMEOUT_MS=600000 (10m)\n` +
          `  - Slow network: retry, or clone manually and pass the local path to 'skills add'\n` +
          `  - Private repo without credentials: ensure auth is configured\n` +
          `      - For SSH: ssh-add -l (to check loaded keys)\n` +
          `      - For HTTPS: gh auth status (if using GitHub CLI)`,
        url,
        true,
        false
      );
    }

    if (isAuthError && repo && isGitHubHttpsCloneUrl(url)) {
      try {
        await resetTempDir(tempDir);
        if (await tryGhClone(repo, tempDir, ref)) {
          return tempDir;
        }
      } catch {
        // Fall through to SSH retry.
      }

      try {
        await resetTempDir(tempDir);
        await gitClone(repo.sshUrl, tempDir, cloneOptions, {
          GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
        });
        return tempDir;
      } catch {
        // Fall through to the targeted auth error below.
      }
    }

    await rm(tempDir, { recursive: true, force: true }).catch(() => {});

    if (isAuthError) {
      throw new GitCloneError(buildGitHubAuthError(url, repo, errorMessage), url, false, true);
    }

    throw new GitCloneError(`Failed to clone ${url}: ${errorMessage}`, url, false, false);
  }
}

export async function cleanupTempDir(dir: string): Promise<void> {
  // Validate that the directory path is within tmpdir to prevent deletion of arbitrary paths
  const normalizedDir = normalize(resolve(dir));
  const normalizedTmpDir = normalize(resolve(tmpdir()));

  if (!normalizedDir.startsWith(normalizedTmpDir + sep) && normalizedDir !== normalizedTmpDir) {
    throw new Error('Attempted to clean up directory outside of temp directory');
  }

  await rm(dir, { recursive: true, force: true });
}
