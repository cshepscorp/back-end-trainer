import { defineFunction } from '@aws-amplify/backend';

/*
  Runs on a schedule (EventBridge, managed by Amplify — nothing for you to
  provision). Each morning it:
    1. Looks at Progress to find the next (topic, difficulty) combo that
       isn't marked complete yet.
    2. Picks a handful of questions from Question for that combo.
    3. Writes a DailyQuiz record for today's date.
    4. Emails you via SES so you know it's ready.

  Cron is UTC. '0 11 * * ? *' = 11:00 UTC = 7am ET during EDT (6am during
  EST) — adjust the hour to taste, and note it'll drift an hour across the
  DST changeover twice a year unless you update it.

  NOTE: Amplify's scheduling syntax has shifted slightly across backend-cli
  versions. If `npx ampx sandbox` complains about this `schedule` field,
  check the current syntax at docs.amplify.aws under Functions > Scheduling.
*/
export const dailyQuizGenerator = defineFunction({
  name: 'daily-quiz-generator',
  entry: './handler.ts',
  schedule: '0 11 * * ? *',
  timeoutSeconds: 30,
  environment: {
    NOTIFY_EMAIL: 'sheppard.christy@gmail.com',
    // 80%+ on a section auto-marks it complete (per your "auto + manual" choice).
    AUTO_COMPLETE_THRESHOLD_PCT: '80',
    // The deployed frontend's URL, so the email can actually link somewhere.
    // Update this if you add a custom domain later.
    APP_URL: 'https://main.d561oj08e0okr.amplifyapp.com',
  },
});
