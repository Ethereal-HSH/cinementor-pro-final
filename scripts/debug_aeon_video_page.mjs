const url = String(process.env.URL || '').trim();
if (!url) {
  console.error('Set URL env var');
  process.exit(1);
}

const res = await fetch(url, {
  headers: {
    'User-Agent': 'Mozilla/5.0',
    'Accept': 'text/html,application/xhtml+xml'
  }
});
const html = await res.text();

const out = {
  status: res.status,
  len: html.length,
  hasNextData: false,
  nextDataTopKeys: [],
  ldJsonCount: 0,
  ldJsonTypes: [],
  transcriptCandidates: [],
  videoObject: null,
  article: null,
  textHints: {
    hasTranscriptWord: /transcript/i.test(html),
    hasCaptionWord: /caption/i.test(html),
    hasDescriptionWord: /description/i.test(html)
  }
};

const nextDataMatch = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
if (nextDataMatch?.[1]) {
  out.hasNextData = true;
  try {
    const data = JSON.parse(nextDataMatch[1]);
    out.nextDataTopKeys = Object.keys(data || {});

    const candidates = [];
    const seen = new Set();
    const walk = (v) => {
      if (!v) return;
      if (typeof v === 'string') {
        const s = v;
        if (s.length > 800 && /\b(the|and|of|to)\b/i.test(s)) {
          if (!seen.has(s)) {
            seen.add(s);
            candidates.push(s);
          }
        }
        return;
      }
      if (Array.isArray(v)) {
        for (const it of v) walk(it);
        return;
      }
      if (typeof v === 'object') {
        for (const k of Object.keys(v)) walk(v[k]);
      }
    };
    walk(data);
    candidates.sort((a, b) => b.length - a.length);
    out.transcriptCandidates = candidates.slice(0, 3).map(s => ({ len: s.length, head: s.slice(0, 220) }));
  } catch {
    out.nextDataTopKeys = ['(parse failed)'];
  }
}

const ldScripts = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
out.ldJsonCount = ldScripts.length;
const articleMatch = html.match(/<article[\s\S]*?>[\s\S]*?<\/article>/i);
if (articleMatch?.[0]) {
  const articleHtml = articleMatch[0];
  const pCount = (articleHtml.match(/<p\b/gi) || []).length;
  const hCount = (articleHtml.match(/<h\d\b/gi) || []).length;
  const imgCount = (articleHtml.match(/<img\b/gi) || []).length;
  const text = articleHtml
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  out.article = {
    len: articleHtml.length,
    pCount,
    hCount,
    imgCount,
    textHead: text.slice(0, 500)
  };
}
for (const s of ldScripts.slice(0, 8)) {
  const m = s.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  const jsonText = (m?.[1] || '').trim();
  if (!jsonText) continue;
  try {
    const v = JSON.parse(jsonText);
    const types = [];
    const collectTypes = (x) => {
      if (!x) return;
      if (Array.isArray(x)) return x.forEach(collectTypes);
      if (typeof x === 'object') {
        if (typeof x['@type'] === 'string') types.push(x['@type']);
        if (x['@graph']) collectTypes(x['@graph']);
      }
    };
    collectTypes(v);
    out.ldJsonTypes.push(...types);

    const findVideoObject = (x) => {
      if (!x) return null;
      if (Array.isArray(x)) {
        for (const it of x) {
          const r = findVideoObject(it);
          if (r) return r;
        }
        return null;
      }
      if (typeof x === 'object') {
        if (x['@type'] === 'VideoObject') return x;
        if (x['@graph']) return findVideoObject(x['@graph']);
      }
      return null;
    };
    if (!out.videoObject) {
      const vo = findVideoObject(v);
      if (vo) {
        out.videoObject = {
          name: vo.name,
          description: typeof vo.description === 'string' ? vo.description.slice(0, 600) : vo.description,
          duration: vo.duration,
          uploadDate: vo.uploadDate,
          thumbnailUrl: vo.thumbnailUrl,
          embedUrl: vo.embedUrl,
          contentUrl: vo.contentUrl
        };
      }
    }
  } catch {}
}

console.log(JSON.stringify(out, null, 2));
