import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const { text } = await req.json();
    if (!text || (Array.isArray(text) && text.length === 0)) {
      return NextResponse.json({ error: "invalid text" }, { status: 400 });
    }

    const apiKey = process.env.DEEPSEEK_API_KEY;
    
    // 模拟模式
    if (!apiKey || apiKey === "your_deepseek_api_key_here") {
      const mockTranslate = (t: string) => `[模拟翻译] ${t.substring(0, 20)}...（请配置 API Key 以获取完整翻译）`;
      const translation = Array.isArray(text) ? text.map(mockTranslate) : mockTranslate(text);
      return NextResponse.json({ translation });
    }

    // 构造 Prompt
    const isArray = Array.isArray(text);
    const userContent = isArray 
      ? `请将以下 JSON 数组中的每一段英文翻译成中文，并返回一个严格的 JSON 字符串数组，保持顺序一致，不要包含 Markdown 标记：\n${JSON.stringify(text)}`
      : `请将以下英文段落翻译成地道的中文：\n${text}`;

    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { 
            role: "system", 
            content: "你是一位精通中英互译的翻译家。请提供信达雅的中文翻译。" 
          },
          { role: "user", content: userContent }
        ],
        temperature: 0.3,
        response_format: isArray ? { type: "json_object" } : undefined 
      })
    });

    if (!response.ok) {
        throw new Error(`DeepSeek API Error: ${response.status}`);
    }

    const data = await response.json();
    let result = data.choices?.[0]?.message?.content || "";

    // 如果是数组模式，尝试解析 JSON
    if (isArray) {
        try {
            // DeepSeek 有时会返回 { "translation": [...] } 或直接 [...]
            // 我们的 prompt 要求返回 JSON 字符串数组
            // 尝试解析
            let parsed = JSON.parse(result);
            // 如果解析出来是对象且包含 key (e.g. "translations"), 尝试提取
            if (!Array.isArray(parsed) && typeof parsed === 'object') {
                const values = Object.values(parsed);
                if (values.length === 1 && Array.isArray(values[0])) {
                    parsed = values[0];
                }
            }
            
            if (Array.isArray(parsed)) {
                return NextResponse.json({ translation: parsed });
            }
        } catch (e) {
            console.error("Failed to parse translation JSON", e);
        }
        // Fallback: 如果解析失败，返回原始文本作为错误提示
        return NextResponse.json({ translation: text.map(() => "翻译解析失败") });
    }

    return NextResponse.json({ translation: result });

  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Translation failed" }, { status: 500 });
  }
}
