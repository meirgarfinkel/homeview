import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Nearest ancestor directory containing pnpm-workspace.yaml (the repo root). */
export function findRepoRoot(
  from = path.dirname(fileURLToPath(import.meta.url)),
): string | undefined {
  let dir = from;
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Load ENV_FILE, or the repo-root .env. Real environment variables win. */
export function loadEnvFile(): void {
  const root = findRepoRoot();
  const file = process.env['ENV_FILE'] ?? (root ? path.join(root, '.env') : undefined);
  if (file && existsSync(file)) process.loadEnvFile(file);
}
