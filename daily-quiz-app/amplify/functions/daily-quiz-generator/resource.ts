import { defineFunction, secret } from '@aws-amplify/backend';

/*
  Runs twice a day (EventBridge, managed by Amplify — nothing for you to
  provision) — a morning session and an afternoon session, each covering a
  different (topic, difficulty) combo so a day's practice covers two
  sections instead of one. Each run:
    1. Looks at Progress (and, for the afternoon run, whatever the morning
       run already picked today) to find the next combo that isn't marked
       complete yet and wasn't already used today.
    2. Picks a handful of questions from Question for that combo.
    3. Writes that session's fields onto today's DailyQuiz record (the
       handler tells AM and PM apart by which cron entry's hour it's
       closest to — see AM_HOUR_UTC/PM_HOUR_UTC in handler.ts).
    4. Emails you via SES so you know it's ready.

  Cron is UTC, array = multiple schedules. '0 11 * * ? *' = 11:00 UTC = 7am
  ET during EDT (6am during EST). '0 16 * * ? *' = 16:00 UTC = noon ET
  during EDT (11am during EST). Both drift an hour across the DST
  changeover twice a year unless you update them — same caveat as before,
  now doubled.

  NOTE: Amplify's scheduling syntax has shifted slightly across backend-cli
  versions. If `npx ampx sandbox` complains about this `schedule` field,
  check the current syntax at docs.amplify.aws under Functions > Scheduling.
*/
export const dailyQuizGenerator = defineFunction({
  name: 'daily-quiz-generator',
  entry: './handler.ts',
  schedule: ['0 11 * * ? *', '0 16 * * ? *'],
  timeoutSeconds: 30,
  environment: {
    // secret() pulls this from Amplify's secret store (backed by SSM
    // Parameter Store) instead of embedding the value directly in code —
    // it resolves into process.env.NOTIFY_EMAIL at runtime through the
    // exact same mechanism as the schema-level Data-access grant (the
    // auto-injected banner script this project's CI debugging already
    // covered). handler.ts needs zero changes because of that — it was
    // already just reading process.env.NOTIFY_EMAIL either way.
    //
    // You still have to actually set the value in two places before this
    // works end to end:
    //   1. Locally, for sandbox testing:  npx ampx sandbox secret set NOTIFY_EMAIL
    //   2. In the Amplify Console, for the deployed `main` branch:
    //      App settings -> Secrets -> add NOTIFY_EMAIL with the real value
    // Until step 2 is done, a real deploy of this function would have
    // NOTIFY_EMAIL undefined and the SES send would fail silently (no
    // email that morning, no separate error notification) — worth one
    // manual Lambda test invoke after deploying to confirm it resolved.
    NOTIFY_EMAIL: secret('NOTIFY_EMAIL'),
    // 80%+ on a section auto-marks it complete (per your "auto + manual" choice).
    AUTO_COMPLETE_THRESHOLD_PCT: '80',
    // The deployed frontend's URL, so the email can actually link somewhere.
    // Update this if you add a custom domain later.
    APP_URL: 'https://main.d561oj08e0okr.amplifyapp.com',
  },
});
