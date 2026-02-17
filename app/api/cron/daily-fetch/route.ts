import { NextResponse } from 'next/server';
import { fetchAndStoreArticles } from '@/lib/crawler';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function getBearerToken(req: Request) {
  const h = req.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || '';
}

export async function GET(req: Request) {
  const secret = String(process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET || '').trim();
  if (process.env.NODE_ENV === 'production') {
    if (!secret) {
      return NextResponse.json({ success: false, error: 'missing CRON_SECRET' }, { status: 500 });
    }
    const token = getBearerToken(req);
    if (!token || token !== secret) {
      return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
    }
  }

  const startedAt = Date.now();
  const results = await fetchAndStoreArticles();
  const ms = Date.now() - startedAt;
  const counts: Record<string, number> = {};
  if (Array.isArray(results)) {
    for (const r of results as any[]) {
      const src = String(r?.source || '');
      if (!src) continue;
      counts[src] = (counts[src] || 0) + 1;
    }
  }

  return NextResponse.json({
    success: true,
    inserted: Array.isArray(results) ? results.length : 0,
    counts,
    ms,
    results
  });
}
