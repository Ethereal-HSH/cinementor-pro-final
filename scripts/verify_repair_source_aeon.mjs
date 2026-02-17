const url = 'http://localhost:3000/api/admin/repair-source';

const toBool = (v, fallback) => {
  if (v === undefined || v === null || v === '') return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return fallback;
};

const limit = Math.max(1, parseInt(String(process.env.LIMIT || '50'), 10) || 50);
const force = toBool(process.env.FORCE, false);
const dryRun = toBool(process.env.DRY_RUN, true);
const recrawl = toBool(process.env.RECRAWL, false);
const clean = toBool(process.env.CLEAN, true);

const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ source: 'Aeon Essays', limit, force, dryRun, recrawl, clean })
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
