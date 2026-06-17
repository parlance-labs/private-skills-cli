import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const OWNER_REPO = 'parlance-labs/private-skills';
const TOKEN = 'e2e-token';
const execFileAsync = promisify(execFile);

const root = await mkdtemp(join(tmpdir(), 'skills-local-registry-e2e-'));
const home = join(root, 'home');
const xdgConfigHome = join(root, 'xdg');
const project = join(root, 'project');
await mkdir(home, { recursive: true });
await mkdir(xdgConfigHome, { recursive: true });
await mkdir(project, { recursive: true });

let version = 1;
const requests: string[] = [];
const cleanupDirs: string[] = [];

function skillRecord() {
  return {
    id: `${OWNER_REPO}/code-review`,
    skillId: 'code-review',
    name: 'code-review',
    description: 'Review code carefully',
    source: OWNER_REPO,
    skillPath: 'skills/code-review/SKILL.md',
    installs: 0,
    indexedAt: '2026-06-17T00:00:00.000Z',
    lastCommitDate: '2026-06-17T00:00:00.000Z',
    commitCount: version,
  };
}

function snapshot() {
  return {
    hash: `snapshot-v${version}`,
    skill: skillRecord(),
    files: [
      {
        path: 'SKILL.md',
        contents: `---
name: code-review
description: Review code carefully
---

# Code Review

Use this code review checklist. Version ${version}.
`,
      },
      {
        path: 'guides/checklist.md',
        contents: `# Checklist v${version}

- Correctness
- Security
- Maintainability
`,
      },
    ],
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function isAuthorized(request: IncomingMessage): boolean {
  return request.headers.authorization === `Bearer ${TOKEN}`;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  requests.push(`${request.method ?? 'GET'} ${url.pathname}${url.search}`);

  if (url.pathname === '/api/t') {
    response.writeHead(204);
    response.end();
    return;
  }

  if (!isAuthorized(request)) {
    sendJson(response, 401, { error: 'Unauthorized: invalid CLI token.' });
    return;
  }

  if (url.pathname === '/api/search') {
    const query = (url.searchParams.get('q') ?? '').toLowerCase();
    const skills = query && !'code-review'.includes(query) ? [] : [skillRecord()];
    sendJson(response, 200, { skills, count: skills.length });
    return;
  }

  if (url.pathname === '/api/skills') {
    sendJson(response, 200, { skills: [skillRecord()], count: 1 });
    return;
  }

  if (url.pathname === '/api/download/parlance-labs/private-skills/code-review') {
    sendJson(response, 200, snapshot());
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') {
  throw new Error('Failed to start fake registry');
}

const registryUrl = `http://127.0.0.1:${address.port}`;
const cli = join(import.meta.dirname, '..', 'bin', 'cli.mjs');
const projectLock = join(project, 'skills-lock.json');
if (!existsSync(cli)) {
  throw new Error(`CLI entrypoint not found: ${cli}`);
}

const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: xdgConfigHome,
  SKILLS_REGISTRY_URL: registryUrl,
  SKILLS_REGISTRY_TOKEN: TOKEN,
  SKILLS_TELEMETRY_URL: `${registryUrl}/api/t`,
  DISABLE_TELEMETRY: '1',
  SKILLS_NO_AGENT_DETECT: '1',
};

async function run(args: string[], extraEnv: Record<string, string | undefined> = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], {
      cwd: project,
      env: { ...env, ...extraEnv },
      encoding: 'utf-8',
      timeout: 30_000,
    });
    return { status: 0, stdout, stderr, message: '' };
  } catch (error: any) {
    return {
      status: typeof error.code === 'number' ? error.code : 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
      message: String(error.message ?? error),
    };
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function extractSupportDir(stdout: string): string | undefined {
  const marker = 'Supporting files for this skill were downloaded to:\n';
  return stdout.split(marker)[1]?.split('\n')[0];
}

async function readProjectLock() {
  return JSON.parse(await readFile(projectLock, 'utf-8')) as {
    skills?: Record<string, { source?: string; sourceType?: string; computedHash?: string }>;
  };
}

try {
  const missingToken = await run(['find', 'code'], {
    SKILLS_REGISTRY_TOKEN: '',
    SKILLS_API_TOKEN: '',
  });
  assert(missingToken.status === 1, 'find without a token should fail');
  assert(
    missingToken.stdout.includes('Registry search requires SKILLS_REGISTRY_TOKEN'),
    'find without a token should explain the missing registry token'
  );

  const find = await run(['find', 'code']);
  assert(
    find.status === 0,
    `find failed with status ${find.status}:\n${find.stdout}\n${find.stderr}\n${find.message}\nRequests:\n${requests.join('\n')}`
  );
  assert(find.stdout.includes(`${OWNER_REPO}@code-review`), 'find should list code-review');

  const add = await run([
    'add',
    OWNER_REPO,
    '--skill',
    'code-review',
    '--agent',
    'claude-code',
    '--copy',
    '-y',
  ]);
  assert(add.status === 0, `add failed:\n${add.stdout}\n${add.stderr}`);

  const skillMd = join(project, '.claude', 'skills', 'code-review', 'SKILL.md');
  const checklist = join(project, '.claude', 'skills', 'code-review', 'guides', 'checklist.md');
  assert(existsSync(skillMd), 'add should install SKILL.md into the agent directory');
  assert(existsSync(checklist), 'add should install supporting files into the agent directory');
  assert((await readFile(checklist, 'utf-8')).includes('Checklist v1'), 'add should install v1');
  const lockAfterAdd = await readProjectLock();
  assert(lockAfterAdd.skills?.['code-review']?.source === OWNER_REPO, 'add should lock source');
  assert(
    lockAfterAdd.skills?.['code-review']?.sourceType === 'registry',
    'add should lock registry source type'
  );
  assert(
    lockAfterAdd.skills?.['code-review']?.computedHash === 'snapshot-v1',
    'add should lock the snapshot hash'
  );

  const list = await run(['list', '--agent', 'claude-code']);
  assert(list.status === 0, `list failed:\n${list.stdout}\n${list.stderr}`);
  assert(list.stdout.includes('code-review'), 'list should show code-review');

  const use = await run(['use', `${OWNER_REPO}@code-review`]);
  assert(use.status === 0, `use failed:\n${use.stdout}\n${use.stderr}`);
  assert(use.stdout.includes('Use this code review checklist'), 'use should render skill content');
  const supportDir = extractSupportDir(use.stdout);
  assert(supportDir, 'use should expose a supporting files directory');
  cleanupDirs.push(join(supportDir, '..'));
  assert(
    (await readFile(join(supportDir, 'guides', 'checklist.md'), 'utf-8')).includes('Checklist v1'),
    'use should materialize supporting files'
  );

  version = 2;
  const update = await run(['update', '--project', '-y']);
  assert(update.status === 0, `update failed:\n${update.stdout}\n${update.stderr}`);
  assert(update.stdout.includes('Updated code-review'), 'update should refresh code-review');
  assert((await readFile(checklist, 'utf-8')).includes('Checklist v2'), 'update should install v2');
  const lockAfterUpdate = await readProjectLock();
  assert(
    lockAfterUpdate.skills?.['code-review']?.computedHash === 'snapshot-v2',
    'update should refresh the project lock hash'
  );

  const remove = await run(['remove', 'code-review', '-y']);
  assert(remove.status === 0, `remove failed:\n${remove.stdout}\n${remove.stderr}`);
  assert(!existsSync(skillMd), 'remove should delete the agent skill');
  const lockAfterRemove = await readProjectLock();
  assert(
    lockAfterRemove.skills?.['code-review'] === undefined,
    'remove should delete the project lock entry'
  );

  const listAfterRemove = await run(['list', '--agent', 'claude-code']);
  assert(
    listAfterRemove.stdout.includes('No project skills found'),
    'list after remove should be empty'
  );

  console.log(`Local registry E2E passed (${registryUrl})`);
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  await rm(root, { recursive: true, force: true });
}
