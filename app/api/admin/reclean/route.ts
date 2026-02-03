import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { cleanContent } from '@/lib/crawler';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST() {
  try {
    const { data: articles, error } = await supabase
      .from('articles')
      .select('id, content, original_url')
      .order('published_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    let updated = 0;
    for (const a of articles || []) {
      const before = a.content || "";
      const after = cleanContent(before, a.original_url);
      if (after !== before) {
        const { error: uerr } = await supabase
          .from('articles')
          .update({ content: after })
          .eq('id', a.id);
        if (!uerr) updated++;
      }
    }

    return NextResponse.json({ success: true, updated });
  } catch (e) {
    console.error('Reclean failed:', e);
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 });
  }
}
