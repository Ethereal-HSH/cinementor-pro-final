export function decodeHTMLEntities(text: string): string {
  let s = text || "";
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
  return s;
}
