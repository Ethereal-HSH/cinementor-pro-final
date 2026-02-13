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
      scanned,
      ok,
      repaired,
      repairedShort,
      deletedShort,
      deleted,
      purged,
      repopulated,
      timeLimitMs,
      elapsedMs: Date.now() - startedAt,
      details
    });
  } catch (e) {
    console.error('Guardian repair failed:', e);
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 });
  }
}
