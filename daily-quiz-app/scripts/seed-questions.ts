/*
  One-time (and re-runnable) seed script — loads src/data/questions.json into
  the deployed Question table.

  Run this yourself, after `npx ampx sandbox` (or a real deploy) has produced
  an amplify_outputs.json in the project root:

    npx tsx scripts/seed-questions.ts

  Safe to re-run: existing questionIds are skipped rather than duplicated, so
  after adding new questions to questions.json (e.g. the JS/AI-LLM topics),
  just run it again — only the new ones get created.
*/
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../amplify/data/resource';
// @ts-expect-error - generated at deploy time, won't exist until you've run `ampx sandbox` once
import outputs from '../amplify_outputs.json';
import questions from '../src/data/questions.json';

Amplify.configure(outputs);
const client = generateClient<Schema>();

async function main() {
  console.log(`Seeding ${questions.length} questions...`);

  const existing = new Set<string>();
  let nextToken: string | null | undefined;
  do {
    const page: Awaited<ReturnType<typeof client.models.Question.list>> = await client.models.Question.list({
      limit: 200,
      nextToken,
      selectionSet: ['questionId'],
    });
    for (const q of page.data) existing.add(q.questionId);
    nextToken = page.nextToken;
  } while (nextToken);

  let created = 0;
  let skipped = 0;
  for (const q of questions) {
    if (existing.has(q.questionId)) {
      skipped++;
      continue;
    }
    const { errors } = await client.models.Question.create(q as Schema['Question']['type']);
    if (errors) {
      console.error(`Failed to create ${q.questionId}:`, errors);
    } else {
      created++;
    }
  }

  console.log(`Done. Created ${created}, skipped ${skipped} already-seeded.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
