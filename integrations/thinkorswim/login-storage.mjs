import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const config = { ...parse(fs.readFileSync(path.join(root, '.env'))), ...process.env };
export const directory = path.resolve(config.TOS_DATA_DIR || path.join(root, 'data/thinkorswim'));
process.umask(0o077);
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
fs.chmodSync(directory, 0o700);
export function save(name, value) {
  const file = path.join(directory, name), temporary = file + '.' + randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}
export function load(name) {
  const file = path.join(directory, name), st = fs.lstatSync(file);
  if (!st.isFile() || (st.mode & 0o077) || st.uid !== process.getuid()) throw new Error('private_file_permissions');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
if (!fs.existsSync(path.join(directory, 'login-key.json'))) save('login-key.json', { key: randomBytes(32).toString('hex') });
export const bridgeKey = load('login-key.json').key;
