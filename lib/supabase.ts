import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const isServer = typeof window === 'undefined';
const supabaseKey = isServer
  ? (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "")
  : (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");

const isValidUrl = (url: string) => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

export const supabase = isValidUrl(supabaseUrl) && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, { db: { schema: 'public' } })
  : createClient("https://placeholder-project.supabase.co", "placeholder-key", { db: { schema: 'public' } });
