import { chmodSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Set KEY=value lines in a .env file, replacing existing ones and appending
 * new ones. Other lines and comments are left untouched. Writes with mode
 * 0600 since the file holds credentials.
 */

const SAFE_UNQUOTED = /^[\w.@:+\-/]*$/;

export function formatEnvValue(value: string): string {
  if (SAFE_UNQUOTED.test(value)) return value;
  if (/[\n\r]/.test(value)) throw new Error('Values with line breaks are not supported');
  if (!value.includes("'")) return `'${value}'`;
  throw new Error(
    'Values containing both special characters and single quotes must be set by hand',
  );
}

export function setEnvValues(text: string, values: Record<string, string>): string {
  const lines = text.split('\n');
  const pending = new Map(Object.entries(values));
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(lines[i]!);
    const key = match?.[1];
    if (key && pending.has(key)) {
      lines[i] = `${key}=${formatEnvValue(pending.get(key)!)}`;
      pending.delete(key);
    }
  }
  if (pending.size > 0) {
    if (lines.at(-1) === '') lines.pop();
    for (const [key, value] of pending) lines.push(`${key}=${formatEnvValue(value)}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function updateEnvFile(path: string, values: Record<string, string>): void {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // New file.
  }
  writeFileSync(path, setEnvValues(text, values), { mode: 0o600 });
  chmodSync(path, 0o600);
}
