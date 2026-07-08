# Deploying the daily quiz app

Everything here runs with **your own AWS credentials, on your own machine** —
I didn't and can't deploy any of this myself; I only wrote the code. Run
these commands yourself in a terminal.

## What this is

A separate, cloud-hosted companion to `quiz.html`: an EventBridge-scheduled
Lambda picks the next not-yet-complete (topic, difficulty) section each
morning, stores it in DynamoDB, and emails you. A small React app (also
hosted on Amplify) lets you take that quiz, see your progress across every
section, and mark sections complete manually. Progress here is completely
separate from `quiz.html`'s localStorage — only the question content is
shared (`src/data/questions.json`, exported from the same bank `quiz.html`
uses).

## 0. Prerequisites

- Node 18+ and an AWS account (you've got both already).
- AWS CLI configured with credentials that can create Lambda/DynamoDB/AppSync/SES/IAM resources: `aws configure` (or SSO login) if you haven't pointed the CLI at this account yet.

## 1. Install dependencies

```
cd daily-quiz-app
npm install
```

## 2. Stand up a personal sandbox (for testing)

Amplify Gen 2's "sandbox" is a real, deployed cloud environment tied to your
AWS credentials — good for confirming everything works before making it
permanent.

```
npx ampx sandbox
```

Leave this running in a terminal tab (it watches for file changes and
redeploys). On first run it'll take several minutes and will generate an
`amplify_outputs.json` file in the project root — that file is how the
frontend and the seed script know how to reach your deployed backend.

If `schedule: '0 11 * * ? *'` in
`amplify/functions/daily-quiz-generator/resource.ts` or the
`getAmplifyDataClientConfig` import in `handler.ts` throws an error here,
that's the one part of this build I couldn't verify locally (see "What I
couldn't test locally" below) — check the current syntax at
docs.amplify.aws and adjust.

## 3. Verify an SES email identity

Since this only ever emails you, SES's default "sandbox mode" (no
production-access request needed) is enough:

1. AWS Console → **SES** → **Verified identities** → **Create identity** → Email address → `sheppard.christy@gmail.com`
2. Click the confirmation link AWS sends to that inbox.

That's it — sandbox-mode SES lets a verified address send to itself.

## 4. Seed the question bank

Once step 2 has produced `amplify_outputs.json`:

```
npx tsx scripts/seed-questions.ts
```

This loads `src/data/questions.json` into the Question table. Re-runnable —
already-seeded questions are skipped, so run it again any time new questions
are added (e.g. once the JS/AI-LLM topics are in).

## 5. Try the frontend locally

```
npm run dev
```

Progress table will be empty until the scheduled function runs once, or you
test it directly (next step).

## 6. Test the scheduled function without waiting for morning

AWS Console → **Lambda** → find the function (named like
`amplify-...-dailyquizgenerator...`) → **Test** → invoke with an empty `{}`
event → check **CloudWatch Logs** for errors, and check your email.

## 7. Make it actually persistent

`ampx sandbox` is meant for iteration — it's tied to your local terminal
session and the CLI's own docs suggest tearing it down when you're not
actively developing (`npx ampx sandbox delete`). It is **not** the right
thing to leave running unattended for months as your "real" morning quiz
service.

For that, push this project to a git repo (GitHub/GitLab/CodeCommit) and
connect it in the **Amplify Console** (Hosting → New app → connect
repository). That creates a real branch deployment — the schedule, function,
and data all keep running independent of your laptop being on. Re-run the
seed script once against that deployed environment's `amplify_outputs.json`
the same way as step 4.

## What I couldn't test locally

I don't have a way to run the actual AWS deploy from my side, and a couple
of heavier dependencies (`@aws-amplify/backend`, `constructs`, `tsx`)
wouldn't finish installing in my sandbox environment (kept timing out on a
large dependency tree — not a reflection of anything wrong with the
packages themselves). I checked every file for syntax correctness, and the
two riskiest spots — the `defineFunction` `schedule` field and the
in-Lambda Data client wiring via `getAmplifyDataClientConfig` — are
commented in the code with exactly what to check against current Amplify
docs if `ampx sandbox` complains. Both are well-documented, stable-ish
Amplify Gen 2 patterns, just the part of the API surface that's shifted the
most over time.
