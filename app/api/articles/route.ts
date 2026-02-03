import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { data, error } = await supabase
      .from('articles')
      .select('id, title, source, published_at, summary, status')
      .order('published_at', { ascending: false })
      .limit(50);

    if (error) {
      throw error;
    }

    return NextResponse.json({ articles: data });
  } catch (error) {
    console.error('Failed to fetch articles:', error);
    return NextResponse.json({ articles: [], error: 'Failed to fetch articles' }, { status: 500 });
  }
}
