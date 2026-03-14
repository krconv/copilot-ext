import { pool } from '../shared/db.js';

interface DbCategory {
  id: string;
  name: string;
  is_excluded: boolean;
  parent_id: string | null;
  description: string | null;
}

interface DbTag {
  id: string;
  name: string;
  is_excluded: boolean;
  description: string | null;
}

interface DbRecurring {
  id: string;
  name: string;
}

export interface AccountInfo {
  name: string;
  type: string | null;
  subType: string | null;
}

// key: "${itemId}:${accountId}" → account info
let accountCache: Record<string, AccountInfo> | null = null;

export async function getAccountMap(): Promise<Record<string, AccountInfo>> {
  if (accountCache) return accountCache;

  const result = await pool.query<{ item_id: string; id: string; name: string; type: string | null; sub_type: string | null }>(
    'SELECT item_id, id, name, type, sub_type FROM accounts'
  );

  accountCache = {};
  for (const row of result.rows) {
    accountCache[`${row.item_id}:${row.id}`] = { name: row.name, type: row.type, subType: row.sub_type };
  }

  return accountCache;
}

export interface IdMaps {
  categories: Record<string, string>;           // slug → id
  tags: Record<string, string>;                 // slug → id
  categoryIdToSlug: Record<string, string>;
  tagIdToSlug: Record<string, string>;
  categoryNames: Record<string, string>;        // slug → human-readable name
  tagNames: Record<string, string>;             // slug → human-readable name
  categoryDescriptions: Record<string, string>; // slug → description (optional, user-supplied)
  tagDescriptions: Record<string, string>;      // slug → description (optional, user-supplied)
  categoryParentSlug: Record<string, string>;   // child slug → parent slug
  recurringIdToName: Record<string, string>;    // id → name (for recurring-linked transactions)
}

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

let cache: IdMaps | null = null;

export function clearIdMapsCache(): void {
  cache = null;
}

export async function getIdMaps(): Promise<IdMaps> {
  if (cache) return cache;

  const [catResult, tagResult, recurringResult] = await Promise.all([
    pool.query<DbCategory>('SELECT id, name, is_excluded, parent_id, description FROM categories'),
    pool.query<DbTag>('SELECT id, name, is_excluded, description FROM tags'),
    pool.query<DbRecurring>("SELECT id, name FROM recurrings WHERE state != 'DELETED'"),
  ]);

  const categories: Record<string, string> = {};
  const categoryNames: Record<string, string> = {};
  const categoryDescriptions: Record<string, string> = {};
  const categoryParentSlug: Record<string, string> = {};

  // Build id→slug map for all non-excluded rows first so we can look up parents
  const idToSlugTemp: Record<string, string> = {};
  for (const cat of catResult.rows) {
    if (!cat.is_excluded) {
      idToSlugTemp[cat.id] = toSlug(cat.name);
    }
  }

  for (const cat of catResult.rows) {
    if (!cat.is_excluded) {
      const slug = toSlug(cat.name);
      categories[slug] = cat.id;
      categoryNames[slug] = cat.name;
      if (cat.description) categoryDescriptions[slug] = cat.description;
      if (cat.parent_id && idToSlugTemp[cat.parent_id]) {
        categoryParentSlug[slug] = idToSlugTemp[cat.parent_id];
      }
    }
  }

  const tags: Record<string, string> = {};
  const tagNames: Record<string, string> = {};
  const tagDescriptions: Record<string, string> = {};

  for (const tag of tagResult.rows) {
    if (!tag.is_excluded) {
      const slug = toSlug(tag.name);
      tags[slug] = tag.id;
      tagNames[slug] = tag.name;
      if (tag.description) tagDescriptions[slug] = tag.description;
    }
  }

  const recurringIdToName: Record<string, string> = {};
  for (const r of recurringResult.rows) {
    recurringIdToName[r.id] = r.name;
  }

  cache = {
    categories,
    tags,
    categoryIdToSlug: Object.fromEntries(Object.entries(categories).map(([k, v]) => [v, k])),
    tagIdToSlug: Object.fromEntries(Object.entries(tags).map(([k, v]) => [v, k])),
    categoryNames,
    tagNames,
    categoryDescriptions,
    tagDescriptions,
    categoryParentSlug,
    recurringIdToName,
  };

  return cache;
}

/** Replace all real category/tag IDs in a string with their readable slugs. */
export function replaceIdsWithNames(text: string, maps: IdMaps): string {
  let result = text;
  for (const [id, slug] of Object.entries(maps.categoryIdToSlug)) {
    result = result.replaceAll(id, slug);
  }
  for (const [id, slug] of Object.entries(maps.tagIdToSlug)) {
    result = result.replaceAll(id, slug);
  }
  return result;
}

/** Translate readable slugs in an LLM result back to real IDs. */
export function resolveResultIds(
  result: { categoryId?: string; tagIds?: string[] },
  maps: IdMaps
): { categoryId?: string; tagIds?: string[] } {
  return {
    categoryId: result.categoryId !== undefined
      ? (maps.categories[result.categoryId] ?? result.categoryId)
      : undefined,
    tagIds: result.tagIds?.map(t => maps.tags[t] ?? t),
  };
}
