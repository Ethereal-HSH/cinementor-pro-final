import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { fetchArticleMarkdown } from '@/lib/crawler';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

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
    const pageSize = 50;
    let offset = 0;
    let scanned = 0;
    let ok = 0;
    let repaired = 0;
    let deleted = 0;
    const details: Array<{ id: string; url: string; action: string }> = [];

    while (true) {
      const { data: rows, error } = await supabase
        .from('articles')
        .select('id, title, original_url, raw_markdown, published_at, summary, status')
        .eq('source', 'The Guardian')
        .order('created_at', { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      if (!rows || rows.length === 0) break;

      for (const row of rows) {
        scanned++;
        if (limit && scanned > limit) break;

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

        if (isOk) {
          ok++;
          continue;
        }

        const fetched = await fetchArticleMarkdown(row.original_url, 'The Guardian');
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
          const { error: uerr } = await supabase
            .from('articles')
            .update({ raw_markdown: finalMd })
            .eq('id', row.id);
          if (!uerr) {
            repaired++;
            details.push({ id: row.id, url: row.original_url, action: 'repaired' });
          }
        } else {
          const { error: derr } = await supabase
            .from('articles')
            .delete()
            .eq('id', row.id);
          if (!derr) {
            deleted++;
            details.push({ id: row.id, url: row.original_url, action: 'deleted' });
          }
        }
      }

      if (limit && scanned >= limit) break;
      offset += pageSize;
    }

    return NextResponse.json({ success: true, scanned, ok, repaired, deleted, details });
  } catch (e) {
    console.error('Guardian repair failed:', e);
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 });
  }
}
