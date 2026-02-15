import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { fetchArticleMarkdown } from '@/lib/crawler';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function normalizeDateKey(input: string) {
  const s = (input || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return '';
  const y = m[1];
  const mm = String(Math.max(1, Math.min(12, parseInt(m[2], 10) || 0))).padStart(2, '0');
  const dd = String(Math.max(1, Math.min(31, parseInt(m[3], 10) || 0))).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

function toCsvList(value: string | null) {
  return (value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function addDaysIso(dateKey: string, days: number) {
  const t = Date.parse(`${dateKey}T00:00:00.000Z`);
  if (!Number.isFinite(t)) return '';
  return new Date(t + days * 86400000).toISOString();
}

function inferPublishedAtFromGuardianUrl(u: string) {
  try {
    const url = new URL(u);
    const parts = url.pathname.split('/').filter(Boolean);
    const year = parts.find(p => /^\d{4}$/.test(p)) || '';
    const yearIdx = parts.findIndex(p => p === year);
    if (!year || yearIdx < 0) return null;
    const mon = (parts[yearIdx + 1] || '').toLowerCase();
    const day = parts[yearIdx + 2] || '';
    const monMap: Record<string, string> = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
    };
    const mm = monMap[mon];
    if (!mm || !/^\d{1,2}$/.test(day)) return null;
    const dd = String(parseInt(day, 10)).padStart(2, '0');
    return `${year}-${mm}-${dd}T00:00:00.000Z`;
  } catch {
    return null;
  }
}

function decodeUrlEntities(u: string) {
  return (u || '')
    .replace(/&amp;/g, '&')
    .replace(/&#38;/g, '&')
    .replace(/&#x26;/gi, '&');
}

function extractImageUrls(markdown: string) {
  const urls: string[] = [];
  const re = /!\[[^\]]*\]\(([^)]+)\)/g;
  const s = markdown || '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const u = decodeUrlEntities((m[1] || '').trim());
    if (u) urls.push(u);
  }
  return urls;
}

function stripHtmlTags(text: string) {
  return (text || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*p\b[^>]*>/gi, '')
    .replace(/<\s*\/\s*p\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
}

function normalizeGuardianStoredMarkdown(md: string) {
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
  s = stripHtmlTags(s);
  s = s
    .replace(/\u00a0/g, ' ')
    .replace(/\u200b/g, '')
    .replace(/\n\s*\*\s*\*\s*\*\s*\n/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  s = s
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...');

  if (!s) return '';

  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => {
    const u = decodeUrlEntities(String(url || '').trim());
    return `![${alt || ''}](${u})`;
  });

  s = s
    .replace(/\[View image in fullscreen\]\(#img-\d+\)/gi, '')
    .replace(/Photograph:\s+[^\n]+/gi, '')
    .replace(/\n\s*#+\s*/g, '\n')
    .replace(/!?\[([^\]]+)\]\(([^)]+)\)/g, (full, txt) => full.startsWith('!') ? full : txt)
    .replace(/\n{3,}/g, '\n\n');

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
  return fixSmartPunctuationArtifacts(fixUtf8Mojibake(unique.join('\n\n').trim()));
}

async function fetchGuardianOgImage(pageUrl: string) {
  try {
    const res = await fetch(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Referer': 'https://www.theguardian.com/'
      }
    });
    if (res.ok) {
      const html = await res.text().catch(() => '');
      const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i)
        || html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i);
      if (m && m[1]) return decodeUrlEntities(m[1]);
    }
  } catch {}
  try {
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(pageUrl)}`;
    const res = await fetch(proxyUrl);
    if (!res.ok) return '';
    const data = await res.json().catch(() => ({}));
    const html = (data.contents || '').toString();
    const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i)
      || html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i);
    if (m && m[1]) return decodeUrlEntities(m[1]);
  } catch {}
  return '';
}

async function checkImageFetchable(url: string) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer': 'https://www.theguardian.com/'
      }
    });
    if (res.ok) {
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!ct || ct.includes('image')) return true;
    }
    if (res.status === 405 || res.status === 403 || res.status === 400) {
      const res2 = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          'Referer': 'https://www.theguardian.com/',
          'Range': 'bytes=0-2047'
        }
      });
      if (res2.ok || res2.status === 206) {
        const ct = (res2.headers.get('content-type') || '').toLowerCase();
        if (!ct || ct.includes('image')) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.max(0, parseInt(searchParams.get('limit') || '0', 10) || 0);
    const minLen = Math.max(0, parseInt(searchParams.get('minLen') || '1000', 10) || 1000);
    const mode = (searchParams.get('mode') || 'images').toLowerCase();
    const timeLimitMs = Math.max(5_000, parseInt(searchParams.get('timeLimitMs') || '250000', 10) || 250000);
    const source = searchParams.get('source') || 'The Guardian';
    const dates = toCsvList(searchParams.get('dates')).map(normalizeDateKey).filter(Boolean);
    const dateSet = new Set(dates);
    const urls = toCsvList(searchParams.get('urls'));
    const debugUrl = searchParams.get('url') || '';
    const force = (searchParams.get('force') || '').toLowerCase() === '1' || (searchParams.get('force') || '').toLowerCase() === 'true';
    const recrawlShort = (searchParams.get('recrawlShort') || '').toLowerCase() === '1' || (searchParams.get('recrawlShort') || '').toLowerCase() === 'true';
    const peekChars = Math.max(100, Math.min(2000, parseInt(searchParams.get('peekChars') || '600', 10) || 600));
    const pageSize = 50;
    let offset = 0;
    let scanned = 0;
    let ok = 0;
    let repaired = 0;
    let repairedShort = 0;
    let deletedShort = 0;
    let deleted = 0;
    let purged = 0;
    let repopulated = 0;
    let washed = 0;
    let washedRecrawled = 0;
    const details: Array<{ id: string; url: string; action: string; beforeLen?: number; afterLen?: number }> = [];
    const startedAt = Date.now();

    let publishedFromIso = '';
    let publishedToIsoExclusive = '';
    if (dates.length > 0) {
      const sorted = [...dates].sort();
      const min = sorted[0];
      const max = sorted[sorted.length - 1];
      publishedFromIso = `${min}T00:00:00.000Z`;
      publishedToIsoExclusive = addDaysIso(max, 1);
    }

    if (mode === 'restore_urls') {
      let restored = 0;
      let skipped = 0;
      const startedAt = Date.now();
      for (const url of urls) {
        if (Date.now() - startedAt > timeLimitMs) break;
        const fetched = await fetchArticleMarkdown(url, source);
        const md = fetched.markdown || '';
        const afterLen = md.length;
        if (afterLen < minLen) {
          details.push({ id: '', url, action: 'restore_too_short', afterLen });
          continue;
        }
        const published_at = source === 'The Guardian' ? inferPublishedAtFromGuardianUrl(url) : null;
        const title = fetched.title || 'Untitled';

        const { error: ierr } = await supabase
          .from('articles')
          .insert({
            title,
            original_url: url,
            source,
            published_at,
            summary: '',
            content: '',
            raw_markdown: md,
            status: 'unread'
          });

        if (!ierr) {
          restored++;
          details.push({ id: '', url, action: 'restored', afterLen });
          continue;
        }

        const { error: uerr } = await supabase
          .from('articles')
          .update({ title, raw_markdown: md, published_at })
          .eq('original_url', url);
        if (!uerr) {
          restored++;
          details.push({ id: '', url, action: 'restored_update', afterLen });
        } else {
          skipped++;
          details.push({ id: '', url, action: 'restore_failed', afterLen });
        }
      }
      return NextResponse.json({
        success: true,
        mode,
        source,
        restored,
        skipped,
        timeLimitMs,
        elapsedMs: Date.now() - startedAt,
        details
      });
    }

    if (mode === 'debug_url') {
      const u = debugUrl;
      if (!u) return NextResponse.json({ success: false, error: 'missing url' }, { status: 400 });
      const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
      let status = 0;
      let html = '';
      try {
        const res = await fetch(u, { headers: { 'User-Agent': ua, 'Accept': 'text/html' } });
        status = res.status;
        html = await res.text().catch(() => '');
      } catch {
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`;
        const res = await fetch(proxyUrl);
        status = res.status;
        const raw = await res.text().catch(() => '');
        try {
          const data = JSON.parse((raw || '').trim());
          html = (data?.contents || '').toString();
        } catch {
          html = raw;
        }
      }
      const ldScripts = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
      let foundLen = 0;
      let foundPreview = '';
      for (const s of ldScripts) {
        const m = s.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
        const jsonText = (m?.[1] || '').trim();
        if (!jsonText) continue;
        try {
          const data = JSON.parse(jsonText);
          const stack: any[] = [data];
          while (stack.length) {
            const cur = stack.pop();
            if (!cur) continue;
            if (typeof cur === 'object') {
              if (typeof cur.articleBody === 'string' && cur.articleBody.trim()) {
                foundLen = cur.articleBody.length;
                foundPreview = cur.articleBody.slice(0, 200);
                stack.length = 0;
                break;
              }
              if (Array.isArray(cur)) {
                for (const it of cur) stack.push(it);
              } else {
                if (cur['@graph']) stack.push(cur['@graph']);
                for (const k of Object.keys(cur)) stack.push(cur[k]);
              }
            }
          }
          if (foundLen) break;
        } catch {}
      }
      return NextResponse.json({
        success: true,
        url: u,
        status,
        htmlLen: html.length,
        ldCount: ldScripts.length,
        hasContentBody: html.includes('content__article-body'),
        articleBodyLen: foundLen,
        articleBodyPreview: foundPreview
      });
    }

    if (mode === 'wash_preview') {
      const u = debugUrl;
      if (!u) return NextResponse.json({ success: false, error: 'missing url' }, { status: 400 });
      const { data: row, error } = await supabase
        .from('articles')
        .select('id, original_url, raw_markdown, source, published_at')
        .eq('original_url', u)
        .maybeSingle();
      if (error) throw error;
      if (!row) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });

      const before = (row.raw_markdown || '').toString();
      const after = normalizeGuardianStoredMarkdown(before);
      const findFirstNonAscii = (s: string) => {
        for (let i = 0; i < s.length; i++) {
          const code = s.charCodeAt(i);
          if (code > 127) {
            const start = Math.max(0, i - 10);
            const end = Math.min(s.length, i + 10);
            const window = s.slice(start, end);
            const codes = Array.from(window, ch => ch.charCodeAt(0));
            return { index: i, code, window, codes };
          }
        }
        return null;
      };
      return NextResponse.json({
        success: true,
        mode,
        id: row.id,
        url: row.original_url,
        published_at: row.published_at,
        beforeLen: before.length,
        afterLen: after.length,
        changed: before !== after,
        beforeSample: before.slice(0, peekChars),
        afterSample: after.slice(0, peekChars),
        beforeFirstNonAscii: findFirstNonAscii(before),
        afterFirstNonAscii: findFirstNonAscii(after)
      });
    }

    if (mode === 'peek') {
      const pageSize = 50;
      let offset = 0;
      const startedAt = Date.now();
      const samples: Array<{ id: string; url: string; published_at: any; len: number; nl: number; nlp: number; sample: string }> = [];
      while (true) {
        let query = supabase
          .from('articles')
          .select('id, original_url, raw_markdown, published_at, source')
          .eq('source', source)
          .order('published_at', { ascending: true });

        const { data: rows, error } = await query.range(offset, offset + pageSize - 1);
        if (error) throw error;
        if (!rows || rows.length === 0) break;

        for (const row of rows) {
          if (limit && samples.length >= limit) break;
          if (Date.now() - startedAt > timeLimitMs) break;
          if (dateSet.size > 0) {
            const inferred = inferPublishedAtFromGuardianUrl(row.original_url)?.slice(0, 10) || '';
            const key = row.published_at ? new Date(row.published_at as any).toISOString().slice(0, 10) : inferred;
            if (!dateSet.has(key)) continue;
          }
          const md = (row.raw_markdown || '').toString();
          const nl = (md.match(/\n/g) || []).length;
          const nlp = (md.match(/\n\n/g) || []).length;
          samples.push({
            id: row.id,
            url: row.original_url,
            published_at: row.published_at,
            len: md.length,
            nl,
            nlp,
            sample: md.slice(0, peekChars)
          });
        }

        if (Date.now() - startedAt > timeLimitMs) break;
        if (limit && samples.length >= limit) break;
        offset += pageSize;
      }

      return NextResponse.json({
        success: true,
        mode,
        source,
        dates,
        limit,
        peekChars,
        count: samples.length,
        samples
      });
    }

    while (true) {
      let query = supabase
        .from('articles')
        .select('id, title, original_url, raw_markdown, published_at, summary, status, source')
        .eq('source', source)
        .order(dates.length > 0 ? 'created_at' : 'published_at', { ascending: true });

      if (dates.length === 0 && publishedFromIso && publishedToIsoExclusive) {
        query = query.gte('published_at', publishedFromIso).lt('published_at', publishedToIsoExclusive);
      }

      const { data: rows, error } = await query.range(offset, offset + pageSize - 1);
      if (error) throw error;
      if (!rows || rows.length === 0) break;

      for (const row of rows) {
        scanned++;
        if (limit && scanned > limit) break;
        if (Date.now() - startedAt > timeLimitMs) break;

        if (dateSet.size > 0) {
          const inferred = inferPublishedAtFromGuardianUrl(row.original_url)?.slice(0, 10) || '';
          const key = row.published_at ? new Date(row.published_at as any).toISOString().slice(0, 10) : inferred;
          if (!dateSet.has(key)) {
            ok++;
            continue;
          }
        }

        const beforeLen = (row.raw_markdown || '').length;

        if (mode === 'wash') {
          const before = (row.raw_markdown || '').toString();
          let nextMd = normalizeGuardianStoredMarkdown(before);
          let action = '';

          if ((force || beforeLen < minLen) && recrawlShort) {
            const fetched = await fetchArticleMarkdown(row.original_url, source);
            const fetchedMd = (fetched.markdown || '').toString();
            if (fetchedMd && fetchedMd.length >= minLen) {
              nextMd = fetchedMd;
              action = 'washed_recrawled';
            }
          }

          if (!nextMd) {
            ok++;
            continue;
          }
          const afterLen = nextMd.length;

          if (!force && afterLen === beforeLen && nextMd === before) {
            ok++;
            continue;
          }

          if (nextMd === before) {
            ok++;
            continue;
          }

          const { error: uerr } = await supabase
            .from('articles')
            .update({ raw_markdown: nextMd })
            .eq('id', row.id);

          if (!uerr) {
            if (action === 'washed_recrawled') washedRecrawled++;
            else washed++;
            details.push({ id: row.id, url: row.original_url, action: action || 'washed', beforeLen, afterLen });
          }
          continue;
        }

        if (mode === 'purge_recrawl') {
          const { error: derr } = await supabase
            .from('articles')
            .delete()
            .eq('id', row.id);
          if (derr) {
            details.push({ id: row.id, url: row.original_url, action: 'purge_failed', beforeLen });
            continue;
          }
          purged++;

          const fetched = await fetchArticleMarkdown(row.original_url, source);
          const nextMd = fetched.markdown || '';
          const afterLen = nextMd.length;
          if (afterLen >= minLen) {
            const { error: ierr } = await supabase
              .from('articles')
              .insert({
                title: fetched.title || row.title,
                original_url: row.original_url,
                source: source,
                published_at: row.published_at,
                summary: row.summary,
                content: '',
                raw_markdown: nextMd,
                status: row.status || 'unread'
              });
            if (!ierr) {
              repopulated++;
              details.push({ id: row.id, url: row.original_url, action: 'purged_recrawled', beforeLen, afterLen });
            } else {
              details.push({ id: row.id, url: row.original_url, action: 'purged_insert_failed', beforeLen, afterLen });
            }
          } else {
            details.push({ id: row.id, url: row.original_url, action: 'purged_recrawl_too_short', beforeLen, afterLen });
          }
          continue;
        }

        if (mode === 'content' || mode === 'recrawl') {
          if (!force && beforeLen >= minLen) {
            ok++;
            continue;
          }

          if (mode === 'recrawl') {
            const fetched = await fetchArticleMarkdown(row.original_url, source);
            const nextMd = fetched.markdown || '';
            const afterLen = nextMd.length;

            if (afterLen >= minLen) {
              const { error: uerr } = await supabase
                .from('articles')
                .update({ raw_markdown: nextMd, title: fetched.title || row.title })
                .eq('id', row.id);
              if (!uerr) {
                repairedShort++;
                details.push({ id: row.id, url: row.original_url, action: 'recrawled', beforeLen, afterLen });
              }
            } else {
              const { error: derr } = await supabase
                .from('articles')
                .delete()
                .eq('id', row.id);
              if (!derr) {
                deletedShort++;
                details.push({ id: row.id, url: row.original_url, action: 'deleted_short', beforeLen, afterLen });
              }
            }

            continue;
          }

          const fetched = await fetchArticleMarkdown(row.original_url, source);
          const nextMd = fetched.markdown || '';
          const afterLen = nextMd.length;
          if (afterLen >= minLen) {
            const { error: uerr } = await supabase
              .from('articles')
              .update({ raw_markdown: nextMd })
              .eq('id', row.id);
            if (!uerr) {
              repairedShort++;
              details.push({ id: row.id, url: row.original_url, action: 'repaired_short', beforeLen, afterLen });
            }
          }
          continue;
        }

        const urls = extractImageUrls(row.raw_markdown || '');
        let isOk = false;
        let expectedImage = urls.length > 0;
        let ogImage = '';

        if (!expectedImage) {
          ogImage = await fetchGuardianOgImage(row.original_url);
          expectedImage = Boolean(ogImage);
        }

        if (urls.length > 0) {
          for (const u of urls.slice(0, 2)) {
            if (await checkImageFetchable(u)) {
              isOk = true;
              break;
            }
          }
        } else if (!expectedImage) {
          isOk = true;
        }

        if (isOk && beforeLen >= minLen) {
          ok++;
          continue;
        }

        if (isOk && (force || beforeLen < minLen)) {
          const fetched = await fetchArticleMarkdown(row.original_url, source);
          const nextMd = fetched.markdown || '';
          const afterLen = nextMd.length;
          if (afterLen >= minLen) {
            const { error: uerr } = await supabase
              .from('articles')
              .update({ raw_markdown: nextMd })
              .eq('id', row.id);
            if (!uerr) {
              repairedShort++;
              details.push({ id: row.id, url: row.original_url, action: 'repaired_short', beforeLen, afterLen });
            }
          }
          continue;
        }

        const fetched = await fetchArticleMarkdown(row.original_url, source);
        const nextMd = fetched.markdown || '';
        const nextUrls = extractImageUrls(nextMd);
        let nextOk = false;
        if (nextUrls.length > 0) {
          for (const u of nextUrls.slice(0, 2)) {
            if (await checkImageFetchable(u)) {
              nextOk = true;
              break;
            }
          }
        } else if (ogImage) {
          const candidate = ogImage;
          if (await checkImageFetchable(candidate)) {
            nextOk = true;
          }
        }

        if (nextOk) {
          const finalMd = nextUrls.length > 0
            ? nextMd
            : `![](${ogImage})\n\n${nextMd}`;
          const afterLen = finalMd.length;
          const { error: uerr } = await supabase
            .from('articles')
            .update({ raw_markdown: finalMd })
            .eq('id', row.id);
          if (!uerr) {
            repaired++;
            details.push({ id: row.id, url: row.original_url, action: 'repaired', beforeLen, afterLen });
          }
        } else {
          const { error: derr } = await supabase
            .from('articles')
            .delete()
            .eq('id', row.id);
          if (!derr) {
            deleted++;
            details.push({ id: row.id, url: row.original_url, action: 'deleted', beforeLen });
          }
        }
      }

      if (Date.now() - startedAt > timeLimitMs) break;
      if (limit && scanned >= limit) break;
      offset += pageSize;
    }

    return NextResponse.json({
      success: true,
      mode,
      source,
      dates,
      force,
      recrawlShort,
      scanned,
      ok,
      repaired,
      repairedShort,
      deletedShort,
      deleted,
      purged,
      repopulated,
      washed,
      washedRecrawled,
      timeLimitMs,
      elapsedMs: Date.now() - startedAt,
      details
    });
  } catch (e) {
    console.error('Guardian repair failed:', e);
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 });
  }
}
