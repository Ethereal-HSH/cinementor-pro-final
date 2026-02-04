import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function isAllowed(url: string) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    return [
      'i.guim.co.uk',
      'media.guim.co.uk',
      'static.guim.co.uk',
      'assets.guim.co.uk',
      'theguardian.com',
      'www.theguardian.com'
    ].some(h => host.endsWith(h));
  } catch {
    return false;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');
  if (!url || !isAllowed(url)) {
    return NextResponse.json({ error: 'invalid url' }, { status: 400 });
  }
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer': 'https://www.theguardian.com/'
      }
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return NextResponse.json({ error: 'fetch_failed', status: res.status, preview: txt.slice(0, 200) }, { status: 502 });
    }
    const ct = res.headers.get('content-type') || 'image/jpeg';
    const ab = await res.arrayBuffer();
    return new Response(ab, {
      headers: {
        'Content-Type': ct,
        'Cache-Control': 'public, max-age=86400'
      }
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
