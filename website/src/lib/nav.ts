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
      { title: 'Core Concepts', slug: 'concepts' },
    ],
  },
  {
    label: 'CORE BUILDING BLOCKS',
    items: [
      { title: 'Sandboxes', slug: 'sandbox' },
      { title: 'Runtime', slug: 'runtime' },
      { title: 'Agents & Profiles', slug: 'agents' },
      { title: 'Host Gateway', slug: 'gateway' },
      { title: 'Services & Permissions', slug: 'services' },
      { title: 'Trace Viewer', slug: 'trace-viewer' },
      { title: 'Build a Swarm Harness', slug: 'build-your-harness' },
    ],
  },
  {
    label: 'BUILT-IN HARNESSES',
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
      { title: 'SDK & API Reference', slug: 'reference/api' },
      { title: 'CLI Reference', slug: 'reference/cli' },
      { title: 'Types & Source Map', slug: 'reference/types' },
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
      { title: '核心概念', slug: 'concepts' },
    ],
  },
  {
    label: '核心构件与实战',
    items: [
      { title: 'Sandbox 隔离沙箱', slug: 'sandbox' },
      { title: 'Runtime 运行控制面', slug: 'runtime' },
      { title: 'Agent 与 Profile', slug: 'agents' },
      { title: 'Host Gateway 宿主机网关', slug: 'gateway' },
      { title: 'Services 与权限', slug: 'services' },
      { title: '观测与调试', slug: 'trace-viewer' },
      { title: '实战：构建 Swarm Harness', slug: 'build-your-harness' },
    ],
  },
  {
    label: '内置 Harness',
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
      { title: 'SDK 与 API 参考', slug: 'reference/api' },
      { title: 'CLI 参考', slug: 'reference/cli' },
      { title: '类型定义与源码映射', slug: 'reference/types' },
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
