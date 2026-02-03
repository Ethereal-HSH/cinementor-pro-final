-- 创建文章表
create table if not exists articles (
  id uuid default gen_random_uuid() primary key,
  title text not null,
  content text not null, -- 存储纯文本或 Markdown 内容
  original_url text unique not null,
  source text not null, -- 例如 "The Guardian", "Science"
  published_at timestamptz,
  created_at timestamptz default now(),
  status text default 'unread', -- unread, reading, read
  tags text[] default '{}',
  summary text -- 可选：AI 生成的摘要
);

-- 创建索引以加速按时间查询
create index if not exists articles_published_at_idx on articles (published_at desc);

-- 开启 Row Level Security (RLS)
alter table articles enable row level security;

-- 允许所有用户读取（如果是公开应用）或仅允许认证用户
-- 这里为了演示方便，允许匿名读取，但限制写入
create policy "Allow public read access"
  on articles for select
  using (true);

-- 仅允许服务端（Service Role）写入，普通用户无法直接写入
-- 注意：Service Role 默认绕过 RLS，不需要额外 Policy，但为了安全起见，不给 anon/authenticated 角色写权限即可。

-- 创建文章分析表
create table if not exists article_analyses (
  id uuid default gen_random_uuid() primary key,
  article_id uuid not null references articles(id) on delete cascade,
  translation_md text not null, -- 四段式中英对照全文（Markdown）
  vocab_md text not null,       -- 8 个核心考点词汇辨析（Markdown）
  long_sentences_md text not null, -- 3 组长难句拆解（Markdown）
  created_at timestamptz default now()
);

-- 索引：按文章 ID 查询
create index if not exists article_analyses_article_idx on article_analyses (article_id);

-- 开启 RLS 并允许公开读取分析结果
alter table article_analyses enable row level security;
create policy "Allow public read analyses"
  on article_analyses for select
  using (true);
