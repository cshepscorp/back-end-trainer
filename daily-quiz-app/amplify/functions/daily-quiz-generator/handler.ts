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

// Matches the two cron entries in resource.ts. The handler doesn't get told
// which schedule entry fired it — EventBridge doesn't pass that through —
// so it infers AM vs PM from whichever hour "now" is closest to. Nearest
// match (not exact) so a manual Lambda console test invoke, which won't
// land on either cron minute, still resolves to something sensible instead
// of always defaulting to one slot.
const AM_HOUR_UTC = 11;
const PM_HOUR_UTC = 16;

type Slot = 'am' | 'pm';

function currentSlot(): Slot {
  const hour = new Date().getUTCHours();
  const dist = (h: number) => Math.min(Math.abs(hour - h), 24 - Math.abs(hour - h));
  return dist(PM_HOUR_UTC) < dist(AM_HOUR_UTC) ? 'pm' : 'am';
}

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

// EventBridge's scheduled invocations call this with an empty/irrelevant
// event, so `forceSlot` only ever comes from a manual Lambda console test —
// real cron runs always fall through to currentSlot(). Purely a testing
// convenience: without it, deliberately exercising both the AM and PM
// branches in one sitting would mean waiting for real clock time to drift
// between 11:00 and 16:00 UTC.
export const handler = async (event?: { forceSlot?: 'am' | 'pm' }) => {
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
  const slot = event?.forceSlot === 'am' || event?.forceSlot === 'pm' ? event.forceSlot : currentSlot();

  // Manual pause, set from the app before a trip (see QuizSettings in the
  // schema). Inclusive of pausedUntil itself — quizzes resume the day after.
  // No separate "resume" step: this just stops mattering once today's date
  // passes it. Applies to both slots equally.
  const settings = await client.models.QuizSettings.get({ id: 'global' });
  if (settings.data?.pausedUntil && date <= settings.data.pausedUntil) {
    console.log(`Paused until ${settings.data.pausedUntil} — skipping today (${date}), no email sent.`);
    return;
  }

  const existing = (await client.models.DailyQuiz.get({ date })).data;

  if (slot === 'pm' && !existing) {
    // Normal cron ordering always has AM (11:00 UTC) fire hours before PM
    // (16:00 UTC), so this should only happen from an out-of-order manual
    // test invoke. Nothing sensible to build a PM session on top of yet —
    // skip quietly rather than writing a row with placeholder AM data.
    console.log("No DailyQuiz row for today yet (AM hasn't run) — skipping PM until AM generates one.");
    return;
  }

  // If this slot's session already exists for today (e.g. function got
  // triggered twice), don't clobber it — just resend the email as a
  // reminder and exit.
  if (slot === 'am' && existing?.topic) {
    await sendEmail('am', existing.topic, existing.difficulty, existing.questionIds.length, true);
    return;
  }
  if (slot === 'pm' && existing?.pmTopic) {
    await sendEmail('pm', existing.pmTopic, existing.pmDifficulty ?? '', (existing.pmQuestionIds ?? []).length, true);
    return;
  }

  // Pull every question and every progress record. Both collections are
  // small (a couple hundred rows at most), so a full scan on each run is
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

  // Build the full ordered list of viable combos.
  const orderedKeys: string[] = [];
  for (const topic of TOPIC_ORDER) {
    for (const difficulty of DIFFICULTY_ORDER) {
      const key = `${topic}::${difficulty}`;
      if ((questionsByKey.get(key)?.length ?? 0) >= MIN_QUESTIONS_FOR_A_SESSION) {
        orderedKeys.push(key);
      }
    }
  }

  // PM shouldn't repeat whatever AM already picked today, even if that
  // combo isn't marked complete yet — otherwise "twice a day" would
  // sometimes just be the same section twice in the same day.
  const excludeKey = slot === 'pm' && existing?.topic ? `${existing.topic}::${existing.difficulty}` : null;

  let chosenKey = orderedKeys.find((key) => key !== excludeKey && progressByKey.get(key)?.status !== 'complete');
  // Nothing incomplete left (aside from maybe today's other slot) — start
  // the rotation over instead of doing nothing.
  if (!chosenKey) chosenKey = orderedKeys.find((key) => key !== excludeKey);
  // Only one viable combo total, and it's the one being excluded — reuse it
  // anyway rather than send nothing.
  if (!chosenKey) chosenKey = orderedKeys[0];
  if (!chosenKey) {
    // No question bank seeded yet.
    await sendEmail(slot, '(none)', '(none)', 0, false, true);
    return;
  }

  const [topic, difficulty] = chosenKey.split('::');
  const pool = questionsByKey.get(chosenKey) ?? [];
  const picked = shuffle(pool).slice(0, Math.min(QUESTIONS_PER_DAY, pool.length));
  const questionIds = picked.map((q) => q.questionId);

  if (slot === 'am') {
    await client.models.DailyQuiz.create({
      date,
      topic,
      difficulty,
      questionIds,
      answeredCount: 0,
      correctCount: 0,
      completed: false,
      emailSent: true,
      pmCompleted: false,
      pmEmailSent: false,
    });
  } else {
    await client.models.DailyQuiz.update({
      date,
      pmTopic: topic,
      pmDifficulty: difficulty,
      pmQuestionIds: questionIds,
      pmAnsweredCount: 0,
      pmCorrectCount: 0,
      pmCompleted: false,
      pmEmailSent: true,
    });
  }

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

  await sendEmail(slot, topic, difficulty, picked.length, false);
};

async function sendEmail(
  slot: Slot,
  topic: string,
  difficulty: string,
  questionCount: number,
  isReminder: boolean,
  noBankSeeded = false,
) {
  const ses = new SESClient({});
  const to = env.NOTIFY_EMAIL;
  const sessionLabel = slot === 'am' ? 'Morning' : 'Afternoon';

  // Keeping the literal "Daily quiz" prefix on every variant — including
  // the reminder/no-bank-seeded cases — since that's what the Gmail filter
  // (subject contains "Daily quiz") matches on to keep these out of Spam.
  const subject = noBankSeeded
    ? 'Daily quiz — question bank not seeded yet'
    : `Daily quiz ready — ${sessionLabel}: ${topic} (${difficulty})${isReminder ? ' — reminder' : ''}`;

  const body = noBankSeeded
    ? `The daily quiz function ran, but found no questions in the Question table yet. Run the seed script (scripts/seed-questions.ts) once, then this'll pick up on the next scheduled run.`
    : `${sessionLabel} section: ${topic} — ${difficulty} (${questionCount} questions).\n\n${env.APP_URL}\n\nScore 80%+ and it auto-marks the section complete; you can also mark it complete or reopen it manually any time from the app.`;

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
