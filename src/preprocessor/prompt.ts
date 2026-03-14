import { type IdMaps, replaceIdsWithNames } from './ids.js';

function formatCategoryList(
  names: Record<string, string>,
  descriptions: Record<string, string>,
  parentSlug: Record<string, string>,
): string {
  const slugs = Object.keys(names);
  if (slugs.length === 0) return '(no categories found)';

  // Group children by parent
  const children: Record<string, string[]> = {};
  const topLevel: string[] = [];
  for (const slug of slugs) {
    const parent = parentSlug[slug];
    if (parent) {
      (children[parent] ??= []).push(slug);
    } else {
      topLevel.push(slug);
    }
  }

  const lines: string[] = [];
  for (const slug of topLevel) {
    const desc = descriptions[slug];
    lines.push(desc ? `- ${names[slug]} (\`${slug}\`) — ${desc}` : `- ${names[slug]} (\`${slug}\`)`);
    for (const child of children[slug] ?? []) {
      const childDesc = descriptions[child];
      lines.push(childDesc ? `  - ${names[child]} (\`${child}\`) — ${childDesc}` : `  - ${names[child]} (\`${child}\`)`);
    }
  }
  return lines.join('\n');
}

function formatTagList(names: Record<string, string>, descriptions: Record<string, string>): string {
  const slugs = Object.keys(names);
  if (slugs.length === 0) return '(no tags configured)';
  return slugs
    .map(slug => {
      const desc = descriptions[slug];
      return desc ? `- \`${slug}\` (${names[slug]}): ${desc}` : `- \`${slug}\` (${names[slug]})`;
    })
    .join('\n');
}

export function buildPrompt(idMaps: IdMaps, matchedRules: { instruction: string }[]): string {
  let built = template
    .replace('{{categories}}', formatCategoryList(idMaps.categoryNames, idMaps.categoryDescriptions, idMaps.categoryParentSlug))
    .replace('{{tags}}', formatTagList(idMaps.tagNames, idMaps.tagDescriptions));

  if (matchedRules.length > 0) {
    built = built.replace('{{matched_rules}}', matchedRules.map(r => `- ${r.instruction}`).join('\n'));
  } else {
    built = built.replace(/---\n\n## Matched Rules\n[\s\S]*?\{\{matched_rules\}\}\n\n/, '');
  }

  return replaceIdsWithNames(built, idMaps);
}

const template = `You are a transaction preprocessing agent for Copilot Money. Before the user sees a new transaction, your job is to clean its name, assign a category, and apply tags.

Always populate the \`debug\` field with a single sentence explaining your decisions — what you changed and why, or why you left fields unchanged.

---

## Transaction Types

- \`REGULAR\` — expense or refund. The only type that can have a \`categoryId\`.
- \`INCOME\` — salary, deposits, interest (not refunds). No \`categoryId\`.
- \`INTERNAL_TRANSFER\` — money moved between accounts (card payments, loan payments, savings transfers). No \`categoryId\`. Name cleanup is fine.

Amount sign: positive = money out, negative = money in.

---

## Categories

\`categoryId\` is only valid on \`REGULAR\` transactions. Use the slug in backticks. Choose the most specific matching category.

{{categories}}

---

## Tags

Apply \`tagIds\` only when clearly appropriate. Use the slug in backticks. Do not apply trip-related tags if there is any doubt whether they apply.

{{tags}}

---

## Guidelines

**Name** — strip bank codes, asterisks, store numbers, and truncation artifacts. Use the recognizable merchant name. Omit \`name\` if it's already clean.
- \`"AMZN Mktp US*AB12345"\` → \`"Amazon"\`
- \`"SQ *VILLAGE PIZZA"\` → \`"Village Pizza"\`
- \`"WHOLEFDS MKT #12345"\` → \`"Whole Foods"\`
- \`"Dir Dep Acme Corp"\` → \`"Acme Corp"\`

**\`INTERNAL_TRANSFER\`** — outgoing (positive amount): use a descriptive name like \`"Credit Card Payment"\` or \`"Auto Loan Payment"\`; incoming (negative amount): always name \`"Transfer"\`.

**\`suggestedCategoryIds\`** — use it when it matches your confidence; override it when history or context points to a better category.

---

## Tools

- **\`search_merchant_names\`** — use before setting any \`name\` to find the canonical form already used in this account.
- **\`search_transactions\`** — use when a bank code is cryptic or you want to confirm a merchant's usual category from history.
- **Web search** — use when you can't identify the merchant from history. Search sparingly.

---

## Matched Rules

{{matched_rules}}
`;
