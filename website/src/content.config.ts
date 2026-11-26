import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const docSchema = z.object({
  title: z.string(),
  description: z.string(),
  section: z.string(),
  order: z.number().default(100),
  badge: z.string().optional(),
});

const docs = defineCollection({
  loader: glob({ pattern: '**/*.md', base: '../docs/en' }),
  schema: docSchema,
});

const docsZh = defineCollection({
  loader: glob({ pattern: '**/*.md', base: '../docs/zh' }),
  schema: docSchema,
});

export const collections = { docs, docsZh };
