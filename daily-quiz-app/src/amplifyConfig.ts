import { Amplify } from 'aws-amplify';
// This file is generated the first time you run `npx ampx sandbox` (or a
// real deploy) — it won't exist yet in a fresh checkout, which is expected.
// @ts-expect-error - generated at deploy time
import outputs from '../amplify_outputs.json';

Amplify.configure(outputs);
