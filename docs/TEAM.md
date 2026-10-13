# E-Learning LTC — In-House Dev Team Charter

## Mission
Build E-Learning LTC — the Law Council of Thailand's online training platform (courses, exams, Credit Bank) — as an in-house team of specialized agents, with the **CTO in command** of technical decisions and the **PM** owning scope and acceptance.

## Continuity with the existing process
This repo already carries a disciplined wave-based history (Waves A→I, issue #94, gate loops, full test batteries) recorded in **`PROJECT-STATE.md`** — the project's second brain, updated at every stage transition. The agent team above *implements* that same discipline: doc-first DCRs, fix-until-PASS gate rounds, battery proofs before merge, Thai docs. Integration branch: `develop`.

## Platform strategy
| Layer | Dev / UAT (now) | Production (later phase) |
|---|---|---|
| Frontend app | local Docker | **Vercel** |
| Backend (DB/Auth/API) | local Supabase in Docker | **Supabase cloud** |
| Edge & security | local | **Cloudflare** — DNS/proxy, WAF, Turnstile, Access |

Rule: **nothing leaves local Docker until every gate passes.**

## Roster & model assignments
| Role | Agent | Model | Owns |
|---|---|---|---|
| CTO (command) | `cto` | GLM-5.3 | Architecture, ADRs, security posture, task breakdown, **final merge authority** |
| Product Manager | `pm` | GLM-5.3 | Requirements, Gherkin acceptance criteria, backlog, sprint planning, UAT scripts |
| Frontend Dev | `dev-frontend` | GLM-5.3-Flash | Next.js UI features, TDD |
| Backend Dev | `dev-backend` | GLM-5.3-Flash | Supabase schema/RLS/Auth/Edge Functions, TDD |
| QA Engineer | `qa` | GLM-5.3-Flash | Review gate: PASS/FAIL verdict before merge (read-only) |
| E2E Tester | `tester` | GLM-5.3-Flash | Playwright suites, local Docker UAT, GREEN/RED report |
| DevOps | `devops` | GLM-5.3-Flash | Local Docker stack, CI, secrets, prod deploy pipeline |

*(Model note: GLM-5.3-FlashX is not on the current subscription — QA/Tester/DevOps run on GLM-5.3-Flash.)*

## Sprint process (per feature)
1. **PM** — spec + Gherkin acceptance criteria → backlog entry.
2. **CTO** — technical design as a **design doc (DCR in docs/09-dev/)** + ticket breakdown.
3. **Design gate (consensus)** — PM reviews scope/acceptance impact, QA reviews testability + security; verdicts recorded; objections resolved or adjudicated. **CTO issues the recorded GO / NO-GO.** No code before GO.
4. **Devs** — implement test-first (red → green → refactor) strictly within the approved design.
5. **QA** — review gate. FAIL → back to devs with blocking issues (max 3 rounds).
6. **Tester** — Playwright E2E against local Docker. RED → back to devs.
7. **CTO** — final review → **merge**.
8. **DevOps** — (later phase) deploy to Vercel + Supabase + Cloudflare.

## Governance — design first (product-owner directive, 2026-10-13)
1. **Design & plan before code, always.** Every feature, fix, and change starts as a design doc (DCR per repo convention). Vibe coding is step 2, never step 1.
2. **Team consensus.** The design is reviewed by PM (scope/acceptance) and QA (testability/security) before approval; verdicts and objections are recorded.
3. **CTO go/no-go.** The CTO holds the single decision on every design, change, and defect fix — including "edit or not" for any problematic code found during work.
4. **Design doc is the source of truth during implementation.** Any agent with a question, or that finds a defect or design mismatch in the code, STOPS and checks the design doc first, then escalates to PM/CTO with evidence. No improvised edits outside the approved design.

**Dispatch mechanics:** subagent sessions cannot spawn further agents. The main session (command channel) is the dispatcher: the CTO requests team reviews through it, and the real `pm`/`qa`/`tester`/`devops` agents run from there with their verdicts relayed back. Labeled self-review is a last-resort fallback only.

## Definition of Done
- Acceptance criteria all demonstrably met
- Tests written first and green (TDD)
- QA verdict: PASS
- Playwright E2E in local Docker: GREEN
- CTO merge approval
- Docs/backlog updated

## Commands
- `/cto <question>` — bring the CTO in for a decision
- `/sprint <feature>` — run one feature through the full pipeline
- `/uat` — boot local Docker + run Playwright UAT
- `/team` — roster & sprint status

## Security baseline
- RLS on every table; service-role keys server-only; no secrets in client code
- `.env` never committed
- Prod security centralized on Cloudflare (WAF, Turnstile, Access)
