export interface NavItem {
  title: string;
  slug: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const DOC_NAV: NavGroup[] = [
  {
    label: '快速开始',
    items: [
      { title: '安装与快速上手', slug: 'quickstart' },
      { title: '核心概念', slug: 'concepts' },
    ],
  },
  {
    label: '理解系统',
    items: [
      { title: '系统架构', slug: 'architecture' },
      { title: '一次运行的完整脉络', slug: 'run-lifecycle' },
    ],
  },
  {
    label: '内置协作 Program',
    items: [
      { title: '五种协作机制总览', slug: 'programs' },
      { title: 'Subagents · 层级委派', slug: 'programs/subagents' },
      { title: 'Flat · 公共任务池', slug: 'programs/flat' },
      { title: 'Agensh · 同级协商', slug: 'programs/agensh' },
      { title: 'ScaleMAS · 成果库研究', slug: 'programs/scalemas' },
      { title: 'Lead-helper · 方向反馈', slug: 'programs/lead-helper' },
    ],
  },
  {
    label: '开发者指南',
    items: [
      { title: '编写你自己的 Program', slug: 'build-your-program' },
    ],
  },
  {
    label: '参考与部署',
    items: [
      { title: 'API 与配置参考', slug: 'reference/api' },
      { title: 'TypeScript 类型与映射', slug: 'reference/types' },
      { title: '发布站点与本地可视化', slug: 'reference/deploy' },
    ],
  },
];

export const FLAT_NAV: NavItem[] = DOC_NAV.flatMap((group) => group.items);

export function normalizeSlug(slug: string): string {
  return slug.replace(/^\/+|\/+$/g, '').replace(/\/index$/, '');
}

export function getPrevNext(currentSlug: string): { prev?: NavItem; next?: NavItem } {
  const norm = normalizeSlug(currentSlug);
  const idx = FLAT_NAV.findIndex((item) => normalizeSlug(item.slug) === norm);
  if (idx < 0) return {};
  return {
    prev: idx > 0 ? FLAT_NAV[idx - 1] : undefined,
    next: idx < FLAT_NAV.length - 1 ? FLAT_NAV[idx + 1] : undefined,
  };
}
