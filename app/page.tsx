"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { formatDistanceToNow, format } from "date-fns";
import { zhCN } from "date-fns/locale";

interface Article {
  id: string;
  title: string;
  source: string;
  published_at: string;
  summary: string | null;
  status: 'unread' | 'reading' | 'read';
}

export default function HomePage() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const SOURCE_ORDER = ["The Guardian","The Conversation","CNBC Technology","Aeon Essays"];
  const [activeSource, setActiveSource] = useState<string>(SOURCE_ORDER[0]);

  useEffect(() => {
    fetchArticles();
  }, []);

  const fetchArticles = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/articles");
      const data = await res.json();
      setArticles(data.articles || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const triggerFetch = async () => {
    setRefreshing(true);
    try {
      await fetch("/api/cron/fetch");
      await fetchArticles();
    } catch (e) {
      console.error(e);
      alert("抓取失败，请检查网络或配置");
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <main className="max-w-4xl mx-auto px-6 py-10 font-serif">
      <header className="mb-12 flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h1 className="text-5xl font-bold italic mb-3 text-gray-900">LinguaFlow Pro</h1>
          <p className="text-gray-600">全球顶级外刊精读 · 每日自动更新</p>
        </div>
        <div className="flex gap-3">
            <button 
                onClick={triggerFetch}
                disabled={refreshing}
                className="px-4 py-2 bg-black text-white rounded hover:bg-gray-800 disabled:opacity-50 text-sm font-sans transition flex items-center gap-2"
            >
                {refreshing ? (
                    <span className="animate-spin">↻</span>
                ) : (
                    <span>↻</span>
                )}
                {refreshing ? "正在采集..." : "刷新外刊"}
            </button>
        </div>
      </header>

      <section>
        <div className="flex items-center justify-between mb-6">
            <div className="flex flex-wrap gap-2">
              {SOURCE_ORDER.map(src => {
                const count = articles.filter(a => a.source === src).length;
                const active = activeSource === src;
                return (
                  <button
                    key={src}
                    onClick={() => setActiveSource(src)}
                    className={`px-3 py-1.5 rounded-full text-sm font-sans border transition ${active ? 'bg-black text-white border-black' : 'bg-white text-gray-700 border-gray-200 hover:border-gray-400'}`}
                  >
                    {src} {count > 0 ? `(${count})` : ''}
                  </button>
                );
              })}
            </div>
            <span className="text-sm text-gray-500 font-sans">
              {articles.length > 0 ? `已更新 ${articles.length} 篇` : "暂无文章"}
            </span>
        </div>

        {loading ? (
            <div className="space-y-6">
                {[1, 2, 3].map(i => (
                    <div key={i} className="animate-pulse">
                        <div className="h-6 bg-gray-200 rounded w-3/4 mb-3"></div>
                        <div className="h-4 bg-gray-200 rounded w-1/4"></div>
                    </div>
                ))}
            </div>
        ) : (
            <div className="space-y-8">
                {articles.filter(a => a.source === activeSource).length === 0 ? (
                  <div className="text-center py-16 bg-gray-50 rounded-lg border border-dashed border-gray-300">
                    <p className="text-gray-500">该来源暂无文章</p>
                  </div>
                ) : (
                  articles
                    .filter(a => a.source === activeSource)
                    .map(article => (
                      <article key={article.id} className="group cursor-pointer">
                        <Link href={`/article/${article.id}`} className="block p-6 border border-gray-100 rounded-xl hover:border-gray-300 hover:shadow-sm transition bg-white">
                          <h4 className="text-lg font-semibold leading-tight group-hover:text-blue-900 transition">
                            {article.title}
                          </h4>
                          <div className="flex items-center gap-4 text-sm text-gray-500 font-sans mt-3">
                            <span className="whitespace-nowrap">
                              {format(new Date(article.published_at), "yyyy-MM-dd")}
                            </span>
                            <span className="whitespace-nowrap">
                              {formatDistanceToNow(new Date(article.published_at), { addSuffix: true, locale: zhCN })}
                            </span>
                            {Date.now() - new Date(article.published_at).getTime() < 2 * 24 * 60 * 60 * 1000 && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded bg-green-100 text-green-700 text-xs font-medium">
                                New
                              </span>
                            )}
                            {article.status === 'read' && (
                              <span className="text-green-600 flex items-center gap-1">
                                ✓ 已读
                              </span>
                            )}
                          </div>
                        </Link>
                      </article>
                    ))
                )}

                {articles.length === 0 && (
                    <div className="text-center py-20 bg-gray-50 rounded-lg border border-dashed border-gray-300">
                        <p className="text-gray-500 mb-4">暂无已抓取的文章</p>
                        <button 
                            onClick={triggerFetch}
                            className="text-blue-600 hover:underline"
                        >
                            立即触发云端采集
                        </button>
                    </div>
                )}
            </div>
        )}
      </section>
    </main>
  );
}
