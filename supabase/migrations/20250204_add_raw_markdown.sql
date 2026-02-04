
-- 为 articles 表增加 raw_markdown 字段
ALTER TABLE articles ADD COLUMN IF NOT EXISTS raw_markdown text;
