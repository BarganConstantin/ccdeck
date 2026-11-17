// Resolve user-dropped native files; never upload or read their contents.
import { platformName } from './platform';

declare global {
  interface Window { ccdeckFiles?: { paths(files: File[]): unknown } }
}
const safe = (path: unknown): path is string => typeof path === 'string' && path.length > 0
  && path.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(path)
  && (/^\//.test(path) || /^[a-z]:[\\/]/i.test(path) || /^\\\\/.test(path));

export function quoteDroppedPaths(paths: unknown[], platform = platformName()): string | null {
  if (!paths.length || paths.length > 64 || !paths.every(safe)) return null;
  // Native Windows sessions use PowerShell; Unix shells use POSIX quoting.
  const escaped = paths.map(path => `'${/^win/i.test(platform) ? path.replaceAll("'", "''") : path.replaceAll("'", "'\\''")}'`);
  const text = escaped.join(' ') + ' ';
  return text.length <= 65536 ? text : null;
}

export function isFileDrop(data: Pick<DataTransfer, 'types'> | null): boolean {
  return !!data && Array.from(data.types).includes('Files');
}

export function fileDropText(data: Pick<DataTransfer, 'files'>, platform = platformName(),
  resolvePaths = (files: File[]) => window.ccdeckFiles?.paths(files)): string | null {
  try {
    const files = Array.from(data.files);
    if (!files.length || files.length > 64) return null;
    const paths = resolvePaths(files);
    return Array.isArray(paths) && paths.length === files.length ? quoteDroppedPaths(paths, platform) : null;
  } catch { return null; }
}
