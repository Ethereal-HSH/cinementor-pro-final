import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { fetchArticleMarkdown } from '@/lib/crawler';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function minLenFor(source: string) {
  if (source === 'CNBC Technology') return 200;
  if (source === 'Aeon Essays') return 1000;
  return 800;
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({} as any));
    const url = String(body?.url || '').trim();
    const source = String(body?.source || '').trim();
    const refresh = Boolean(body?.refresh);

    if (!url || !/^https?:\/\//.test(url) || !source) {
      return NextResponse.json({ success: false, error: 'missing url/source' }, { status: 400 });
    }

    const { data: existing, error } = await supabase
      .from('articles')
      .select('id, title, raw_markdown, content, published_at, summary, status, source, original_url')
      .eq('original_url', url)
      .maybeSingle();
    if (error) throw error;

    const fetched = await fetchArticleMarkdown(url, source);
    const md = String(fetched?.markdown || '');
    const title = String(fetched?.title || '').trim();
    const minLen = minLenFor(source);
    if (!md || md.length < minLen) {
      return NextResponse.json({ success: false, error: 'fetch failed', url, source, len: md.length }, { status: 502 });
    }

    if (!existing) {
      const { data: ins, error: ierr } = await supabase
        .from('articles')
        .insert({
          title: title || 'Untitled',
          original_url: url,
          source,
          published_at: new Date().toISOString(),
          summary: null,
          content: '',
          raw_markdown: md,
          status: 'unread'
        })
        .select('id')
        .maybeSingle();

      if (ierr) throw ierr;
      return NextResponse.json({ success: true, action: 'inserted', id: ins?.id, url, source, len: md.length });
    }

    if (refresh) {
      const payload: Record<string, any> = { raw_markdown: md };
      if (title && title !== String(existing.title || '').trim()) payload.title = title;
      const { error: uerr } = await supabase.from('articles').update(payload).eq('id', existing.id);
      if (uerr) throw uerr;
      return NextResponse.json({ success: true, action: 'updated', id: existing.id, url, source, len: md.length });
    }

    return NextResponse.json({ success: true, action: 'exists', id: existing.id, url, source, len: md.length });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

