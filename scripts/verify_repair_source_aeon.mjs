const url = 'http://localhost:3000/api/admin/repair-source';

const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ source: 'Aeon Essays', limit: 3, force: true, dryRun: true, recrawl: true })
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

