import Parser from 'rss-parser';
import { supabase } from './supabase';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || "";

function sanitizeUrl(u: string) {
  return (u || "").trim().replace(/[)\]]+$/g, "");
}

export function cleanContent(text: string, url?: string) {
  const ban = [
    /facebook\.com/i, /instagram\.com/i, /twitter\.com|x\.com/i, /reddit\.com/i,
    /youtube\.com/i, /tiktok\.com/i, /linkedin\.com/i,
    /\bsubscribe\b/i, /\bsign up\b/i, /\bdonate\b/i, /\bsupport\b/i,
    /\bshare\b/i, /\bnewsletter\b/i, /\badvertisement\b/i, /\bcookie\b/i,
    /\bprivacy policy\b/i, /\bterms of service\b/i, /\brelated articles?\b/i,
    /\bmore stories\b/i, /\bfollow us\b/i
  ];
  const lines = (text || "").replace(/\r\n/g, "\n").split(/\n/);
  const host = (() => { try { return new URL(url || "").hostname; } catch { return ""; } })();
  const filtered = lines.filter(l => {
    const s = l.trim();
    // 保留空行用于段落分隔
    if (s.length === 0) return true;
    if (s.length <= 2) return false;
    if (/^#{1,6}\s*(subscribe|newsletter|related|more)/i.test(s)) return false;
    if (/^[•\-\*]\s*(share|subscribe|donate)/i.test(s)) return false;
    if (/^[A-Z\s\|•\-]{8,}$/.test(s)) return false; // 菜单类
    if (ban.some(rx => rx.test(s))) return false;
    const linkCount = (s.match(/\[.*?\]\(https?:\/\/.*?\)/g) || []).length;
    if (linkCount >= 3) return false;
    if (host.includes("aeon.co")) {
      if (/^\[Image\s*\d+:/i.test(s)) return false;
      if (/^\d+\s+minutes!?$/i.test(s)) return false;
      if (/^Save$/i.test(s)) return false;
      if (/Get curated editors’ picks/i.test(s)) return false;
      if (/We publish hard-won knowledge/i.test(s)) return false;
      if (/Your donation/i.test(s)) return false;
      if (/Monthly\s+Annually\s+One-time/i.test(s)) return false;
      if (/Select amount/i.test(s)) return false;
      if (/\$\d+\s+per\s+month/i.test(s)) return false;
      if (/^Director:/i.test(s)) return false;
    }
    return true;
  });
  let out = filtered.join("\n");
  // 规范化多空行为双空行
  out = out.replace(/\n{3,}/g, "\n\n");
  // 句末标点后若只有单换行且下一行以大写字母开头，视为段落分隔并插入额外空行
  out = out.replace(/([.!?]["']?)\n(?=[A-Z])/g, "$1\n\n");
  return out.trim();
}

async function fetchFullText(url: string) {
  const clean = sanitizeUrl(url);
  const jinaUrl = `https://r.jina.ai/${clean}`;
  const maxRetries = 2;
  let retry = 0;
  while (retry <= maxRetries) {
    try {
      // 优先尝试使用选择器，仅抓取主要正文区域
      let res = await fetch(jinaUrl, { headers: { Accept: "application/json", "X-Target-Selector": "article, .article, .article-body, main, .main-content, .content__article-body" } });
      if (!res.ok && res.status === 422) {
        // 选择器导致断言失败时，回退到默认模式
        res = await fetch(jinaUrl, { headers: { Accept: "application/json" } });
      }
      if (!res.ok) {
        if ([401, 403, 451, 400].includes(res.status)) return "";
      } else {
        const body = await res.json();
        const data = body.data || body;
        let content = data.content || data.text || "";
        content = cleanContent(content, clean);
        const len = content.length;
        console.log("Jina fullText length:", len, clean);
        if (len >= 500) return content;
        return "";
      }
    } catch {}
    retry++;
    if (retry <= maxRetries) await new Promise(r => setTimeout(r, 1000 * retry));
  }
  return "";
}

async function generateAnalysis(content: string) {
  if (!DEEPSEEK_KEY) return null;
  const maxLen = 8000;
  const input = content.length > maxLen ? content.slice(0, maxLen) : content;
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${DEEPSEEK_KEY}`
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        {
          role: "system",
          content:
            "你是 LinguaFlow Pro 的英文精读导师。仅输出 JSON：translation_md、vocab_md、long_sentences_md。不要总结，不要改写原文。输入可能包含网页噪音（导航、社交链接、页脚信息）。请先识别并丢弃这些部分，只处理真实文章正文。"
        },
        {
          role: "user",
          content:
            "Please take the PROVIDED FULL TEXT and split it into 4 original paragraphs. Do not change the wording of the original English text. Provide Chinese translation for each. Also provide 8 core vocabulary analyses and 3 sets of long-sentence breakdowns. Output JSON fields: translation_md (bilingual Markdown), vocab_md (Markdown list), long_sentences_md (Markdown). Do not summarize.\n\nFULL TEXT:\n" +
            input
        }
      ],
      temperature: 0.2
    })
  });
  if (!response.ok) return null;
  const data = await response.json();
  const contentOut = data?.choices?.[0]?.message?.content || "";
  try {
    const parsed = JSON.parse(contentOut);
    if (
      typeof parsed?.translation_md === "string" &&
      typeof parsed?.vocab_md === "string" &&
      typeof parsed?.long_sentences_md === "string"
    ) {
      return parsed;
    }
  } catch {}
  return null;
}

const parser = new Parser();

// 定义我们要抓取的源
const SOURCES = [
  {
    name: 'The Guardian',
    url: 'https://www.theguardian.com/world/rss',
    logo: 'https://assets.guim.co.uk/images/ezticons/205e4b6c310c83a79493a3d567040441/favicon-32x32.ico'
  },
  {
    name: 'The Conversation',
    url: 'https://theconversation.com/global/articles.atom',
    logo: 'https://cdn.theconversation.com/static/tc/favicon.ico'
  },
  {
    name: 'CNBC Technology',
    url: 'https://www.cnbc.com/id/19854910/device/rss/rss.html',
    logo: 'https://sc.cnbcfm.com/applications/cnbc.com/staticcontent/img/cnbc_logo.gif'
  },
  {
    name: 'BBC Technology',
    url: 'http://feeds.bbci.co.uk/news/technology/rss.xml',
    logo: 'https://news.bbcimg.co.uk/nol/shared/img/bbc_news_120x60.gif'
  },
  {
    name: 'Aeon Essays',
    url: 'https://aeon.co/feed.rss',
    logo: 'https://aeon.co/favicon.ico'
  }
];

export async function fetchAndStoreArticles() {
  const results = [];

  for (const source of SOURCES) {
    try {
      console.log(`Fetching RSS feed for: ${source.name}`);
      const feed = await parser.parseURL(source.url);

      // 只要最新的 5 篇文章，避免一次处理太多超时
      const items = feed.items.slice(0, 5);

      for (const item of items) {
        if (!item.link) continue;

        // 1. 检查数据库是否已存在 (去重)
        const { data: existing } = await supabase
          .from('articles')
          .select('id')
          .eq('original_url', item.link)
          .single();

        if (existing) {
          console.log(`Skipping existing article: ${item.title}`);
          continue;
        }

        console.log(`Processing new article: ${item.title}`);

        let content = '';
        let title = item.title || 'Untitled';
        content = await fetchFullText(item.link);
        if (!content) {
          console.warn("Full text fetch failed, skip:", title);
          continue;
        }

        if (content.length < 500) {
          console.warn("Content below threshold, skip:", title);
          continue;
        }

        const { data: inserted, error } = await supabase
          .from('articles')
          .insert({
            title: title,
            content: content,
            original_url: item.link,
            source: source.name,
            published_at: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
            summary: null,
            status: 'unread'
          })
          .select('id')
          .single();

        if (error) {
          console.error(`Failed to insert article: ${title}`, error);
        } else {
          results.push({ title, source: source.name });
          if (inserted?.id) {
            try {
              const analysis = await generateAnalysis(content);
              if (analysis) {
                await supabase.from('article_analyses').insert({
                  article_id: inserted.id,
                  translation_md: analysis.translation_md,
                  vocab_md: analysis.vocab_md,
                  long_sentences_md: analysis.long_sentences_md
                });
              }
            } catch (e) {
              console.warn(`Analysis failed for: ${title}`, e);
            }
          }
        }
      }
    } catch (err) {
      console.error(`Error processing source ${source.name}:`, err);
    }
  }

  return results;
}
