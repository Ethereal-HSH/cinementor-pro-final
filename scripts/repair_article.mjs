const id = String(process.env.ARTICLE_ID || '').trim();
if (!id) {
  console.error('Set ARTICLE_ID env var');
  process.exit(1);
}

const toBool = (v, fallback) => {
  if (v === undefined || v === null || v === '') return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return fallback;
};

const force = toBool(process.env.FORCE, true);
const recrawl = toBool(process.env.RECRAWL, true);

const res = await fetch('http://localhost:3000/api/admin/repair-article', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id, force, recrawl })
});
const text = await res.text();
let payload = null;
try {
  payload = JSON.parse(text);
} catch {
  payload = { raw: text };
}

console.log(JSON.stringify(payload, null, 2));
if (!res.ok || !payload?.success) process.exit(1);
