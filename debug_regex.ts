export {};

function htmlToMarkdown(html: string) {
  let s = html;
}
  const pickFromSrcset = (srcset: string) => {
    const parts = (srcset || '').split(',').map(p => p.trim()).filter(Boolean);
    let bestUrl = '';
    let bestW = -1;
    for (const part of parts) {
      const segs = part.split(/\s+/);
      const candidate = segs[0] || '';
      const wMatch = part.match(/(\d+)\s*w/);
      const w = wMatch ? parseInt(wMatch[1], 10) : 0;
      if (w >= bestW) {
        bestW = w;
        bestUrl = candidate;
      }
    }
    const url = bestUrl || '';
    if (url.startsWith('//')) return 'https:' + url;
    if (/^https?:\/\//i.test(url)) return url;
    return url ? 'https://' + url.replace(/^\/+/, '') : '';
  };

  // Current Order: Picture THEN Figure
  s = s.replace(/<picture[\s\S]*?<\/picture>/gi, (m) => {
    const srcsetMatch = m.match(/<source[^>]*srcset=["']([^"']+)["'][^>]*>/i);
    const altMatch = m.match(/<img[^>]*alt=["']?([^"'>]*)["']?[^>]*>/i);
    const src = srcsetMatch ? pickFromSrcset(srcsetMatch[1]) : '';
    const alt = altMatch ? altMatch[1] : '';
    if (!src) return '';
    return `![${alt}](${src})\n\n`;
  });

  s = s.replace(/<figure[\s\S]*?<\/figure>/gi, (m) => {
    const imgMatch = m.match(/<img[^>]*src=["']([^"']+)["'][^>]*alt=["']?([^"'>]*)["']?[^>]*>/i)
      || m.match(/<img[^>]*alt=["']?([^"'>]*)["']?[^>]*src=["']([^"']+)["'][^>]*>/i);
    const srcsetMatch = m.match(/<source[^>]*srcset=["']([^"']+)["'][^>]*>/i);
    const dmvsMatch = m.match(/data-media-viewer-src=["']([^"']+)["']/i);
    let src = '';
    let alt = '';
    if (imgMatch) {
      if (imgMatch.length >= 3) {
        const a = imgMatch[1];
        const b = imgMatch[2];
        if (/^https?:|^\/\//.test(a)) {
          src = a;
          alt = b || '';
        } else {
          alt = a || '';
          src = b || '';
        }
      }
    } else if (srcsetMatch) {
      src = pickFromSrcset(srcsetMatch[1]);
      const altM = m.match(/<img[^>]*alt=["']?([^"'>]*)["']?[^>]*>/i);
      alt = altM ? altM[1] : '';
    }
    if (dmvsMatch && !src) {
      src = dmvsMatch[1];
    }
    if (src && src.startsWith('//')) {
      src = 'https:' + src;
    }
    if (src && !/^https?:\/\//i.test(src)) {
      src = 'https://' + src.replace(/^\/+/, '');
    }
    const capMatch = m.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i);
    const cap = capMatch ? capMatch[1] : '';
    if (!src) return '';
    return `![${alt}](${src})\n\n${cap ? `${cap}\n\n` : ''}`;
  });
  
  return s;
}

const input = `
<figure class="element element-image">
 <picture>
  <source srcset="https://media.guim.co.uk/img/test.jpg?w=1000 1000w" sizes="100vw">
  <img src="https://media.guim.co.uk/img/test.jpg?w=500" alt="Test Image">
 </picture>
 <figcaption>My Caption</figcaption>
</figure>
`;

console.log("Result:", JSON.stringify(htmlToMarkdown(input)));
