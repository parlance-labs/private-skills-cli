import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'fs';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFile: execFileMock,
  };
});

import {
  GitCloneError,
  cloneRepo,
  isGitHubHttpsCloneUrl,
  isGitHubSsoAuthError,
  parseGitHubRepoUrl,
} from './git.ts';

function mockExecFileSuccess(stdout = '', stderr = '') {
  execFileMock.mockImplementationOnce(
    (_file: string, _args: string[], _options: unknown, callback: (...args: unknown[]) => void) => {
      callback(null, stdout, stderr);
    }
  );
}

function mockGitAvailable() {
  mockExecFileSuccess('git version 2.50.0\n');
}

function mockExecFileError(message: string) {
  execFileMock.mockImplementationOnce(
    (_file: string, _args: string[], _options: unknown, callback: (...args: unknown[]) => void) => {
      const error = Object.assign(new Error(message), { code: 1 });
      callback(error, '', message);
    }
  );
}

function mockExecFileMissingGit() {
  execFileMock.mockImplementationOnce(
    (_file: string, _args: string[], _options: unknown, callback: (...args: unknown[]) => void) => {
      const error = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
      callback(error, '', '');
    }
  );
}

function mockExecFileTimeout() {
  execFileMock.mockImplementationOnce(
    (_file: string, _args: string[], _options: unknown, callback: (...args: unknown[]) => void) => {
      const error = Object.assign(new Error('Command failed: git clone'), {
        killed: true,
        signal: 'SIGTERM',
      });
      callback(error, '', '');
    }
  );
}

function expectGitCloneCall(callIndex: number, url: string, tempDir: string, ref?: string) {
  const cloneOptions = ref ? ['--depth', '1', '--branch', ref] : ['--depth', '1'];

  expect(execFileMock).toHaveBeenNthCalledWith(
    callIndex,
    'git',
    [
      '-c',
      'filter.lfs.required=false',
      '-c',
      'filter.lfs.smudge=',
      '-c',
      'filter.lfs.clean=',
      '-c',
      'filter.lfs.process=',
      'clone',
      ...cloneOptions,
      url,
      tempDir,
    ],
    expect.objectContaining({
      env: expect.objectContaining({
        GIT_TERMINAL_PROMPT: '0',
        GIT_LFS_SKIP_SMUDGE: '1',
      }),
    }),
    expect.any(Function)
  );
}

function expectNoGhCalls() {
  expect(execFileMock.mock.calls.some(([file]) => file === 'gh')).toBe(false);
}

describe('git clone fallbacks', () => {
  const createdDirs: string[] = [];

  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses GitHub HTTPS and SSH clone URLs', () => {
    expect(parseGitHubRepoUrl('https://github.com/Giphy/giphy-codex-skills.git')).toEqual({
      owner: 'Giphy',
      repo: 'giphy-codex-skills',
      slug: 'Giphy/giphy-codex-skills',
      sshUrl: 'git@github.com:Giphy/giphy-codex-skills.git',
    });

    expect(parseGitHubRepoUrl('git@github.com:Giphy/giphy-codex-skills.git')).toEqual({
      owner: 'Giphy',
      repo: 'giphy-codex-skills',
      slug: 'Giphy/giphy-codex-skills',
      sshUrl: 'git@github.com:Giphy/giphy-codex-skills.git',
    });
  });

  it('detects GitHub SAML SSO clone failures', () => {
    expect(
      isGitHubSsoAuthError("remote: The 'Giphy' organization has enabled or enforced SAML SSO.")
    ).toBe(true);
    expect(isGitHubSsoAuthError('fatal: Authentication failed')).toBe(false);
  });

  it('only enables automatic auth fallback for GitHub HTTPS clone URLs', () => {
    expect(isGitHubHttpsCloneUrl('https://github.com/Giphy/giphy-codex-skills.git')).toBe(true);
    expect(isGitHubHttpsCloneUrl('http://github.com/Giphy/giphy-codex-skills.git')).toBe(false);
    expect(isGitHubHttpsCloneUrl('git@github.com:Giphy/giphy-codex-skills.git')).toBe(false);
    expect(isGitHubHttpsCloneUrl('https://gitlab.com/Giphy/giphy-codex-skills.git')).toBe(false);
  });

  it('falls back to gh repo clone for GitHub HTTPS auth failures', async () => {
    mockGitAvailable();
    mockExecFileError(
      "remote: The 'Giphy' organization has enabled or enforced SAML SSO.\n" +
        "fatal: unable to access 'https://github.com/Giphy/giphy-codex-skills.git/': The requested URL returned error: 403"
    );
    mockExecFileSuccess('Git operations protocol: https\n');
    mockExecFileSuccess();

    const tempDir = await cloneRepo('https://github.com/Giphy/giphy-codex-skills.git');
    createdDirs.push(tempDir);

    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      'git',
      ['--version'],
      expect.any(Object),
      expect.any(Function)
    );
    expectGitCloneCall(2, 'https://github.com/Giphy/giphy-codex-skills.git', tempDir);
    expect(execFileMock).toHaveBeenNthCalledWith(
      3,
      'gh',
      ['auth', 'status', '-h', 'github.com'],
      expect.any(Object),
      expect.any(Function)
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      4,
      'gh',
      ['repo', 'clone', 'Giphy/giphy-codex-skills', tempDir, '--', '--depth=1'],
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('falls back to SSH when gh clone is unavailable or fails', async () => {
    mockGitAvailable();
    mockExecFileError('fatal: Authentication failed');
    mockExecFileSuccess('Git operations protocol: ssh\n');
    mockExecFileError('gh repo clone failed');
    mockExecFileSuccess();

    const tempDir = await cloneRepo('https://github.com/Giphy/giphy-codex-skills.git');
    createdDirs.push(tempDir);

    expectGitCloneCall(2, 'https://github.com/Giphy/giphy-codex-skills.git', tempDir);
    expectGitCloneCall(5, 'git@github.com:Giphy/giphy-codex-skills.git', tempDir);
    expect(execFileMock.mock.calls[4]?.[2]).toEqual(
      expect.objectContaining({
        env: expect.objectContaining({
          GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
        }),
      })
    );
  });

  it('surfaces a targeted SAML SSO message when all fallbacks fail', async () => {
    mockGitAvailable();
    mockExecFileError(
      "remote: The 'Giphy' organization has enabled or enforced SAML SSO.\n" +
        "fatal: unable to access 'https://github.com/Giphy/giphy-codex-skills.git/': The requested URL returned error: 403"
    );
    mockExecFileError('gh auth unavailable');
    mockExecFileError('Permission denied (publickey).');

    try {
      await cloneRepo('https://github.com/Giphy/giphy-codex-skills.git');
      throw new Error('Expected cloneRepo to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(GitCloneError);
      expect((error as Error).message).toMatch(/SAML SSO/);
      expect((error as Error).message).toMatch(/git@github\.com:Giphy\/giphy-codex-skills\.git/);
    }
  });

  it('does not try gh fallback for GitLab clone URLs', async () => {
    mockGitAvailable();
    mockExecFileError('fatal: unable to access repo: The requested URL returned error: 403');

    await expect(cloneRepo('https://gitlab.com/Giphy/giphy-codex-skills.git')).rejects.toThrow(
      GitCloneError
    );
    expectNoGhCalls();
  });

  it('does not try gh fallback for GitHub SSH clone URLs', async () => {
    mockGitAvailable();
    mockExecFileError('Permission denied (publickey).');

    await expect(cloneRepo('git@github.com:Giphy/giphy-codex-skills.git')).rejects.toThrow(
      GitCloneError
    );
    expectNoGhCalls();
  });

  it('keeps timeout errors actionable when direct git execution times out', async () => {
    mockGitAvailable();
    mockExecFileTimeout();

    await expect(
      cloneRepo('https://github.com/Giphy/giphy-codex-skills.git')
    ).rejects.toMatchObject({
      isTimeout: true,
      isAuthError: false,
      message: expect.stringContaining('Clone timed out after 300s'),
    });
  });

  it('fails with install guidance when git is not available on PATH', async () => {
    mockExecFileMissingGit();

    await expect(
      cloneRepo('https://github.com/Giphy/giphy-codex-skills.git')
    ).rejects.toMatchObject({
      isTimeout: false,
      isAuthError: false,
      message: expect.stringContaining("the 'git' executable was not found on PATH"),
    });

    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
