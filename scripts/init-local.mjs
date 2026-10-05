import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
const file = 'worker/.dev.vars';
if (existsSync(file)) console.log('worker/.dev.vars already exists; preserved.');
else {
  writeFileSync(file,`ENVIRONMENT=development\nHWID_FINGERPRINT_SECRET=${randomBytes(32).toString('hex')}\nDISCORD_WEBHOOK_URL=\n`,{mode:0o600});
  console.log('Created ignored worker/.dev.vars with a random local fingerprint secret.');
}
