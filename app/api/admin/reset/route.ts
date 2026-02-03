
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { fetchAndStoreArticles } from '@/lib/crawler';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // Allow long running for fetch

export async function GET() {
  try {
    // Delete all articles (using a condition that is always true)
    const { error: deleteError } = await supabase
      .from('articles')
      .delete()
      .neq('title', 'IMPOSSIBLE_TITLE_XYZ_123'); // Delete everything that isn't this title

    if (deleteError) {
      throw deleteError;
    }

    // Re-fetch
    const results = await fetchAndStoreArticles();

    return NextResponse.json({
      success: true,
      message: `Reset complete. Fetched ${results.length} new articles.`,
      data: results
    });
  } catch (error) {
    console.error('Reset failed:', error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}
