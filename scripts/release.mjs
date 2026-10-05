import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
if (process.platform !== 'win32') throw new Error('Run Windows releases on Windows with Rust MSVC and C++ build tools.');
process.env.VEXOR_API_URL ||= JSON.parse(readFileSync('production.json','utf8')).endpoint;
if (process.env.VEXOR_API_URL && new URL(process.env.VEXOR_API_URL).protocol !== 'https:') throw new Error('Release endpoints must use HTTPS.');
const npm_cli = process.env.npm_execpath;
if (!npm_cli) throw new Error('Run this script using npm run release.');
function npm(args, cwd) {
  const result = spawnSync(process.execPath, [npm_cli,...args], { cwd, stdio:'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
npm(['run','check']);
npm(['test']);
const cargo = spawnSync('cargo',['test','--workspace'],{stdio:'inherit'});
if (cargo.status !== 0) process.exit(cargo.status || 1);
mkdirSync('dist',{recursive:true});
const checksums = [];
for (const name of ['hwid-chk','hwid-admin']) {
  npm(['run','tauri','--','build','--no-bundle'],resolve('apps',name));
  const target = resolve('dist',`${name}.exe`);
  copyFileSync(resolve('target','release',`${name}.exe`),target);
  checksums.push(`${createHash('sha256').update(readFileSync(target)).digest('hex')}  ${name}.exe`);
}
writeFileSync('dist/checksums.txt',checksums.join('\n')+'\n');
console.log('Release executables and SHA-256 checksums are in dist/. Give customers only hwid-chk.exe.');
