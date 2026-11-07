# Contributing

1. Follow the setup in the README, with `AI_FAKE=1` and a local mail server.
2. Add a test that fails before your fix.
3. Run `npx tsc --noEmit`, `npx vitest run` and `npx playwright test`.
4. Send a small pull request that says what changed and why.

Tests must never send mail to real people.
