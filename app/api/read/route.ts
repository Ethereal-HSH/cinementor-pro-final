import { NextResponse } from "next/server";
import { cleanContent, fetchArticleMarkdown } from "@/lib/crawler";
import { supabase } from "@/lib/supabase";

export async function POST(req: Request) {
  try {
    const { url, article_id } = await req.json();
    if (typeof url !== "string" || url.length < 4) {
      return NextResponse.json(
        { error: "invalid url" },
        { status: 400 }
      );
    }

    // Jina Reader 支持直接拼接 URL，建议加上 http 前缀如果缺失
    const targetUrl = url.startsWith("http") ? url : `https://${url}`;

    if (article_id) {
      const { data } = await supabase
        .from('articles')
        .select('id, title, source, original_url, raw_markdown, content')
        .eq('id', article_id)
        .maybeSingle();
      const source = String(data?.source || '');
      const originalUrl = String(data?.original_url || targetUrl);
      const existing = String(data?.raw_markdown || data?.content || '');
      if (source === 'Aeon Essays' && originalUrl.includes('aeon.co/videos/') && existing.trim().length >= 120) {
        return NextResponse.json({ title: data?.title || 'Untitled', content: existing });
      }

      if (source === 'Aeon Essays' && originalUrl.includes('aeon.co/videos/')) {
        const fetched = await fetchArticleMarkdown(originalUrl, source);
        const md = String(fetched?.markdown || '');
        const title = String(fetched?.title || data?.title || 'Untitled');
        if (md && md.length >= 120) {
          await supabase
            .from('articles')
            .update({ title, content: md, raw_markdown: md })
            .eq('id', article_id);
          return NextResponse.json({ title, content: md });
        }
      }
    }
    const readerUrl = `https://r.jina.ai/${targetUrl}`;

    // 尝试获取 JSON 格式以获得更准确的元数据
    let readerRes = await fetch(readerUrl, { headers: { "Accept": "application/json" } });

    if (!readerRes.ok) {
      // 尝试纯文本（Markdown）模式
      readerRes = await fetch(readerUrl);
      if (!readerRes.ok) {
        return NextResponse.json({
          title: "Untitled",
          content: ""
        });
      }
      const md = await readerRes.text();
      const content = cleanContent(md, targetUrl);
      return NextResponse.json({ title: "Untitled", content });
    }

    const body = await readerRes.json();
    const data = body?.data || body || {};
    
    // Jina JSON常见结构：{ data: { title, content(md), text } }
    const title = data.title || body.title || "Untitled";
    let content = data.content || data.text || body.content || body.text || "";
    content = cleanContent(content, targetUrl);

    // 若传入 article_id，服务端直接写库（避免客户端 RLS 更新失败）
    if (article_id && content && content.length >= 200) {
      await supabase
        .from('articles')
        .update({ content, raw_markdown: content })
        .eq('id', article_id);
    }

    return NextResponse.json({ title, content });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "server error" },
      { status: 500 }
    );
  }
}
