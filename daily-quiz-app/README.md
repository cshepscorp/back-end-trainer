# Daily Backend Quiz (Amplify)

Cloud-hosted companion to `../docs/quiz.html` — a scheduled Lambda picks a
not-yet-complete topic/difficulty each morning, emails you, and a small
React app (this project) lets you take it and track progress separately
from the self-guided quiz's localStorage.

**See [DEPLOY.md](./DEPLOY.md) for setup and deployment steps.** Nothing
here is deployed yet — it's source code you deploy yourself with your own
AWS credentials.

Question content (`src/data/questions.json`) is exported from the same bank
`quiz.html` uses, so the two stay in sync content-wise while tracking
progress completely independently.
