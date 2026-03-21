# Fearless Job Search — Project Memory

## Product
fearlessjobsearch.com — AI job search tool for senior leaders (Directors, VPs, C-Suite)
Built by Dr. Benjamin Ritter | Live for Yourself Consulting

## Stack
- Frontend: single-file index.html (no framework)
- Backend: Vercel serverless functions in /api
- Database: Supabase (tgicomrycbhrinobvnlr.supabase.co)
- Hosting: Vercel Pro ($20/mo)
- Payments: Stripe
- Email: Resend (benjaminritter@lfyconsulting.com)

## Key APIs
- JSearch (RapidAPI) — job search pipeline
- Brave Search ($5/1K queries) — LinkedIn contact finding
- Anthropic Claude Sonnet ($3/$15 per 1M tokens) — scoring, verification, outreach generation
- Supabase — auth, database, persistent cache
- Stripe — subscriptions and one-time payments
- Resend — transactional email after coaching purchases

## Admin
- Admin emails: ritterbenjamin@gmail.com, ben@liveforyourselfconsulting.com
- Ben's contact email: benjaminritter@lfyconsulting.com
- Admin accounts bypass all usage gates — check isAdmin() in _plans.js

## Stripe Price IDs
- Starter $29/mo:          price_1TCuhfK3APtatfMmhlcWdsdW
- Pro $59/mo:              price_1TCuiKK3APtatfMmOQCSWWd4
- Unlimited Monthly $99:   price_1TCujoK3APtatfMmz0GggJn4
- Unlimited Yearly $599:   price_1TCukaK3APtatfMmKNbheswb
- Resume Review $500:      price_1TDFhJK3APtatfMmjK9kHib4  ← payment mode, not subscription
- Resume + LinkedIn $800:  price_1TDFi0K3APtatfMmtU7ZLSsk  ← payment mode, not subscription

## Plans
- Free: 3 jobs visible, no contacts, no outreach
- Starter: 1 search/mo, 10 jobs, contacts + outreach enabled
- Pro: 4 searches/mo, company target mode enabled
- Unlimited: unlimited searches, all features, priority support

## Coaching Products
- Resume Review ($500) and Resume + LinkedIn ($800) are one-time Stripe payments
- mode: 'payment' not 'subscription' in create-checkout.js
- Both price IDs must be in COACHING_PRICE_IDS Set in create-checkout.js AND stripe-webhook.js
- After purchase: Resend sends confirmation email automatically from benjaminritter@lfyconsulting.com
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

## API Files
- search-jobs.js      — JSearch queries + Claude scoring (maxDuration: 60)
- search-contacts.js  — Brave Search + Claude verification (maxDuration: 60)
- chat.js             — outreach generation (maxDuration: 60)
- create-checkout.js  — Stripe checkout session (maxDuration: 30)
- stripe-webhook.js   — subscription events + Resend confirmation emails (maxDuration: 30)
- billing-portal.js   — Stripe customer portal (maxDuration: 30)
- check-usage.js      — gates paid features by plan (maxDuration: 10)
- delete-account.js   — full account + data deletion (maxDuration: 30)
- invalidate-cache.js — clears Supabase cache entries (maxDuration: 10)
- _plans.js           — single source of truth for plan definitions + ADMIN_EMAILS
- _auth.js            — JWT verification helper: verifyUser(req)
- _cache.js           — Supabase persistent cache helpers

## Supabase Tables
- profiles            — user plan, stripe_customer_id, subscription_status, search_count_month
- pipeline_jobs       — saved jobs per user (onConflict: user_id, title, company)
- saved_searches      — saved search profiles per user
- contact_cache       — shared across ALL users by company (not user-scoped) — saves Brave queries
- outreach_cache      — user-scoped personalized outreach messages
- usage_log           — search usage tracking

## Caching Architecture
- Session cache: in-memory object in index.html, clears on page refresh
  - sessionCache.contacts — keyed by buildContactKey(company, function)
  - sessionCache.outreach — keyed by buildOutreachKey(linkedinUrl, company)
- Persistent cache: Supabase tables
  - contact_cache: shared across users, TTL 48h — biggest Brave cost saver
  - outreach_cache: user-scoped, TTL 72h
- Cache read always before API call — failure is never fatal (try/catch)
- Cache writes are fire-and-forget (never awaited in response path)

## Security Requirements
- All API endpoints use verifyUser(req) from _auth.js to verify JWT
- userId always taken from verified session — never trusted from request body
- Stripe webhook must verify signature using STRIPE_WEBHOOK_SECRET
- Admin email check must use verified session email — never req.body.email
- SUPABASE_SERVICE_KEY only in server-side API files — never in index.html
- delete-account.js checks isAdmin() before allowing deletion

## UI Architecture (index.html)
- Step flow: 1 (Search) → 2 (Matched Opportunities) → 3 (Decision-Makers) → 4 (Outreach)
- Back buttons call goToStep(n) only — never trigger API calls
- New Search button calls resetToInitialState() — wired in Steps 2, 3, and 4
- resetToInitialState() clears session cache, state variables, form inputs, navigates to Step 1
- Pipeline dedup: filterOutPipelineJobs() runs after scoring, before renderJobs()
- Account panel shows plan badge, searches used/remaining, Manage Billing link
- Admin accounts show "Unlimited" not a number for searches

## Known Issues (March 2026)
- Seniority detection returning csuite incorrectly — context mentions inflate score
- Smith & Nephew "SNATS" suffix not fully cleaned by cleanCompanyName
- startCoachingCheckout hangs at getSession inside apiCall — fixed by calling fetch directly
- Supabase persistent cache (_cache.js) created but not yet wired into search-contacts.js pipeline
- Resend coaching emails not yet implemented in stripe-webhook.js
- Password reset flow not showing set-new-password form after clicking reset link
- Admin account showing "undefined/undefined" for search count

## Development Rules
- Universal logic only — no hardcoded company names, titles, or edge cases
- Always check session cache → Supabase cache → API (in that order)
- Cache failures never fatal — always try/catch around cache reads/writes
- Promise.all for all independent parallel operations — no sequential awaits
- Cap all arrays before passing to external APIs
- All external API calls (JSearch, Brave, Claude, Stripe) wrapped in try/catch
- Retry logic on JSearch and Brave timeouts
- No mixing require/import in same file — use ES module imports throughout
- _plans.js is single source of truth — no plan data duplicated elsewhere

## Standard Post-Deploy Checklist
1. Check Vercel logs for errors after every deploy
2. Confirm no const/let referenced before declaration
3. Module syntax consistent throughout
4. Try/catch on all external calls
5. No sequential awaits on independent operations
6. Arrays capped before external API calls
7. Test the specific feature that was changed end-to-end
