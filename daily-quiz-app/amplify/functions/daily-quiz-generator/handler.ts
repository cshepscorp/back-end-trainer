import type { Schema } from '../../data/resource';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

// Reading process.env directly instead of importing the generated
// `$amplify/env/<function-name>` module. That module's only real job is
// giving TypeScript types; the actual values (including the SSM-resolved
// ones getAmplifyDataClientConfig needs) land in process.env at runtime via
// a banner script Amplify injects into the bundle automatically — visible
// in a CDK build log as `internalAmplifyFunctionResolveSsmParams`. That
// injection is triggered by the schema-level `allow.resource(dailyQuizGenerator)`
// grant in amplify/data/resource.ts, not by this import. The import itself
// resolved fine locally under `npx ampx sandbox` but failed to resolve
// during Amplify Hosting's CI bundling step (`ampx pipeline-deploy`) —
// apparently a different bundler code path. Using process.env sidesteps
// needing esbuild to resolve that virtual module at all.
const env = process.env as NodeJS.ProcessEnv & {
  NOTIFY_EMAIL: string;
  AUTO_COMPLETE_THRESHOLD_PCT: string;
  APP_URL: string;
};

// Stable ordering so the rotation is deterministic and easy to reason about —
// walk topics in this order, and within each topic, easy -> advanced.
const TOPIC_ORDER = [
  'node-express',
  'node-internals',
  'proxy',
  'frontend',
  'databases',
  'auth',
  'terminal',
  'db-performance',
  'testing',
  'security',
  'system-design',
  'production',
  'javascript',
  'ai-llm',
  'infra-as-code',
  'synthesis',
];
const DIFFICULTY_ORDER = ['easy', 'moderate', 'hard', 'advanced'];
const QUESTIONS_PER_DAY = 8;
const MIN_QUESTIONS_FOR_A_SESSION = 3;

function todayDateString(): string {
  // Plain UTC date. If you're regularly quizzing right around midnight and
  // it feels off-by-one, swap this for an explicit America/New_York
  // conversion — not worth the complexity otherwise.
  return new Date().toISOString().slice(0, 10);
}

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export const handler = async () => {
  // process.env genuinely has AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /
  // AWS_SESSION_TOKEN / AWS_REGION / AMPLIFY_DATA_DEFAULT_NAME at runtime —
  // Lambda always injects the first four, and the schema-level grant sets
  // the last one. TypeScript just can't see that from NodeJS.ProcessEnv's
  // type (everything's optional there), so this cast bypasses that
  // mismatch rather than hand-rolling the exact DataClientEnv shape.
  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env as any);
  Amplify.configure(resourceConfig, libraryOptions);
  const client = generateClient<Schema>();

  const date = todayDateString();

  // If today's quiz already exists (e.g. function got triggered twice),
  // don't clobber it — just resend the email as a reminder and exit.
  const existing = await client.models.DailyQuiz.get({ date });
  if (existing.data) {
    await sendEmail(existing.data.topic, existing.data.difficulty, existing.data.questionIds.length, true);
    return;
  }

  // Pull every question and every progress record. Both collections are
  // small (a couple hundred rows at most), so a full scan once a day is
  // cheap — no need for anything fancier.
  const allQuestions: Schema['Question']['type'][] = [];
  let nextToken: string | null | undefined;
  do {
    const page: Awaited<ReturnType<typeof client.models.Question.list>> = await client.models.Question.list({
      limit: 200,
      nextToken,
    });
    allQuestions.push(...page.data);
    nextToken = page.nextToken;
  } while (nextToken);

  const allProgress: Schema['Progress']['type'][] = [];
  nextToken = undefined;
  do {
    const page: Awaited<ReturnType<typeof client.models.Progress.list>> = await client.models.Progress.list({
      limit: 200,
      nextToken,
    });
    allProgress.push(...page.data);
    nextToken = page.nextToken;
  } while (nextToken);

  const progressByKey = new Map(allProgress.map((p) => [`${p.topic}::${p.difficulty}`, p]));

  // Group questions by topic+difficulty so we know which combos actually
  // have enough content to quiz on.
  const questionsByKey = new Map<string, Schema['Question']['type'][]>();
  for (const q of allQuestions) {
    const key = `${q.topic}::${q.difficulty}`;
    if (!questionsByKey.has(key)) questionsByKey.set(key, []);
    questionsByKey.get(key)!.push(q);
  }

  // Build the full ordered list of viable combos, then find the first one
  // that isn't complete yet.
  const orderedKeys: string[] = [];
  for (const topic of TOPIC_ORDER) {
    for (const difficulty of DIFFICULTY_ORDER) {
      const key = `${topic}::${difficulty}`;
      if ((questionsByKey.get(key)?.length ?? 0) >= MIN_QUESTIONS_FOR_A_SESSION) {
        orderedKeys.push(key);
      }
    }
  }

  let chosenKey = orderedKeys.find((key) => progressByKey.get(key)?.status !== 'complete');
  // Everything's complete — start the rotation over instead of doing nothing.
  if (!chosenKey) chosenKey = orderedKeys[0];
  if (!chosenKey) {
    // No question bank seeded yet.
    await sendEmail('(none)', '(none)', 0, false, true);
    return;
  }

  const [topic, difficulty] = chosenKey.split('::');
  const pool = questionsByKey.get(chosenKey) ?? [];
  const picked = shuffle(pool).slice(0, Math.min(QUESTIONS_PER_DAY, pool.length));

  await client.models.DailyQuiz.create({
    date,
    topic,
    difficulty,
    questionIds: picked.map((q) => q.questionId),
    answeredCount: 0,
    correctCount: 0,
    completed: false,
    emailSent: true,
  });

  // Make sure a Progress row exists so the frontend has something to
  // read/update, defaulting to 'in-progress' the first time this combo comes up.
  const existingProgress = progressByKey.get(chosenKey);
  if (!existingProgress) {
    await client.models.Progress.create({
      topic,
      difficulty,
      status: 'in-progress',
      bestScorePct: 0,
      streak: 0,
      lastAttemptDate: date,
      completedManually: false,
    });
  }

  await sendEmail(topic, difficulty, picked.length, false);
};

async function sendEmail(
  topic: string,
  difficulty: string,
  questionCount: number,
  isReminder: boolean,
  noBankSeeded = false,
) {
  const ses = new SESClient({});
  const to = env.NOTIFY_EMAIL;

  const subject = noBankSeeded
    ? 'Daily quiz — question bank not seeded yet'
    : `Daily quiz ready: ${topic} (${difficulty})${isReminder ? ' — reminder' : ''}`;

  const body = noBankSeeded
    ? `The daily quiz function ran, but found no questions in the Question table yet. Run the seed script (scripts/seed-questions.ts) once, then this'll pick up on the next scheduled run.`
    : `Today's section: ${topic} — ${difficulty} (${questionCount} questions).\n\n${env.APP_URL}\n\nScore 80%+ and it auto-marks the section complete; you can also mark it complete or reopen it manually any time from the app.`;

  // SES sandbox mode is fine here since sender and recipient are the same
  // verified address — no need to request production access for personal use.
  await ses.send(
    new SendEmailCommand({
      Source: to,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject },
        Body: { Text: { Data: body } },
      },
    }),
  );
}
