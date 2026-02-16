import dns from 'node:dns';
import https from 'node:https';
import Parser from 'rss-parser';
import { supabase } from './supabase';

dns.setDefaultResultOrder?.('ipv4first');

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

function decodeUrlEntities(u: string) {
  return (u || '')
    .replace(/&amp;/g, '&')
    .replace(/&#38;/g, '&')
    .replace(/&#x26;/gi, '&');
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
  // Aeon usually has long essays, so keep 2000.
  // But if we extracted via Next.js hack, it might be fragmented, so maybe lower slightly or keep strict?
  // Let's keep 2000 for Aeon to avoid partial crap.
  if (source === 'CNBC Technology') {
    const s = (markdown || '').toString();
    if (s.length < 400) return false;
    if (/403\s+Forbidden|Access\s+Denied|verify\s+you\s+are\s+human|enable\s+javascript/i.test(s)) return false;
    const nlp = (s.match(/\n\n/g) || []).length;
    if (s.length >= 1200) return true;
    return nlp >= 2;
  }
  if (source === 'Aeon Essays') {
    const s = (markdown || '').toString();
    const looksLikeListing = ((s.match(/\b\d+\s+minutes!\[/gi) || []).length >= 5)
      && ((s.match(/^##\s+/gmi) || []).length >= 5)
      && ((s.match(/!\[[^\]]*\]\([^\)]+\)/g) || []).length >= 5);
    if (looksLikeListing) return false;
    const looksLikeVideo = /youtube\.com\/embed\//i.test(s) || /^Embed:\s+https?:\/\//gmi.test(s);
    if (looksLikeVideo) return s.length >= 120;
    return s.length >= 1000;
  }
  return typeof markdown === 'string' && markdown.length >= base;
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function tryGuardianContentApi(url: string) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!u.hostname.includes('theguardian.com')) return null;

  const apiUrl = `https://content.guardianapis.com${u.pathname}?api-key=test&show-fields=bodyText,headline,standfirst,thumbnail`;
  try {
    const res = await fetchWithTimeout(apiUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    }, 15000);
    if (!res.ok) return null;
    const data: any = await res.json().catch(() => null);
    const content = data?.response?.content;
    const fields = content?.fields || {};
    const title = (fields.headline || content?.webTitle || '').toString();
    const bodyText = (fields.bodyText || '').toString();
    if (!bodyText) return null;
    const paras = bodyText
      .replace(/\r/g, '')
      .split(/\n{2,}|\n/)
      .map(s => s.trim())
      .filter(Boolean);
    const standfirst = (fields.standfirst || '').toString().replace(/<[^>]+>/g, '').trim();
    const thumbnail = (fields.thumbnail || '').toString().trim();

    let md = '';
    if (thumbnail) md += `![](${thumbnail})\n\n`;
    if (standfirst) md += `${standfirst}\n\n`;
    md += paras.join('\n\n');
    return { title, markdown: md };
  } catch {
    return null;
  }
}

async function fetchFeedWithSnapshot(url: string) {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  const fetchWithTimeout = async (input: string, init: RequestInit, timeoutMs: number) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  const tryRss2Json = async () => {
    const apiUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}`;
    const apiRes = await fetchWithTimeout(apiUrl, { headers: { 'User-Agent': ua, 'Accept': 'application/json' } }, 15000);
    const data = await apiRes.json().catch(() => ({} as any));
    if (apiRes.ok && data && data.status === 'ok' && Array.isArray(data.items)) {
      const items = data.items.map((it: any) => {
        const description = (it?.description || '').toString();
        const snippet = description.replace(/<[^>]+>/g, '').slice(0, 200);
        return {
          title: (it?.title || '').toString(),
          link: (it?.link || '').toString(),
          guid: (it?.guid || it?.link || '').toString(),
          pubDate: (it?.pubDate || '').toString(),
          isoDate: (it?.pubDate || '').toString(),
          content: (it?.content || it?.description || '').toString(),
          contentEncoded: (it?.content || '').toString(),
          contentSnippet: snippet
        };
      });
      console.log(`[Feed Snapshot] rss2json success for ${url} items=${items.length}`);
      return { items } as any;
    }
    console.log(`[Feed Snapshot] rss2json failed for ${url} status=${apiRes.status}`);
    return null;
  };

  try {
    const feed = await tryRss2Json();
    if (feed) return feed;
  } catch (e) {
    console.log(`[Feed Snapshot] rss2json failed: ${e}`);
  }

  try {
    const feed = await Promise.race([
      parser.parseURL(url),
      new Promise<never>((_r, reject) =>
        setTimeout(() => reject(new Error('feed parseURL timeout')), 15000)
      )
    ]);
    return feed;
  } catch (e) {
    console.log(`[Feed Snapshot] parseURL failed: ${e}`);
  }

  const isLikelyXml = (t: string) => {
    const s = (t || '').trim().replace(/^[\s\ufeff]+/, '');
    if (!s) return false;
    if (!s.startsWith('<')) return false;
    return /<(rss|feed)\b/i.test(s);
  };

  const parseXml = async (xml: string) => {
    const cleaned = (xml || '').trim().replace(/^[\s\ufeff]+/, '');
    return parser.parseString(cleaned);
  };

  let res: Response | undefined;
  try {
    res = await fetchWithTimeout(
      url,
      { headers: { 'User-Agent': ua, 'Accept': 'application/xml,text/xml,application/rss+xml' } },
      15000
    );
  } catch (e) {
    console.log(`[Feed Snapshot] Direct fetch failed: ${e}`);
  }

  if (res?.ok) {
    const body = await res.text().catch(() => '');
    const snap = body.slice(0, 200);
    console.log(`[Feed Snapshot] ${url} status=${res.status} ${snap}`);
    if (isLikelyXml(body)) {
      return await parseXml(body);
    }
  } else {
    console.log(`[Feed Snapshot] Direct fetch status=${res?.status}, trying proxy...`);
  }

  try {
    const rawUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
    const rawRes = await fetchWithTimeout(rawUrl, {}, 15000);
    const rawBody = await rawRes.text().catch(() => '');
    const rawSnap = rawBody.slice(0, 200);
    console.log(`[Feed Snapshot] ${url} proxy=/raw status=${rawRes.status} ${rawSnap}`);
    if (rawRes.ok && isLikelyXml(rawBody)) {
      return await parseXml(rawBody);
    }
  } catch (e) {
    console.log(`[Feed Snapshot] /raw proxy failed: ${e}`);
  }

  try {
    const getUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
    const getRes = await fetchWithTimeout(getUrl, {}, 15000);
    const data = await getRes.json().catch(() => ({} as any));
    const contents =
      (data && typeof data === 'object' && 'contents' in data ? (data as any).contents : '') || '';
    const snap = typeof contents === 'string' ? contents.slice(0, 200) : '';
    console.log(`[Feed Snapshot] ${url} proxy=/get status=${getRes.status} ${snap}`);
    if (getRes.ok && typeof contents === 'string' && isLikelyXml(contents)) {
      return await parseXml(contents);
    }
  } catch (e) {
    console.log(`[Feed Snapshot] /get proxy failed: ${e}`);
  }

  throw new Error('feed fetch failed');
}

async function fetchRawMarkdown(url: string, selector?: string): Promise<{ markdown: string; title: string }> {
  let clean = sanitizeUrl(url);
  try {
    const u = new URL(clean);
    if (u.hostname === 'www.theguardian.com') {
      u.hostname = 'amp.theguardian.com';
      clean = u.toString();
    }
  } catch {}
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
  const looksLikeHtml = (t: string) => /<!doctype\s+html|<html\b/i.test(t || '');
  const timeoutMs = (() => {
    try {
      const host = new URL(url).hostname;
      if (host.includes('theguardian.com')) return 25000;
    } catch {}
    return 15000;
  })();
  const targets: string[] = [url];
  try {
    const u = new URL(url);
    if (u.hostname === 'www.theguardian.com') {
      const amp = new URL(url);
      amp.hostname = 'amp.theguardian.com';
      targets.unshift(amp.toString());
    }
  } catch {}
  const nativeGet = (targetUrl: string, timeoutMs: number, redirectsLeft: number): Promise<{ status: number; text: string }> => {
    return new Promise((resolve, reject) => {
      let u: URL;
      try {
        u = new URL(targetUrl);
      } catch {
        reject(new Error('invalid url'));
        return;
      }
      const req = https.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port ? parseInt(u.port, 10) : undefined,
          path: u.pathname + u.search,
          method: 'GET',
          headers: {
            'User-Agent': ua,
            'Accept': 'text/html',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'identity',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Referer': u.origin + '/'
          },
          timeout: timeoutMs
        },
        (res) => {
          const status = res.statusCode || 0;
          const loc = res.headers.location;
          if (loc && [301, 302, 303, 307, 308].includes(status) && redirectsLeft > 0) {
            res.resume();
            const nextUrl = new URL(loc, targetUrl).toString();
            nativeGet(nextUrl, timeoutMs, redirectsLeft - 1).then(resolve).catch(reject);
            return;
          }
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => resolve({ status, text: data }));
        }
      );
      req.on('timeout', () => {
        req.destroy(new Error('timeout'));
      });
      req.on('error', reject);
      req.end();
    });
  };

  const fetchWithTimeout = async (input: string, init: RequestInit, timeoutMs: number) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  for (const target of targets) {
    try {
      const r = await nativeGet(target, timeoutMs, 4);
      if (r.status >= 200 && r.status < 300 && r.text && looksLikeHtml(r.text)) {
        console.log(`[HTML Snapshot] ${target} status=${r.status} ${r.text.slice(0, 200)}`);
        return r.text;
      }
    } catch (e) {
      console.log(`[HTML Snapshot] Direct fetch failed: ${e}`);
    }

    let res: Response | undefined;
    try {
      res = await fetchWithTimeout(target, { headers: { 'User-Agent': ua, 'Accept': 'text/html' } }, timeoutMs);
    } catch (e) {
      console.log(`[HTML Snapshot] Direct fetch failed: ${e}`);
    }

    if (!res || !res.ok) {
      console.log(`[HTML Snapshot] Direct fetch status=${res?.status}, trying proxy...`);
      const rawProxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`;
      try {
        res = await fetchWithTimeout(rawProxyUrl, {}, timeoutMs);
      } catch (e) {
        console.log(`[HTML Snapshot] Proxy fetch failed: ${e}`);
      }

      if (res && res.ok) {
        const text = await res.text().catch(() => '');
        console.log(`[HTML Snapshot] ${target} proxy=/raw status=${res.status} ${text.slice(0, 200)}`);
        if (text && looksLikeHtml(text)) return text;
      }

      const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(target)}`;
      try {
        res = await fetchWithTimeout(proxyUrl, {}, timeoutMs);
      } catch (e) {
        console.log(`[HTML Snapshot] Proxy fetch failed: ${e}`);
      }
    }

    if (!res) continue;

    const raw = await res.text().catch(() => '');
    let text = raw;
    if (res.ok) {
      const trimmed = (raw || '').trim();
      if (trimmed.startsWith('{') && trimmed.includes('"contents"')) {
        try {
          const data = JSON.parse(trimmed);
          if (data && typeof data === 'object' && typeof (data as any).contents === 'string') {
            text = (data as any).contents;
          }
        } catch {}
      }
    }

    console.log(`[HTML Snapshot] ${target} status=${res.status} ${text.slice(0, 200)}`);
    if (res.ok && text && looksLikeHtml(text)) return text;
  }

  return '';
}

function htmlToMarkdown(html: string) {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<noscript[^>]*>([\s\S]*?)<\/noscript>/gi, (_m, inner) => String(inner || ''));
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
    const url = decodeUrlEntities(bestUrl || '');
    if (url.startsWith('//')) return 'https:' + url;
    if (/^https?:\/\//i.test(url)) return url;
    return url ? 'https://' + url.replace(/^\/+/, '') : '';
  };

  const pickAttr = (tag: string, names: string[]) => {
    const t = tag || '';
    for (const name of names) {
      const m = t.match(new RegExp(`${name}=["']([^"']+)["']`, 'i'));
      if (m?.[1]) return m[1];
    }
    return '';
  };

  // Handle <figure> first, because it might contain <picture> or <img>
  s = s.replace(/<figure[\s\S]*?<\/figure>/gi, (m) => {
    const imgTag = (m.match(/<img[^>]*>/i) || [''])[0];
    const srcsetMatch = m.match(/<source[^>]*srcset=["']([^"']+)["'][^>]*>/i);
    const dmvsMatch = m.match(/data-media-viewer-src=["']([^"']+)["']/i);
    let src = '';
    let alt = '';
    if (imgTag) {
      alt = pickAttr(imgTag, ['alt']);
      src = pickAttr(imgTag, ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-image', 'data-url']);
      if (!src) {
        const ss = pickAttr(imgTag, ['srcset', 'data-srcset']);
        if (ss) src = pickFromSrcset(ss);
      }
    }
    if (!src && srcsetMatch) {
      src = pickFromSrcset(srcsetMatch[1]);
    }
    if (dmvsMatch && !src) src = dmvsMatch[1];
    src = decodeUrlEntities(src);
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

  s = s.replace(/<picture[\s\S]*?<\/picture>/gi, (m) => {
    const srcsetMatch = m.match(/<source[^>]*srcset=["']([^"']+)["'][^>]*>/i);
    const imgTag = (m.match(/<img[^>]*>/i) || [''])[0];
    let src = srcsetMatch ? pickFromSrcset(srcsetMatch[1]) : '';
    if (!src && imgTag) {
      const ss = pickAttr(imgTag, ['srcset', 'data-srcset']);
      if (ss) src = pickFromSrcset(ss);
      if (!src) src = pickAttr(imgTag, ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-image', 'data-url']);
    }
    const alt = imgTag ? pickAttr(imgTag, ['alt']) : '';
    if (!src) return '';
    return `![${alt}](${src})\n\n`;
  });

  s = s.replace(/<img[^>]*alt=["']?([^"'>]*)["']?[^>]*src=["']([^"'>]+)["'][^>]*>/gi, (_m, alt, src) => {
    let url = decodeUrlEntities(src || '');
    const dmvs = (_m.match(/data-media-viewer-src=["']([^"']+)["']/i) || [])[1];
    if (dmvs) url = decodeUrlEntities(dmvs);
    if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
    return `![${alt || ''}](${url})\n\n`;
  });
  s = s.replace(/<img[^>]*>/gi, (m) => {
    const alt = pickAttr(m, ['alt']);
    let src = pickAttr(m, ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-image', 'data-url']);
    if (!src) {
      const ss = pickAttr(m, ['srcset', 'data-srcset']);
      if (ss) src = pickFromSrcset(ss);
    }
    if (!src) return '';
    let url = decodeUrlEntities(src || '');
    const dmvs = (m.match(/data-media-viewer-src=["']([^"']+)["']/i) || [])[1];
    if (dmvs) url = decodeUrlEntities(dmvs);
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

function extractAeonContent(html: string) {
  // Try standard article extraction first
  const m = html.match(/<article[\s\S]*?>[\s\S]*?<\/article>/i);
  if (m) {
    const articleHtml = String(m[0] || '').replace(/<noscript[^>]*>([\s\S]*?)<\/noscript>/gi, (_m, inner) => String(inner || ''));
    return htmlToMarkdown(articleHtml);
  }

  // Fallback to extracting from Next.js hydration data
  const scripts = html.match(/<script[^>]*>self\.__next_f\.push\(\[1,[\s\S]*?\]\)<\/script>/g);
  if (!scripts) return '';
  
  const textParts: string[] = [];
  // Regex to capture "children":"TEXT" pattern, avoiding nested structures/props
  // This is a heuristic and might need adjustment
  const regex = /"children":"((?:[^"\\]|\\.)*)"/g;
  
  for (const script of scripts) {
     let match;
     while ((match = regex.exec(script)) !== null) {
       // Filter out obvious non-content
       const t = match[1];
       if (t.length > 50 && !t.includes('http') && !t.includes('{')) {
         // Unescape JSON string quotes
         textParts.push(t.replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
       }
     }
  }
  
  if (textParts.length === 0) return '';
  return textParts.join('\n\n');
}

function extractVideoObjectFromLdJson(html: string) {
  const scripts = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  const extractJson = (scriptTag: string) => {
    const m = scriptTag.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
    return (m?.[1] || '').trim();
  };
  const findVideoObject = (v: any): any => {
    if (!v) return null;
    if (Array.isArray(v)) {
      for (const it of v) {
        const r = findVideoObject(it);
        if (r) return r;
      }
      return null;
    }
    if (typeof v === 'object') {
      if ((v as any)['@type'] === 'VideoObject') return v;
      if ((v as any)['@graph']) return findVideoObject((v as any)['@graph']);
    }
    return null;
  };
  for (const tag of scripts) {
    const jsonText = extractJson(tag);
    if (!jsonText) continue;
    try {
      const data = JSON.parse(jsonText);
      const vo = findVideoObject(data);
      if (vo) return vo;
    } catch {}
  }
  return null;
}

function aeonVideoMarkdownFromVideoObject(vo: any) {
  const title = String(vo?.name || '').trim();
  const desc = String(vo?.description || '').trim();
  const duration = String(vo?.duration || '').trim();
  const embedUrl = String(vo?.embedUrl || '').trim();
  const safeEmbedUrl = embedUrl.replace('://www.youtube.com/embed/', '://www.youtube-nocookie.com/embed/');
  const videoId = (() => {
    const m = safeEmbedUrl.match(/\/embed\/([^?&#/]+)/i);
    return m?.[1] || '';
  })();
  const watchUrl = videoId ? `https://youtu.be/${videoId}` : '';
  const thumb = Array.isArray(vo?.thumbnailUrl) ? String(vo.thumbnailUrl[0] || '') : String(vo?.thumbnailUrl || '');

  const parts: string[] = [];
  if (title) parts.push(`## ${title}`);
  if (desc) parts.push(desc);
  if (thumb) parts.push(`![](${thumb})`);
  if (duration) parts.push(`Duration: ${duration}`);
  if (safeEmbedUrl) parts.push(`Embed: ${safeEmbedUrl}`);
  if (watchUrl) parts.push(`Watch: ${watchUrl}`);
  return parts.filter(Boolean).join('\n\n').trim();
}

async function tryYoutubeTranscript(videoId: string) {
  const id = String(videoId || '').trim();
  if (!id) return '';
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const urls = [
    `https://www.youtube.com/api/timedtext?fmt=vtt&lang=en&v=${encodeURIComponent(id)}`,
    `https://www.youtube.com/api/timedtext?fmt=vtt&lang=en&kind=asr&v=${encodeURIComponent(id)}`,
  ];

  for (const u of urls) {
    try {
      const res = await fetchWithTimeout(u, { headers: { 'User-Agent': ua, 'Accept': 'text/vtt,text/plain;q=0.9,*/*;q=0.1' } }, 12000);
      if (!res.ok) continue;
      const text = await res.text().catch(() => '');
      const t = String(text || '').trim();
      if (!t) continue;
      if (/sign\s+in|confirm\s+your\s+age|consent\.youtube\.com/i.test(t)) continue;
      if (/^<transcript\/>\s*$/i.test(t)) continue;
      if (!/WEBVTT/i.test(t) && t.length < 80) continue;
      return t;
    } catch {
      continue;
    }
  }
  return '';
}

function vttToPlainText(vtt: string) {
  const lines = String(vtt || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(l => l.trim());
  const out: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    if (/^WEBVTT/i.test(line)) continue;
    if (/^\d+$/.test(line)) continue;
    if (/^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/.test(line)) continue;
    if (/^NOTE\b/i.test(line)) continue;
    const cleaned = line.replace(/<[^>]+>/g, '').trim();
    if (cleaned) out.push(cleaned);
  }
  const merged = out.join(' ').replace(/\s+/g, ' ').trim();
  if (!merged) return '';
  const chunks: string[] = [];
  let buf = '';
  for (const part of merged.split(/(?<=[.!?])\s+/)) {
    const p = part.trim();
    if (!p) continue;
    const next = buf ? `${buf} ${p}` : p;
    if (next.length >= 520) {
      if (buf.trim()) chunks.push(buf.trim());
      buf = p;
      continue;
    }
    buf = next;
    if (buf.length >= 260 && /[.!?]$/.test(buf)) {
      chunks.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.join('\n\n').trim();
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
    const ldScripts = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
    const extractArticleBody = (v: any): string => {
      if (!v) return '';
      if (Array.isArray(v)) {
        for (const it of v) {
          const r = extractArticleBody(it);
          if (r) return r;
        }
        return '';
      }
      if (typeof v === 'object') {
        if (typeof (v as any).articleBody === 'string' && (v as any).articleBody.trim()) return (v as any).articleBody;
        if ((v as any)['@graph']) return extractArticleBody((v as any)['@graph']);
        for (const key of Object.keys(v)) {
          const r = extractArticleBody((v as any)[key]);
          if (r) return r;
        }
      }
      return '';
    };
    for (const s of ldScripts) {
      const m = s.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
      const jsonText = (m?.[1] || '').trim();
      if (!jsonText) continue;
      try {
        const data = JSON.parse(jsonText);
        const body = extractArticleBody(data);
        if (body) {
          return body
            .replace(/\r/g, '')
            .split(/\n{2,}|\n+/)
            .map(p => p.trim())
            .filter(Boolean)
            .join('\n\n');
        }
      } catch {}
    }

    const m = html.match(/<div[^>]*class=["'][^"']*content__article-body[^"']*["'][^>]*>[\s\S]*?<\/div>/i);
    articleHtml = m ? m[0] : '';
    if (!articleHtml) {
      const mm = html.match(/<article[\s\S]*?>[\s\S]*?<\/article>/i);
      articleHtml = mm ? mm[0] : '';
    }
  } else if (host.includes('aeon.co')) {
    const content = extractAeonContent(html);
    if (content) return content;
    const m = html.match(/<article[\s\S]*?>[\s\S]*?<\/article>/i);
    articleHtml = m ? m[0] : '';
  } else if (host.includes('cnbc.com')) {
    const extractNextDataCandidate = () => {
      const m = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
      const jsonText = (m?.[1] || '').trim();
      if (!jsonText) return '';
      try {
        const data = JSON.parse(jsonText);

        const candidates: string[] = [];
        const walk = (v: any, path: string) => {
          if (!v) return;
          if (typeof v === 'string') {
            const s = v;
            if (s.length > 800 && /<p\b/i.test(s)) {
              candidates.push(s);
              return;
            }
            if (s.length > 1500 && (/(\n\n)|\n/.test(s) || /<br\b/i.test(s))) {
              candidates.push(s);
              return;
            }
            return;
          }
          if (Array.isArray(v)) {
            for (let i = 0; i < v.length; i++) walk(v[i], `${path}[${i}]`);
            return;
          }
          if (typeof v === 'object') {
            for (const k of Object.keys(v)) {
              const nextPath = path ? `${path}.${k}` : k;
              walk((v as any)[k], nextPath);
            }
          }
        };

        walk(data, '');
        if (candidates.length === 0) return '';
        candidates.sort((a, b) => b.length - a.length);
        return candidates[0];
      } catch {
        return '';
      }
    };

    const ldScripts = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
    const extractArticleBody = (v: any): string => {
      if (!v) return '';
      if (Array.isArray(v)) {
        for (const it of v) {
          const r = extractArticleBody(it);
          if (r) return r;
        }
        return '';
      }
      if (typeof v === 'object') {
        if (typeof (v as any).articleBody === 'string' && (v as any).articleBody.trim()) return (v as any).articleBody;
        if ((v as any)['@graph']) return extractArticleBody((v as any)['@graph']);
        for (const key of Object.keys(v)) {
          const r = extractArticleBody((v as any)[key]);
          if (r) return r;
        }
      }
      return '';
    };
    for (const s of ldScripts) {
      const m = s.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
      const jsonText = (m?.[1] || '').trim();
      if (!jsonText) continue;
      try {
        const data = JSON.parse(jsonText);
        const body = extractArticleBody(data);
        if (body) {
          return body
            .replace(/\r/g, '')
            .split(/\n{2,}|\n+/)
            .map(p => p.trim())
            .filter(Boolean)
            .join('\n\n');
        }
      } catch {}
    }

    const nextCandidate = extractNextDataCandidate();
    if (nextCandidate) {
      const md = htmlToMarkdown(nextCandidate);
      if (md && md.trim().length > 800) return md;
    }

    const m = html.match(/<div[^>]*class=["'][^"']*ArticleBody-articleBody[^"']*["'][^>]*>[\s\S]*?<\/div>/i);
    articleHtml = m ? m[0] : '';
    if (!articleHtml) {
      const mm = html.match(/<div[^>]*class=["'][^"']*Group-container[^"']*["'][^>]*>[\s\S]*?<\/div>/i);
      articleHtml = mm ? mm[0] : '';
    }
  }
  
  // Universal fallback: if specific extraction failed (empty or too short), try to use the full body
  // but strip common noise first.
  if (!articleHtml || articleHtml.length < 500) {
      console.log(`[${host}] Specific extraction failed (len=${articleHtml.length}), using full body fallback.`);
      // Remove header, footer, nav, aside before converting
      let cleanHtml = html;
      cleanHtml = cleanHtml.replace(/<header[\s\S]*?<\/header>/gi, '');
      cleanHtml = cleanHtml.replace(/<footer[\s\S]*?<\/footer>/gi, '');
      cleanHtml = cleanHtml.replace(/<nav[\s\S]*?<\/nav>/gi, '');
      cleanHtml = cleanHtml.replace(/<aside[\s\S]*?<\/aside>/gi, '');
      articleHtml = cleanHtml;
  }

  if (!articleHtml) return '';
  return htmlToMarkdown(articleHtml);
}

function normalizeMarkdownSource(md: string, source: string) {
  let s = (md || '').replace(/\r/g, '');
  const fixUtf8Mojibake = (input: string) => {
    const raw = input || '';
    if (!/[ÃÂâ]/.test(raw)) return raw;
    try {
      const bytes = Uint8Array.from(Array.from(raw, ch => ch.charCodeAt(0) & 0xff));
      const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      if (!decoded) return raw;
      if (decoded.includes('\uFFFD')) return raw;
      const badBefore = (raw.match(/[ÃÂâ]/g) || []).length;
      const badAfter = (decoded.match(/[ÃÂâ]/g) || []).length;
      if (badAfter <= badBefore) return decoded;
      return raw;
    } catch {
      return raw;
    }
  };

  const ensureParagraphBreaks = (input: string) => {
    let t = (input || '').replace(/\r/g, '').trim();
    if (!t) return '';
    if (!t.includes('\n') && t.includes('\\n')) t = t.replace(/\\r/g, '').replace(/\\n/g, '\n');
    t = t.replace(/\n{3,}/g, '\n\n').trim();
    const nlp = (t.match(/\n\n/g) || []).length;
    if (t.length < 2500) return t;
    if (nlp >= 4) return t;

    const splitSentences = (text: string) => {
      const out: string[] = [];
      const re = /[^.!?\n]+[.!?]+(?:\s+|$)|[^\n]+(?:\n+|$)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const seg = String(m[0] || '').trim();
        if (!seg) continue;
        out.push(seg);
      }
      return out.length ? out : [text];
    };

    const chunks: string[] = [];
    let cur = '';
    const pushCur = () => {
      const v = cur.trim();
      if (v) chunks.push(v);
      cur = '';
    };

    const parts = t.includes('\n') ? t.split(/\n+/).map(x => x.trim()).filter(Boolean) : splitSentences(t);
    for (const part of parts) {
      const next = cur ? `${cur} ${part}` : part;
      if (next.length >= 520) {
        pushCur();
        cur = part;
        continue;
      }
      cur = next;
      if (/[.!?]\s*$/.test(cur) && cur.length >= 220) {
        pushCur();
      }
    }
    pushCur();

    if (chunks.length <= 1) return t;
    return chunks.join('\n\n').trim();
  };
  const fixSmartPunctuationArtifacts = (input: string) => {
    let s = input || '';
    s = s.replace(/[\u200b\u00a0\u00ad\ufeff]/g, '');
    s = s
      .replace(/\u00c2\s/g, ' ')
      .replace(/\u00c2/g, '')
      .replace(/\u00e2\u20ac\u2122/g, '’')
      .replace(/\u00e2\u0080\u0099/g, '’')
      .replace(/\u00e2\u20ac\u02dc/g, '‘')
      .replace(/\u00e2\u0080\u0098/g, '‘')
      .replace(/\u00e2\u20ac\u0153/g, '“')
      .replace(/\u00e2\u0080\u009c/g, '“')
      .replace(/\u00e2\u20ac\u009d/g, '”')
      .replace(/\u00e2\u0080\u009d/g, '”')
      .replace(/\u00e2\u20ac\u2013/g, '–')
      .replace(/\u00e2\u0080\u0093/g, '–')
      .replace(/\u00e2\u20ac\u2014/g, '—')
      .replace(/\u00e2\u0080\u0094/g, '—')
      .replace(/\u00e2\u20ac\u2026/g, '…')
      .replace(/\u00e2\u0080\u00a6/g, '…')
      .replace(/\u00e2\u20ac\u2022/g, '•')
      .replace(/\u00e2\u0080\u00a2/g, '•')
      .replace(/\u00e2\u201e\u00a2/g, '™')
      .replace(/\u00e2\u0084\u00a2/g, '™');

    s = s.replace(/[\u0080-\u009f]/g, '');

    s = s
      .replace(/([A-Za-z])\u00e2[\u200b\u00a0\u00ad\ufeff]*s\b/g, "$1’s")
      .replace(/([A-Za-z])\u00e2[\u0080-\u009f\u200b\u00a0\u00ad\ufeff]*s\b/g, "$1’s")
      .replace(/([A-Za-z]s)\u00e2[\u200b\u00a0\u00ad\ufeff]*\s/g, "$1’ ")
      .replace(/([A-Za-z]s)\u00e2[\u0080-\u009f\u200b\u00a0\u00ad\ufeff]*\s/g, "$1’ ")
      .replace(/n\u00e2t\b/gi, "n’t")
      .replace(/n\u00e2[\u0080-\u009f]*t\b/gi, "n’t")
      .replace(/I\u00e2m\b/g, "I’m")
      .replace(/I\u00e2[\u0080-\u009f]*m\b/g, "I’m")
      .replace(/we\u00e2re\b/gi, "we’re")
      .replace(/you\u00e2re\b/gi, "you’re")
      .replace(/they\u00e2re\b/gi, "they’re")
      .replace(/it\u00e2s\b/gi, "it’s")
      .replace(/that\u00e2s\b/gi, "that’s")
      .replace(/there\u00e2s\b/gi, "there’s");
    return s;
  };

  s = fixSmartPunctuationArtifacts(fixUtf8Mojibake(s));
  if (source === 'Aeon Essays') {
    s = s
      .replace(/\n\s*#{4,}[^\n]*\n/gi, '\n')
      .replace(/^\s*Skip\s+to\s+content\s*$/gmi, '')
      .replace(/^\s*Share\s+(this|on)\s+.*$/gmi, '')
      .replace(/^\s*(Facebook|Twitter|Email|LinkedIn)\s*$/gmi, '')
      .replace(/^\s*(Read\s+more|Further\s+reading|Related\s+articles|More\s+from\s+Aeon)\s*:?\s*$/gmi, '')
      .replace(/\n{3,}/g, '\n\n');

    const paras = s.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
    const isFooter = (p: string) => {
      const x = p.replace(/\s+/g, ' ').trim();
      if (!x) return true;
      if (/^Support\s+Aeon/i.test(x)) return true;
      if (/Aeon\s+is\s+(a|an)\s+(registered\s+)?charity/i.test(x)) return true;
      if (/Copyright\s+.*Aeon/i.test(x)) return true;
      if (/^Published\s+on\s+/i.test(x)) return true;
      if (/^By\s+[A-Z]/.test(x) && x.length < 80) return false;
      if (/^Sign\s+up\s+to\s+/i.test(x)) return true;
      if (/^Subscribe\s+/i.test(x)) return true;
      if (/^Newsletter\s*$/i.test(x)) return true;
      if (/^Tags?:/i.test(x)) return true;
      if (/^Topics?:/i.test(x)) return true;
      if (/^Related:/i.test(x)) return true;
      if (/^Read\s+more\s+at\s+aeon\.co/i.test(x)) return true;
      return false;
    };
    while (paras.length > 0 && isFooter(paras[paras.length - 1])) paras.pop();

    const dedup = new Set<string>();
    const unique: string[] = [];
    for (const p of paras) {
      const key = p.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!key) continue;
      if (dedup.has(key)) continue;
      dedup.add(key);
      unique.push(p);
    }
    s = ensureParagraphBreaks(fixSmartPunctuationArtifacts(fixUtf8Mojibake(unique.join('\n\n'))));
  }
  if (source === 'The Guardian') {
    s = s
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/\u2026/g, '...');

    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => {
      const u = decodeUrlEntities(String(url || '').trim());
      return `![${alt || ''}](${u})`;
    });
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
        || /^Tags?:/i.test(p)
        || /^Related:/i.test(p)
        || /^This article was amended/i.test(p)
        || /^First published on/i.test(p)
        || /^Sign up to /i.test(p)
        || /^Support the Guardian/i.test(p)
        || /^Share on /i.test(p);
    };
    while (paras.length > 0 && isFooter(paras[paras.length - 1])) {
      paras.pop();
    }

    const dedup = new Set<string>();
    const unique: string[] = [];
    for (const p of paras) {
      const key = p.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!key) continue;
      if (dedup.has(key)) continue;
      dedup.add(key);
      unique.push(p);
    }
    s = fixSmartPunctuationArtifacts(fixUtf8Mojibake(unique.join('\n\n')));
  }
  return s.trim();
}

export function cleanContent(text: string, url?: string) {
  const s = String(text || '');
  const u = String(url || '');
  const source = u.includes('aeon.co')
    ? 'Aeon Essays'
    : u.includes('theguardian.com')
      ? 'The Guardian'
      : u.includes('cnbc.com')
        ? 'CNBC Technology'
        : '';
  if (!source) return s;
  return normalizeMarkdownSource(s, source);
}

export async function fetchArticleMarkdown(url: string, source: string) {
  if (source === 'Aeon Essays') {
    try {
      const u = new URL(url);
      if (u.hostname.includes('aeon.co') && u.pathname.startsWith('/videos/')) {
        const html = await fetchHtml(url);
        if (html) {
          const vo = extractVideoObjectFromLdJson(html);
          let md = vo ? aeonVideoMarkdownFromVideoObject(vo) : '';
          const title = String(vo?.name || '').trim();
          const embedUrl = String(vo?.embedUrl || '').trim();
          const videoId = (() => {
            const m = embedUrl.match(/\/embed\/([^?&#/]+)/i);
            return m?.[1] || '';
          })();
          const vtt = videoId ? await tryYoutubeTranscript(videoId) : '';
          const transcript = vtt ? vttToPlainText(vtt) : '';
          if (transcript) {
            md = `${md}\n\n## Transcript\n\n${transcript}`.trim();
          }
          const norm = md ? normalizeMarkdownSource(md, source) : '';
          if (norm && isContentValid(norm, source)) return { markdown: norm, title };
        }
      }
    } catch {}

    const sel = selectorFor(url, source);
    const a = await fetchRawMarkdown(url, sel);
    const fb = await domainFallbackMarkdown(url);

    const score = (md: string) => {
      const s = (md || '').toString();
      if (!s.trim()) return -1e9;
      const nlp = (s.match(/\n\n/g) || []).length;
      const img = (s.match(/!\[[^\]]*\]\([^\)]+\)/g) || []).length;
      const lines = (s.match(/\n/g) || []).length;
      return s.length + nlp * 600 + img * 2500 + Math.min(2000, lines * 10);
    };

    const cand: Array<{ md: string; title: string }> = [];
    if (a.markdown) cand.push({ md: normalizeMarkdownSource(a.markdown, source), title: a.title || '' });
    if (fb) cand.push({ md: normalizeMarkdownSource(fb, source), title: '' });
    cand.sort((x, y) => score(y.md) - score(x.md));
    const best = cand[0];
    if (!best) return { markdown: '', title: a.title || '' };
    if (!isContentValid(best.md, source)) return { markdown: '', title: a.title || '' };
    return { markdown: best.md, title: best.title || a.title || '' };
  }

  if (source === 'CNBC Technology') {
    const sel = selectorFor(url, source);
    const a = await fetchRawMarkdown(url, sel);
    const fb = await domainFallbackMarkdown(url);

    const score = (md: string) => {
      const s = (md || '').toString();
      if (!s.trim()) return -1e9;
      if (/403\s+Forbidden|Access\s+Denied|verify\s+you\s+are\s+human|enable\s+javascript/i.test(s)) return -1e9;
      const nlp = (s.match(/\n\n/g) || []).length;
      const lines = (s.match(/\n/g) || []).length;
      return s.length + nlp * 800 + Math.min(2000, lines * 10);
    };

    const cand: Array<{ md: string; title: string }> = [];
    if (a.markdown) cand.push({ md: normalizeMarkdownSource(a.markdown, source), title: a.title || '' });
    if (fb) cand.push({ md: normalizeMarkdownSource(fb, source), title: '' });
    cand.sort((x, y) => score(y.md) - score(x.md));
    const best = cand[0];
    if (!best) return { markdown: '', title: a.title || '' };
    if (!isContentValid(best.md, source)) return { markdown: '', title: a.title || '' };
    return { markdown: best.md, title: best.title || a.title || '' };
  }

  if (source === 'The Guardian') {
    const api = await tryGuardianContentApi(url);
    if (api && isContentValid(api.markdown, source)) {
      return { markdown: normalizeMarkdownSource(api.markdown, source), title: api.title || '' };
    }
  }
  const sel = selectorFor(url, source);
  let { markdown, title } = await fetchRawMarkdown(url, sel);
  if (!isContentValid(markdown, source)) {
    const fb = await domainFallbackMarkdown(url);
    markdown = fb;
  }
  if (!isContentValid(markdown, source)) {
    return { markdown: "", title: title || "" };
  }
  return { markdown: normalizeMarkdownSource(markdown, source), title: title || "" };
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
      // 1. 映射并解析日期，确保 valid items
      const candidates = items.map(item => {
        let link = (item as any).link;
        if (!link && typeof item === 'object' && 'links' in item) {
          link = (item as any).links?.[0]?.href;
        }
        if (!link) link = (item as any).guid || (item as any).id;
        
        // 解析发布时间，用于排序
        const pubStr = (item as any).isoDate || (item as any).pubDate || new Date().toISOString();
        const pubTime = new Date(pubStr).getTime();

        return { 
          ...item, 
          link: sanitizeUrl(String(link || '')),
          _pubTime: pubTime,
          _pubStr: pubStr 
        };
      })
      .filter(i => i.link && /^https?:\/\//.test(i.link))
      // 2. 按日期降序排序（新文章在前）
      .sort((a, b) => b._pubTime - a._pubTime);

      if (candidates.length > 0) {
        const newest = new Date(candidates[0]._pubTime).toISOString();
        const oldest = new Date(candidates[candidates.length - 1]._pubTime).toISOString();
        console.log(`[${source.name}] Candidates: ${candidates.length}, Date Range: ${newest} ~ ${oldest}`);
      }

      const links = candidates.map(c => c.link);
      const { data: existingData } = await supabase
        .from('articles')
        .select('original_url')
        .in('original_url', links);
      const existingLinks = new Set(existingData?.map(e => e.original_url) || []);
      
      // 3. 排除已存在的，剩下的即为“新文章”（相对于DB）
      // 由于已经按日期降序，这里得到的 newItems 依然是新->旧的顺序
      // 我们将从前往后取，直到满足 quota。这意味着：
      // - 如果有今天的新闻，优先取今天的。
      // - 如果今天的都存过了，会自动往后取昨天的、前天的...
      // - 从而实现“优先新文章，不足时用旧文章填补”
      const newItems = candidates.filter(c => !existingLinks.has(c.link));
      
      let successCount = 0;
      const fullFetch = source.name === 'The Guardian' || source.name === 'Aeon Essays';
      const lightweight = !fullFetch;
      for (const item of newItems) {
        if (successCount >= quota) break;

        if (lightweight) {
          const title = (item as any).title || 'Untitled';
          const summaryBase = ((item as any).contentSnippet || (item as any).content || '') as string;
          const summary = summaryBase ? summaryBase.slice(0, 200) : '';
          const published_at = item._pubStr;
          const rssContent = (item as any).contentEncoded || (item as any).content || '';
          const markdown = typeof rssContent === 'string' && rssContent.trim() ? htmlToMarkdown(rssContent) : '';
          const { error } = await supabase.from('articles').insert({
            title,
            original_url: item.link,
            source: source.name,
            published_at: new Date(published_at).toISOString(),
            summary,
            content: "",
            raw_markdown: markdown ? normalizeMarkdownSource(markdown, source.name) : "",
            status: 'unread'
          });
          if (!error) {
            successCount++;
            allResults.push({ title, source: source.name });
          }
          continue;
        }

        const sel = selectorFor(item.link, source.name);
        let { markdown, title: jinaTitle } = await fetchRawMarkdown(item.link, sel);
        
        if (!isContentValid(markdown, source.name)) {
          console.log(`[${source.name}] Jina invalid (len=${markdown?.length}), trying fallback...`);
          const fb = await domainFallbackMarkdown(item.link);
          markdown = fb;
          
          if (!isContentValid(markdown, source.name)) {
            console.log(`[${source.name}] HTML fallback invalid (len=${markdown?.length}), trying RSS content...`);
            const rssContent = (item as any).contentEncoded || (item as any).content || "";
            if (rssContent) {
              markdown = htmlToMarkdown(rssContent);
            }
            
            if (!isContentValid(markdown, source.name)) {
              console.log(`[${source.name}] All methods failed for ${item.link} (final len=${markdown?.length})`);
              continue;
            }
          }
        }
        const title = jinaTitle || (item as any).title || 'Untitled';
        const summaryBase = ((item as any).contentSnippet || (item as any).content || '') as string;
        const summary = summaryBase ? summaryBase.slice(0, 200) : '';
        const published_at = item._pubStr;
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
      console.error(`[${source.name}] Critical Error:`, e);
      report[source.name] = `Error`;
    }
  }

  const reportStr = Object.entries(report).map(([k, v]) => `${k}: ${v}`).join(', ');
  console.log(`[Quota Report] ${reportStr} | Total New: ${allResults.length}`);
  return allResults;
}
