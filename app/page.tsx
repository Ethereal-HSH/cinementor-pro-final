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
  summary_zh?: string | null;
  status: 'unread' | 'reading' | 'read';
}

const formatSummary = (s: string | null) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t;
};

export default function HomePage() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const SOURCE_ORDER = ["The Guardian","The Conversation","CNBC Technology","Aeon Essays"];
  const [activeSource, setActiveSource] = useState<string>(SOURCE_ORDER[0]);
  const [repairingId, setRepairingId] = useState<string | null>(null);
  const [repairingSource, setRepairingSource] = useState(false);
  const [translatingSummaries, setTranslatingSummaries] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<{ source: string; scrollY: number } | null>(null);

  useEffect(() => {
    fetchArticles();
  }, []);

  useEffect(() => {
    try {
      const restore = sessionStorage.getItem('home.restore') === '1';
      if (!restore) return;
      const source = sessionStorage.getItem('home.activeSource') || SOURCE_ORDER[0];
      const scrollY = parseInt(sessionStorage.getItem('home.scrollY') || '0', 10) || 0;
      setActiveSource(SOURCE_ORDER.includes(source) ? source : SOURCE_ORDER[0]);
      setPendingRestore({ source, scrollY });
    } catch {}
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!pendingRestore) return;
    try {
      window.scrollTo({ top: Math.max(0, pendingRestore.scrollY), behavior: 'auto' });
      sessionStorage.removeItem('home.restore');
      setPendingRestore(null);
    } catch {
      setPendingRestore(null);
    }
  }, [loading, pendingRestore]);

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

  const ensureSummaryZh = async (ids: string[]) => {
    const list = Array.from(new Set(ids.map(x => String(x || '').trim()).filter(Boolean))).slice(0, 10);
    if (list.length === 0) return;
    setTranslatingSummaries(true);
    try {
      const res = await fetch('/api/admin/ensure-summary-zh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: list })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) return;
      const results = data?.results || {};
      setArticles(prev => prev.map(a => {
        const zh = results[a.id];
        if (!zh) return a;
        return { ...a, summary_zh: zh };
      }));
    } catch (e) {
      console.error(e);
    } finally {
      setTranslatingSummaries(false);
    }
  };

  useEffect(() => {
    if (loading) return;
    if (translatingSummaries) return;
    const visible = articles
      .filter(a => a.source === activeSource)
      .filter(a => formatSummary(a.summary) && !formatSummary(a.summary_zh || null))
      .slice(0, 6)
      .map(a => a.id);
    if (visible.length === 0) return;
    ensureSummaryZh(visible);
  }, [loading, translatingSummaries, activeSource, articles]);

  const triggerFetch = async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/cron/fetch");
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.success) {
        throw new Error(payload?.error || payload?.message || `HTTP ${res.status}`);
      }
      if (Array.isArray(payload?.data) && payload.data.length === 0) {
        alert("没有抓取到新文章（可能已是最新）");
      }
      await fetchArticles();
    } catch (e) {
      console.error(e);
      alert("抓取失败，请检查网络或配置");
    } finally {
      setRefreshing(false);
    }
  };

  const handleRepair = async (articleId: string) => {
    if (!articleId) return;
    setRepairingId(articleId);
    try {
      const res = await fetch('/api/admin/repair-article', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: articleId })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      await fetchArticles();
      alert(`修复完成：${data.action || 'ok'}（${data.beforeLen} → ${data.afterLen}）`);
    } catch (e) {
      console.error(e);
      alert('修复失败，请稍后重试');
    } finally {
      setRepairingId(null);
    }
  };

  const handleRepairSource = async (source: string) => {
    const src = String(source || '').trim();
    if (!src) return;
    const ok = confirm(`将对“${src}”执行批量清洗/重抓，可能耗时 1-3 分钟。继续吗？`);
    if (!ok) return;
    setRepairingSource(true);
    try {
      const res = await fetch('/api/admin/repair-source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: src, limit: 500, force: true, dryRun: false, recrawl: true })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      await fetchArticles();
      alert(`批量清洗完成：updated=${data.updated}, failed=${data.failed}, scanned=${data.scanned}`);
    } catch (e) {
      console.error(e);
      alert('批量清洗失败，请稍后重试');
    } finally {
      setRepairingSource(false);
    }
  };

  const markLeavingHome = () => {
    try {
      sessionStorage.setItem('home.restore', '1');
      sessionStorage.setItem('home.activeSource', activeSource);
      sessionStorage.setItem('home.scrollY', String(window.scrollY || 0));
    } catch {}
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
            <div className="flex items-center gap-3">
              <button
                onClick={() => { if (!repairingSource) handleRepairSource(activeSource); }}
                disabled={repairingSource}
                className={`px-3 py-1.5 rounded-full text-sm font-sans border transition ${repairingSource ? 'cursor-wait opacity-70 border-gray-200 text-gray-400' : 'bg-white text-gray-700 border-gray-200 hover:border-gray-400 hover:text-black'}`}
                title={repairingSource ? '清洗中...' : '批量清洗当前来源'}
              >
                {repairingSource ? '清洗中…' : '清洗当前来源'}
              </button>
              <span className="text-sm text-gray-500 font-sans">
                {articles.length > 0 ? `已更新 ${articles.length} 篇` : "暂无文章"}
              </span>
            </div>
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
                        <Link
                          href={`/article/${article.id}`}
                          onClick={() => markLeavingHome()}
                          className="block p-6 border border-gray-100 rounded-xl hover:border-gray-300 hover:shadow-sm transition bg-white"
                        >
                          <h4 className="text-lg font-semibold leading-tight group-hover:text-blue-900 transition">
                            {article.title}
                          </h4>
                          {formatSummary(article.summary) && (
                            <div className="mt-2 text-sm text-gray-500 font-sans leading-relaxed">
                              {formatSummary(article.summary)}
                            </div>
                          )}
                          {formatSummary(article.summary_zh || null) && (
                            <div className="mt-1 text-sm text-gray-600 font-sans leading-relaxed">
                              {formatSummary(article.summary_zh || null)}
                            </div>
                          )}
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

                            <button
                              aria-label={repairingId === article.id ? '修复中...' : '修复该文章'}
                              title={repairingId === article.id ? '修复中...' : '修复该文章'}
                              className={`ml-auto inline-flex items-center justify-center w-7 h-7 rounded-full border text-xs transition ${repairingId === article.id ? 'cursor-wait opacity-70 border-gray-200 text-gray-400' : 'border-gray-200 text-gray-600 hover:text-black hover:border-gray-400'}`}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                if (repairingId) return;
                                handleRepair(article.id);
                              }}
                              disabled={!!repairingId}
                            >
                              {repairingId === article.id ? '…' : '修'}
                            </button>
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
