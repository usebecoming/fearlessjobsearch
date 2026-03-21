# Fearless Job Search - Development Notes

## Core Product Philosophy — Contacts

Contacts are the most valuable feature. The goal is never just "find the hiring manager for this job posting" — it's "help the user start a conversation at a company they want to work at."

This means:
- Always show contacts even when no jobs are posted (company target mode)
- Always show LinkedIn fallback links even when contacts are found ("Find more people at [Company]")
- Never show an empty state — there is always someone to reach out to
- The message is always "here's who to talk to" not "we couldn't find anyone"
- Confirmed employees with vague titles are still valuable — the user can click through and see who they are
- Recruiters and TA contacts are always relevant for any job function
- LinkedIn links must always include the currentCompany filter so users land on the right people
- `isFunctionRelevant` defaults to KEEP — only reject clearly wrong industry (nurse for Marketing, chef for People)

## Contact Pipeline Limitations

The contact finding pipeline uses Brave Search to find LinkedIn profiles via public web indexing. Known limitations:

- Coverage is strongest for companies with 500+ employees
- Small/obscure companies may return 0-2 contacts
- LinkedIn profiles update faster than Brave's index — some contacts may have changed roles
- Company names from JSearch are sometimes garbled (subsidiary codes, all-caps, etc.) — the cleaner handles most cases but edge cases exist
- The false positive blocklist (known HR consultants who appear across many companies) is maintained in the `knownFalsePositives` Set in search-contacts.js — add to it as new ones are found

## Job Search Limitations

- JSearch aggregates from LinkedIn, Indeed, Glassdoor, ZipRecruiter
- Results are filtered for relevance but market depth varies by location
- Senior L&D in Austin = thin market (~8-10 relevant jobs)
- Senior Software Engineering in SF = deep market (50+ jobs)
- Seniority loosening triggers automatically when < 10 jobs found after filtering
- Some JSearch timeouts are normal — retry logic handles them
- The blocklist covers MLM, staffing agencies, and known bad actors but new ones appear regularly — add to the list as found

## Known Issues (as of March 2026)

- Single-word LinkedIn slugs (e.g. hannahquach) display without spaces — name splitter handles most but not all
- Sharon Cannon CPO at Housing Authority consistently dropped by Claude verification — unknown cause, needs investigation
- Smith & Nephew company name cleaning edge case — "SMITH & NEPHEW SNATS INC" sometimes cleans to "SMITH &"
- Clifton Larson Allen LinkedIn slug not found via Brave — using generated slug "clifton-larson-allen" as fallback

## Development Process Rules

Before making any changes:
1. Review the full codebase and understand what exists
2. Identify dependencies and what could break
3. Share your plan in plain English and wait for approval before writing any code

When making changes:
4. Make edits incrementally, not all at once
5. After each change, verify: the new feature works, every other screen still works, no console errors
6. If anything is broken, fix it before moving on

After all changes:
7. Do a full audit of everything touched
8. Log any issues or warnings
9. Fix all issues before marking complete
10. Give a plain English summary of what changed, what was tested, and current app status

Never consider a task complete until the full app is working.

## Key Files

- `index.html` — Full app + landing page (single file)
- `api/search-jobs.js` — JSearch API + job filtering pipeline
- `api/search-contacts.js` — Brave Search + Claude contact verification
- `api/chat.js` — Claude API proxy
- `api/create-checkout.js` — Stripe checkout
- `api/stripe-webhook.js` — Stripe subscription events
- `api/check-usage.js` — Plan limit enforcement
- `api/fetch-job.js` — Anchor link content fetcher
- `api/log-usage.js` — Usage tracking (service key)
- `api/_rateLimit.js` — Rate limiting shared module

## Environment Variables (Vercel)

- `ANTHROPIC_API_KEY` — Claude API
- `RAPIDAPI_KEY` — JSearch job search
- `BRAVE_SEARCH_KEY` — Contact LinkedIn search
- `APOLLO_API_KEY` — Contact fallback
- `STRIPE_SECRET_KEY` — Payments
- `STRIPE_WEBHOOK_SECRET` — Webhook verification
- `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_PRO` / `STRIPE_PRICE_UNLIMITED_MONTHLY` / `STRIPE_PRICE_UNLIMITED_YEARLY`
- `SUPABASE_URL` — Database
- `SUPABASE_SERVICE_KEY` — Server-side database access

## Admin

- Admin emails: `ritterbenjamin@gmail.com`, `ben@liveforyourselfconsulting.com`
- Admin dashboard: `/admin`
- Support email: `support@lfyconsulting.com`
