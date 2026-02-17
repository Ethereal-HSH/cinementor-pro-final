import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const projectRoot = path.resolve(process.cwd());
const envPath = path.join(projectRoot, '.env.local');

if (!fs.existsSync(envPath)) {
  console.error('Missing .env.local');
  process.exit(1);
}

const content = fs.readFileSync(envPath, 'utf8');
const hasCron = /^\s*CRON_SECRET\s*=\s*.+\s*$/m.test(content);
if (hasCron) {
  console.log('CRON_SECRET already exists in .env.local');
  process.exit(0);
}

const secret = crypto.randomBytes(32).toString('hex');
const next = `${content.replace(/\s*$/g, '')}\nCRON_SECRET=${secret}\n`;
fs.writeFileSync(envPath, next, 'utf8');
console.log('CRON_SECRET added to .env.local');

