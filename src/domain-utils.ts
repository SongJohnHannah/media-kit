/**
 * Domain classification for routing downloads.
 */

// Sites that need CDP browser for text/image (anti-scraping)
export const CDP_FIRST_DOMAINS = [
  "x.com",
  "twitter.com",
  "douyin.com",
  "www.douyin.com",
  "xiaohongshu.com",
  "www.xiaohongshu.com",
  "instagram.com",
  "www.instagram.com",
  "threads.net",
  "www.threads.net",
] as const;

// Chinese video domains
export const CHINESE_VIDEO_DOMAINS = [
  "bilibili.com", "b23.tv", "www.bilibili.com",
  "douyin.com", "www.douyin.com",
  "kuaishou.com", "gifshow.com", "ksapisrv.com", "www.kuaishou.com",
  "xiaohongshu.com", "www.xiaohongshu.com", "xhslink.com",
  "weibo.com", "weibo.cn", "weibo.com.cn", "www.weibo.com",
  "iqiyi.com", "www.iqiyi.com",
  "youku.com", "www.youku.com",
  "v.qq.com", "m.v.qq.com",
  "mgtv.com", "www.mgtv.com",
  "acfun.cn", "www.acfun.cn",
  "zhihu.com", "www.zhihu.com",
  "ixigua.com", "www.ixigua.com",
  "toutiao.com", "www.toutiao.com",
  "ximalaya.com", "www.ximalaya.com",
  "huya.com", "www.huya.com",
  "douyu.com", "www.douyu.com",
  "haokan.baidu.com",
  "bcy.net", "www.bcy.net",
  "miaopai.com",
  "music.163.com",
  "tangdou.com",
  "geekbang.org", "time.geekbang.org",
  "xinpianchang.com", "www.xinpianchang.com",
] as const;

export function isCdpFirstDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return CDP_FIRST_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

export function isChineseVideoDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return CHINESE_VIDEO_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
