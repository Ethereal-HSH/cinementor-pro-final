import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const { url } = await req.json();
    if (typeof url !== "string" || url.length < 4) {
      return NextResponse.json(
        { error: "invalid url" },
        { status: 400 }
      );
    }

    // Jina Reader 支持直接拼接 URL，建议加上 http 前缀如果缺失
    const targetUrl = url.startsWith("http") ? url : `https://${url}`;
    const readerUrl = `https://r.jina.ai/${targetUrl}`;

    // 尝试获取 JSON 格式以获得更准确的元数据
    const readerRes = await fetch(readerUrl, { 
      headers: { 
        "Accept": "application/json",
        "X-With-Generated-Alt": "true"
      } 
    });

    if (!readerRes.ok) {
      return NextResponse.json({
        title: "Untitled",
        content: "暂未成功提取正文，请确认链接有效或稍后再试"
      });
    }

    const data = await readerRes.json();
    
    // Jina Reader JSON 响应结构通常包含 title, content (markdown), text 等
    const title = data.title || "Untitled";
    const content = data.content || data.text || "";

    return NextResponse.json({ title, content });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "server error" },
      { status: 500 }
    );
  }
}
