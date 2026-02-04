import Parser from 'rss-parser';
import { supabase } from './supabase';

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || "";

const QUOTA = {
  'The Guardian': 2,
  'The Conversation': 2,
  'CNBC Technology': 2,
  'Aeon Essays': 1
};

const TOTAL_LIMIT = 7;

const SOURCES = [
  {
    name: 'The Guardian',
    url: 'https://www.theguardian.com/world/rss',
    logo: 'https://assets.guim.co.uk/images/ezticons/205e4b6c310c83a79493a3d567040441/favicon-32x32.ico'
  },
  {
    name: 'The Conversation',
    url: 'https://theconversation.com/global/articles.atom',
    logo: 'https://cdn.theconversation.com/static/tc/favicon.ico'
  },
  {
    name: 'CNBC Technology',
    url: 'https://www.cnbc.com/id/19854910/device/rss/rss.html',
    logo: 'https://sc.cnbcfm.com/applications/cnbc.com/staticcontent/img/cnbc_logo.gif'
  },
  {
    name: 'Aeon Essays',
    url: 'https://aeon.co/feed.rss',
    logo: 'https://aeon.co/favicon.ico'
  }
];

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  },
  customFields: {
    item: [
      ['link', 'link'],
      ['id', 'id'],
      ['guid', 'guid'],
      ['content', 'content'],
      ['content:encoded', 'contentEncoded']
    ]
  }
});

function sanitizeUrl(u: string) {
  return (u || "").trim().replace(/[)\]]+$/g, "");
}

function selectorFor(url: string, source: string) {
  let host = "";
  try { host = new URL(url).hostname; } catch {}
  if (host.includes('aeon.co')) return 'article';
  if (host.includes('cnbc.com')) return '.ArticleBody, .articleBody, article';
  if (host.includes('theguardian.com')) return '.content__article-body, figure, picture, article';
  if (host.includes('bbc.co')) return 'article';
  if (host.includes('theconversation.com')) return 'article, main';
  return 'article, .article, .article-body, main, .main-content, .content__article-body';
}

function isContentValid(markdown: string, source: string) {
  const base = 1000;
  const need = source === 'Aeon Essays' ? 2000 : base;
  return typeof markdown === 'string' && markdown.length >= need;
}

async function fetchFeedWithSnapshot(url: string) {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const res = await fetch(url, { headers: { 'User-Agent': ua, 'Accept': 'application/xml,text/xml,application/rss+xml' } });
  const body = await res.text().catch(() => '');
  const snap = body.slice(0, 200);
  if (!res.ok) {
    console.log(`[Feed Snapshot] ${url} status=${res.status} ${snap}`);
    throw new Error(`feed fetch failed ${res.status}`);
  }
  console.log(`[Feed Snapshot] ${url} status=${res.status} ${snap}`);
  const feed = await parser.parseString(body);
  return feed;
}

async function fetchRawMarkdown(url: string, selector?: string): Promise<{ markdown: string; title: string }> {
  const clean = sanitizeUrl(url);
  const jinaUrl = `https://r.jina.ai/${clean}`;
  const headersBase: Record<string, string> = {
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  };
  let res = await fetch(jinaUrl, { headers: { ...headersBase, "X-Target-Selector": selector || '' } });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    console.log(`[Jina Snapshot] ${clean} status=${res.status} ${txt.slice(0, 200)}`);
    res = await fetch(jinaUrl, { headers: headersBase });
  }
  if (!res.ok) {
    const txt2 = await res.text().catch(() => '');
    console.log(`[Jina Snapshot] ${clean} status=${res.status} ${txt2.slice(0, 200)}`);
    return { markdown: "", title: "" };
  }
  const body = await res.json().catch(async () => {
    const t = await res.text().catch(() => '');
    console.log(`[Jina NonJSON Snapshot] ${clean} ${t.slice(0, 200)}`);
    return {};
  });
  const data = body.data || body;
  const content = data.content || data.text || "";
  const title = data.title || "";
  const status = (body.status || data.status || "").toString().toLowerCase();
  if (status.includes('error') || /incomplete|navigation menu/i.test(body.message || '')) {
    return { markdown: "", title };
  }
  return { markdown: content, title };
}

async function fetchHtml(url: string) {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const res = await fetch(url, { headers: { 'User-Agent': ua, 'Accept': 'text/html' } });
  const text = await res.text().catch(() => '');
  console.log(`[HTML Snapshot] ${url} status=${res.status} ${text.slice(0, 200)}`);
  if (!res.ok) return '';
  return text;
}

function htmlToMarkdown(html: string) {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  s = s.replace(/<aside[\s\S]*?<\/aside>/gi, '');
  s = s.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  s = s.replace(/data-component=["']share["'][^>]*>[\s\S]*?<\/[^>]+>/gi, '');
  s = s.replace(/data-component=["']following["'][^>]*>[\s\S]*?<\/[^>]+>/gi, '');

  const pickFromSrcset = (srcset: string) => {
    const parts = (srcset || '').split(',').map(p => p.trim()).filter(Boolean);
    let bestUrl = '';
    let bestW = -1;
    for (const part of parts) {
      const segs = part.split(/\s+/);
      const candidate = segs[0] || '';
      const wMatch = part.match(/(\d+)\s*w/);
      const w = wMatch ? parseInt(wMatch[1], 10) : 0;
      if (w >= bestW) {
        bestW = w;
        bestUrl = candidate;
      }
    }
    const url = bestUrl || '';
    if (url.startsWith('//')) return 'https:' + url;
    if (/^https?:\/\//i.test(url)) return url;
    return url ? 'https://' + url.replace(/^\/+/, '') : '';
  };

  s = s.replace(/<picture[\s\S]*?<\/picture>/gi, (m) => {
    const srcsetMatch = m.match(/<source[^>]*srcset=["']([^"']+)["'][^>]*>/i);
    const altMatch = m.match(/<img[^>]*alt=["']?([^"'>]*)["']?[^>]*>/i);
    const src = srcsetMatch ? pickFromSrcset(srcsetMatch[1]) : '';
    const alt = altMatch ? altMatch[1] : '';
    if (!src) return '';
    return `![${alt}](${src})\n\n`;
  });
  s = s.replace(/<figure[\s\S]*?<\/figure>/gi, (m) => {
    const imgMatch = m.match(/<img[^>]*src=["']([^"']+)["'][^>]*alt=["']?([^"'>]*)["']?[^>]*>/i)
      || m.match(/<img[^>]*alt=["']?([^"'>]*)["']?[^>]*src=["']([^"']+)["'][^>]*>/i);
    const srcsetMatch = m.match(/<source[^>]*srcset=["']([^"']+)["'][^>]*>/i);
    const dmvsMatch = m.match(/data-media-viewer-src=["']([^"']+)["']/i);
    let src = '';
    let alt = '';
    if (imgMatch) {
      // imgMatch may be (src,alt) or (alt,src)
      if (imgMatch.length >= 3) {
        const a = imgMatch[1];
        const b = imgMatch[2];
        if (/^https?:|^\/\//.test(a)) {
          src = a;
          alt = b || '';
        } else {
          alt = a || '';
          src = b || '';
        }
      }
    } else if (srcsetMatch) {
      src = pickFromSrcset(srcsetMatch[1]);
      const altM = m.match(/<img[^>]*alt=["']?([^"'>]*)["']?[^>]*>/i);
      alt = altM ? altM[1] : '';
    }
    if (dmvsMatch && !src) {
      src = dmvsMatch[1];
    }
    if (src && src.startsWith('//')) {
      src = 'https:' + src;
    }
    if (src && !/^https?:\/\//i.test(src)) {
      src = 'https://' + src.replace(/^\/+/, '');
    }
    const capMatch = m.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i);
    const cap = capMatch ? capMatch[1] : '';
    if (!src) return '';
    return `![${alt}](${src})\n\n${cap ? `${cap}\n\n` : ''}`;
  });

  s = s.replace(/<img[^>]*alt=["']?([^"'>]*)["']?[^>]*src=["']([^"'>]+)["'][^>]*>/gi, (_m, alt, src) => {
    let url = src || '';
    const dmvs = (_m.match(/data-media-viewer-src=["']([^"']+)["']/i) || [])[1];
    if (dmvs) url = dmvs;
    if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
    return `![${alt || ''}](${url})\n\n`;
  });
  s = s.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_m, t) => `\n# ${t}\n\n`);
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_m, t) => `\n## ${t}\n\n`);
  s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_m, t) => `\n### ${t}\n\n`);
  s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_m, t) => `${t}\n\n`);
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // Guardian 链接容易导致 URL 断行，这里直接保留文本即可
  s = s.replace(/<a[^>]*href=["'][^"'>]+["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, t) => `${t}`);
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

async function domainFallbackMarkdown(url: string) {
  const html = await fetchHtml(url);
  if (!html) return '';
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  let articleHtml = '';
  if (host.includes('theconversation.com')) {
    const m = html.match(/<article[\s\S]*?>[\s\S]*?<\/article>/i);
    articleHtml = m ? m[0] : '';
    if (!articleHtml) {
      const mm = html.match(/<main[\s\S]*?>[\s\S]*?<\/main>/i);
      articleHtml = mm ? mm[0] : '';
    }
  } else if (host.includes('theguardian.com')) {
    const m = html.match(/<div[^>]*class=["'][^"']*content__article-body[^"']*["'][^>]*>[\s\S]*?<\/div>/i);
    articleHtml = m ? m[0] : '';
    if (!articleHtml) {
      const mm = html.match(/<article[\s\S]*?>[\s\S]*?<\/article>/i);
      articleHtml = mm ? mm[0] : '';
    }
  } else if (host.includes('aeon.co')) {
    const m = html.match(/<article[\s\S]*?>[\s\S]*?<\/article>/i);
    articleHtml = m ? m[0] : '';
  }
  if (!articleHtml) return '';
  return htmlToMarkdown(articleHtml);
}

function normalizeMarkdownSource(md: string, source: string) {
  let s = (md || '').replace(/\r/g, '');
  if (source === 'The Guardian') {
    s = s
      .replace(/\[View image in fullscreen\]\(#img-\d+\)/gi, '')
      .replace(/Photograph:\s+[^\n]+/gi, '')
      .replace(/\n\s*#+\s*/g, '\n') // 清理不必要的 # 号
      .replace(/!?\[([^\]]+)\]\(([^)]+)\)/g, (full, txt) => full.startsWith('!') ? full : txt) // 非图片链接保留文字
      .replace(/\n{3,}/g, '\n\n');
    // 去除尾部“跳转/标签”段
    const paras = s.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
    const isFooter = (p: string) => {
      return /Explore more on these topics|Reuse this content|mailto:/i.test(p)
        || /\]\(\/(world|tone|commentisfree|sport|uk-news|us-news)[^)]+\)/i.test(p)
        || /More on (these|this) topics?/i.test(p)
        || /^Tags?:/i.test(p);
    };
    while (paras.length > 0 && isFooter(paras[paras.length - 1])) {
      paras.pop();
    }
    s = paras.join('\n\n');
  }
  return s.trim();
}

export function cleanContent(text: string, url?: string) {
  return text;
}

export async function fetchAndStoreArticles() {
  const report: Record<string, string> = {};
  const allResults: any[] = [];

  for (const source of SOURCES) {
    const quota = QUOTA[source.name as keyof typeof QUOTA] || 0;
    if (quota === 0) continue;
    try {
      const feed = await fetchFeedWithSnapshot(source.url);
      const items = feed.items || [];
      const candidates = items.map(item => {
        let link = (item as any).link;
        if (!link && typeof item === 'object' && 'links' in item) {
          link = (item as any).links?.[0]?.href;
        }
        if (!link) link = (item as any).guid || (item as any).id;
        return { ...item, link: sanitizeUrl(String(link || '')) };
      }).filter(i => i.link && /^https?:\/\//.test(i.link));
      const links = candidates.map(c => c.link);
      const { data: existingData } = await supabase
        .from('articles')
        .select('original_url')
        .in('original_url', links);
      const existingLinks = new Set(existingData?.map(e => e.original_url) || []);
      const newItems = candidates.filter(c => !existingLinks.has(c.link));
      let successCount = 0;
      for (const item of newItems) {
        if (successCount >= quota) break;
        const sel = selectorFor(item.link, source.name);
        let { markdown, title: jinaTitle } = await fetchRawMarkdown(item.link, sel);
        if (!isContentValid(markdown, source.name)) {
          const fb = await domainFallbackMarkdown(item.link);
          markdown = fb;
          if (!isContentValid(markdown, source.name)) {
            continue;
          }
        }
        const title = jinaTitle || (item as any).title || 'Untitled';
        const summaryBase = ((item as any).contentSnippet || (item as any).content || '') as string;
        const summary = summaryBase ? summaryBase.slice(0, 200) : '';
        const published_at = (item as any).isoDate || (item as any).pubDate || new Date().toISOString();
        const { error } = await supabase.from('articles').insert({
          title,
          original_url: item.link,
          source: source.name,
          published_at: new Date(published_at).toISOString(),
          summary,
          content: "",
          raw_markdown: normalizeMarkdownSource(markdown, source.name),
          status: 'unread'
        });
        if (!error) {
          successCount++;
          allResults.push({ title, source: source.name });
        }
      }
      report[source.name] = `${successCount}/${quota}`;
    } catch (e) {
      report[source.name] = `Error`;
    }
  }

  const reportStr = Object.entries(report).map(([k, v]) => `${k}: ${v}`).join(', ');
  console.log(`[Quota Report] ${reportStr} | Total New: ${allResults.length}`);
  return allResults;
}
