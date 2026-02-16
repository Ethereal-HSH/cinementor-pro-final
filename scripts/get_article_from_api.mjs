const id = String(process.env.ARTICLE_ID || '').trim();
if (!id) {
  console.error('Set ARTICLE_ID env var');
  process.exit(1);
}

const res = await fetch('http://localhost:3000/api/articles');
const data = await res.json().catch(() => ({}));
const articles = Array.isArray(data.articles) ? data.articles : [];
const a = articles.find(x => String(x?.id || '') === id) || null;
console.log(JSON.stringify(a, null, 2));

