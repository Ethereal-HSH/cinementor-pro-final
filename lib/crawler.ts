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
  // For CNBC, articles can be short, so 500 might be enough if it's a short news piece.
  if (source === 'CNBC Technology') return typeof markdown === 'string' && markdown.length >= 200;
  const need = source === 'Aeon Essays' ? 1000 : base; // Lower Aeon to 1000 to be safe
  return typeof markdown === 'string' && markdown.length >= need;
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
    const url = decodeUrlEntities(bestUrl || '');
    if (url.startsWith('//')) return 'https:' + url;
    if (/^https?:\/\//i.test(url)) return url;
    return url ? 'https://' + url.replace(/^\/+/, '') : '';
  };

  // Handle <figure> first, because it might contain <picture> or <img>
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
    const altMatch = m.match(/<img[^>]*alt=["']?([^"'>]*)["']?[^>]*>/i);
    const src = srcsetMatch ? pickFromSrcset(srcsetMatch[1]) : '';
    const alt = altMatch ? altMatch[1] : '';
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
  if (m) return htmlToMarkdown(m[0]);

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
  if (source === 'The Guardian') {
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

export async function fetchArticleMarkdown(url: string, source: string) {
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
      const fullFetch = source.name === 'The Guardian';
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
