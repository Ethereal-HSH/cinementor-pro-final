"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
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

      {/* 文章列表 */}
      <section>
        <div className="flex items-center justify-between mb-8 border-b border-gray-200 pb-4">
            <h2 className="text-2xl font-bold">最新推荐</h2>
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
                {articles.map((article) => (
                    <article key={article.id} className="group cursor-pointer">
                        <Link href={`/article/${article.id}`} className="block p-6 border border-gray-100 rounded-xl hover:border-gray-300 hover:shadow-sm transition bg-white">
                            <div className="flex flex-col md:flex-row gap-4 md:items-start justify-between mb-3">
                                <h3 className="text-2xl font-semibold leading-tight group-hover:text-blue-900 transition flex-1">
                                    {article.title}
                                </h3>
                                <span className="inline-block px-2 py-1 bg-gray-100 text-xs text-gray-600 rounded font-sans whitespace-nowrap">
                                    {article.source}
                                </span>
                            </div>
                            
                            <div className="flex items-center gap-4 text-sm text-gray-500 font-sans mt-4">
                                <span>
                                    {formatDistanceToNow(new Date(article.published_at), { addSuffix: true, locale: zhCN })}
                                </span>
                                {article.status === 'read' && (
                                    <span className="text-green-600 flex items-center gap-1">
                                        ✓ 已读
                                    </span>
                                )}
                            </div>
                        </Link>
                    </article>
                ))}

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
