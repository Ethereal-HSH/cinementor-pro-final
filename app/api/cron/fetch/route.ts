import { NextResponse } from 'next/server';
import { fetchAndStoreArticles } from '@/lib/crawler';

// 设置最大执行时间（Vercel Pro 为 300s，Hobby 为 10s，本地无限制）
export const maxDuration = 300; 
// 标记为动态路由，防止被静态缓存
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    // 简单的鉴权（可选）：检查请求头中是否包含某个 Secret
    // const authHeader = req.headers.get('authorization');
    // if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    //   return new Response('Unauthorized', { status: 401 });
    // }

    const results = await fetchAndStoreArticles();
    
    return NextResponse.json({
      success: true,
      message: `Successfully fetched ${results.length} new articles.`,
      data: results
    });
  } catch (error) {
    console.error('Cron job failed:', error);
    return NextResponse.json(
      { success: false, error: 'Internal Server Error' }, 
      { status: 500 }
    );
  }
}
