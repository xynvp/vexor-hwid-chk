import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
function crc32(b) { let c = 0xffffffff; for (const x of b) { c ^= x; for (let i=0;i<8;i++) c = (c>>>1)^((c&1)?0xedb88320:0); } return (c^0xffffffff)>>>0; }
function chunk(type,data) { const t = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4); length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t,data]))); return Buffer.concat([length,t,data,crc]); }
const n = 256, pixels = Buffer.alloc(n*(1+n*4));
for (let y=0;y<n;y++) for(let x=0;x<n;x++) {
  const offset = y*(1+n*4)+1+x*4;
  const v = y>60 && y<196 && (Math.abs(x-(68+(y-60)*.44))<13 || Math.abs(x-(188-(y-60)*.44))<13);
  pixels.set(v ? [245,245,245,255] : [18,18,20,255],offset);
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n,0); ihdr.writeUInt32BE(n,4); ihdr[8]=8; ihdr[9]=6;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
const ico = Buffer.alloc(22); ico.writeUInt16LE(1,2); ico.writeUInt16LE(1,4); ico.writeUInt16LE(1,10); ico.writeUInt16LE(32,12); ico.writeUInt32LE(png.length,14); ico.writeUInt32LE(22,18);
for (const app of ['hwid-chk','hwid-admin']) { const dir = `apps/${app}/src-tauri/icons`; mkdirSync(dir,{recursive:true}); writeFileSync(`${dir}/icon.ico`,Buffer.concat([ico,png])); writeFileSync(`${dir}/icon.png`,png); }
