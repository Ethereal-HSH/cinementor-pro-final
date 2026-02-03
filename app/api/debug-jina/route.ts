
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const targetUrl = searchParams.get('url');
  
  if (!targetUrl) {
    return NextResponse.json({ error: 'Please provide a url query parameter' }, { status: 400 });
  }

  const jinaUrl = `https://r.jina.ai/${targetUrl}`;
  
  try {
    const res = await fetch(jinaUrl, {
      headers: {
        "Accept": "application/json"
      }
    });

    const body = await res.json();

    return NextResponse.json({
      status_code: res.status,
      body_code: body.code,
      body_status: body.status,
      body_name: body.name, // Error name?
      body_message: body.message, // Error message?
      keys: Object.keys(body),
      data_exists: !!body.data,
      content_length: body.data?.content?.length || 0
    });

  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
