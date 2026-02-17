import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { cleanContent, fetchArticleMarkdown } from '@/lib/crawler';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function minLenFor(source: string, url?: string) {
  if (source === 'CNBC Technology') return 200;
  if (source === 'Aeon Essays') {
    const u = String(url || '');
    if (u.includes('aeon.co/videos/')) return 120;
    return 1000;
  }
  return 800;
}

function looksBadFormatting(md: string, source: string, url?: string) {
  const s = String(md || '');
  if (!s.trim()) return true;
  if (!s.includes('\n') && s.includes('\\n')) return true;
  if (/<\s*br\b|<\s*p\b|<\s*\/\s*p\s*>/i.test(s)) return true;

  if (source === 'Aeon Essays') {
    const listing = ((s.match(/\b\d+\s+minutes!\[/gi) || []).length >= 5)
      && ((s.match(/^##\s+/gmi) || []).length >= 5)
      && ((s.match(/!\[[^\]]*\]\([^\)]+\)/g) || []).length >= 5);
    if (listing) return true;
  }

  const minLen = minLenFor(source, url);
  if (s.length < minLen) return true;

  const nlp = (s.match(/\n\n/g) || []).length;
  if (s.length > 2000 && nlp < 2) return true;
  if (s.length > 4000 && nlp < 4) return true;
  return false;
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({} as any));
    const source = String(body?.source || '').trim();
    const limit = Math.max(1, Math.min(2000, parseInt(String(body?.limit || '500'), 10) || 500));
    const force = Boolean(body?.force);
    const dryRun = Boolean(body?.dryRun);
    const recrawl = body?.recrawl === undefined ? true : Boolean(body?.recrawl);
    const clean = body?.clean === undefined ? true : Boolean(body?.clean);
    const deleteOnFail = Boolean(body?.deleteOnFail);
    const hardDeleteOnFail = Boolean(body?.hardDeleteOnFail);
    const retryAfterDelete = body?.retryAfterDelete === undefined ? true : Boolean(body?.retryAfterDelete);
    const forceDelete = Boolean(body?.forceDelete);

    if (!source) {
      return NextResponse.json({ success: false, error: 'missing source' }, { status: 400 });
    }

    const pageSize = 50;
    let offset = 0;
    const startedAt = Date.now();
    const timeLimitMs = 250000;

    let scanned = 0;
    let ok = 0;
    let bad = 0;
    let recrawled = 0;
    let updated = 0;
    let cleaned = 0;
    let failed = 0;
    let purged = 0;
    let deleted = 0;
    let reinserted = 0;
    const samples: Array<{ id: string; url: string; action: string; beforeLen: number; afterLen: number }>
      = [];

    while (true) {
      if (Date.now() - startedAt > timeLimitMs) break;
      if (scanned >= limit) break;

      const { data: rows, error } = await supabase
        .from('articles')
        .select('id, title, source, original_url, raw_markdown, content, published_at, summary, status')
        .eq('source', source)
        .order('published_at', { ascending: false })
        .range(offset, offset + pageSize - 1);

      if (error) throw error;
      if (!rows || rows.length === 0) break;

      for (const row of rows) {
        if (Date.now() - startedAt > timeLimitMs) break;
        if (scanned >= limit) break;
        scanned++;

        const url = String(row.original_url || '');
        const before = String(row.raw_markdown || row.content || '');
        let next = before;
        let localAction = '';
        if (clean && source === 'Aeon Essays') {
          const washed = cleanContent(next, url);
          if (washed && washed !== next) {
            next = washed;
            localAction = localAction ? `${localAction}+cleaned` : 'cleaned';
            cleaned++;
          }
        }

        const stillBad = force || looksBadFormatting(next, source, url);
        const localChanged = next !== before;

        if (!stillBad) {
          ok++;
          if (localChanged && !dryRun) {
            const { error: uerr0 } = await supabase
              .from('articles')
              .update({ raw_markdown: next })
              .eq('id', row.id);
            if (!uerr0) {
              updated++;
              if (samples.length < 20) {
                samples.push({
                  id: row.id,
                  url: String(row.original_url || ''),
                  action: localAction || 'cleaned',
                  beforeLen: before.length,
                  afterLen: next.length
                });
              }
            }
          } else if (localChanged && dryRun && samples.length < 20) {
            samples.push({
              id: row.id,
              url: String(row.original_url || ''),
              action: localAction ? `would_${localAction}` : 'would_clean',
              beforeLen: before.length,
              afterLen: next.length
            });
          }
          continue;
        }

        bad++;
        if (!recrawl) {
          if (localChanged && !dryRun) {
            const { error: uerr0 } = await supabase
              .from('articles')
              .update({ raw_markdown: next })
              .eq('id', row.id);
            if (!uerr0) updated++;
          }
          continue;
        }

        const fetched = await fetchArticleMarkdown(url, source);
        const md = String(fetched?.markdown || '');
        const title = String(fetched?.title || '').trim();
        const minLen = minLenFor(source, url);
        if (!md || md.length < minLen) {
          failed++;

          if (deleteOnFail && !dryRun) {
            const { count: anaCount, error: aerr } = await supabase
              .from('article_analyses')
              .select('id', { count: 'exact', head: true })
              .eq('article_id', row.id);

            if (!aerr && (forceDelete || (anaCount || 0) === 0)) {
              if (hardDeleteOnFail) {
                const { error: derr } = await supabase.from('articles').delete().eq('id', row.id);
                if (!derr) {
                  deleted++;

                  if (retryAfterDelete) {
                    const fetched2 = await fetchArticleMarkdown(url, source);
                    const md2 = String(fetched2?.markdown || '');
                    const title2 = String(fetched2?.title || '').trim();
                    if (md2 && md2.length >= minLen) {
                      const payload: Record<string, any> = {
                        id: row.id,
                        title: title2 || String(row.title || ''),
                        original_url: String(row.original_url || ''),
                        source,
                        published_at: row.published_at,
                        summary: row.summary || null,
                        status: row.status || 'unread',
                        content: '',
                        raw_markdown: md2
                      };
                      const { error: ierr } = await supabase.from('articles').insert(payload);
                      if (!ierr) {
                        reinserted++;
                        if (samples.length < 20) {
                          samples.push({
                            id: row.id,
                            url: String(row.original_url || ''),
                            action: 'deleted+reinserted',
                            beforeLen: before.length,
                            afterLen: md2.length
                          });
                        }
                      }
                    }
                  }
                }
              } else {
                const shouldPurge = before.length < minLen;
                if (shouldPurge) {
                  const { error: perr } = await supabase
                    .from('articles')
                    .update({ raw_markdown: '', content: '' })
                    .eq('id', row.id);
                  if (!perr) purged++;
                }

                if (retryAfterDelete) {
                  const fetched2 = await fetchArticleMarkdown(url, source);
                  const md2 = String(fetched2?.markdown || '');
                  const title2 = String(fetched2?.title || '').trim();
                  if (md2 && md2.length >= minLen) {
                    const payload: Record<string, any> = { raw_markdown: md2 };
                    if (title2 && title2 !== String(row.title || '').trim()) payload.title = title2;
                    const { error: uerr2 } = await supabase.from('articles').update(payload).eq('id', row.id);
                    if (!uerr2) {
                      updated++;
                      if (samples.length < 20) {
                        samples.push({
                          id: row.id,
                          url: String(row.original_url || ''),
                          action: shouldPurge ? 'purged+recrawled' : 'recrawled',
                          beforeLen: before.length,
                          afterLen: md2.length
                        });
                      }
                    }
                  }
                }
              }
            }
          }

          continue;
        }

        recrawled++;
        const doUpdate = !dryRun && (md !== before || force);
        if (doUpdate) {
          const payload: Record<string, any> = { raw_markdown: md };
          if (title && title !== String(row.title || '').trim()) payload.title = title;
          const { error: uerr } = await supabase.from('articles').update(payload).eq('id', row.id);
          if (uerr) {
            failed++;
            continue;
          }
          updated++;
        }

        if (samples.length < 20) {
          samples.push({
            id: row.id,
            url: String(row.original_url || ''),
            action: dryRun ? 'would_recrawl' : 'recrawled',
            beforeLen: before.length,
            afterLen: md.length
          });
        }
      }

      offset += pageSize;
    }

    return NextResponse.json({
      success: true,
      source,
      limit,
      dryRun,
      force,
      recrawl,
      clean,
      deleteOnFail,
      hardDeleteOnFail,
      retryAfterDelete,
      forceDelete,
      scanned,
      ok,
      bad,
      recrawled,
      updated,
      cleaned,
      failed,
      purged,
      deleted,
      reinserted,
      samples
    });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
