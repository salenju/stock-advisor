import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function loadConfig() {
  const raw = await readFile(join(__dirname, '..', 'config.json'), 'utf-8');
  return JSON.parse(raw);
}
