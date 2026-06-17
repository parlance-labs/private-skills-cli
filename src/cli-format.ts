import { homedir } from 'os';
import { sep } from 'path';

export function shortenPath(
  fullPath: string,
  cwd: string,
  home: string = homedir(),
  pathSep: string = sep
): string {
  if (fullPath === home || fullPath.startsWith(home + pathSep)) {
    return '~' + fullPath.slice(home.length);
  }
  if (fullPath === cwd || fullPath.startsWith(cwd + pathSep)) {
    return '.' + fullPath.slice(cwd.length);
  }
  return fullPath;
}

export function formatList(items: string[], maxShow: number = 5): string {
  if (items.length <= maxShow) {
    return items.join(', ');
  }
  const shown = items.slice(0, maxShow);
  const remaining = items.length - maxShow;
  return `${shown.join(', ')} +${remaining} more`;
}
