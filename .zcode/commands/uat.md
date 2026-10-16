---
description: Boot the local Docker stack and run the Playwright UAT suite
---

1. Dispatch the `devops` agent to bring the local Docker stack up and healthy (app + local Supabase).
2. Dispatch the `tester` agent to run the full Playwright suite as UAT against it.
3. Report the per-scenario table and the overall GREEN/RED verdict. If RED, list the failing scenarios and the reproduction commands.
