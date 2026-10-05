// Provision only missing server secrets and an initial staff account.
// Plaintext credentials are stored in the user's private local profile, never in this repository.
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID, pbkdf2Sync } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, unlinkSync, rmdirSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const cli = resolve('node_modules/wrangler/bin/wrangler.js');
function wrangler(args, json = false) {
  const r = spawnSync(process.execPath,[cli,...args],{cwd:resolve('worker'),encoding:'utf8',windowsHide:true});
  if(r.status !== 0) throw new Error(`Wrangler ${args[0]} failed. ${r.stderr}`);
  if(json) { const start = r.stdout.search(/[\[{]/); return JSON.parse(r.stdout.slice(start)); }
  return r.stdout;
}
const secret_names = wrangler(['secret','list'],true).map(s=>s.name);
const secrets = {};
if(!secret_names.includes('HWID_FINGERPRINT_SECRET')) secrets.HWID_FINGERPRINT_SECRET = randomBytes(32).toString('hex');
// Opaque admin sessions use stored token hashes, so ADMIN_SESSION_SECRET is unnecessary.
let webhook = process.env.DISCORD_WEBHOOK_URL;
if(!webhook && existsSync('worker/.dev.vars')) { const vars = readFileSync('worker/.dev.vars','utf8'); webhook = /^DISCORD_WEBHOOK_URL\s*=\s*["']?([^\r\n"']+)/m.exec(vars)?.[1]; }
if(webhook && /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_.-]+$/.test(webhook) && !secret_names.includes('DISCORD_WEBHOOK_URL')) secrets.DISCORD_WEBHOOK_URL = webhook;
const temporary = mkdtempSync(join(tmpdir(),'vexor-provision-'));
try {
  if(Object.keys(secrets).length) { const file = join(temporary,'secrets.json'); writeFileSync(file,JSON.stringify(secrets)); wrangler(['secret','bulk',file]); unlinkSync(file); }
  console.log('Required Worker secrets configured. Discord: '+(secret_names.includes('DISCORD_WEBHOOK_URL') || secrets.DISCORD_WEBHOOK_URL ? 'configured' : 'optional secret slot, not configured'));
  const admins = wrangler(['d1','execute','hwid-db','--remote','--command','SELECT username FROM admins WHERE enabled = 1','--json'],true)[0].results;
  if(admins.length) { console.log('Existing staff accounts retained.'); process.exit(0); }
  const folder = join(process.env.LOCALAPPDATA,'vexor'); mkdirSync(folder,{recursive:true});
  const protectedPath = join(folder,'staff-credentials.json');
  const username = 'staff', password = randomBytes(24).toString('base64url'), salt = randomBytes(16).toString('hex');
  const password_hash = `pbkdf2-sha256$100000$${salt}$${pbkdf2Sync(password,salt,100000,32,'sha256').toString('hex')}`;
  const sqlPath = join(temporary,'staff.sql');
  writeFileSync(sqlPath,`INSERT INTO admins (id,username,password_hash,created_at) VALUES ('${randomUUID()}','${username}','${password_hash}',${Math.floor(Date.now()/1000)});`);
  // Remove inherited access before putting credentials on disk.
  const acl = spawnSync('icacls.exe',[folder,'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`],{windowsHide:true,encoding:'utf8'});
  if(acl.status !== 0) throw new Error('Unable to restrict staff credential directory permissions.');
  writeFileSync(protectedPath,JSON.stringify({username,password,endpoint:JSON.parse(readFileSync('production.json','utf8')).endpoint},null,2));
  wrangler(['d1','execute','hwid-db','--remote','--file',sqlPath]); unlinkSync(sqlPath);
  console.log('Initial staff login created. Credentials: '+protectedPath);
} finally { for(const name of ['secrets.json','staff.sql']) { const file=join(temporary,name); if(existsSync(file)) unlinkSync(file); } rmdirSync(temporary); }
