const id = String(process.env.ARTICLE_ID || '').trim();
if (!id) {
  console.error('Set ARTICLE_ID env var');
  process.exit(1);
}

const res = await fetch('http://localhost:3000/api/admin/repair-article', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id, force: true, recrawl: true })
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

