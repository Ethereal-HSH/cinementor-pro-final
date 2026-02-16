import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { fetchArticleMarkdown } from '@/lib/crawler';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function decodeUrlEntities(u: string) {
  return (u || '')
    .replace(/&amp;/g, '&')
    .replace(/&#38;/g, '&')
    .replace(/&#x26;/gi, '&');
}

function stripHtmlTags(text: string) {
  return (text || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*p\b[^>]*>/gi, '')
    .replace(/<\s*\/\s*p\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
}

function normalizeGuardianStoredMarkdown(md: string) {
  let s = (md || '').replace(/\r/g, '');
  if (!s.includes('\n') && s.includes('\\n')) {
    s = s.replace(/\\r/g, '').replace(/\\n/g, '\n');
  }

  const fixUtf8Mojibake = (input: string) => {
    const raw = input || '';
    if (!/[ÃÂâ]/.test(raw)) return raw;
    try {
      const bytes = Uint8Array.from(Array.from(raw, ch => ch.charCodeAt(0) & 0xff));
      const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      if (!decoded) return raw;
      if (decoded.includes('\uFFFD')) return raw;
      const badBefore = (raw.match(/[ÃÂâ]/g) || []).length;
      const badAfter = (decoded.match(/[ÃÂâ]/g) || []).length;
      if (badAfter <= badBefore) return decoded;
      return raw;
    } catch {
      return raw;
    }
  };

  const fixSmartPunctuationArtifacts = (input: string) => {
    let s = input || '';
    s = s.replace(/[\u200b\u00a0\u00ad\ufeff]/g, '');
    s = s
      .replace(/\u00c2\s/g, ' ')
      .replace(/\u00c2/g, '')
      .replace(/\u00e2\u20ac\u2122/g, '’')
      .replace(/\u00e2\u0080\u0099/g, '’')
      .replace(/\u00e2\u20ac\u02dc/g, '‘')
      .replace(/\u00e2\u0080\u0098/g, '‘')
      .replace(/\u00e2\u20ac\u0153/g, '“')
      .replace(/\u00e2\u0080\u009c/g, '“')
      .replace(/\u00e2\u20ac\u009d/g, '”')
      .replace(/\u00e2\u0080\u009d/g, '”')
      .replace(/\u00e2\u20ac\u2013/g, '–')
      .replace(/\u00e2\u0080\u0093/g, '–')
      .replace(/\u00e2\u20ac\u2014/g, '—')
      .replace(/\u00e2\u0080\u0094/g, '—')
      .replace(/\u00e2\u20ac\u2026/g, '…')
      .replace(/\u00e2\u0080\u00a6/g, '…')
      .replace(/\u00e2\u20ac\u2022/g, '•')
      .replace(/\u00e2\u0080\u00a2/g, '•')
      .replace(/\u00e2\u201e\u00a2/g, '™')
      .replace(/\u00e2\u0084\u00a2/g, '™');

    s = s.replace(/[\u0080-\u009f]/g, '');

    s = s
      .replace(/([A-Za-z])\u00e2[\u200b\u00a0\u00ad\ufeff]*s\b/g, "$1’s")
      .replace(/([A-Za-z])\u00e2[\u0080-\u009f\u200b\u00a0\u00ad\ufeff]*s\b/g, "$1’s")
      .replace(/([A-Za-z]s)\u00e2[\u200b\u00a0\u00ad\ufeff]*\s/g, "$1’ ")
      .replace(/([A-Za-z]s)\u00e2[\u0080-\u009f\u200b\u00a0\u00ad\ufeff]*\s/g, "$1’ ")
      .replace(/n\u00e2t\b/gi, "n’t")
      .replace(/n\u00e2[\u0080-\u009f]*t\b/gi, "n’t")
      .replace(/I\u00e2m\b/g, "I’m")
      .replace(/I\u00e2[\u0080-\u009f]*m\b/g, "I’m")
      .replace(/we\u00e2re\b/gi, "we’re")
      .replace(/you\u00e2re\b/gi, "you’re")
      .replace(/they\u00e2re\b/gi, "they’re")
      .replace(/it\u00e2s\b/gi, "it’s")
      .replace(/that\u00e2s\b/gi, "that’s")
      .replace(/there\u00e2s\b/gi, "there’s");
    return s;
  };

  s = fixSmartPunctuationArtifacts(fixUtf8Mojibake(s));
  s = stripHtmlTags(s);
  s = s
    .replace(/\u00a0/g, ' ')
    .replace(/\u200b/g, '')
    .replace(/\n\s*\*\s*\*\s*\*\s*\n/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  s = s
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...');

  if (!s) return '';

  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => {
    const u = decodeUrlEntities(String(url || '').trim());
    return `![${alt || ''}](${u})`;
  });

  s = s
    .replace(/\[View image in fullscreen\]\(#img-\d+\)/gi, '')
    .replace(/Photograph:\s+[^\n]+/gi, '')
    .replace(/\n\s*#+\s*/g, '\n')
    .replace(/!?\[([^\]]+)\]\(([^)]+)\)/g, (full, txt) => full.startsWith('!') ? full : txt)
    .replace(/\n{3,}/g, '\n\n');

  const paras = s.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
  const isFooter = (p: string) => {
    return /Explore more on these topics|Reuse this content|mailto:/i.test(p)
      || /\]\(\/(world|tone|commentisfree|sport|uk-news|us-news)[^)]+\)/i.test(p)
      || /More on (these|this) topics?/i.test(p)
      || /^Tags?:/i.test(p)
      || /^Related:/i.test(p)
      || /^This article was amended/i.test(p)
      || /^First published on/i.test(p)
      || /^Sign up to /i.test(p)
      || /^Support the Guardian/i.test(p)
      || /^Share on /i.test(p);
  };
  while (paras.length > 0 && isFooter(paras[paras.length - 1])) {
    paras.pop();
  }

  const dedup = new Set<string>();
  const unique: string[] = [];
  for (const p of paras) {
    const key = p.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!key) continue;
    if (dedup.has(key)) continue;
    dedup.add(key);
    unique.push(p);
  }
  return fixSmartPunctuationArtifacts(fixUtf8Mojibake(unique.join('\n\n').trim()));
}

function minLenFor(source: string, url?: string) {
  if (source === 'CNBC Technology') return 200;
  if (source === 'Aeon Essays') {
    const u = String(url || '');
    if (u.includes('aeon.co/videos/')) return 120;
    return 1000;
  }
  return 800;
}

function countNewlines(s: string) {
  return (s.match(/\n/g) || []).length;
}

function countParagraphBreaks(s: string) {
  return (s.match(/\n\n/g) || []).length;
}

function splitIntoSentences(text: string) {
  const t = text || '';
  return t.match(/[^.!?]+[.!?]+["')\]]?|[^.!?]+$/g)?.map(s => s.trim()).filter(Boolean) || [t];
}

function normalizeForSplit(md: string) {
  let s = (md || '').replace(/\r/g, '');
  if (!s.includes('\n') && s.includes('\\n')) {
    s = s.replace(/\\r/g, '').replace(/\\n/g, '\n');
  }
  if (/<\s*br\b|<\s*p\b|<\s*\/\s*p\s*>/i.test(s)) {
    s = stripHtmlTags(s);
  }
  return s.replace(/\u00a0/g, ' ').replace(/\u200b/g, '').trim();
}

function splitMarkdownIntoParagraphs(md: string) {
  const s = normalizeForSplit(md);
  if (!s) return [] as string[];

  const byBlank = s
    .split(/\n\s*\n+/)
    .map(p => p.trim())
    .filter(Boolean);
  let baseBlocks: string[] | null = byBlank.length > 0 ? byBlank : null;

  const parseImage = (line: string) => /^!\[[^\]]*\]\([^)]+\)/.test((line || '').trim());
  const isHeadingOrRule = (line: string) => {
    const t = (line || '').trim();
    return /^#{1,6}\s+/.test(t) || /^[-*]{3,}$/.test(t) || /^>\s+/.test(t);
  };
  const isBullet = (line: string) => /^[-*]\s+/.test((line || '').trim());
  const isSentenceEnd = (t: string) => /[.!?]["')\]]?$/.test((t || '').trim());
  const startsLikeNew = (t: string) => /^[A-Z0-9“"'\[]/.test((t || '').trim());

  if (!baseBlocks || baseBlocks.length === 1) {
    baseBlocks = null;
  }

  if (!baseBlocks && s.includes('\n')) {
    const lines = s
      .split(/\n+/)
      .map(l => l.trim())
      .filter(Boolean);

    const paras: string[] = [];
    let buf = '';
    const flush = () => {
      const t = buf.trim();
      if (t) paras.push(t);
      buf = '';
    };

    for (const line of lines) {
      if (!line) continue;
      if (parseImage(line)) {
        flush();
        paras.push(line);
        continue;
      }
      if (isHeadingOrRule(line)) {
        flush();
        paras.push(line);
        continue;
      }
      if (isBullet(line)) {
        flush();
        paras.push(line);
        continue;
      }
      if (!buf) {
        buf = line;
        continue;
      }

      const shouldBreak =
        buf.length > 700 ||
        (buf.length > 60 && isSentenceEnd(buf) && startsLikeNew(line));

      if (shouldBreak) {
        flush();
        buf = line;
        continue;
      }
      buf += (buf.endsWith('-') ? '' : ' ') + line;
    }
    flush();
    baseBlocks = paras.length > 0 ? paras : [s];
  }

  if (!baseBlocks) {
    baseBlocks = [s];
  }

  const expandLongText = (text: string) => {
    const t = (text || '').trim();
    if (!t) return [] as string[];
    const sentences = splitIntoSentences(t);
    const out: string[] = [];
    let buf = '';
    let sentCount = 0;
    const flush = () => {
      const x = buf.trim();
      if (x) out.push(x);
      buf = '';
      sentCount = 0;
    };
    for (const sent of sentences) {
      const piece = (sent || '').trim();
      if (!piece) continue;
      if (!buf) {
        buf = piece;
        sentCount = 1;
        continue;
      }
      const next = `${buf} ${piece}`;
      if (next.length > 700 || sentCount >= 3) {
        flush();
        buf = piece;
        sentCount = 1;
        continue;
      }
      buf = next;
      sentCount += 1;
    }
    flush();

    if (out.length === 1 && out[0].length > 1200) {
      const long = out[0];
      const chunks: string[] = [];
      let i = 0;
      while (i < long.length) {
        const targetEnd = Math.min(long.length, i + 700);
        const slice = long.slice(i, targetEnd);
        const lastSpace = slice.lastIndexOf(' ');
        const end = lastSpace > 350 ? i + lastSpace : targetEnd;
        chunks.push(long.slice(i, end).trim());
        i = end;
      }
      return chunks.filter(Boolean);
    }
    return out.length > 0 ? out : [t];
  };

  const isSpecialBlock = (block: string) => {
    const t = (block || '').trim();
    return /^!\[[^\]]*\]\([^)]+\)/.test(t)
      || /^#{1,6}\s+/.test(t)
      || /^[-*]{3,}$/.test(t)
      || /^>\s+/.test(t)
      || /^[-*]\s+/.test(t);
  };

  const expanded: string[] = [];
  for (const b of baseBlocks) {
    const t = (b || '').trim();
    if (!t) continue;
    if (isSpecialBlock(t)) {
      expanded.push(t);
      continue;
    }
    if (t.length > 900) {
      expanded.push(...expandLongText(t));
      continue;
    }
    expanded.push(t);
  }

  return expanded.length > 0 ? expanded : baseBlocks;
}

function ensureParagraphBreaks(md: string) {
  const paras = splitMarkdownIntoParagraphs(md);
  const joined = paras.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return joined;
}

function needsParagraphize(md: string) {
  const s = normalizeForSplit(md);
  if (!s) return false;
  const len = s.length;
  if (len < 700) return false;
  const nlp = countParagraphBreaks(s);
  if (nlp === 0) return true;
  const paras = nlp + 1;
  const avg = len / paras;
  if (avg > 900) return true;
  if (len > 2000 && nlp < 4) return true;
  if (len > 4000 && nlp < 8) return true;
  return false;
}

function looksBadFormatting(md: string, source?: string) {
  const s = (md || '');
  if (!s.trim()) return true;
  if (!s.includes('\n') && s.includes('\\n')) return true;
  if (/<\s*br\b|<\s*p\b|<\s*\/\s*p\s*>/i.test(s)) return true;

  if (source === 'Aeon Essays') {
    const listing = ((s.match(/\b\d+\s+minutes!\[/gi) || []).length >= 5)
      && ((s.match(/^##\s+/gmi) || []).length >= 5)
      && ((s.match(/!\[[^\]]*\]\([^\)]+\)/g) || []).length >= 5);
    if (listing) return true;
  }

  const nlp = countParagraphBreaks(s);
  if (nlp === 0) {
    if (s.length > 700) return true;
    const nl = countNewlines(s);
    if (nl <= 2 && s.length > 500) return true;
  }

  if (needsParagraphize(s)) return true;
  return false;
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({} as any));
    const id = String(body?.id || '').trim();
    const force = Boolean(body?.force);
    const recrawl = body?.recrawl === undefined ? true : Boolean(body?.recrawl);

    if (!id) {
      return NextResponse.json({ success: false, error: 'missing id' }, { status: 400 });
    }

    const { data: row, error } = await supabase
      .from('articles')
      .select('id, title, source, original_url, raw_markdown, content')
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;
    if (!row) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });

    const source = String(row.source || '');
    const url = String(row.original_url || '');
    const before = String(row.raw_markdown || row.content || '');
    const beforeNl = countNewlines(before);
    const beforeNlp = countParagraphBreaks(before);

    const minLen = minLenFor(source, url);
    const bad = looksBadFormatting(before, source) || before.length < minLen;
    if (!force && !bad) {
      return NextResponse.json({
        success: true,
        id,
        source,
        action: 'noop',
        beforeLen: before.length,
        afterLen: before.length,
        beforeNl,
        beforeNlp,
        afterNl: beforeNl,
        afterNlp: beforeNlp
      });
    }

    let next = before;
    let action = '';
    if (source === 'The Guardian') {
      const washed = normalizeGuardianStoredMarkdown(before);
      if (washed && washed !== before) {
        next = washed;
        action = 'washed';
      }
    }

    if (force || needsParagraphize(next)) {
      const beforeBreaks = countParagraphBreaks(normalizeForSplit(next));
      const withParas = ensureParagraphBreaks(next);
      const afterBreaks = countParagraphBreaks(normalizeForSplit(withParas));
      if (withParas && withParas !== next && afterBreaks > beforeBreaks) {
        next = withParas;
        action = action ? `${action}+paragraphized` : 'paragraphized';
      }
    }

    const shouldRecrawl = recrawl && (force || next.length < minLen || looksBadFormatting(next, source));
    if (shouldRecrawl && url) {
      const fetched = await fetchArticleMarkdown(url, source);
      const md = String(fetched?.markdown || '');
      if (md && md.length >= minLen) {
        next = md;
        action = action ? `${action}+recrawled` : 'recrawled';

        if (force || needsParagraphize(next)) {
          const beforeBreaks = countParagraphBreaks(normalizeForSplit(next));
          const withParas = ensureParagraphBreaks(next);
          const afterBreaks = countParagraphBreaks(normalizeForSplit(withParas));
          if (withParas && withParas !== next && afterBreaks > beforeBreaks) {
            next = withParas;
            action = action ? `${action}+paragraphized` : 'paragraphized';
          }
        }

        const title = String(fetched?.title || '').trim();
        if (title && title !== String(row.title || '').trim()) {
          const { error: uerr2 } = await supabase
            .from('articles')
            .update({ title, raw_markdown: next })
            .eq('id', id);
          if (uerr2) throw uerr2;
          return NextResponse.json({
            success: true,
            id,
            source,
            action,
            beforeLen: before.length,
            afterLen: next.length,
            beforeNl,
            beforeNlp,
            afterNl: countNewlines(next),
            afterNlp: countParagraphBreaks(next),
            titleUpdated: true
          });
        }
      }
    }

    if (!next.trim()) {
      return NextResponse.json({
        success: true,
        id,
        source,
        action: action || 'noop',
        beforeLen: before.length,
        afterLen: 0,
        beforeNl,
        beforeNlp,
        afterNl: 0,
        afterNlp: 0
      });
    }

    if (next !== before || force) {
      const { error: uerr } = await supabase
        .from('articles')
        .update({ raw_markdown: next })
        .eq('id', id);
      if (uerr) throw uerr;
    }

    return NextResponse.json({
      success: true,
      id,
      source,
      action: action || 'updated',
      beforeLen: before.length,
      afterLen: next.length,
      beforeNl,
      beforeNlp,
      afterNl: countNewlines(next),
      afterNlp: countParagraphBreaks(next)
    });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
