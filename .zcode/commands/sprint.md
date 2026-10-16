---
description: Run one feature through the full team pipeline (PM → CTO → devs → QA → E2E → merge gate)
---

Run one feature through the full in-house team pipeline. Target feature: $ARGUMENTS
If empty, take the top `todo` item from `docs/backlog.md`; if the backlog has none, ask the user what to build.

Pipeline — each step's output feeds the next:
1. **PM** (`pm` agent) — produce the spec with Gherkin acceptance criteria; add/update the `docs/backlog.md` entry.
2. **CTO** (`cto` agent) — technical design as a **design doc (DCR in docs/09-dev/)** + ticket breakdown for `dev-frontend` / `dev-backend`.
3. **Design gate — consensus + GO.** PM reviews scope/acceptance impact; QA (`qa` agent) reviews testability + security. Verdicts recorded (objections resolved or adjudicated). CTO issues the recorded **GO/NO-GO**. **No code before GO — vibe coding is step 2, never step 1.**
4. **Devs** (`dev-frontend` and/or `dev-backend` agents, in parallel where the tickets are independent) — implement test-first, strictly within the approved design.
5. **QA** (`qa` agent) — review gate (including design conformance). On FAIL, send the blocking issues back to the devs; loop up to 3 rounds.
6. **Tester** (`tester` agent) — Playwright E2E against the local Docker stack (ask `devops` to bring it up healthy first). On RED, back to the devs.
7. **CTO** — final review and merge approval.

Merge **only** when QA verdict is PASS, E2E is GREEN, and the CTO approves. Finish with a sprint summary table: step | agent | outcome.
