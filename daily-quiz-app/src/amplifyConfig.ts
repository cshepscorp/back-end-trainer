import { Amplify } from 'aws-amplify';
// This file is generated the first time you run `npx ampx sandbox` (or a
// real deploy) — it won't exist yet in a fresh checkout, which is expected.
// Using @ts-ignore rather than @ts-expect-error: the latter itself becomes
// an error once the file DOES exist (e.g. in CI, where the backend build
// phase generates it moments before this frontend build runs) — ts-ignore
// silently no-ops in both the "file missing" and "file present" cases.
// @ts-ignore
import outputs from '../amplify_outputs.json';

Amplify.configure(outputs);
