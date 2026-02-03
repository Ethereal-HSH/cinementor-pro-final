import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const { sentence } = await req.json();
    if (typeof sentence !== "string" || sentence.length === 0) {
      return NextResponse.json({ error: "invalid sentence" }, { status: 400 });
    }

    const apiKey = process.env.DEEPSEEK_API_KEY;
    
    // 如果没有配置 Key 或 Key 是占位符，返回模拟数据
    if (!apiKey || apiKey === "your_deepseek_api_key_here") {
      return NextResponse.json({
        analysis: "⚠️ 未检测到有效的 DEEPSEEK_API_KEY。\n\n请在 .env.local 文件中配置您的 DeepSeek API Key 以启用真实 AI 解析。\n\n(当前为模拟模式)\n\n" + getMockAnalysis(sentence)
      });
    }

    try {
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
              content: `你是 LinguaFlow Pro 的 AI 导师，专为高阶英语学习者服务。请对用户提供的英语句子进行深度解析。
请严格按照以下 Markdown 格式输出（不要包含 Markdown 代码块标记）：

### 💡 精准翻译
{地道的中文翻译}

### 🧬 语法拆解
{清晰的句子结构分析，使用“主语”、“谓语”等术语，关键语法点用粗体}

### 📚 考点词汇
- **{单词/短语}**: {简明释义} ({近义词/用法辨析})
...`
            },
            { role: "user", content: sentence }
          ],
          temperature: 0.3
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("DeepSeek API Error:", errorText);
        throw new Error(`DeepSeek API Error: ${response.status}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || "解析失败，请重试。";
      
      return NextResponse.json({ analysis: content });
    } catch (error) {
      console.error(error);
      return NextResponse.json({ 
        analysis: "AI 服务暂时不可用，请稍后再试。\n\n" + (error instanceof Error ? error.message : String(error)) 
      });
    }
  } catch {
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}

function getMockAnalysis(sentence: string) {
    const tokens = sentence
      .replace(/[^\w\s'-]/g, "")
      .split(/\s+/)
      .filter(Boolean);
    const words = tokens.length;
    
    return [
      "### 💡 模拟翻译",
      "这是一个模拟的翻译结果（因为未配置 API Key）。",
      "",
      "### 🧬 语法拆解",
      `这是一个包含 ${words} 个单词的句子。`,
      "- **主干**：模拟主语 + 模拟谓语",
      "",
      "### 📚 考点词汇",
      tokens.slice(0, 3).map(t => `- **${t}**: 模拟释义`).join("\n")
    ].join("\n");
}
