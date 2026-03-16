import { PrismaClient } from "@prisma/client";

/** Stop words to exclude from TF-IDF scoring */
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "to", "of", "in",
  "for", "on", "with", "at", "by", "from", "as", "into", "through",
  "during", "before", "after", "above", "below", "between", "out", "off",
  "over", "under", "again", "further", "then", "once", "and", "but", "or",
  "nor", "not", "no", "so", "too", "very", "just", "than", "that", "this",
  "these", "those", "it", "its", "my", "your", "his", "her", "our", "their",
  "what", "which", "who", "when", "where", "why", "how", "all", "each",
  "every", "both", "few", "more", "most", "other", "some", "such",
  "up", "about", "task", "new", "add", "create", "update", "fix",
]);

/** Tokenize text into lowercase words, removing stop words and short tokens */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/** Compute term frequency for a document */
function computeTF(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  // Normalize
  const maxFreq = Math.max(...tf.values(), 1);
  for (const [term, count] of tf) {
    tf.set(term, count / maxFreq);
  }
  return tf;
}

/**
 * Auto-tagger service using TF-IDF to suggest tags for a task.
 * Matches task content against existing project tags by name similarity.
 */
export async function suggestTags(
  prisma: PrismaClient,
  taskId: string,
  maxSuggestions = 5
): Promise<string[]> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { tags: true },
  });

  if (!task) return [];

  // Get all project tags
  const allTags = await prisma.tag.findMany({
    where: { projectId: task.projectId },
  });

  if (allTags.length === 0) return [];

  // Build text from task
  const descText = typeof task.description === "string" ? task.description : "";
  const bodyText = task.body ?? "";
  const text = `${task.title} ${bodyText} ${descText}`;
  const tokens = tokenize(text);

  if (tokens.length === 0) return [];

  const tf = computeTF(tokens);

  // Existing tag IDs to skip
  const existingTagIds = new Set(task.tags.map((tt) => tt.tagId));

  // Score each tag: how well does the tag name match the task's content
  const scored: Array<{ tagId: string; score: number }> = [];

  for (const tag of allTags) {
    if (existingTagIds.has(tag.id)) continue;

    const tagTokens = tokenize(tag.name);
    let score = 0;

    for (const tagToken of tagTokens) {
      // Exact match
      if (tf.has(tagToken)) {
        score += tf.get(tagToken)! * 2;
        continue;
      }

      // Partial match: tag token is substring of any task token
      for (const [term, freq] of tf) {
        if (term.includes(tagToken) || tagToken.includes(term)) {
          score += freq;
          break;
        }
      }
    }

    if (score > 0) {
      scored.push({ tagId: tag.id, score });
    }
  }

  // Sort by score descending, take top N
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxSuggestions).map((s) => s.tagId);
}

/** Apply auto-tags to a task (called after task creation) */
export async function autoTagTask(
  prisma: PrismaClient,
  taskId: string
): Promise<void> {
  const suggestedTagIds = await suggestTags(prisma, taskId);

  if (suggestedTagIds.length === 0) return;

  await prisma.taskTag.createMany({
    data: suggestedTagIds.map((tagId) => ({
      taskId,
      tagId,
    })),
    skipDuplicates: true,
  });
}
