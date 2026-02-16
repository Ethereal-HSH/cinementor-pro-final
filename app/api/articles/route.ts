import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { data, error } = await supabase
      .from("articles")
      .select("id,title,source,published_at,summary,summary_zh,status")
      .order("published_at", { ascending: false })
      .limit(200);

    if (error) {
      return NextResponse.json(
        { articles: [], error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({ articles: data || [] });
  } catch (e) {
    return NextResponse.json(
      { articles: [], error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
