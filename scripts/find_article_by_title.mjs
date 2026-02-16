const titleQuery = String(process.env.TITLE_QUERY || process.argv[2] || '').trim();
if (!titleQuery) {
  console.error('Usage: TITLE_QUERY="..." node scripts/find_article_by_title.mjs');
  process.exit(1);
}

const res = await fetch('http://localhost:3000/api/articles');
if (!res.ok) {
  console.error('Failed to fetch /api/articles', res.status);
  process.exit(1);
}

const data = await res.json().catch(() => ({}));
const articles = Array.isArray(data.articles) ? data.articles : [];

const q = titleQuery.toLowerCase();
const hits = articles.filter(a => String(a?.title || '').toLowerCase().includes(q));

console.log(JSON.stringify({ query: titleQuery, hits }, null, 2));
