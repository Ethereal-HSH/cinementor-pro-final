const url = 'http://localhost:3000/api/admin/repair-source';

const limit = Number.parseInt(process.env.LIMIT || '200', 10) || 200;
const dryRun = (process.env.DRY_RUN || '').trim() === '1';

const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ source: 'Aeon Essays', limit, force: true, dryRun, recrawl: true })
});

const text = await res.text();
let payload = null;
try {
  payload = JSON.parse(text);
} catch {
  payload = { raw: text };
}

if (!res.ok || !payload?.success) {
  console.error('repair-source failed', { status: res.status, payload });
  process.exit(1);
}

console.log(JSON.stringify(payload, null, 2));

