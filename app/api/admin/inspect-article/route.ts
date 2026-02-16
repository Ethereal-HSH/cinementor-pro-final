import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

function summarizeParas(md: string, maxParas: number) {
  const paras = String(md || '')
    .replace(/\r/g, '')
    .split(/\n\n+/)
    .map(p => p.trim())
    .filter(Boolean);
  return paras.slice(0, maxParas).map((p, i) => ({
    i,
    len: p.length,
    sample: p.slice(0, 220)
  }));
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const id = String(searchParams.get('id') || '').trim();
    if (!id) {
      return NextResponse.json({ success: false, error: 'missing id' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('articles')
      .select('id,title,source,original_url,raw_markdown,content,published_at')
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;
    if (!data) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });

    const md = String(data.raw_markdown || data.content || '');
    const s = md;
    const nlp = (s.match(/\n\n/g) || []).length;
    const nl = (s.match(/\n/g) || []).length;
    const img = (s.match(/!\[[^\]]*\]\([^\)]+\)/g) || []).length;
    const hasHtml = /<\s*br\b|<\s*p\b|<\s*\/\s*p\s*>|<[^>]+>/.test(s);
    const hasEscapedNl = !s.includes('\n') && s.includes('\\n');

    return NextResponse.json({
      success: true,
      article: {
        id: data.id,
        title: data.title,
        source: data.source,
        original_url: data.original_url,
        published_at: data.published_at
      },
      stats: {
        len: s.length,
        nl,
        nlp,
        img,
        hasHtml,
        hasEscapedNl
      },
      head: s.slice(0, 1400),
      paras: summarizeParas(s, 16)
    });
  } catch (e) {
    const msg = e instanceof Error
      ? e.message
      : (e && typeof e === 'object' && 'message' in e)
        ? String((e as any).message)
        : (() => {
          try { return JSON.stringify(e); } catch { return String(e); }
        })();
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
