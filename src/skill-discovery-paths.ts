export const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', '__pycache__'] as const;

export const SKIP_DIR_SET: ReadonlySet<string> = new Set(SKIP_DIRS);

const SKILLS_DIRS = [
  'skills',
  'skills/.curated',
  'skills/.experimental',
  'skills/.system',
] as const;

export const AGENT_PROJECT_SKILL_DIRS = [
  '.agents/skills',
  '.claude/skills',
  '.cline/skills',
  '.codebuddy/skills',
  '.codex/skills',
  '.commandcode/skills',
  '.continue/skills',
  '.github/skills',
  '.goose/skills',
  '.iflow/skills',
  '.junie/skills',
  '.kilocode/skills',
  '.kiro/skills',
  '.mux/skills',
  '.neovate/skills',
  '.opencode/skills',
  '.openhands/skills',
  '.pi/skills',
  '.qoder/skills',
  '.roo/skills',
  '.trae/skills',
  '.windsurf/skills',
  '.zencoder/skills',
] as const;

export const PRIORITY_SKILL_DIRS = ['', ...SKILLS_DIRS, ...AGENT_PROJECT_SKILL_DIRS] as const;

export const PRIORITY_SKILL_PREFIXES = PRIORITY_SKILL_DIRS.map((dir) => (dir ? `${dir}/` : ''));
