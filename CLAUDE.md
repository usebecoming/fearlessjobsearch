# Fearless Job Search — Project Memory

## Product
fearlessjobsearch.com — AI job search tool for senior leaders (Directors, VPs, C-Suite)
Built by Dr. Benjamin Ritter | Live for Yourself Consulting

## Stack
- Frontend: single-file index.html (no framework)
- Backend: Vercel serverless functions in /api
- Database: Supabase (tgicomrycbhrinobvnlr.supabase.co)
- Hosting: Vercel Pro ($20/mo)
- Payments: Stripe (live mode)
- Email: Resend (benjaminritter@lfyconsulting.com, domain: lfyconsulting.com)

## Key APIs
- JSearch (RapidAPI) — job search pipeline, batched 3 at a time with 1s delay
- Brave Search ($5/1K queries) — LinkedIn contact finding
- Anthropic Claude Sonnet ($3/$15 per 1M tokens) — scoring, verification, outreach generation
- Supabase — auth, database, persistent cache
- Stripe — subscriptions and one-time payments
- Resend — transactional email (welcome emails, coaching confirmations, Ben notifications)

## Admin
- Admin email: ritterbenjamin@gmail.com (sole admin for dashboard + bypasses)
- Ben's contact email: benjaminritter@lfyconsulting.com
- Admin accounts bypass all usage gates — check isAdmin() in _plans.js
- Admin dashboard at /admin — restricted to ritterbenjamin@gmail.com only
- benjaminritter@lfyconsulting.com is a regular user account (currently Pro for testing)

## Stripe Price IDs
- Starter $29/mo:          price_1TCuhfK3APtatfMmhlcWdsdW
- Pro $59/mo:              price_1TCuiKK3APtatfMmOQCSWWd4
- Accelerate Monthly $99:  price_1TCujoK3APtatfMmz0GggJn4
- Accelerate Yearly $999:  price_1TCukaK3APtatfMmKNbheswb
- Resume Review $500:      price_1TDFhJK3APtatfMmjK9kHib4  ← payment mode, not subscription
- Resume + LinkedIn $800:  price_1TDFi0K3APtatfMmtU7ZLSsk  ← payment mode, not subscription

## Plans
- Free: 3 jobs visible, no contacts, no outreach
- Starter: 1 search/mo, 10 jobs, contacts + outreach enabled
- Pro: 4 searches/mo, 10 jobs, company target mode, saved searches, resume scoring
- Accelerate: 10 searches/mo, 20 jobs/search, all features, priority support, annual option

## Coaching Products
- Resume Review ($500) and Resume + LinkedIn ($800) are one-time Stripe payments
- mode: 'payment' not 'subscription' in create-checkout.js
- Both price IDs must be in COACHING_PRICE_IDS Set in create-checkout.js AND stripe-webhook.js
- After purchase: Resend sends confirmation email automatically from benjaminritter@lfyconsulting.com
- Ben gets notification email on every coaching purchase
- Ben follows up manually — no cal.com redirect needed from buy buttons
- Intake form (includes resume upload): https://forms.gle/deP2oP9xE1osrHCU9
- Cal.com booking: https://cal.com/drbenjaminritter/coaching-sessions?duration=60&overlayCalendar=true

## Coaching Confirmation Emails (sent by stripe-webhook.js via Resend)

### Resume Review — subject: "Your resume review is confirmed — here's what happens next"
[First name],

Your purchase is confirmed. Here's what to do next:

Step 1 — Book your 60-minute session:
https://cal.com/drbenjaminritter/coaching-sessions?duration=60&overlayCalendar=true

Step 2 — Complete this intake form (includes resume upload):
https://forms.gle/deP2oP9xE1osrHCU9

Once I have your booking and intake form I have everything I need and we're all set for our session.

Looking forward to it.

— Ben
Dr. Benjamin Ritter | Live for Yourself Consulting
ICF PCC | EdD Organizational Leadership
benjaminritter@lfyconsulting.com

### Resume + LinkedIn — subject: "Your Resume + LinkedIn package is confirmed — next steps"
[First name],

Your purchase is confirmed. Here's what to do next:

Step 1 — Book your 60-minute session:
https://cal.com/drbenjaminritter/coaching-sessions?duration=60&overlayCalendar=true

Step 2 — Complete this intake form (includes resume upload and LinkedIn URL):
https://forms.gle/deP2oP9xE1osrHCU9

Once I have your booking and intake form I have everything I need and we're all set.

Looking forward to it.

— Ben
Dr. Benjamin Ritter | Live for Yourself Consulting
ICF PCC | EdD Organizational Leadership
benjaminritter@lfyconsulting.com

### Ben notification email (send to benjaminritter@lfyconsulting.com on every coaching purchase)
Subject: New coaching purchase: [Product name] ([Price])
Body: Customer name, email, product purchased. Note they've been sent a confirmation email.

## Subscription Welcome Emails (sent by stripe-webhook.js via Resend)
- Starter: "You're in. Here's how to get your first conversation booked"
- Pro: "Pro is live. You've got enough firepower to run a real campaign"
- Accelerate: "Accelerate is active — here's the strategy that works"
- Ben gets notification on every new subscription and cancellation

## API Files
- search-jobs.js      — JSearch queries + title expansion + filtering (maxDuration: 60)
- search-contacts.js  — Brave Search + Claude verification + company dedup (maxDuration: 60)
- chat.js             — outreach generation proxy to Claude (maxDuration: 60)
- create-checkout.js  — Stripe checkout session, coaching=payment mode (maxDuration: 30)
- stripe-webhook.js   — subscription events + Resend emails, signature verified (maxDuration: 30)
- billing-portal.js   — Stripe customer portal (maxDuration: 30)
- check-usage.js      — gates paid features by plan (maxDuration: 10)
- delete-account.js   — full account + data deletion (maxDuration: 30)
- invalidate-cache.js — clears Supabase cache entries (maxDuration: 10)
- fetch-job.js        — fetches job listing details, SSRF-protected domain whitelist (maxDuration: 10)
- _plans.js           — single source of truth for plan definitions + ADMIN_EMAILS
- _auth.js            — JWT verification helper: verifyUser(req), token from Authorization header
- _cache.js           — Supabase persistent cache helpers (contact_cache, outreach_cache)

## Supabase Tables
- profiles            — user plan, stripe_customer_id, subscription_status, search_count_month
- pipeline_jobs       — saved jobs per user (onConflict: user_id, title, company)
- saved_searches      — saved search profiles per user
- contact_cache       — shared across ALL users by company (not user-scoped) — saves Brave queries, TTL 48h
- outreach_cache      — user-scoped personalized outreach messages, TTL 72h
- usage_log           — search usage tracking

## Caching Architecture
- Session cache: in-memory object in index.html, clears on page refresh
  - sessionCache.contacts — keyed by buildContactKey(company, function)
  - sessionCache.outreach — keyed by buildOutreachKey(linkedinUrl, company)
- Persistent cache: Supabase tables via _cache.js
  - contact_cache: shared across users, TTL 48h — biggest Brave cost saver
  - outreach_cache: user-scoped, TTL 72h
- Cache read always before API call — failure is never fatal (try/catch)
- Cache writes are fire-and-forget (never awaited in response path)
- Pipeline filter (filterOutPipelineJobs) has 3s timeout to prevent Supabase hangs

## Auth Architecture
- Supabase auth with email/password
- JWT passed in Authorization header on all API calls
- getAuthHeaders() caches token from onAuthStateChange, 8s timeout with refresh fallback
- All API endpoints call verifyUser(req) — userId from verified session, never from request body
- Password reset flow: detects recovery token in URL hash, shows set-new-password form
- Auth modal does NOT close on overlay click — only X button (prevents accidental dismissal on mobile)

## Security
- All API endpoints use verifyUser(req) from _auth.js to verify JWT
- userId always taken from verified session — never trusted from request body
- Stripe webhook verifies signature using STRIPE_WEBHOOK_SECRET via crypto.timingSafeEqual
- Admin email check uses verified session email — never req.body.email
- SUPABASE_SERVICE_KEY only in server-side API files — never in index.html
- delete-account.js checks isAdmin() before allowing deletion
- fetch-job.js has SSRF protection — whitelist of allowed domains only
- Stripe checkout has allow_promotion_codes: true (coupon codes enabled)

## Job Search Pipeline (search-jobs.js)
- Title expansion: VP↔Vice President, Head↔Director synonyms, connector stripping, capped at 7
- JSearch queries run in batches of 3 with 1s delay between batches (prevents 429s)
- Filters: agencies, MLM/pyramid, blocklisted companies, fundraising disambiguation
- Seniority detection: segment-based, matches title at START of line only, one-level-down rule
- Function detection: token-based scoring system (People, Engineering, Marketing, etc.)
- Relevance filter: removes titles unrelated to search function
- Company+title deduplication removes duplicate listings
- Results capped at 20 before Claude scoring
- Claude scoring done client-side via callClaude() → /api/chat.js

## Contact Search Pipeline (search-contacts.js)
- Jobs grouped by company — same company searched only once (saves API calls)
- Token-based function detection (same system as search-jobs.js)
- HM/Recruiter/Skip-Level title hierarchy derived from function + seniority
- Brave queries: 3 parallel (HM, Recruiter, Skip-Level) with fallback broadened queries
- Pre-qualification: auto-accept (company confirmed), auto-reject (past tense, known false positives), Claude decides (uncertain)
- Claude verification: 10 contacts max per company, post-Claude filters for vague titles, former employees
- Company slug lookup for LinkedIn fallback links
- Cross-company deduplication after all jobs processed
- Persistent cache: shared contact_cache in Supabase, TTL 48h
- Company target mode: works without specific job posting, uses entered titles for function detection

## Outreach Generation
- 4-message sequence: Connection Request (Day 1), Follow-Up (Day 2), Re-Engage (Day 8), Close (Day 14)
- Message 1 (Connection Request): HARD LIMIT 200 characters for LinkedIn
- Peer-level tone, specific credentials from resume, no flattery/desperation
- Claude prompt enforces: use actual numbers/domains from resume, under 75 words per message
- Batched: 4 contacts per Claude call to prevent 504 timeouts
- Character count displayed for Message 1 with over-200 warning

## UI Architecture (index.html)
- Step flow: 1 (Search) → 2 (Matched Opportunities) → 3 (Decision-Makers) → 4 (Outreach)
- Search modes: Job Target (titles + locations) and Company Target (companies + titles)
- Back buttons call goToStep(n) only — never trigger API calls
- New Search button calls resetToInitialState() — wired in Steps 2, 3, and 4
- resetToInitialState() clears session cache, state variables, form inputs, navigates to Step 1
- Pipeline dedup: filterOutPipelineJobs() runs after scoring, before renderJobs(), 3s timeout
- Account panel shows plan badge, searches used/remaining, Manage Billing link, Delete Account
- Admin accounts show "Admin (Unlimited)" for searches
- Find Opportunities button: auto-commits uncommitted tag text on blur and on click
- Button shows "Searching..." with pulse animation during search, restores on step navigation
- Tag inputs: Enter or comma to commit, blur to auto-commit
- Resume upload: click or drag-drop, supports PDF (pdf.js) and DOCX (mammoth.js)
- Modals: upgrade, auth, coaching/help, delete account (typed DELETE confirmation)
- Mobile responsive: 640px and 768px breakpoints, body scroll locked when modals open
- Copy to clipboard with fallback for mobile Safari

## Core Product Philosophy — Contacts
Contacts are the most valuable feature. The goal is never just "find the hiring manager for this job posting" — it's "help the user start a conversation at a company they want to work at."

This means:
- Always show contacts even when no jobs are posted (company target mode)
- Always show LinkedIn fallback links even when contacts are found
- Never show an empty state — there is always someone to reach out to
- The message is always "here's who to talk to" not "we couldn't find anyone"
- Confirmed employees with vague titles are still valuable
- Recruiters and TA contacts are always relevant for any job function
- LinkedIn links use keyword search with company name for filtering

## Environment Variables (in Vercel)
- SUPABASE_URL
- SUPABASE_ANON_KEY (client-side only)
- SUPABASE_SERVICE_KEY (server-side only)
- STRIPE_SECRET_KEY (sk_live_...)
- STRIPE_WEBHOOK_SECRET (whsec_...)
- RAPIDAPI_KEY (JSearch)
- BRAVE_API_KEY
- ANTHROPIC_API_KEY
- RESEND_API_KEY (re_...)

## Fixed Issues (March 2026)
- Supabase auth hanging: replaced getUser() with getSession(), added token caching + 8s timeout + refresh
- Service worker caching stale pages: rewritten to not cache API calls
- Sign out not working: isSigningOut flag + clear localStorage tokens
- Decision-makers freezing: temporal dead zone fix for selectedJobData
- Contacts returning wrong people: pre-qualification + known false positive blocklist + function relevance
- Vercel 60s timeout: parallel processing with Promise.all, 10 contact cap, batched JSearch
- Seniority detecting C-Suite incorrectly: rewritten to segment-based, START-of-line matching only
- Resume truncated at 1200 chars: increased to 5000
- PDF parsing losing structure: Y-position line break detection
- Company name cleaning too aggressive: protect 2-word brand names
- False positive filter too aggressive: core-word protection for company name surnames
- Stripe webhook unprotected: added crypto signature verification
- API endpoints accepting spoofed userId: all use verifyUser(req) now
- Admin bypass spoofable via request body: reads from verified session only
- JSearch 400 errors: removed invalid job_requirements parameter
- JSearch 429 rate limits: batched queries (3 at a time, 1s delay)
- Pipeline filter hanging: added 3s timeout, fails open
- Auth modal closing accidentally on mobile: removed overlay click-to-close
- Coaching checkout hanging: bypass getSession timeout, use cached token
- getAuthHeaders 3s timeout too aggressive: increased to 8s with refresh fallback

## Development Rules
- Universal logic only — no hardcoded company names, titles, or edge cases
- Always check session cache → Supabase cache → API (in that order)
- Cache failures never fatal — always try/catch around cache reads/writes
- Promise.all for all independent parallel operations — no sequential awaits
- Cap all arrays before passing to external APIs
- All external API calls (JSearch, Brave, Claude, Stripe) wrapped in try/catch
- JSearch queries batched 3 at a time with 1s delay between batches
- No mixing require/import in same file — use ES module imports throughout
- _plans.js is single source of truth — no plan data duplicated elsewhere
- Always commit and push after code changes — never leave uncommitted
- Plan first, share approach before writing code for significant changes

## Standard Post-Deploy Checklist
1. Check Vercel logs for errors after every deploy
2. Confirm no const/let referenced before declaration
3. Module syntax consistent throughout
4. Try/catch on all external calls
5. No sequential awaits on independent operations
6. Arrays capped before external API calls
7. Test the specific feature that was changed end-to-end
