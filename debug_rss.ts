
import Parser from 'rss-parser';

const parser = new Parser({
  customFields: {
    item: [
      ['content:encoded', 'contentEncoded'],
      ['content', 'content']
    ]
  }
});

async function check() {
  const sources = [
    { name: 'Aeon', url: 'https://aeon.co/feed.rss' },
    { name: 'CNBC', url: 'https://www.cnbc.com/id/19854910/device/rss/rss.html' }
  ];

  for (const s of sources) {
    try {
      console.log(`Checking ${s.name}...`);
      const feed = await parser.parseURL(s.url);
      const item = feed.items[0];
      if (item) {
        console.log(`[${s.name}] Title: ${item.title}`);
        const c1 = item.contentEncoded || "";
        const c2 = item.content || "";
        const c3 = item.contentSnippet || "";
        console.log(`[${s.name}] contentEncoded len: ${c1.length}`);
        console.log(`[${s.name}] content len: ${c2.length}`);
        console.log(`[${s.name}] snippet len: ${c3.length}`);
        console.log(`[${s.name}] content sample: ${c1.slice(0, 100) || c2.slice(0, 100)}`);
      } else {
        console.log(`[${s.name}] No items found.`);
      }
    } catch (e) {
      console.log(`[${s.name}] Error: ${e.message}`);
    }
  }
}

check();
