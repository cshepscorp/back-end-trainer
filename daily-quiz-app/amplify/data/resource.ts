import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { dailyQuizGenerator } from '../functions/daily-quiz-generator/resource';

/*
  Data model for the daily quiz app.

  - Question: the shared question bank (seeded once from src/data/questions.json,
    which is exported from the same content as the self-guided quiz.html).
  - Progress: one record per (topic, difficulty) combo — tracks whether you've
    marked it complete, your best score, and a streak count.
  - DailyQuiz: one record per calendar date. The original `topic`/`difficulty`/
    `questionIds`/`answeredCount`/`correctCount`/`completed`/`emailSent` fields
    represent the morning session, unchanged since this ran once a day. The
    `pm*` fields are additive (added when a second, afternoon run was
    introduced) rather than a new identifier/key shape — changing the
    identifier would force DynamoDB to replace the table and lose every past
    day's history, so a same-day second session is modeled as more columns on
    the same row instead of a second row.
  - QuizSettings: a single row (fixed id 'global') holding user-controlled
    toggles. Right now that's just `pausedUntil` — set it from the app before
    a trip and the scheduled function silently skips generating/emailing
    until that date passes, no separate "resume" step needed.

  Auth: publicApiKey for everything. This is a single-user app with no login
  screen (matches "skip auth for now"), so API-key auth is the simplest mode —
  anyone with the key (which only lives in your own deployed app / Lambda env)
  can read/write. Fine for personal use; would need to move to Cognito-based
  owner auth if this ever became multi-user.
*/
const schema = a.schema({
  Question: a
    .model({
      questionId: a.string().required(),
      topic: a.string().required(),
      difficulty: a.string().required(),
      type: a.string().required(), // 'mc' | 'flip'
      prompt: a.string(), // mc question text
      options: a.string().array(),
      optionsAlt: a.string().array(),
      correctIndex: a.integer(),
      explain: a.string(),
      front: a.string(), // flip question text
      back: a.string(),
      source: a.string().array(),
    })
    .identifier(['questionId'])
    .authorization((allow) => [allow.publicApiKey()]),

  Progress: a
    .model({
      topic: a.string().required(),
      difficulty: a.string().required(),
      status: a.string().required(), // 'not-started' | 'in-progress' | 'complete'
      bestScorePct: a.integer(),
      streak: a.integer(),
      lastAttemptDate: a.string(), // YYYY-MM-DD
      completedManually: a.boolean(),
    })
    .identifier(['topic', 'difficulty'])
    .authorization((allow) => [allow.publicApiKey()]),

  DailyQuiz: a
    .model({
      date: a.string().required(), // YYYY-MM-DD, also the identifier
      // Morning session — unchanged shape/meaning from before the PM session existed.
      topic: a.string().required(),
      difficulty: a.string().required(),
      questionIds: a.string().array().required(),
      answeredCount: a.integer().default(0),
      correctCount: a.integer().default(0),
      completed: a.boolean().default(false),
      emailSent: a.boolean().default(false),
      // Per-question responses for review later — array of
      // { questionId, type, chosenIndex?, draftAnswer?, selfGrade? }.
      // Previously nothing captured what you actually answered, only the
      // aggregate answeredCount/correctCount, so there was nothing to
      // review beyond a bare score. json() rather than a nested model
      // since this is only ever read back as a whole for its own session,
      // never queried into individually.
      answers: a.json(),
      // Afternoon session — optional/nullable since past dates (and any day
      // where the PM run hasn't fired yet) simply won't have these set.
      pmTopic: a.string(),
      pmDifficulty: a.string(),
      pmQuestionIds: a.string().array(),
      pmAnsweredCount: a.integer().default(0),
      pmCorrectCount: a.integer().default(0),
      pmCompleted: a.boolean().default(false),
      pmEmailSent: a.boolean().default(false),
      pmAnswers: a.json(),
    })
    .identifier(['date'])
    .authorization((allow) => [allow.publicApiKey()]),

  QuizSettings: a
    .model({
      id: a.string().required(), // always 'global' — single-user app, one settings row
      pausedUntil: a.string(), // YYYY-MM-DD, inclusive — quizzes resume the day after this
    })
    .identifier(['id'])
    .authorization((allow) => [allow.publicApiKey()]),
})
  // Schema-level grant (this is the piece that actually wires up the
  // $amplify/env/<function-name> module and the IAM-based data client
  // config inside the function — model-level publicApiKey() rules above
  // are separate and still what the frontend uses). Function access can
  // only be configured here, not per-model.
  .authorization((allow) => [allow.resource(dailyQuizGenerator)]);

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'apiKey',
    // 365 days so you don't have to think about rotating it for personal use.
    // Amplify will warn you as it approaches expiry — just redeploy to renew.
    apiKeyAuthorizationMode: { expiresInDays: 365 },
  },
});
