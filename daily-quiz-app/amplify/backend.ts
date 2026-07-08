import { defineBackend } from '@aws-amplify/backend';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { data } from './data/resource';
import { dailyQuizGenerator } from './functions/daily-quiz-generator/resource';

const backend = defineBackend({
  data,
  dailyQuizGenerator,
});

// Note: the function's read/write access to the Data API is granted in
// amplify/data/resource.ts via `.authorization((allow) => [allow.resource(dailyQuizGenerator)])`
// on the schema itself — that's the piece that also wires up the
// `$amplify/env/daily-quiz-generator` module the handler imports. Granting
// it here instead via `graphqlApi.grantQuery/grantMutation` gives the same
// IAM permissions but *doesn't* wire up that generated env module, which is
// what caused the "malformed environment variables" error the first time.

// Let the function send email via SES. Sandbox-mode SES only requires the
// send permission — no domain/production-access setup for a single
// verified-to-yourself address.
backend.dailyQuizGenerator.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['ses:SendEmail', 'ses:SendRawEmail'],
    resources: ['*'],
  }),
);
