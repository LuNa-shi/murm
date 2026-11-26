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
    label: 'GETTING STARTED',
    items: [
      { title: 'Quick Start', slug: 'quickstart' },
      { title: 'Core Concepts', slug: 'concepts' },
    ],
  },
  {
    label: 'ARCHITECTURE',
    items: [
      { title: 'System Architecture', slug: 'architecture' },
      { title: 'Anatomy of a Run', slug: 'run-lifecycle' },
    ],
  },
  {
    label: 'BUILT-IN HARNESSES',
    items: [
      { title: 'Five Topologies Overview', slug: 'harnesses' },
      { title: 'Subagents', slug: 'harnesses/subagents' },
      { title: 'TaskPool', slug: 'harnesses/taskpool' },
      { title: 'PeerMesh', slug: 'harnesses/peermesh' },
      { title: 'Substrate', slug: 'harnesses/substrate' },
      { title: 'Lead-Worker', slug: 'harnesses/lead-worker' },
    ],
  },
  {
    label: 'DEVELOPERS',
    items: [
      { title: 'Build Your Own Harness', slug: 'build-your-harness' },
    ],
  },
  {
    label: 'REFERENCE',
    items: [
      { title: 'API & Configuration', slug: 'reference/api' },
      { title: 'Types & Mapping', slug: 'reference/types' },
      { title: 'Deployment', slug: 'reference/deploy' },
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
