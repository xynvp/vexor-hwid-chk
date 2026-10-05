import { randomBytes, pbkdf2Sync, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { writeFileSync, unlinkSync, mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Never pass passwords on the command line or write them into SQL/history.
let muted = false;
const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } });
const prompt = createInterface({ input: process.stdin, output, terminal: true });
try {
  const username = (await prompt.question('Admin username (lowercase): ')).trim();
  if (!/^[a-z0-9_.-]{1,64}$/.test(username)) throw new Error('Invalid username.');
  process.stdout.write('Password (at least 14 characters, hidden): '); muted = true;
  const password = await prompt.question('');
  muted = false; process.stdout.write('\n');
  if (password.length < 14 || password.length > 256 || /[\x00-\x1f\x7f]/.test(password)) throw new Error('Use a password of 14–256 printable characters.');
  const salt = randomBytes(16).toString('hex');
  const hash = `pbkdf2-sha256$100000$${salt}$${pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex')}`;
  const sql = `INSERT INTO admins (id,username,password_hash,created_at) VALUES ('${randomUUID()}','${username}','${hash}',${Math.floor(Date.now()/1000)});`;
  const temp = mkdtempSync(join(tmpdir(), 'hwid-admin-'));
  const file = join(temp, 'admin.sql');
  writeFileSync(file, sql, { mode: 0o600 });
  try {
    const mode = process.argv.includes('--remote') ? '--remote' : '--local';
    const result = spawnSync(process.execPath, ['../node_modules/wrangler/bin/wrangler.js','d1','execute','hwid-db',mode,'--file',file], { cwd: 'worker', stdio: 'inherit' });
    if (result.status !== 0) throw new Error('Admin creation failed. Check D1 configuration and migrations.');
    console.log('Admin created. No credentials were saved in the repository.');
  } finally { unlinkSync(file); rmdirSync(temp); }
} catch (error) { muted = false; console.error(error.message); process.exitCode = 1; }
finally { prompt.close(); }
