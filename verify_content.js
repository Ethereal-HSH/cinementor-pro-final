
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://lewwgfcgpzmfmqxgynej.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxld3dnZmNncHptZm1xeGd5bmVqIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDExNzA2NiwiZXhwIjoyMDg1NjkzMDY2fQ.4cPcSkDqZ2meWhMG-1ii6WlSbrQBoleW8LXnJd-u5Xc';

const supabase = createClient(supabaseUrl, supabaseKey);

async function verify() {
  const { data, error } = await supabase
    .from('articles')
    .select('title, content, original_url')
    .limit(10);

  if (error) {
    console.error('Error:', error);
    return;
  }

  console.log(`Found ${data.length} articles.`);
  data.forEach((article, i) => {
    console.log(`[${i + 1}] Title: ${article.title.substring(0, 50)}...`);
    console.log(`    URL: ${article.original_url}`);
    console.log(`    Length: ${article.content.length} chars`);
    const paras = (article.content || "").split(/\n\n+/).filter(Boolean).length;
    console.log(`    Paragraphs: ${paras}`);
    console.log(`    Preview: ${article.content.substring(0, 100).replace(/\n/g, ' ')}...`);
    console.log('---');
  });
}

verify();
