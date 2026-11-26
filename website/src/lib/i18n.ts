import { withBase } from './url';

export type Lang = 'en' | 'zh';

export function homeHref(lang: Lang): string {
  return withBase(lang === 'zh' ? '/zh/' : '/');
}

export function docHref(lang: Lang, slug: string): string {
  const clean = slug.replace(/^\/+|\/+$/g, '').replace(/\/index$/, '');
  return withBase(lang === 'zh' ? `/zh/docs/${clean}/` : `/docs/${clean}/`);
}

export function alternateHref(lang: Lang, slug?: string): string {
  const other: Lang = lang === 'zh' ? 'en' : 'zh';
  return slug ? docHref(other, slug) : homeHref(other);
}

export const UI = {
  en: {
    htmlLang: 'en',
    switchLabel: '中文',
    switchAria: 'Switch to Chinese',
    searchBtn: 'Search',
    searchPlaceholder: 'Search concepts, harnesses, APIs...',
    searchEmptyPrefix: 'No matching pages for',
    searchAria: 'Search documentation',
    themeAria: 'Toggle color theme',
    themeTitle: 'Toggle light / dark theme',
    menuAria: 'Toggle sidebar',
    copyCode: 'Copy',
    copiedCode: 'Copied',
    copyError: 'Error',
    copyPage: 'Copy page',
    copiedPage: 'Copied',
    copyPageAria: 'Copy page text',
    onThisPage: 'ON THIS PAGE',
    prevLabel: '← PREVIOUS',
    nextLabel: 'NEXT →',
    sidebarAria: 'Documentation navigation',
    paginationAria: 'Pagination',
  },
  zh: {
    htmlLang: 'zh-CN',
    switchLabel: 'EN',
    switchAria: '切换到英文 (Switch to English)',
    searchBtn: '搜索',
    searchPlaceholder: '搜索概念、Harness、API...',
    searchEmptyPrefix: '未找到匹配页面：',
    searchAria: '搜索文档',
    themeAria: '切换浅色 / 深色主题',
    themeTitle: '切换浅色 / 深色主题',
    menuAria: '展开或收起目录',
    copyCode: '复制',
    copiedCode: '已复制',
    copyError: '失败',
    copyPage: '复制本页',
    copiedPage: '已复制',
    copyPageAria: '复制本页文本',
    onThisPage: '本页目录',
    prevLabel: '← 上一篇',
    nextLabel: '下一篇 →',
    sidebarAria: '文档导航',
    paginationAria: '上下页导航',
  },
} as const;
