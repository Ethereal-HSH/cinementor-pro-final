import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({} as any));
    const idsIn = Array.isArray(body?.ids) ? body.ids : (body?.id ? [body.id] : []);
    const ids = idsIn.map((x: any) => String(x || '').trim()).filter(Boolean).slice(0, 20);
    const force = Boolean(body?.force);
    if (ids.length === 0) {
      return NextResponse.json({ success: false, error: 'missing ids' }, { status: 400 });
    }

    const { data: rows, error } = await supabase
      .from('articles')
      .select('id, summary, summary_zh')
      .in('id', ids);

    if (error) throw error;
    const list = Array.isArray(rows) ? rows : [];

    const fixUtf8Mojibake = (input: string) => {
      const raw = String(input || '');
      const hasCjk = /[\u4e00-\u9fff]/.test(raw);
      const latin1Count = (raw.match(/[\u00c0-\u00ff]/g) || []).length;
      if (hasCjk) return raw;
      if (latin1Count < 6) return raw;
      if (latin1Count / Math.max(1, raw.length) < 0.15) return raw;
      try {
        const bytes = Uint8Array.from(Array.from(raw, ch => ch.charCodeAt(0) & 0xff));
        const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        if (!decoded) return raw;
        if (decoded.includes('\uFFFD')) return raw;
        if (!/[\u4e00-\u9fff]/.test(decoded)) return raw;
        const latin1After = (decoded.match(/[\u00c0-\u00ff]/g) || []).length;
        if (latin1After > latin1Count) return raw;
        return decoded;
      } catch {
        return raw;
      }
    };
    const isMojibakeLike = (input: string) => {
      const raw = String(input || '');
      if (!raw.trim()) return false;
      if (/[\u4e00-\u9fff]/.test(raw)) return false;
      const latin1Count = (raw.match(/[\u00c0-\u00ff]/g) || []).length;
      return latin1Count >= 6 && latin1Count / Math.max(1, raw.length) >= 0.15;
    };

    const fixedExisting: Record<string, string> = {};
    for (const r of list) {
      const cur = String((r as any).summary_zh || '');
      if (!cur.trim()) continue;
      const fixed = fixUtf8Mojibake(cur);
      if (fixed !== cur && /[\u4e00-\u9fff]/.test(fixed)) {
        const { error: uerr } = await supabase
          .from('articles')
          .update({ summary_zh: fixed })
          .eq('id', String((r as any).id));
        if (uerr) throw uerr;
        fixedExisting[String((r as any).id)] = fixed;
      }
    }

    const toTranslate = list
      .filter(r => {
        const zh = String((r as any).summary_zh || '');
        if (force) return String((r as any).summary || '').trim().length > 0;
        if (!zh.trim()) return String((r as any).summary || '').trim().length > 0;
        if (isMojibakeLike(zh)) return String((r as any).summary || '').trim().length > 0;
        return false;
      })
      .map(r => ({ id: String(r.id), summary: String(r.summary || '') }));

    if (toTranslate.length === 0) {
      const existing: Record<string, string> = {};
      for (const r of list) {
        const v = String(r.summary_zh || '').trim();
        if (v) existing[String(r.id)] = v;
      }
      return NextResponse.json({ success: true, translated: 0, results: { ...existing, ...fixedExisting } });
    }

    const res = await fetch(new URL('/api/translate', req.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: toTranslate.map(x => x.summary) })
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload) {
      return NextResponse.json({ success: false, error: `translate failed (${res.status})` }, { status: 500 });
    }

    const arr = Array.isArray(payload.translation) ? payload.translation : null;
    if (!arr || arr.length !== toTranslate.length) {
      return NextResponse.json({ success: false, error: 'translate result invalid' }, { status: 500 });
    }

    const results: Record<string, string> = {};
    for (let i = 0; i < toTranslate.length; i++) {
      const id = toTranslate[i].id;
      const zh = fixUtf8Mojibake(String(arr[i] || '')).trim();
      if (!zh) continue;
      results[id] = zh;
      const { error: uerr } = await supabase
        .from('articles')
        .update({ summary_zh: zh })
        .eq('id', id);
      if (uerr) throw uerr;
    }

    return NextResponse.json({
      success: true,
      translated: Object.keys(results).length,
      results: { ...results, ...fixedExisting }
    });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
