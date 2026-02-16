const id = String(process.env.ARTICLE_ID || '').trim();
if (!id) {
  console.error('Set ARTICLE_ID env var');
  process.exit(1);
}

const res = await fetch(`http://localhost:3000/api/admin/inspect-article?id=${encodeURIComponent(id)}`);
const text = await res.text();
let payload = null;
try {
  payload = JSON.parse(text);
} catch {
  payload = { raw: text };
}

console.log(JSON.stringify(payload, null, 2));
if (!res.ok || !payload?.success) process.exit(1);

