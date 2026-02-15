export function decodeHTMLEntities(text: string): string {
  const fixUtf8Mojibake = (input: string) => {
    const s = input || "";
    if (!/[ÃÂâ]/.test(s)) return s;
    try {
      const bytes = Uint8Array.from(Array.from(s, ch => ch.charCodeAt(0) & 0xff));
      const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      if (!decoded) return s;
      if (decoded.includes('\uFFFD')) return s;
      const badBefore = (s.match(/[ÃÂâ]/g) || []).length;
      const badAfter = (decoded.match(/[ÃÂâ]/g) || []).length;
      if (badAfter <= badBefore) return decoded;
      return s;
    } catch {
      return s;
    }
  };

  const fixSmartPunctuationArtifacts = (input: string) => {
    let s = input || "";
    s = s.replace(/[\u200b\u00a0\u00ad\ufeff]/g, "");
    s = s
      .replace(/\u00c2\s/g, " ")
      .replace(/\u00c2/g, "")
      .replace(/\u00e2\u20ac\u2122/g, "’")
      .replace(/\u00e2\u0080\u0099/g, "’")
      .replace(/\u00e2\u20ac\u02dc/g, "‘")
      .replace(/\u00e2\u0080\u0098/g, "‘")
      .replace(/\u00e2\u20ac\u0153/g, "“")
      .replace(/\u00e2\u0080\u009c/g, "“")
      .replace(/\u00e2\u20ac\u009d/g, "”")
      .replace(/\u00e2\u0080\u009d/g, "”")
      .replace(/\u00e2\u20ac\u2013/g, "–")
      .replace(/\u00e2\u0080\u0093/g, "–")
      .replace(/\u00e2\u20ac\u2014/g, "—")
      .replace(/\u00e2\u0080\u0094/g, "—")
      .replace(/\u00e2\u20ac\u2026/g, "…")
      .replace(/\u00e2\u0080\u00a6/g, "…")
      .replace(/\u00e2\u20ac\u2022/g, "•")
      .replace(/\u00e2\u0080\u00a2/g, "•")
      .replace(/\u00e2\u201e\u00a2/g, "™")
      .replace(/\u00e2\u0084\u00a2/g, "™");

    s = s.replace(/[\u0080-\u009f]/g, "");

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

  let s = fixSmartPunctuationArtifacts(fixUtf8Mojibake(text || ""));
  for (let i = 0; i < 3; i++) {
    const prev = s;
    s = s
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, "\"")
      .replace(/&apos;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/gi, "'");
    s = s.replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => {
      try {
        return String.fromCharCode(parseInt(h, 16));
      } catch {
        return _m;
      }
    });
    s = s.replace(/&#([0-9]+);/g, (_m, d) => {
      try {
        return String.fromCharCode(parseInt(d, 10));
      } catch {
        return _m;
      }
    });
    if (s === prev) break;
  }
  return fixSmartPunctuationArtifacts(fixUtf8Mojibake(s));
}
