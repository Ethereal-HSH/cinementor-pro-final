import { NextResponse } from 'next/server';
import Parser from 'rss-parser';
import { supabase } from '@/lib/supabase';
import { fetchArticleMarkdown } from '@/lib/crawler';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const FEED_URLS: Record<string, string> = {
  'CNBC Technology': 'https://www.cnbc.com/id/19854910/device/rss/rss.html'
};

function minLenFor(source: string) {
  if (source === 'CNBC Technology') return 200;
  if (source === 'Aeon Essays') return 1000;
  return 800;
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({} as any));
    const source = String(body?.source || '').trim();
    const limit = Math.max(1, Math.min(200, parseInt(String(body?.limit || '50'), 10) || 50));
    const dryRun = Boolean(body?.dryRun);

    const feedUrl = FEED_URLS[source];
    if (!source || !feedUrl) {
      return NextResponse.json({ success: false, error: 'unsupported source' }, { status: 400 });
    }

    const parser = new Parser({
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      customFields: {
        item: [['content:encoded', 'contentEncoded']]
      }
    });

    const feed = await parser.parseURL(feedUrl);
    const items = feed.items || [];
    const links = items
      .map((it: any) => String(it.link || it.guid || it.id || '').trim())
      .filter(u => /^https?:\/\//.test(u));

    const { data: existing } = await supabase
      .from('articles')
      .select('original_url')
      .in('original_url', links);

    const existingSet = new Set((existing || []).map(r => r.original_url));
    const missing = links.filter(u => !existingSet.has(u)).slice(0, limit);

    let inserted = 0;
    let fetchedOk = 0;
    let failed = 0;
    const samples: Array<{ url: string; id?: string; len?: number }>
      = [];

    const minLen = minLenFor(source);
    for (const url of missing) {
      const it = items.find((x: any) => String(x.link || x.guid || x.id || '').trim() === url) as any;
      const published_at = it?.isoDate || it?.pubDate || new Date().toISOString();
      const rssTitle = String(it?.title || '').trim();
      const rssSummaryBase = String(it?.contentSnippet || it?.content || '').trim();
      const summary = rssSummaryBase ? rssSummaryBase.slice(0, 200) : '';

      const fetched = await fetchArticleMarkdown(url, source);
      const md = String(fetched?.markdown || '');
      const title = String(fetched?.title || '').trim() || rssTitle || 'Untitled';
      if (!md || md.length < minLen) {
        failed++;
        continue;
      }
      fetchedOk++;

      if (!dryRun) {
        const { data: ins, error } = await supabase
          .from('articles')
          .insert({
            title,
            original_url: url,
            source,
            published_at: new Date(published_at).toISOString(),
            summary,
            content: '',
            raw_markdown: md,
            status: 'unread'
          })
          .select('id')
          .maybeSingle();
        if (error) {
          failed++;
          continue;
        }
        inserted++;
        if (samples.length < 20) samples.push({ url, id: ins?.id, len: md.length });
      } else {
        if (samples.length < 20) samples.push({ url, len: md.length });
      }
    }

    return NextResponse.json({
      success: true,
      source,
      feedUrl,
      limit,
      dryRun,
      feedCount: items.length,
      missingCount: missing.length,
      fetchedOk,
      inserted,
      failed,
      samples
    });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

