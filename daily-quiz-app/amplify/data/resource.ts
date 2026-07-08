import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { dailyQuizGenerator } from '../functions/daily-quiz-generator/resource';

/*
  Data model for the daily quiz app.

  - Question: the shared question bank (seeded once from src/data/questions.json,
    which is exported from the same content as the self-guided quiz.html).
  - Progress: one record per (topic, difficulty) combo — tracks whether you've
    marked it complete, your best score, and a streak count.
  - DailyQuiz: one record per calendar date — the specific set of questions the
    scheduled function picked for that morning, plus how you did on it.

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
      topic: a.string().required(),
      difficulty: a.string().required(),
      questionIds: a.string().array().required(),
      answeredCount: a.integer().default(0),
      correctCount: a.integer().default(0),
      completed: a.boolean().default(false),
      emailSent: a.boolean().default(false),
    })
    .identifier(['date'])
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
