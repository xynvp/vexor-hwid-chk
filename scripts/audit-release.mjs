import { readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const credentials=JSON.parse(readFileSync(join(process.env.LOCALAPPDATA,'vexor','staff-credentials.json'),'utf8'));
const endpoint=JSON.parse(readFileSync('production.json','utf8')).endpoint;
const results=[];
for(const name of ['hwid-chk','hwid-admin']) {
 const b=readFileSync(`dist/${name}.exe`),pe=b.readUInt32LE(0x3c),optional=pe+24,subsystem=b.readUInt16LE(optional+68);
 assert.equal(subsystem,2,'Release uses Windows GUI subsystem, no console');
 assert.ok(b.includes(Buffer.from(endpoint)),'Production backend embedded');
 for(const value of [credentials.password,'discord.com/api/webhooks/']) assert.equal(b.includes(Buffer.from(value)),false,'No credential/webhook value in binary');
 const appjs=readFileSync(`apps/${name}/dist/index.html`,'utf8');assert.equal(appjs.includes('sourceMappingURL'),false);
 results.push({name,bytes:b.length,windows_gui_subsystem:true,production_endpoint_embedded:true,no_staff_password:true,no_webhook_url:true});
}
writeFileSync('test-data/release-audit.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
