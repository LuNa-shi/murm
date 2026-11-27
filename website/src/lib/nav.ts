import type { Lang } from './i18n';

export interface NavItem {
  title: string;
  slug: string;
  badge?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const DOC_NAV: NavGroup[] = [
  {
    label: 'GET STARTED',
    items: [
      { title: 'Overview', slug: 'overview' },
      { title: 'Quickstart', slug: 'quickstart' },
      { title: 'How murm Works', slug: 'concepts' },
    ],
  },
  {
    label: 'BUILD ON MURM',
    items: [
      { title: 'Use the SDK', slug: 'sdk' },
      { title: 'Build Your Own Harness', slug: 'build-your-harness' },
      { title: 'System Architecture', slug: 'architecture' },
      { title: 'Run Lifecycle', slug: 'run-lifecycle' },
    ],
  },
  {
    label: 'HARNESSES',
    items: [
      { title: 'Choose a Harness', slug: 'harnesses' },
      { title: 'Subagents', slug: 'harnesses/subagents' },
      { title: 'TaskPool', slug: 'harnesses/taskpool' },
      { title: 'PeerMesh', slug: 'harnesses/peermesh' },
      { title: 'Substrate', slug: 'harnesses/substrate' },
      { title: 'Lead-Worker', slug: 'harnesses/lead-worker' },
    ],
  },
  {
    label: 'REFERENCE',
    items: [
      { title: 'API & Configuration', slug: 'reference/api' },
      { title: 'Types & Source Map', slug: 'reference/types' },
      { title: 'Documentation Site', slug: 'reference/deploy' },
    ],
  },
  {
    label: 'RELEASES',
    items: [
      { title: 'Latest', slug: 'latest', badge: 'v0.2.0' },
      { title: 'Changelog', slug: 'changelog' },
    ],
  },
];

export const DOC_NAV_ZH: NavGroup[] = [
  {
    label: '快速开始',
    items: [
      { title: '文档总览', slug: 'overview' },
      { title: '快速上手', slug: 'quickstart' },
      { title: 'murm 如何工作', slug: 'concepts' },
    ],
  },
  {
    label: '基于 MURM 构建',
    items: [
      { title: '使用 SDK', slug: 'sdk' },
      { title: '构建你自己的 Harness', slug: 'build-your-harness' },
      { title: '系统架构', slug: 'architecture' },
      { title: 'Run 生命周期', slug: 'run-lifecycle' },
    ],
  },
  {
    label: '协作机制',
    items: [
      { title: '选择 Harness', slug: 'harnesses' },
      { title: 'Subagents', slug: 'harnesses/subagents' },
      { title: 'TaskPool', slug: 'harnesses/taskpool' },
      { title: 'PeerMesh', slug: 'harnesses/peermesh' },
      { title: 'Substrate', slug: 'harnesses/substrate' },
      { title: 'Lead-Worker', slug: 'harnesses/lead-worker' },
    ],
  },
  {
    label: '参考手册',
    items: [
      { title: 'API 与配置参考', slug: 'reference/api' },
      { title: '类型定义与源码映射', slug: 'reference/types' },
      { title: '站点部署指南', slug: 'reference/deploy' },
    ],
  },
  {
    label: '版本与更新',
    items: [
      { title: '最新版本', slug: 'latest', badge: 'v0.2.0' },
      { title: '更新日志', slug: 'changelog' },
    ],
  },
];

export function getDocNav(lang: Lang = 'en'): NavGroup[] {
  return lang === 'zh' ? DOC_NAV_ZH : DOC_NAV;
}

export function normalizeSlug(slug: string): string {
  return slug.replace(/^\/+|\/+$/g, '').replace(/\/index$/, '');
}

export function getPrevNext(currentSlug: string, lang: Lang = 'en'): { prev?: NavItem; next?: NavItem } {
  const flat = getDocNav(lang).flatMap((group) => group.items);
  const norm = normalizeSlug(currentSlug);
  const idx = flat.findIndex((item) => normalizeSlug(item.slug) === norm);
  if (idx < 0) return {};
  return {
    prev: idx > 0 ? flat[idx - 1] : undefined,
    next: idx < flat.length - 1 ? flat[idx + 1] : undefined,
  };
}
