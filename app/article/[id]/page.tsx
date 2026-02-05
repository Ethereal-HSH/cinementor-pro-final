"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase";

interface Paragraph {
  id: string;
  original: string;
  sentences: string[];
  translation: string | null;
  show?: boolean;
  loading?: boolean;
  isImage?: boolean; // 新增：标识是否为图片
  captionZh?: string | null;
  captionShow?: boolean;
  captionLoading?: boolean;
}

export default function ArticlePage() {
  const { id } = useParams();
  const [title, setTitle] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [paragraphs, setParagraphs] = useState<Paragraph[]>([]);
  const [selectedSentence, setSelectedSentence] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fullAnalysis, setFullAnalysis] = useState<{
    translation_md: string;
    vocab_md: string;
    long_sentences_md: string;
  } | null>(null);

  const normalizeImageSrc = (src: string) => {
    const s = (src || "").trim();
    const decoded = s
      .replace(/&amp;/g, "&")
      .replace(/&#38;/g, "&")
      .replace(/&#x26;/gi, "&");
    const t = decoded.replace(/[)\]]+$/g, "");
    if (decoded.startsWith("//")) return "https:" + decoded;
    if (/^https?:\/\//i.test(t)) return t;
    return "https://" + t.replace(/^\/+/, "");
  };

  const parseImageMarkdown = (p: string) => {
    const m = p.match(/^!\[(.*?)\]\(([^)]+)\)/);
    if (!m) return null;
    const alt = m[1] || "";
    const src = normalizeImageSrc(m[2] || "");
    return { alt, src };
  };

  const proxifyImage = (src: string) => {
    try {
      const u = new URL(src);
      const host = u.hostname;
      const needProxy = ['i.guim.co.uk','media.guim.co.uk','static.guim.co.uk','assets.guim.co.uk'].some(h => host.endsWith(h));
      if (needProxy) {
        return `/api/proxy-image?url=${encodeURIComponent(src)}`;
      }
      return src;
    } catch {
      return src;
    }
  };

  const cleanupParas = (arr: string[]) => {
    const cleaned = arr
      .map(s => s.replace(/\s+\n/g, "\n").trim())
      .map(s => s.replace(/\[View image in fullscreen\]\(#img-\d+\)/gi, ""))
      .map(s => s.replace(/Photograph:\s+[^\n]+/gi, ""))
      .map(s => s.replace(/!?\[([^\]]+)\]\(([^)]+)\)/g, (full, txt) => full.startsWith('!') ? full : txt)) // 链接转纯文本，保留图片
      .filter(s => s.length > 0 && !/^Share this|Sign up|Support the Guardian/i.test(s))
      .filter(s => !/Explore more on these topics|Reuse this content|mailto:/i.test(s));
    // 去重
    const set = new Set<string>();
    const unique: string[] = [];
    for (const s of cleaned) {
      const key = s.replace(/\s+/g, " ").toLowerCase();
      if (!set.has(key)) {
        set.add(key);
        unique.push(s);
      }
    }
    return unique;
  };

  useEffect(() => {
    if (id) {
      fetchArticle(id as string);
    }
  }, [id]);

  const splitIntoSentences = (text: string) => {
    return text.match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g)?.map(s => s.trim()).filter(s => s.length > 0) || [text];
  };

  const fetchArticle = async (articleId: string) => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('articles')
        .select('*')
        .eq('id', articleId)
        .single();

      if (error) throw error;
      if (!data) throw new Error("Article not found");

      setTitle(data.title);
      setSource(data.source);

      // 优先使用 raw_markdown，如果为空则回退到 content
      let content = data.raw_markdown || data.content || "";
      
      // 如果两者都为空或太短，尝试实时抓取
      if (!content || content.length < 500) {
        try {
          const res = await fetch("/api/read", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: data.original_url, article_id: articleId })
          });
          const rd = await res.json();
          const fetched = rd.content || "";
          if (fetched && fetched.length > 0) {
            content = fetched;
          }
        } catch (e) {
          console.warn("On-demand content fetch failed", e);
        }
      }
      
      const rawParas = cleanupParas(content.split(/\n\n+/).filter((p: string) => p.trim().length > 0));
      
      const processedParas = rawParas.map((p: string, idx: number) => {
        const img = parseImageMarkdown(p);
        if (img) {
          return {
            id: `para-${idx}`,
            original: p,
            sentences: [img.src],
            translation: img.alt,
            show: true,
            loading: false,
            isImage: true,
            captionZh: null,
            captionShow: false,
            captionLoading: false
          };
        }

        return {
            id: `para-${idx}`,
            original: p,
            sentences: splitIntoSentences(p),
            translation: null,
            show: false,
            loading: false,
            isImage: false
        };
      });

      setParagraphs(processedParas);

      // 更新状态为已读 (如果需要)
      if (data.status === 'unread') {
        await supabase.from('articles').update({ status: 'reading' }).eq('id', articleId);
      }

      const { data: ana } = await supabase
        .from('article_analyses')
        .select('translation_md, vocab_md, long_sentences_md, created_at')
        .eq('article_id', articleId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (ana) {
        setFullAnalysis({
          translation_md: ana.translation_md,
          vocab_md: ana.vocab_md,
          long_sentences_md: ana.long_sentences_md
        });
      } else {
        setFullAnalysis(null);
      }

    } catch (e) {
      console.error(e);
      alert("加载文章失败");
    } finally {
      setLoading(false);
    }
  };

  const handleToggleCaption = async (idx: number) => {
    const para = paragraphs[idx];
    if (!para.isImage) return;
    const baseText = para.translation || "";
    if (!baseText.trim()) return;
    if (para.captionZh) {
      setParagraphs(prev => prev.map((p, i) => i === idx ? { ...p, captionShow: !p.captionShow } : p));
      return;
    }
    setParagraphs(prev => prev.map((p, i) => i === idx ? { ...p, captionLoading: true } : p));
    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: [baseText] })
      });
      const data = await res.json();
      const t = Array.isArray(data.translation) ? data.translation[0] : data.translation;
      setParagraphs(prev => prev.map((p, i) => i === idx ? { ...p, captionZh: t || "翻译失败", captionShow: true } : p));
    } catch (e) {
      console.error(e);
      setParagraphs(prev => prev.map((p, i) => i === idx ? { ...p, captionZh: "翻译失败", captionShow: true } : p));
    } finally {
      setParagraphs(prev => prev.map((p, i) => i === idx ? { ...p, captionLoading: false } : p));
    }
  };

  const handleAnalyze = async (sentence: string) => {
    setSelectedSentence(sentence);
    setAnalysis(null);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sentence })
      });
      const data = await res.json();
      setAnalysis(data.analysis);
    } catch (e) {
      console.error(e);
      setAnalysis("解析服务暂时不可用");
    }
  };

  const handleToggleParagraph = async (idx: number) => {
    const para = paragraphs[idx];
    if (para.isImage) return; // 图片无需翻译

    if (para.translation) {
      setParagraphs(prev => prev.map((p, i) => i === idx ? { ...p, show: !p.show } : p));
      return;
    }
    setParagraphs(prev => prev.map((p, i) => i === idx ? { ...p, loading: true } : p));
    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: [para.original] })
      });
      const data = await res.json();
      const t = Array.isArray(data.translation) ? data.translation[0] : data.translation;
      setParagraphs(prev => prev.map((p, i) => i === idx ? { ...p, translation: t || "翻译失败", show: true } : p));
    } catch (e) {
      console.error(e);
      setParagraphs(prev => prev.map((p, i) => i === idx ? { ...p, translation: "翻译失败", show: true } : p));
    } finally {
      setParagraphs(prev => prev.map((p, i) => i === idx ? { ...p, loading: false } : p));
    }
  };

  if (loading) {
    return <div className="flex justify-center items-center h-screen">加载中...</div>;
  }

  return (
    <main className="max-w-6xl mx-auto px-6 py-10 font-serif grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-12">
      <section>
        <header className="mb-10">
          <div className="mb-4">
            <Link
              href="/"
              aria-label="返回主界面"
              title="返回主界面"
              className="inline-flex items-center justify-center w-8 h-8 rounded-full text-gray-400 hover:text-black focus:outline-none focus-visible:ring-1 focus-visible:ring-gold"
            >
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M15 6l-6 6 6 6" />
                <path d="M3 12h12" />
              </svg>
            </Link>
          </div>
          <div className="text-sm text-gray-500 mb-2 uppercase tracking-widest">{source}</div>
          <h1 className="text-4xl font-bold mb-8 leading-tight text-gray-900">{title}</h1>
          
          <div className="flex items-center justify-between border-b border-gray-200 pb-4 mb-6">
             <span className="text-sm text-gray-500">共 {paragraphs.length} 个段落</span>
          </div>
        </header>

        <article className="prose prose-lg prose-gray max-w-none">
          {paragraphs.map((para, idx) => (
            <div key={para.id} className="mb-8 group">
              {para.isImage ? (
                  <figure className="my-6">
                      <img 
                        src={proxifyImage(normalizeImageSrc(para.sentences[0]))} 
                        alt={para.translation || "Article Image"} 
                        className="w-full min-h-[200px] bg-gray-100 rounded-lg shadow-md"
                        loading="lazy"
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                          const placeholder = e.currentTarget.nextElementSibling;
                          if (placeholder instanceof HTMLElement) {
                            placeholder.style.display = 'flex';
                          }
                        }}
                      />
                      <div style={{display:'none'}} className="w-full min-h-[200px] bg-gray-100 rounded-lg flex items-center justify-center text-gray-400 text-sm">
                        图片加载失败
                      </div>
                      <div className="flex justify-center mt-2">
                        <div className="inline-flex items-center gap-2">
                          {para.translation && <figcaption className="text-sm text-gray-500">{para.translation}</figcaption>}
                          <button
                          aria-label={para.captionLoading ? "译文生成中..." : (para.captionShow ? "隐藏图片说明译文" : "翻译图片说明")}
                          title={para.captionLoading ? "译文生成中..." : (para.captionShow ? "隐藏图片说明译文" : "翻译图片说明")}
                          className={`inline-flex items-center justify-center w-6 h-6 rounded-full transition-opacity transition-transform duration-200 text-gray-500 hover:text-ink ${para.captionLoading ? 'cursor-wait' : ''}`}
                          onClick={() => handleToggleCaption(idx)}
                          disabled={para.captionLoading}
                        >
                          {para.captionLoading ? (
                            <svg viewBox="0 0 24 24" className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" strokeWidth="1.5">
                              <circle cx="12" cy="12" r="9" opacity="0.25" />
                              <path d="M12 3a9 9 0 0 1 9 9" />
                            </svg>
                          ) : (
                            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5">
                              <path d="M20 3c-3 0-6 1.5-8 3.5L6 12l-2 6 6-2 5.5-6c2-2 3.5-5 3.5-8z" />
                              <path d="M14 7l3 3" />
                              <path d="M6 12l6 6" />
                            </svg>
                          )}
                          </button>
                        </div>
                      </div>
                      {para.captionShow && (
                        <div className={`mt-2 px-3 py-2 bg-gray-50 rounded border border-gray-100 text-gray-700 text-sm leading-relaxed transition-opacity duration-500 inline-block mx-auto ${para.captionZh ? 'opacity-100' : 'opacity-50'} text-center`}>
                          {para.captionZh || (para.captionLoading ? "译文生成中..." : "暂无译文")}
                        </div>
                      )}
                  </figure>
              ) : (
                <>
                  <p className="leading-loose text-gray-900 mb-3">
                    {para.sentences.map((s, sIdx) => (
                      <span
                        key={sIdx}
                        className={`cursor-pointer transition duration-200 rounded px-1 -mx-1 
                          ${selectedSentence === s ? 'bg-yellow-200' : 'hover:bg-yellow-100'}`}
                        onClick={() => handleAnalyze(s)}
                      >
                        {s}{" "}
                      </span>
                    ))}
                  </p>
                  <div className="mb-2">
                    <button
                      aria-label={para.loading ? "译文生成中..." : (para.show ? "隐藏该段译文" : "翻译该段")}
                      title={para.loading ? "译文生成中..." : (para.show ? "隐藏该段译文" : "翻译该段")}
                      className={`inline-flex items-center justify-center w-6 h-6 rounded-full transition-opacity transition-transform duration-200 opacity-0 group-hover:opacity-100 group-hover:translate-y-0 translate-y-1 focus:outline-none focus-visible:ring-1 focus-visible:ring-gold ${para.loading ? 'cursor-wait' : ''} ${para.show ? 'text-gold' : 'text-gray-500'} hover:text-ink`}
                      onClick={() => handleToggleParagraph(idx)}
                      disabled={para.loading}
                    >
                      {para.loading ? (
                        <svg viewBox="0 0 24 24" className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <circle cx="12" cy="12" r="9" opacity="0.25" />
                          <path d="M12 3a9 9 0 0 1 9 9" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <path d="M20 3c-3 0-6 1.5-8 3.5L6 12l-2 6 6-2 5.5-6c2-2 3.5-5 3.5-8z" />
                          <path d="M14 7l3 3" />
                          <path d="M6 12l6 6" />
                        </svg>
                      )}
                    </button>
                  </div>
                  
                  {para.show && (
                    <div className={`mt-2 p-4 bg-gray-50 rounded border border-gray-100 text-gray-700 text-base leading-relaxed transition-opacity duration-500 ${para.translation ? 'opacity-100' : 'opacity-50'}`}>
                      {para.translation || (para.loading ? "译文生成中..." : "暂无译文")}
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </article>
      </section>

      <aside className="hidden lg:block">
        <div className="sticky top-8 h-[calc(100vh-4rem)] overflow-y-auto">
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 min-h-[500px] flex flex-col">
            <div className="flex items-center gap-2 mb-6 pb-4 border-b border-gray-100">
               <div className="w-2 h-8 bg-black rounded-full"></div>
               <h3 className="text-xl font-bold">AI 导师解析</h3>
            </div>

            {!selectedSentence ? (
              <div className="prose prose-sm prose-p:text-gray-600 prose-headings:font-bold prose-headings:text-black">
                {fullAnalysis ? (
                  <div className="space-y-6">
                    <div>
                      <h4 className="text-lg font-semibold mb-2">四段式中英对照</h4>
                      <div className="whitespace-pre-wrap">{fullAnalysis.translation_md}</div>
                    </div>
                    <div>
                      <h4 className="text-lg font-semibold mb-2">考点词汇辨析</h4>
                      <div className="whitespace-pre-wrap">{fullAnalysis.vocab_md}</div>
                    </div>
                    <div>
                      <h4 className="text-lg font-semibold mb-2">长难句拆解</h4>
                      <div className="whitespace-pre-wrap">{fullAnalysis.long_sentences_md}</div>
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center text-gray-400 text-center p-4">
                    <svg className="w-12 h-12 mb-4 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
                    <p>点击左侧正文中任意句子<br/>获取语法拆解与词汇分析</p>
                  </div>
                )}
              </div>
            ) : (
                <div className="prose prose-sm prose-p:text-gray-600 prose-headings:font-bold prose-headings:text-black">
                    <div className="whitespace-pre-wrap">{analysis || "分析中..."}</div>
                </div>
            )}
          </div>
        </div>
      </aside>
    </main>
  );
}
