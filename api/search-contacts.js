import { rateLimit } from './_rateLimit.js';
import { getContactCache, setContactCache } from './_cache.js';
import { verifyUser } from './_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rl = rateLimit(req, { maxRequests: 5, windowMs: 60000 });
  if (!rl.allowed) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
  }

  // Verify authenticated user from JWT
  const auth = await verifyUser(req);
  if (auth.error) {
    return res.status(401).json({ error: auth.error });
  }

  const braveKey = process.env.BRAVE_SEARCH_KEY;
  if (!braveKey) {
    return res.status(500).json({ error: 'Contact search not configured' });
  }

  try {
    const { jobs } = req.body;
    if (!jobs || !Array.isArray(jobs) || jobs.length === 0) {
      return res.status(400).json({ error: 'No jobs provided' });
    }

    // Comprehensive company aliases
    const companyAliases = {
      // Big 4 / Consulting
      'ey':'Ernst Young','ernst & young':'Ernst Young','ernst and young':'Ernst Young',
      'pwc':'PricewaterhouseCoopers','kpmg':'KPMG','bcg':'Boston Consulting Group',
      'mckinsey':'McKinsey Company','mckinsey & company':'McKinsey Company',
      'bain':'Bain Company','bain & company':'Bain Company',
      'booz allen':'Booz Allen Hamilton','booz':'Booz Allen Hamilton',
      'a.t. kearney':'Kearney','at kearney':'Kearney',
      // Tech
      'ibm':'IBM','ge':'General Electric','hp':'Hewlett Packard','hpe':'Hewlett Packard Enterprise',
      'at&t':'ATT','att':'ATT','p&g':'Procter Gamble','procter & gamble':'Procter Gamble',
      'j&j':'Johnson Johnson','jnj':'Johnson Johnson','johnson & johnson':'Johnson Johnson',
      'msft':'Microsoft','meta':'Meta Platforms','fb':'Meta','aws':'Amazon Web Services',
      'sfdc':'Salesforce','crm':'Salesforce','dell emc':'Dell EMC',
      // Finance
      'jp morgan':'JPMorgan','j.p. morgan':'JPMorgan','jpmorgan chase':'JPMorgan Chase',
      'bofa':'Bank of America','b of a':'Bank of America','boa':'Bank of America',
      'gs':'Goldman Sachs','goldman':'Goldman Sachs','morgan stanley':'Morgan Stanley',
      'citi':'Citibank','ubs':'UBS','hsbc':'HSBC','bny mellon':'BNY Mellon',
      // Medical
      'smith & nephew':'Smith Nephew','smith and nephew':'Smith Nephew',
      'smith & nephew snats inc':'Smith Nephew','bd':'Becton Dickinson',
      'b. braun':'B Braun','b braun':'B Braun','hca':'HCA Healthcare',
      'cvs':'CVS Health','unh':'UnitedHealth Group',
      // Defense
      'rtx':'RTX Corporation','raytheon':'Raytheon','l3harris':'L3Harris Technologies',
      'lm':'Lockheed Martin','lockheed':'Lockheed Martin','ng':'Northrop Grumman',
      'gd':'General Dynamics','bae':'BAE Systems','saic':'SAIC','caci':'CACI International',
      // Retail
      'wmt':'Walmart','tgt':'Target','hd':'Home Depot','the home depot':'Home Depot',
      "lowe's":'Lowes',"mcdonald's":'McDonalds','mcdonalds':'McDonalds',
      // Energy
      'exxonmobil':'ExxonMobil','xom':'ExxonMobil','cvx':'Chevron','bp':'BP',
      // Telecom
      'tmobile':'T-Mobile','t-mobile':'T-Mobile','vz':'Verizon',
      'disney':'Walt Disney','the walt disney company':'Walt Disney',
      // HR/Staffing
      'adp':'ADP','wtw':'Willis Towers Watson','korn ferry':'Korn Ferry',
      // Numbers
      '3m':'3M Company','3m company':'3M Company'
    };

    // ── Group jobs by company to avoid duplicate searches ──
    console.log(`\n🚀 Processing ${jobs.length} jobs...`);

    const JOB_TIMEOUT_MS = 45000;

    // Group by cleaned company name
    const companyGroups = {};
    const skipJobs = []; // jobs with no valid company

    for (const job of jobs) {
      const company = job.company;
      const jobTitle = job.title;

      if (!company || company === 'Unknown' || company.length < 2) {
        console.log(`Skipping: no valid company name for "${jobTitle}"`);
        skipJobs.push({ job_id: job.job_id, company, job_title: jobTitle, location: job.location || '', derived: {}, contacts: [] });
        continue;
      }

      let cleanedCompany = cleanCompanyName(company);
      const alias = companyAliases[cleanedCompany.toLowerCase().trim()];
      if (alias) {
        console.log(`🔤 Company alias: "${cleanedCompany}" → "${alias}"`);
        cleanedCompany = alias;
      }

      const companyKey = cleanedCompany.toLowerCase().trim();
      if (!companyGroups[companyKey]) {
        companyGroups[companyKey] = {
          searchCompany: cleanedCompany,
          originalCompany: company,
          jobs: []
        };
      }
      companyGroups[companyKey].jobs.push(job);
    }

    // Log dedup savings
    console.log(`\n📊 Contact search groups:`);
    Object.values(companyGroups).forEach(group => {
      console.log(`  ${group.searchCompany}: ${group.jobs.length} job(s)`);
      group.jobs.forEach(j => console.log(`    - ${j.title}`));
      if (group.jobs.length > 1) {
        console.log(`  ♻️ Reusing contacts for ${group.searchCompany} across ${group.jobs.length} jobs — saved ${group.jobs.length - 1} Brave search + Claude call`);
      }
    });

    // Run contact search once per unique company in parallel
    const companyPromises = Object.values(companyGroups).map(async (group) => {
      const company = group.originalCompany;
      const searchCompany = group.searchCompany;
      // Use first job for deriving function/titles
      const representativeJob = group.jobs[0];
      const jobTitle = representativeJob.title;

      // Skip very short names that can't be searched safely
      if (searchCompany.length <= 3 && !companyAliases[searchCompany.toLowerCase().trim()]) {
        console.log(`⚠️ Company name too short: "${searchCompany}" — using LinkedIn fallback`);
        const slug = await getLinkedInCompanySlug(company, braveKey);
        group.result = {
          company, derived: {}, contacts: [],
          linkedin_slug: slug, geo_urn: getGeoUrn(representativeJob.location),
          coverage_signal: 'poor'
        };
        return;
      }
      if (searchCompany !== company) {
        console.log(`🧹 Cleaned company: "${company}" → "${searchCompany}"`);
      }

      const isCompanyMode = representativeJob.type === 'company';
      console.log(`\n=== CONTACTS FOR: ${isCompanyMode ? `(company mode) ${jobTitle}` : jobTitle} at ${searchCompany} ===`);

      // Step 1: Derive function, titles, hierarchy
      // Company mode always has an explicit title now — no fallback needed
      const derived = deriveAll(jobTitle);
      console.log('Function:', derived.func);
      console.log('HM titles:', derived.hmTitles);
      console.log('Skip-Level titles:', derived.slTitles);
      console.log('Recruiter terms:', derived.recTerms);

      // CHECK PERSISTENT CACHE FIRST
      // Contact results are shared — same company = same contacts regardless of user
      const cached = await getContactCache(searchCompany, derived.func);
      if (cached) {
        const cleanedCached = cached.contacts.filter(c => isValidExtractedName(c.name));
        if (cleanedCached.length < cached.contacts.length) {
          console.log(`  🧹 Filtered ${cached.contacts.length - cleanedCached.length} bad names from cache`);
        }
        // If too many bad names, bypass cache and re-fetch
        if (cleanedCached.length < 2 && cached.contacts.length >= 3) {
          console.log(`  ⚠️ Cache has too many bad names — bypassing for fresh fetch`);
        } else {
          console.log(`⚡ Contacts served from Supabase cache: ${searchCompany} (${cleanedCached.length} contacts)`);
          const geoUrn = getGeoUrn(representativeJob.location);
          group.result = {
            company,
            derived: { func: derived.func, hmTitles: derived.hmTitles, slTitles: derived.slTitles, recTerms: derived.recTerms },
            contacts: cleanedCached,
            linkedin_slug: cached.companySlug,
            geo_urn: geoUrn,
            is_professional_services: false,
            fromCache: true,
            coverage_signal: cleanedCached.length >= 6 ? 'good' : cleanedCached.length >= 3 ? 'limited' : 'poor'
          };
          return;
        }
      }
      console.log(`🔍 Cache miss — running Brave pipeline for ${searchCompany}`);

      let braveQueryCount = 0;
      const companyNames = getCompanyVariations(searchCompany);
      const allContacts = [];

      // Helper: search with false positive filtering for short name fallbacks
      async function searchAndFilter(queryBuilder, role) {
        for (let i = 0; i < companyNames.length; i++) {
          const co = companyNames[i];
          const isShortName = i > 0 && co.length < company.length;
          const q = queryBuilder(co);
          console.log(`  ${role} query [${co}]:`, q);
          let r = await braveSearch(q, braveKey);
          braveQueryCount++;

          if (isShortName && r.length > 0) {
            const before = r.length;
            r = r.filter(result => {
              const slug = (result.linkedin_url || '').toLowerCase();
              const snip = (result.snippet || '').toLowerCase();
              const short = co.toLowerCase();
              if (slug.includes(short.replace(/\s+/g, '-')) && !snip.includes(short)) {
                console.log(`  ❌ False positive: ${result.name} — "${short}" in slug is person's name`);
                return false;
              }
              return true;
            });
            if (before !== r.length) console.log(`  Filtered ${before - r.length} false positives`);
          }

          console.log(`  ${role} results: ${r.length}`);
          allContacts.push(...r.map(c => ({ ...c, searchRole: role })));
          if (r.length >= 3) break;
        }
      }

      // Step 2: Run Brave searches IN PARALLEL
      const hmQuery = derived.hmTitles.map(t => `"${t}"`).join(' OR ');
      const recQuery = derived.recTerms.map(t => `"${t}"`).join(' OR ');
      const slQuery = derived.slTitles.map(t => `"${t}"`).join(' OR ');

      var searches = [
        searchAndFilter(co => `site:linkedin.com/in "${co}" (${hmQuery})`, 'Hiring Manager'),
        searchAndFilter(co => `site:linkedin.com/in "${co}" (${recQuery})`, 'Recruiter / TA'),
        searchAndFilter(co => `site:linkedin.com/in "${co}" (${slQuery})`, 'Skip-Level')
      ];
      // Company mode: add function-specific search upfront for better coverage
      if (isCompanyMode && derived.func !== 'General') {
        searches.push(searchAndFilter(co => `site:linkedin.com/in "${co}" (${getDeptSearchTerms(derived.func)}) (Director OR VP OR Head OR Senior OR Lead)`, 'Hiring Manager'));
      }
      await Promise.all(searches);

      // Fallback: broader HM if few results
      if (allContacts.filter(c => c.searchRole === 'Hiring Manager').length < 3) {
        await searchAndFilter(co => `site:linkedin.com/in "${co}" (${getDeptSearchTerms(derived.func)}) (VP OR SVP OR "Head of" OR Director OR Chief)`, 'Hiring Manager');
      }

      const deduped = dedupeContacts(allContacts);
      console.log(`Total deduped for ${company}: ${deduped.length}`);
      console.log('URLs:', deduped.map(c => c.linkedin_url));

      // Apollo fallback if very few results
      const apolloKey = process.env.APOLLO_API_KEY;
      if (deduped.length < 3 && apolloKey) {
        console.log('Trying Apollo fallback...');
        const apolloContacts = await apolloSearch(company, derived, apolloKey);
        console.log(`Apollo: ${apolloContacts.length} contacts`);
        allContacts.push(...apolloContacts);
      }

      // Enhanced founder search for small companies
      let dedupedSoFar = dedupeContacts(allContacts);
      if (dedupedSoFar.length < 3) {
        console.log('🔍 Running founder/CEO search...');
        const founderQuery1 = `site:linkedin.com/in "${company}" (Founder OR "Co-Founder" OR CEO OR President)`;
        const founderResults1 = await braveSearch(founderQuery1, braveKey);
        braveQueryCount++;
        console.log(`  Founder search (site): ${founderResults1.length} results`);
        allContacts.push(...founderResults1.map(r => ({ ...r, searchRole: 'Skip-Level', isFounder: true })));

        if (founderResults1.length < 1) {
          const founderQuery2 = `"${company}" founder CEO "linkedin.com/in"`;
          console.log(`  Founder web search: ${founderQuery2}`);
          const founderResults2 = await braveSearch(founderQuery2, braveKey);
          braveQueryCount++;
          console.log(`  Founder web results: ${founderResults2.length}`);
          allContacts.push(...founderResults2.map(r => ({ ...r, searchRole: 'Skip-Level', isFounder: true })));
        }
      }

      const finalContacts = dedupeContacts(allContacts);

      // Pre-qualify contacts BEFORE Claude
      const preQualified = [];
      const claudeDecide = [];
      let autoRejected = 0;

      for (const contact of finalContacts) {
        const result = preQualifyContact(contact.linkedin_url, contact.snippet, searchCompany, contact.page_title);
        if (result.accepted === true) {
          contact.preQualified = true;
          contact.confidence = result.confidence;
          contact.preQualReason = result.reason;
          contact.inferredTitle = inferTitleFromSlug(contact.linkedin_url);
          preQualified.push(contact);
          console.log(`  ✅ Pre-qualified: ${contact.name} — ${result.reason}`);
        } else if (result.accepted === false) {
          autoRejected++;
          console.log(`  ❌ Pre-rejected: ${contact.name} — ${result.reason}`);
        } else {
          contact.claudeDecide = true;
          claudeDecide.push(contact);
          console.log(`  🤔 Claude decides: ${contact.name}`);
        }
      }

      console.log(`Pre-qualification for ${company}:`);
      console.log(`  ✅ Auto-accepted: ${preQualified.length}`);
      console.log(`  🤔 Claude decides: ${claudeDecide.length}`);
      console.log(`  ❌ Auto-rejected: ${autoRejected}`);

      // Founder search if too few pre-qualified contacts
      if (preQualified.length < 2) {
        console.log(`🔍 Low pre-qualified count (${preQualified.length}) — running founder search for ${company}`);
        const fq1 = `"${company}" founder CEO president "linkedin.com/in"`;
        console.log(`  Founder query: ${fq1}`);
        const fResults = await braveSearch(fq1, braveKey);
        braveQueryCount++;
        console.log(`  Founder results: ${fResults.length}`);
        for (const fr of fResults) {
          if (!preQualified.some(p => p.linkedin_url === fr.linkedin_url) && !claudeDecide.some(p => p.linkedin_url === fr.linkedin_url)) {
            fr.preQualified = true;
            fr.confidence = 'medium';
            fr.preQualReason = 'founder/CEO search';
            fr.isFounder = true;
            fr.searchRole = 'Skip-Level';
            fr.inferredTitle = inferTitleFromSlug(fr.linkedin_url) || 'Founder / CEO';
            preQualified.push(fr);
            console.log(`  ✅ Founder found: ${fr.name} — ${fr.linkedin_url}`);
          }
        }
      }

      // Combine pre-qualified first, then claude-decide, cap at 10
      const allForClaude = [...preQualified, ...claudeDecide];
      const toPassToClaude = allForClaude.slice(0, 10);
      if (allForClaude.length > 10) {
        console.log(`📊 Capped: ${allForClaude.length} → ${toPassToClaude.length} contacts for Claude`);
      }
      console.log(`Passing ${toPassToClaude.length} contacts to Claude`);

      // Look up LinkedIn company slug for fallback links
      const companySlug = await getLinkedInCompanySlug(company, braveKey);
      const geoUrn = getGeoUrn(representativeJob.location);

      // Detect professional services / law firm
      const isProfServices = /law|legal|llp|llc|consulting|advisors|partners|group|associates/i.test(company);
      let extraSlTitles = [];
      if (isProfServices && derived.func === 'People') {
        extraSlTitles = ['Chief Administrative Officer', 'Chief Talent Officer', 'Managing Partner', 'Administrative Partner', 'Director of Administration'];
        console.log('Professional services detected, added alternative skip-level titles');
      }

      // ── CLAUDE VERIFICATION (server-side) ──
      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      const contactsPassedIn = toPassToClaude.length;
      let verifiedContacts = [];

      if (anthropicKey && contactsPassedIn > 0) {
        console.log(`\n🤖 Calling Claude to verify ${contactsPassedIn} contacts for ${company}...`);

        const companyModeContext = isCompanyMode
          ? `The user is interested in working at ${company} in a ${derived.func} role similar to "${jobTitle}". No active job posting — this is proactive networking.`
          : '';

        const claudePrompt = `You are a contact role assigner. Some contacts are pre-qualified (preQualified: true) — do NOT reject these. Only assign role type, extract title, write reason.

${isCompanyMode ? companyModeContext : `Job: ${jobTitle} at ${company}`}
Function: ${derived.func}
HM titles: ${derived.hmTitles.join(', ')}
SL titles: ${[...derived.slTitles, ...extraSlTitles].join(', ')}
${isProfServices ? 'This is a law firm / professional services company. Accept Managing Partner, Chief Administrative Officer as skip-level.' : ''}

For pre-qualified contacts: assign role, extract title from snippet or use inferredTitle, write reason. Do NOT reject pre-qualified contacts.
For claudeDecide contacts: verify employment, then assign role or omit entirely.
Never return empty titles. Use this hierarchy for assigning titles:
1. Extract from snippet or page title (best — use the actual title mentioned)
2. Use the inferredTitle field already provided (inferred from LinkedIn URL slug)
3. Look for role keywords in snippet (HR, People, Talent, Recruiting, etc.) and construct a minimal title like 'HR Professional' or 'Talent Acquisition'
4. Company name as last resort ONLY when no title signal exists anywhere (e.g. 'Red Bull Employee')
NEVER use the job title from the search query as a contact's title — do not borrow or invent titles.

IMPORTANT: Return ONLY accepted contacts in the JSON array. Do NOT include rejected contacts. Do NOT use "Rejected" as a role value. Valid roles are ONLY: "Hiring Manager", "Skip-Level", "Recruiter / TA". If you would reject a contact, simply omit them from the array.

CRITICAL — Hiring Manager assignment:
Only assign role "Hiring Manager" if the contact's title contains HR, People, Talent, Learning, Culture, Workforce, Organizational, HRBP, or similar People function keywords.
Do NOT assign Hiring Manager to:
- Administrative titles (supervisor, coordinator, assistant, liaison, specialist in non-HR fields)
- Operations titles (director of intake, director of programs, case manager, services supervisor, supportive services)
- Support titles (executive assistant, admin, community liaison)
These may be assigned Skip-Level if they are genuinely executive level (VP+, Director+, C-suite). Otherwise omit them entirely.

CEO, President, COO, CHRO, VP of People, Talent Acquisition Manager should NEVER be rejected for a People/HR role. These are the most valuable contacts.

EMPLOYMENT RECENCY — critical:
Reject any contact where the snippet mentions a date range ending before 2024 (e.g. '2019-2023'), uses past tense about their role ('led', 'managed', 'built' with no present tense), says 'former', 'previously', 'retired', 'left', 'departed', or mentions they joined a different company recently. When in doubt, set confidence to 'low' rather than rejecting.

Contacts:
${JSON.stringify(toPassToClaude.slice(0, 20), null, 2)}

Return JSON array only — accepted contacts only:
[{"name":"string","title":"string","role":"Hiring Manager|Skip-Level|Recruiter / TA","linkedin":"string (exact URL)","confidence":"high|medium","note":"string"}]`;

        try {
          const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 4096, system: 'Respond ONLY with a JSON array. No markdown, no explanation.', messages: [{ role: 'user', content: claudePrompt }] })
          });

          if (claudeRes.ok) {
            const claudeData = await claudeRes.json();
            let rawText = claudeData.content?.[0]?.text || '';
            console.log(`\n🤖 RAW CLAUDE RESPONSE for ${company}:`);
            console.log(rawText.substring(0, 800));

            rawText = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
            try {
              verifiedContacts = JSON.parse(rawText);
              if (!Array.isArray(verifiedContacts)) verifiedContacts = verifiedContacts.contacts || verifiedContacts.results?.[0]?.contacts || [];
            } catch (e) {
              console.log(`❌ Failed to parse Claude response: ${e.message}`);
              verifiedContacts = [];
            }

            console.log(`\n📤 CLAUDE OUTPUT for ${company}:`);
            if (verifiedContacts.length === 0) {
              console.log(`  ❌ Claude returned 0 contacts (rejected all ${contactsPassedIn})`);
            } else {
              verifiedContacts.forEach(c => {
                const icon = c.confidence === 'high' ? '✅' : '🔶';
                console.log(`  ${icon} ${c.name} | ${c.role || c.role_type} | ${c.title} | ${c.confidence}`);
              });
              console.log(`\n  📊 Kept: ${verifiedContacts.length} of ${contactsPassedIn} (${Math.round(verifiedContacts.length/contactsPassedIn*100)}% acceptance)`);
              const returnedUrls = new Set(verifiedContacts.map(c => (c.linkedin || c.linkedin_url || '').toLowerCase()));
              toPassToClaude.forEach(c => {
                if (!returnedUrls.has((c.linkedin_url || '').toLowerCase())) {
                  console.log(`  ⚠️ Dropped by Claude: ${c.name} (${c.linkedin_url})`);
                }
              });
            }
          } else {
            console.log(`❌ Claude API error: ${claudeRes.status}`);
          }
        } catch (e) {
          console.log(`❌ Claude call failed: ${e.message}`);
        }

        // Filter out contacts Claude marked as "Rejected" role
        const rejectedByRole = verifiedContacts.filter(c => (c.role || c.role_type || '').toLowerCase().includes('reject'));
        if (rejectedByRole.length > 0) {
          console.log(`\n🚫 Claude used "Rejected" as role for ${rejectedByRole.length} contacts:`);
          rejectedByRole.forEach(c => console.log(`  ${c.name} | ${c.title} — ${c.note || ''}`));
          verifiedContacts = verifiedContacts.filter(c => !(c.role || c.role_type || '').toLowerCase().includes('reject'));
        }

        // Post-Claude quality filters
        const beforeFilter = verifiedContacts.length;
        verifiedContacts = verifiedContacts.filter(c => {
          const roleType = c.role || c.role_type || '';
          if (isTitleJustCompanyName(c.title, company)) {
            // Only keep if there's a C-suite signal in note or LinkedIn URL
            var hasCsuiteSignal = /(ceo|coo|cto|cmo|cfo|chro|cpo|president|founder|co-founder|chairman)/i.test(
              (c.note || '') + ' ' + (c.linkedin || '')
            );
            if (hasCsuiteSignal) {
              console.log(`  🔶 Keeping C-suite with vague title: ${c.name} — "${c.title}"`);
              c.titleVerified = false;
              return true;
            }
            console.log(`  ❌ Vague title rejected (no C-suite signal): ${c.name} — "${c.title}"`);
            return false;
          }
          if (isWrongEntityFalsePositive(c.title, c.note, company)) {
            console.log(`  ❌ Wrong entity false positive: ${c.name} — "${c.title}"`);
            return false;
          }
          if (isSubEntityFalsePositive(c.note, c.title, company)) {
            console.log(`  ❌ Sub-entity false positive: ${c.name} — "${c.title}"`);
            return false;
          }
          if (isFamousExecFalsePositive(c, company)) {
            console.log(`  ❌ Famous exec false positive: ${c.name} — "${c.title}"`);
            return false;
          }
          if (isFranchiseOwner(c.title, company)) {
            console.log(`  ❌ Franchise owner rejected: ${c.name} — "${c.title}"`);
            return false;
          }
          if (isTitleTooVague(c.title, roleType)) {
            console.log(`  ❌ Vague title rejected: ${c.name} — "${c.title}"`);
            return false;
          }
          if (isFormerEmployee(c.title, c.note)) {
            console.log(`  ❌ Former employee rejected: ${c.name} — "${c.title}"`);
            return false;
          }
          if (isTooJunior(c.title, jobTitle, derived.func)) {
            console.log(`  ❌ Too junior: ${c.name} — "${c.title}"`);
            return false;
          }
          if (!isFunctionRelevant(c.title, derived.func, roleType)) {
            console.log(`  ❌ Wrong function rejected: ${c.name} — "${c.title}" not relevant to ${derived.func}`);
            return false;
          }
          return true;
        });
        if (beforeFilter !== verifiedContacts.length) {
          console.log(`  Post-filter: ${beforeFilter} → ${verifiedContacts.length} contacts`);
        }

        // Flag contacts whose title mentions a different major company
        verifiedContacts = verifiedContacts.map(c => {
          if (titleMentionsDifferentCompany(c.title, company)) {
            if (/\b(ceo|founder|co-founder)\b/i.test(c.title)) {
              console.log(`  ❌ CEO/Founder mismatch rejected: ${c.name} — "${c.title}"`);
              return null;
            }
            return { ...c, confidence: 'medium', note: (c.note || '') + ' (Title may reference previous employer — verify profile)' };
          }
          return c;
        }).filter(Boolean);
      }

      // Post-Claude founder search if too few verified
      if (verifiedContacts.length < 3) {
        console.log(`\n🔍 Low contact count (${verifiedContacts.length}) for ${company} — running post-Claude founder search`);
        const fq = `"${company}" founder CEO president "linkedin.com/in"`;
        console.log(`  Founder query: ${fq}`);
        const fRes = await braveSearch(fq, braveKey);
        braveQueryCount++;
        console.log(`  Founder search returned: ${fRes.length} results`);
        fRes.forEach(r => {
          if (r.linkedin_url && !verifiedContacts.some(v => (v.linkedin || v.linkedin_url || '').includes(r.linkedin_url.split('/').pop()))) {
            console.log(`  👤 Adding founder: ${r.name} — ${r.linkedin_url}`);
            verifiedContacts.push({
              name: r.name,
              title: inferTitleFromSlug(r.linkedin_url) || 'Founder / CEO',
              role: 'Skip-Level',
              linkedin: r.linkedin_url,
              confidence: 'medium',
              note: 'Founder/CEO identified through web search'
            });
          }
        });
      }

      // Store result for this company group
      group.result = {
        company,
        derived: { func: derived.func, hmTitles: derived.hmTitles, slTitles: [...derived.slTitles, ...extraSlTitles], recTerms: derived.recTerms },
        contacts: verifiedContacts,
        linkedin_slug: companySlug,
        geo_urn: geoUrn,
        is_professional_services: isProfServices,
        coverage_signal: verifiedContacts.length >= 6 ? 'good' : verifiedContacts.length >= 3 ? 'limited' : 'poor'
      };

      // Save to persistent cache — fire and forget
      setContactCache(
        searchCompany,
        derived.func,
        verifiedContacts,
        null, // fallback links built client-side
        companySlug,
        braveQueryCount
      ).catch(err => console.error('Cache write failed:', err.message));
    });

    // Run all company searches in parallel with per-company timeout
    await Promise.all(
      companyPromises.map(p => Promise.race([
        p,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Company timeout')), JOB_TIMEOUT_MS))
      ]).catch(err => {
        console.error(`❌ Company search failed: ${err.message}`);
      }))
    );

    // Cache summary
    const groups = Object.values(companyGroups);
    const cacheHits = groups.filter(g => g.result?.fromCache).length;
    const cacheMisses = groups.filter(g => g.result && !g.result.fromCache).length;
    console.log(`\n📊 CACHE SUMMARY:`);
    console.log(`  Cache hits:   ${cacheHits} companies`);
    console.log(`  Cache misses: ${cacheMisses} companies`);
    if (cacheHits > 0) {
      console.log(`  Estimated Brave queries saved: ${cacheHits * 6}`);
    }

    // Build results — apply company contacts to ALL jobs at that company
    const results = [...skipJobs];
    for (const group of Object.values(companyGroups)) {
      const r = group.result || { company: group.originalCompany, derived: {}, contacts: [], linkedin_slug: '', geo_urn: null };
      for (const job of group.jobs) {
        results.push({
          job_id: job.job_id,
          company: r.company,
          job_title: job.title,
          location: job.location || '',
          derived: r.derived,
          contacts: [...r.contacts], // copy so cross-company dedup doesn't affect siblings
          linkedin_slug: r.linkedin_slug,
          geo_urn: r.geo_urn || getGeoUrn(job.location),
          is_professional_services: r.is_professional_services
        });
      }
    }

    console.log(`\n✅ All ${results.length} jobs completed (${Object.keys(companyGroups).length} unique companies searched)`);

    // ── CROSS-JOB DEDUPLICATION ──
    // Fix 1: Cross-COMPANY dedup (same company = keep, different company = remove)
    console.log(`\n🔄 Running cross-company deduplication...`);
    const urlToCompany = new Map();
    let totalRemoved = 0;
    results.forEach(job => {
      const companyKey = (job.company || '').toLowerCase().trim();
      const before = (job.contacts || []).length;
      job.contacts = (job.contacts || []).filter(c => {
        const urlKey = (c.linkedin || c.linkedin_url || '').toLowerCase().split('?')[0].replace(/\/+$/, '');
        if (!urlKey) return true;
        const claimedBy = urlToCompany.get(urlKey);
        if (claimedBy && claimedBy !== companyKey) {
          // Same person at DIFFERENT company - remove
          console.log(`  ⚠️ Cross-company duplicate: ${c.name} (${claimedBy} → ${companyKey})`);
          totalRemoved++;
          return false;
        }
        // Same company or first time - keep
        urlToCompany.set(urlKey, companyKey);
        return true;
      });
      if (before !== (job.contacts || []).length) {
        console.log(`  ${job.company} (${job.job_title}): ${before} → ${job.contacts.length}`);
      }
    });
    console.log(`✅ Deduplication complete — removed ${totalRemoved} cross-company duplicates`);

    console.log(`\n=== FINAL: ${results.reduce((s, r) => s + (r.contacts || []).length, 0)} contacts across ${results.length} jobs ===`);
    return res.status(200).json({ results });
  } catch (err) {
    console.error('Contact search error:', err);
    return res.status(500).json({ error: 'Something went wrong searching for contacts.' });
  }
}

// ── Step 1: Derive function, titles, hierarchy ──

function deriveAll(jobTitle) {
  const func = deriveFunction(jobTitle);
  const level = deriveLevel(jobTitle);
  console.log(`🔎 deriveLevel input: "${jobTitle}" → level: ${level}`);
  let hmTitles, slTitles, recTerms;

  // Special handling for People function with level-aware titles
  if (func === 'People') {
    const t = jobTitle.toLowerCase();
    if (/director/i.test(t)) {
      hmTitles = ['CHRO', 'CPO', 'Chief People Officer', 'Chief HR Officer', 'VP of People', 'VP of HR', 'VP People', 'Head of People', 'Head of HR'];
      slTitles = ['CEO', 'President', 'COO'];
    } else if (/vp|vice president/i.test(t)) {
      hmTitles = ['CHRO', 'CPO', 'Chief People Officer', 'Chief HR Officer'];
      slTitles = ['CEO', 'President', 'COO'];
    } else if (/manager|lead|specialist|coordinator|facilitator|partner/i.test(t)) {
      hmTitles = ['Director of HR', 'Director of People', 'VP of HR', 'VP of People', 'Head of HR', 'Head of People', 'Director of Talent'];
      slTitles = ['CHRO', 'CPO', 'VP of People', 'VP of HR'];
    } else {
      hmTitles = ['VP of People', 'VP of HR', 'CHRO', 'CPO', 'Head of People'];
      slTitles = ['CEO', 'COO', 'President'];
    }
    recTerms = ['HR recruiter', 'people recruiter', 'talent acquisition', 'recruiting partner', 'talent partner', 'HR business partner'];
  } else {
    hmTitles = getHiringManagerTitles(func, level);
    slTitles = getSkipLevelTitles(func, level);
    recTerms = getRecruiterTerms(func);
  }

  // Dedupe: remove any title that appears in both HM and SL (keep in HM only)
  const hmSet = new Set(hmTitles.map(t => t.toLowerCase()));
  slTitles = slTitles.filter(t => !hmSet.has(t.toLowerCase()));

  console.log(`✅ Function: ${func} | Level: ${level} for "${jobTitle}"`);
  return { func, level, hmTitles, slTitles, recTerms };
}

// Company-mode: derive titles from target function directly (no job title)
function deriveAllFromFunction(targetFunction) {
  const func = targetFunction || 'General';
  const level = 'director'; // default seniority for company-mode

  let hmTitles, slTitles, recTerms;
  if (func === 'General') {
    hmTitles = ['CEO', 'COO', 'President', 'Managing Director'];
    slTitles = ['Chairman', 'Board Member'];
    recTerms = ['recruiter', 'talent acquisition', 'recruiting partner', 'talent partner', 'HR business partner'];
  } else {
    hmTitles = getHiringManagerTitles(func, level);
    slTitles = getSkipLevelTitles(func, level);
    recTerms = getRecruiterTerms(func);
  }

  const hmSet = new Set(hmTitles.map(t => t.toLowerCase()));
  slTitles = slTitles.filter(t => !hmSet.has(t.toLowerCase()));

  console.log(`✅ Company-mode function: ${func} (default ${level} level)`);
  return { func, level, hmTitles, slTitles, recTerms };
}

function deriveFunction(jobTitle) {
  if (!jobTitle) return 'General';

  const title = jobTitle.toLowerCase();

  // TOKEN-BASED SCORING — each function has signal words worth different points
  // Highest scoring function wins. Threshold of 2 required.
  const functionTokens = {
    'People': {
      high: [
        'hr', 'hris', 'hrbp', 'chro', 'cpo',
        'human resources', 'people ops', 'people operations',
        'talent acquisition', 'talent management', 'talent development',
        'talent partner', 'talent lead',
        'learning and development', 'l&d',
        'organizational development', 'organisation development',
        'leadership development', 'leader development',
        'learning design', 'instructional design',
        'workforce development', 'workforce planning',
        'employee experience', 'employee relations',
        'people partner', 'people lead', 'people business partner',
        'hr business partner', 'hr generalist', 'hr manager',
        'culture partner', 'total rewards',
        'succession planning', 'performance management',
        'change management', 'organizational design',
        'capability development', 'capability building',
        'executive coaching', 'career development',
        'adult learning', 'facilitation'
      ],
      medium: [
        'talent', 'learning', 'training', 'development',
        'people', 'culture', 'engagement', 'coaching',
        'organizational', 'workforce', 'employee',
        'recruiting', 'recruiter', 'recruitment',
        'onboarding', 'retention', 'dei', 'diversity', 'inclusion',
        'compensation', 'benefits', 'capability',
        'performance', 'feedback',
        'leadership', 'team effectiveness'
      ],
      low: [
        'partner', 'advisor', 'strategist', 'architect',
        'consultant', 'specialist', 'generalist',
        'impact', 'effectiveness'
      ]
    },
    'Engineering': {
      high: [
        'software engineer', 'software developer', 'frontend', 'backend',
        'full stack', 'fullstack', 'devops', 'sre', 'platform engineer',
        'machine learning', 'ml engineer', 'data engineer', 'data engineering',
        'security engineer', 'cloud engineer', 'infrastructure engineer',
        'ai engineer', 'ai researcher'
      ],
      medium: [
        'engineering', 'developer', 'programmer',
        'technical', 'infrastructure', 'cloud',
        'platform', 'api', 'microservices',
        'architecture', 'transformation',
        'ai', 'devops'
      ],
      low: ['tech', 'technology', 'systems']
    },
    'Marketing': {
      high: [
        'demand generation', 'demand gen', 'growth marketing',
        'performance marketing', 'brand marketing', 'content marketing',
        'product marketing', 'field marketing', 'email marketing',
        'digital marketing', 'seo', 'sem', 'paid media', 'paid social',
        'marketing operations', 'marketing analytics',
        'customer insights', 'consumer insights', 'market research',
        'go-to-market'
      ],
      medium: [
        'marketing', 'brand', 'growth', 'content', 'creative',
        'communications', 'pr', 'public relations', 'campaign',
        'insights', 'analytics', 'gtm'
      ],
      low: ['awareness', 'messaging', 'positioning']
    },
    'Product': {
      high: [
        'product manager', 'product management', 'product owner',
        'product designer', 'ux designer', 'ui designer',
        'user researcher', 'ux researcher', 'product analyst',
        'product strategy', 'product operations', 'product led'
      ],
      medium: [
        'product', 'ux', 'ui', 'user experience', 'user research',
        'design', 'roadmap', 'agile', 'scrum', 'platform', 'plg'
      ],
      low: ['feature', 'launch', 'mvp']
    },
    'Sales': {
      high: [
        'account executive', 'account manager', 'sales manager',
        'business development', 'bdr', 'sdr', 'sales development',
        'enterprise sales', 'inside sales', 'field sales',
        'revenue operations', 'revops', 'sales operations',
        'customer success', 'client success', 'relationship manager',
        'sales enablement', 'account management'
      ],
      medium: [
        'sales', 'revenue', 'quota', 'pipeline',
        'account', 'client', 'customer', 'partnerships', 'commercial',
        'alliances'
      ],
      low: ['prospecting', 'negotiation', 'deal']
    },
    'Finance': {
      high: [
        'financial planning', 'fp&a', 'financial analyst',
        'controller', 'comptroller', 'treasurer', 'cfo',
        'accounting manager', 'tax manager', 'audit manager',
        'corporate finance', 'corporate development',
        'investor relations', 'm&a'
      ],
      medium: [
        'finance', 'financial', 'accounting', 'treasury',
        'budget', 'forecast', 'audit', 'tax', 'payroll', 'risk'
      ],
      low: ['cost', 'variance']
    },
    'Operations': {
      high: [
        'supply chain manager', 'logistics manager', 'operations manager',
        'chief operating officer', 'vp operations',
        'procurement manager', 'vendor management',
        'business operations', 'biz ops',
        'continuous improvement'
      ],
      medium: [
        'operations', 'ops', 'supply chain', 'logistics',
        'procurement', 'vendor', 'fulfillment', 'facilities',
        'process improvement', 'lean', 'six sigma'
      ],
      low: ['efficiency', 'optimization', 'workflow']
    },
    'Legal': {
      high: [
        'general counsel', 'chief legal officer',
        'corporate attorney', 'litigation attorney',
        'compliance officer', 'chief compliance officer',
        'legal operations', 'contract manager'
      ],
      medium: [
        'legal', 'attorney', 'counsel', 'lawyer',
        'compliance', 'regulatory', 'risk', 'governance'
      ],
      low: ['policy', 'regulation']
    },
    'Data': {
      high: [
        'data scientist', 'data engineer', 'data analyst',
        'business intelligence', 'bi engineer', 'bi analyst',
        'analytics engineer', 'data architect',
        'data science', 'data strategy', 'customer analytics'
      ],
      medium: [
        'data', 'analytics', 'insights',
        'statistics', 'tableau', 'looker'
      ],
      low: ['metrics', 'dashboard', 'visualization']
    }
  };

  // Use word-boundary matching for short tokens to avoid false positives
  // e.g. "pr" should not match inside "practitioner"
  function tokenMatch(text, token) {
    if (token.length <= 3) {
      return new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text);
    }
    return text.includes(token);
  }

  const scores = {};
  for (const [func, tokens] of Object.entries(functionTokens)) {
    let score = 0;
    for (const token of tokens.high) {
      if (tokenMatch(title, token)) score += 3;
    }
    for (const token of tokens.medium) {
      if (tokenMatch(title, token)) score += 2;
    }
    for (const token of tokens.low) {
      if (tokenMatch(title, token)) score += 1;
    }
    scores[func] = score;
  }

  const sorted = Object.entries(scores).sort(([,a], [,b]) => b - a);
  const [topFunction, topScore] = sorted[0];

  console.log(`🔍 Function scores for "${jobTitle}": ${
    sorted.filter(([,s]) => s > 0).map(([f,s]) => `${f}:${s}`).join(', ') || 'none'
  }`);

  if (topScore < 2) {
    console.log(`⚠️ Could not detect function for: "${jobTitle}" — defaulting to General`);
    return 'General';
  }

  console.log(`✅ Function detected: ${topFunction} (score: ${topScore}) for "${jobTitle}"`);
  return topFunction;
}

function deriveLevel(jobTitle) {
  const t = jobTitle.toLowerCase();
  if (t.includes('ceo') || t.includes('president') || t.includes('founder')) return 'ceo';
  // Check C-suite abbreviations with word boundaries to avoid false matches
  // e.g. "generation" should not match "cto", "director" should not match "cro"
  if (t.includes('chief') || /\bcmo\b/.test(t) || /\bcto\b/.test(t) || /\bcfo\b/.test(t) || /\bcpo\b/.test(t) || /\bcro\b/.test(t) || /\bcoo\b/.test(t) || /\bchro\b/.test(t)) return 'csuite';
  if (t.includes('svp') || t.includes('senior vice president') || t.includes('evp') || t.includes('executive vice president')) return 'svp';
  if (t.includes('vp') || t.includes('vice president')) return 'vp';
  if (t.includes('senior director') || t.includes('executive director')) return 'senior_director';
  if (t.includes('head of')) return 'head';
  if (t.includes('director')) return 'director';
  if (t.includes('senior manager')) return 'senior_manager';
  if (t.includes('manager')) return 'manager';
  return 'director'; // default
}

function getHiringManagerTitles(func, level) {
  const csuiteTitles = getCsuiteForFunction(func);

  const levelMap = {
    'manager': [`Director of ${func}`, `Director ${func}`, `Head of ${func}`, `Senior Director ${func}`],
    'senior_manager': [`Director of ${func}`, `Senior Director ${func}`, `Head of ${func}`, `VP of ${func}`],
    'director': [`VP of ${func}`, `VP ${func}`, `Vice President ${func}`, `Head of ${func}`, `SVP ${func}`, ...csuiteTitles],
    'senior_director': [`SVP ${func}`, `VP of ${func}`, `Senior Vice President ${func}`, ...csuiteTitles],
    'head': [`VP of ${func}`, `VP ${func}`, `SVP ${func}`, ...csuiteTitles],
    'vp': [`SVP ${func}`, `Senior Vice President ${func}`, `EVP ${func}`, ...csuiteTitles],
    'svp': [...csuiteTitles, 'CEO', 'President'],
    'csuite': ['CEO', 'President', 'Founder'],
    'ceo': ['Chairman', 'Board Member'],
  };

  if (func === 'General') {
    return ['CEO', 'COO', 'President', 'Managing Director'];
  }
  return levelMap[level] || [`VP of ${func}`, `Head of ${func}`, ...csuiteTitles];
}

function getSkipLevelTitles(func, level) {
  const csuiteTitles = getCsuiteForFunction(func);

  const levelMap = {
    'manager': [`VP of ${func}`, `VP ${func}`, `SVP ${func}`],
    'senior_manager': [`VP of ${func}`, `SVP ${func}`, ...csuiteTitles],
    'director': [`SVP ${func}`, ...csuiteTitles, 'CEO', 'President'],
    'senior_director': [...csuiteTitles, 'CEO', 'President', 'COO'],
    'head': [...csuiteTitles, 'CEO', 'President', 'COO'],
    'vp': ['CEO', 'President', 'COO', 'Founder'],
    'svp': ['CEO', 'President', 'Chairman', 'Founder'],
    'csuite': ['CEO', 'President', 'Chairman'],
    'ceo': ['Chairman', 'Board'],
  };

  if (func === 'General') {
    return ['CEO', 'President', 'Chairman', 'Board Member'];
  }
  return levelMap[level] || [...csuiteTitles, 'CEO', 'President'];
}

function getCsuiteForFunction(func) {
  const map = {
    'Marketing': ['CMO', 'Chief Marketing Officer'],
    'Product': ['CPO', 'Chief Product Officer'],
    'Engineering': ['CTO', 'Chief Technology Officer', 'Chief Engineering Officer'],
    'Sales': ['CRO', 'Chief Revenue Officer', 'Chief Sales Officer'],
    'Finance': ['CFO', 'Chief Financial Officer'],
    'Operations': ['COO', 'Chief Operating Officer'],
    'People': ['CHRO', 'Chief People Officer', 'CPO', 'Chief Human Resources Officer', 'VP of People', 'VP of HR', 'Head of People', 'Head of HR'],
    'Data': ['CDO', 'Chief Data Officer', 'CTO'],
    'Legal': ['CLO', 'Chief Legal Officer', 'General Counsel'],
    'Security': ['CISO', 'Chief Information Security Officer'],
    'Customer Success': ['CCO', 'Chief Customer Officer'],
    'Revenue': ['CRO', 'Chief Revenue Officer'],
    'Communications': ['CCO', 'Chief Communications Officer'],
    'Data': ['CDO', 'Chief Data Officer', 'CTO', 'VP of Analytics', 'VP of Data'],
  };
  return map[func] || ['COO', 'Chief Operating Officer'];
}

function getRecruiterTerms(func) {
  const base = ['recruiter', 'talent acquisition', 'recruiting partner', 'talent partner', 'HR business partner'];
  const funcSpecific = {
    'Engineering': ['technical recruiter', 'engineering recruiter'],
    'Product': ['technical recruiter', 'product recruiter'],
    'People': ['HR recruiter', 'people recruiter', 'talent acquisition'],
    'Marketing': ['marketing recruiter'],
    'Sales': ['sales recruiter'],
    'Finance': ['finance recruiter'],
    'Design': ['design recruiter', 'creative recruiter'],
  };
  return [...(funcSpecific[func] || []), ...base];
}

// ── Step 2: Brave Search ──

function getDeptSearchTerms(func) {
  const map = {
    'People': '"People" OR "HR" OR "Human Resources" OR "Talent" OR "Learning" OR "OD"',
    'Marketing': '"Marketing" OR "Growth" OR "Brand" OR "Demand"',
    'Engineering': '"Engineering" OR "Software" OR "Technology" OR "Platform"',
    'Sales': '"Sales" OR "Business Development" OR "Revenue"',
    'Finance': '"Finance" OR "Accounting" OR "FP&A"',
    'Product': '"Product" OR "Product Management"',
    'Operations': '"Operations" OR "Supply Chain"',
    'Data': '"Data" OR "Analytics" OR "Insights" OR "ML"',
    'Design': '"Design" OR "UX" OR "Creative"',
    'Customer Success': '"Customer Success" OR "Client Success" OR "CX"',
    'Revenue': '"Revenue" OR "Sales" OR "Commercial"',
    'Legal': '"Legal" OR "Compliance" OR "General Counsel"',
    'Security': '"Security" OR "InfoSec" OR "Cybersecurity"',
    'Communications': '"Communications" OR "PR" OR "Corporate Comms"',
  };
  return map[func] || `"${func}"`;
}

async function braveSearch(query, apiKey) {
  try {
    const params = new URLSearchParams({
      q: query,
      count: '10',
      text_decorations: 'false',
      search_lang: 'en'
    });

    const response = await fetch(
      `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
      {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey
        }
      }
    );

    if (!response.ok) {
      console.error('Brave API error:', response.status);
      return [];
    }

    const data = await response.json();
    const webResults = (data.web && data.web.results) || [];
    console.log(`    Brave raw: ${webResults.length} results`);

    // Step 3: Extract and clean LinkedIn URLs
    const contacts = [];
    for (const r of webResults) {
      const url = r.url || '';
      // Reject non-profile pages
      if (url.includes('linkedin.com/company/')) continue;
      if (url.includes('linkedin.com/jobs/')) continue;
      if (url.includes('linkedin.com/pulse/')) continue;
      if (url.includes('linkedin.com/posts/')) continue;
      if (!url.includes('linkedin.com/in/') && !url.includes('linkedin.com/pub/')) continue;

      // Clean URL
      let cleanUrl = url.split('?')[0].split('#')[0].replace(/\/+$/, '');
      if (!cleanUrl.startsWith('http')) cleanUrl = 'https://' + cleanUrl;

      const name = extractNameFromUrl(cleanUrl);
      if (!name || name.length < 3) continue;
      if (!isValidExtractedName(name)) continue;

      contacts.push({
        name,
        linkedin_url: cleanUrl,
        snippet: (r.description || r.title || '').substring(0, 400),
        page_title: (r.title || '').substring(0, 200)
      });
    }

    console.log(`    After cleaning: ${contacts.length} valid profiles`);
    return contacts;
  } catch (err) {
    console.error('Brave search failed:', err.message);
    return [];
  }
}

function isValidExtractedName(name) {
  if (!name || name.length < 3) return false;
  const hasSpace = name.includes(' ');
  // Must have a space (first + last) unless very short
  if (!hasSpace && name.length > 10) return false;
  // Reject digits mixed with letters (slug IDs)
  if (/[a-z][0-9]|[0-9][a-z]/i.test(name.replace(/\s/g, ''))) return false;
  // Reject all lowercase with no spaces (unsplit slug)
  if (name === name.toLowerCase() && !hasSpace) return false;
  // Reject single long word (12+ chars, no space)
  if (!hasSpace && name.length > 12) return false;
  return true;
}

function extractNameFromUrl(url) {
  const match = url.match(/linkedin\.com\/(?:in|pub)\/([^\/\?]+)/);
  if (!match) return '';
  const slug = match[1].toLowerCase();
  const credentials = new Set([
    'mba', 'phr', 'sphr', 'shrm', 'cpa', 'cgma', 'lmsw', 'mpaff', 'phd', 'edd',
    'jd', 'md', 'rn', 'cfa', 'cfe', 'pmp', 'csm', 'ciso', 'cissp', 'cipp',
    'hrm', 'mhrm', 'mshrm', 'mpa', 'mps', 'ms', 'ma', 'bs', 'ba', 'bba', 'msc', 'pdm',
    'cpo', 'chro', 'cto', 'cmo', 'cfo', 'coo', 'ceo', 'cro', 'cio', 'hr'
  ]);
  const parts = slug.split('-').filter(p => {
    if (p.length === 0) return false;
    if (/^\d+$/.test(p)) return false; // pure numbers
    if (/^[a-z0-9]*\d[a-z0-9]*$/.test(p) && /\d/.test(p) && p.length > 3) return false; // alphanumeric IDs
    if (p.length === 1) return false; // single letters
    if (credentials.has(p)) return false; // credential suffixes
    return true;
  });

  // If slug has hyphens — use existing hyphen-split logic
  if (parts.length >= 2) {
    return parts.slice(0, 3).map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
  }

  // Single word slug (no hyphens) — try name splitting
  if (parts.length === 1) {
    const split = splitSingleWordSlug(parts[0]);
    return split;
  }

  return '';
}

// Split single-word LinkedIn slugs like "anjelicagarcia" → "Anjelica Garcia"
function splitSingleWordSlug(slug) {
  if (!slug || slug.length < 4) return slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : '';

  const commonFirstNames = new Set([
    'michael', 'christopher', 'matthew', 'jonathan', 'nicholas',
    'benjamin', 'alexander', 'nathaniel', 'zachary', 'timothy',
    'joshua', 'andrew', 'brandon', 'samuel', 'raymond',
    'gregory', 'patrick', 'stephen', 'jeffrey',
    'charles', 'richard', 'anthony', 'william', 'robert',
    'thomas', 'daniel', 'joseph', 'kenneth', 'donald',
    'george', 'edward', 'steven', 'brian', 'ronald',
    'kevin', 'jason', 'gary', 'eric', 'jacob',
    'tyler', 'aaron', 'peter', 'walter', 'harold',
    'frank', 'henry', 'carl', 'albert', 'arthur',
    'fred', 'leonard', 'clarence', 'eugene', 'ralph',
    'wayne', 'russell', 'louis', 'alan', 'dennis',
    'jerry', 'lawrence', 'justin', 'terry', 'sean',
    'jennifer', 'jessica', 'stephanie', 'elizabeth', 'rebecca',
    'kathleen', 'michelle', 'kimberly', 'christina', 'margaret',
    'patricia', 'barbara', 'linda', 'susan',
    'dorothy', 'sarah', 'karen', 'lisa', 'nancy',
    'betty', 'sandra', 'ashley', 'emily', 'donna',
    'carol', 'amanda', 'melissa', 'deborah', 'rachel',
    'sharon', 'laura', 'cynthia', 'angela', 'shirley',
    'anna', 'brenda', 'pamela', 'emma', 'nicole',
    'helen', 'samantha', 'katherine', 'christine', 'debra',
    'carolyn', 'janet', 'catherine', 'maria', 'heather',
    'diane', 'julie', 'joyce', 'victoria', 'kelly',
    'virginia', 'joan', 'evelyn', 'lauren', 'judith',
    'olivia', 'frances', 'martha', 'cheryl', 'megan',
    'andrea', 'hannah', 'jacqueline', 'gloria',
    'jean', 'kathryn', 'alice', 'teresa', 'sara',
    'janice', 'doris', 'madison', 'julia', 'grace',
    'judy', 'abigail', 'marie', 'denise', 'amber',
    'brittany', 'danielle', 'theresa', 'natalie', 'diana',
    'rose', 'kayla', 'morgan', 'taylor', 'jordan',
    'skylar', 'paige', 'maya', 'ella', 'avery', 'addison',
    'alejandro', 'carlos', 'antonio', 'miguel', 'jose',
    'juan', 'rafael', 'sergio', 'marco', 'mario',
    'lucia', 'carolina', 'valentina', 'isabella', 'camila',
    'anjelica', 'madeleine', 'brianna',
    'amy', 'ann', 'eve', 'joy', 'kay', 'kim',
    'lee', 'meg', 'pat', 'sue',
    'adam', 'alex', 'andy', 'ben', 'bob', 'brad',
    'brett', 'chad', 'clay', 'cole', 'cody', 'dale',
    'dan', 'dave', 'dean', 'drew', 'duke', 'earl',
    'evan', 'gene', 'glen', 'gus', 'hal', 'hank',
    'ian', 'ivan', 'jack', 'jake', 'jeff',
    'jim', 'joe', 'joel', 'john', 'jon', 'josh',
    'karl', 'kent', 'kirk', 'kurt', 'kyle',
    'lance', 'lars', 'leon', 'liam', 'luke', 'marc',
    'mark', 'matt', 'max', 'mike', 'milo', 'neal',
    'neil', 'nick', 'noah', 'noel', 'omar', 'otto',
    'owen', 'paul', 'pete', 'phil', 'reed', 'reid',
    'rex', 'rick', 'rob', 'rod', 'ron', 'ross',
    'roy', 'ryan', 'sam', 'seth',
    'stan', 'ted', 'tim', 'todd', 'tom', 'tony',
    'troy', 'wade', 'will', 'zach'
  ]);

  const lower = slug.toLowerCase();

  // Try each first name — longest match first to avoid partial matches
  // Sort by length descending so "christopher" matches before "chris"
  const sorted = [...commonFirstNames].sort((a, b) => b.length - a.length);
  for (const firstName of sorted) {
    if (lower.startsWith(firstName) && lower.length > firstName.length + 1) {
      const lastName = slug.slice(firstName.length);
      if (lastName.length >= 2) {
        return firstName.charAt(0).toUpperCase() + firstName.slice(1) + ' ' +
               lastName.charAt(0).toUpperCase() + lastName.slice(1);
      }
    }
  }

  // Can't split — return capitalized as-is
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

// ── Company name variations ──

function getCompanyVariations(company) {
  const variations = [company];
  const known = {
    'RTX': ['Raytheon', 'RTX Corporation'], 'Meta': ['Facebook', 'Meta Platforms'],
    'Alphabet': ['Google'], 'Google': ['Alphabet'],
    'Amazon': ['AWS', 'Amazon Web Services'], 'AWS': ['Amazon'],
    'JPMorgan': ['JP Morgan', 'JPMorgan Chase'], 'Goldman Sachs': ['Goldman'],
    'Salesforce': ['Salesforce.com'], 'CrowdStrike': ['Crowdstrike'],
    'Palo Alto Networks': ['Palo Alto'],
  };
  const upper = company.toUpperCase();
  for (const [key, aliases] of Object.entries(known)) {
    if (key.toUpperCase() === upper) { variations.push(...aliases); break; }
  }
  // Smart short name extraction
  const shortName = getShortName(company);
  if (shortName) variations.push(shortName);
  return [...new Set(variations)];
}

function getShortName(companyName) {
  if (!companyName || companyName.length <= 8) return null;
  if (/^[A-Z]{2,6}$/.test(companyName.trim())) return null;
  const tooGeneric = new Set([
    'the','a','an','new','old','big','great','global','national','american','united','first',
    'best','top','advanced','premier','elite','pro','max','super','smart','bright','clear',
    'clean','fast','quick','help','care','life','living','next','future','digital','virtual',
    'cyber','cloud','data','tech','business','enterprise','corporate','professional','general',
    'universal','total','complete','full','open','free','easy','simple','modern','dynamic',
    'strategic','integrated','innovative','creative','north','south','east','west','central',
    'prime','apex','peak','summit','pinnacle'
  ]);
  const words = companyName.split(/\s+/);
  const first = words[0].toLowerCase().replace(/[^a-z]/g, '');
  if (first.length >= 4 && !tooGeneric.has(first)) return words[0];
  if (words.length > 1) {
    const second = words[1].toLowerCase().replace(/[^a-z]/g, '');
    if (second.length >= 4 && !tooGeneric.has(second)) return words[1];
  }
  return null;
}

// ── Apollo fallback ──

async function apolloSearch(company, derived, apiKey) {
  try {
    const titles = [...derived.hmTitles.slice(0, 3), ...derived.slTitles.slice(0, 2), 'Recruiter', 'Talent Acquisition'];
    const response = await fetch('https://api.apollo.io/api/v1/mixed_people/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        q_organization_name: company,
        person_titles: titles.slice(0, 5),
        page: 1,
        per_page: 10
      })
    });
    if (!response.ok) { console.error('Apollo error:', response.status); return []; }
    const data = await response.json();
    return (data.people || [])
      .filter(p => p.linkedin_url && p.linkedin_url.includes('linkedin.com/in/'))
      .map(p => ({
        name: [p.first_name, p.last_name].filter(Boolean).join(' '),
        linkedin_url: p.linkedin_url.split('?')[0],
        snippet: `${p.title || ''} at ${p.organization?.name || company}`,
        page_title: `${p.first_name} ${p.last_name} - ${p.title || ''}`,
        searchRole: categorizeRole(p.title, derived)
      }));
  } catch (err) { console.error('Apollo failed:', err.message); return []; }
}

function categorizeRole(title, derived) {
  if (!title) return 'Hiring Manager';
  const t = title.toLowerCase();
  if (t.includes('recruit') || t.includes('talent acq') || t.includes('talent partner')) return 'Recruiter / TA';
  if (t.includes('ceo') || t.includes('president') || t.includes('coo') || t.includes('chairman')) return 'Skip-Level';
  return 'Hiring Manager';
}

// ── Pre-qualification: accept/reject contacts BEFORE Claude ──

// Known false positive profiles that appear across multiple companies
const KNOWN_FALSE_POSITIVES = new Set([
  'ann-miller-hr', 'iker-zubia-hr', 'leigh-gordon-1ab5517', 'leigh-gordon', 'stephanie-yocum',
  'chris-plonsky-9700165',        // Athletics at UFCU - wrong function
  'prakash-ilango-8962541b',      // Dell - no title signal
  'sridhar-gurram-b5905011',      // Dell - no title signal
  'kirk-scott-562a7b74',          // Dell - no title signal
  'patwadors',                    // Pat Wadors — LinkedIn influencer, appears for many companies
  'mark-hidle'                    // Appears across multiple company searches
]);

// City/name words that cause false positives in slugs
const COMMON_NAME_WORDS = new Set([
  // Cities/places that are also surnames
  'austin', 'clifton', 'houston', 'dallas', 'phoenix', 'jordan', 'hunter', 'taylor',
  'morgan', 'parker', 'lincoln', 'grant', 'hayes', 'reed', 'scott', 'young', 'white',
  'mason', 'logan', 'carter', 'cooper', 'riley',
  // Common surnames that overlap with company names
  'smith', 'johnson', 'anderson', 'miller', 'wilson', 'moore', 'jackson', 'martin',
  'lee', 'thompson', 'garcia', 'martinez', 'robinson', 'clark', 'rodriguez', 'lewis',
  'walker', 'hall', 'allen', 'wright', 'baker', 'nelson', 'mitchell',
  'campbell', 'roberts', 'turner',
  // Company-name surnames — cause false positives when company name contains a common surname
  'hanger', 'hangar', 'ford', 'honda', 'toyota', 'dell',
  'gates', 'jobs', 'cook', 'hewlett', 'packard',
  'kaiser', 'porter', 'graham', 'burns', 'reid',
  'hunt', 'price', 'waters', 'fisher', 'marsh',
  'black', 'gray', 'gold', 'silver', 'diamond',
  'stone', 'wood', 'woods', 'fields', 'banks',
  'bond', 'sharp', 'bell', 'crane', 'wolf',
  'fox', 'holt', 'roper', 'hoover', 'church',
  'page', 'monk', 'ross', 'wade',
  'knight', 'bishop', 'king', 'cross', 'wells',
  'bay', 'lake', 'hill', 'ridge', 'glen',
  'north', 'south', 'east', 'west', 'central',
  'crown', 'summit', 'peak', 'apex', 'crest',
  'national', 'federal', 'capital', 'metro',
  'pioneer', 'heritage', 'legacy', 'cornerstone',
  'keystone', 'landmark', 'beacon', 'harbor',
  'anchor', 'compass', 'meridian', 'zenith',
  'sterling', 'golden', 'bright', 'swift', 'strong', 'keen',
  'brown', 'green',
  // Company names that match surnames or slug words
  'holdsworth', 'loenbro', 'cisco', 'adobe', 'oracle', 'tesla',
  'lyft', 'uber', 'slack', 'zoom', 'stripe', 'square', 'block',
  'shopify', 'twilio', 'okta', 'splunk', 'veeva', 'workday',
  'zendesk', 'hubspot', 'datadog', 'snowflake', 'palantir',
  'asana', 'notion', 'figma', 'canva', 'dropbox', 'box',
  'airtable', 'monday', 'rippling', 'gusto', 'lattice',
  'greenhouse', 'lever', 'bamboo', 'namely', 'paylocity',
  'paycom', 'ceridian', 'kronos', 'ultimate', 'saba',
  'sumtotal', 'absorb', 'docebo', 'bridge', 'degreed',
  'edcast', 'percipio', 'linkedin', 'coursera', 'udemy',
  'pluralsight', 'skillsoft'
]);

function nameContainsCompanyWord(name, companyName) {
  if (!name || !companyName) return false;
  const genericWords = new Set(['industries', 'technologies', 'solutions', 'services',
    'group', 'company', 'corporation', 'international', 'global', 'national',
    'consulting', 'associates', 'partners', 'holdings', 'enterprises']);
  const companyWords = companyName.toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 4)
    .filter(w => !genericWords.has(w));
  const nameParts = name.toLowerCase().split(/\s+/);
  return companyWords.some(w => nameParts.some(np => np === w));
}

function isTooJunior(contactTitle, jobTitle, jobFunction) {
  if (!contactTitle || !jobTitle) return false;
  var ct = contactTitle.toLowerCase();
  var jt = jobTitle.toLowerCase();
  var isDirectorSearch = /director|vp|vice president|head of|chief|svp|evp|managing/i.test(jt);
  if (!isDirectorSearch) return false;

  // Universal junior patterns — too junior for any director+ search
  var juniorPatterns = [
    /^hr coordinator/i, /^hr assistant/i, /^hr administrator/i,
    /^recruiting coordinator/i, /^talent coordinator/i,
    /^hr generalist(?!\s+senior)/i, /^human resources coordinator/i,
    /^people coordinator/i, /^people assistant/i
  ];
  if (juniorPatterns.some(function(p) { return p.test(ct); })) return true;

  // Function-aware: recruiter titles are junior for People searches only
  if (jobFunction === 'People') {
    if (/^hr recruiter$/i.test(ct)) return true;
    if (/^recruiter$/i.test(ct)) return true;
    if (/^talent recruiter$/i.test(ct)) return true;
  }

  return false;
}

function preQualifyContact(url, snippet, companyName, pageTitle) {
  const slug = url.toLowerCase();
  const snippetLower = (snippet || '').toLowerCase();
  const companyLower = companyName.toLowerCase();

  // Check known false positives
  const slugClean = slug.replace(/.*linkedin\.com\/in\//, '').replace(/[\?#].*$/, '').replace(/\/+$/, '');
  if (KNOWN_FALSE_POSITIVES.has(slugClean)) {
    console.log(`  🚫 Known false positive BLOCKED: ${slugClean}`);
    return { accepted: false, reason: 'known false positive profile' };
  }
  // Also check partial slug match (e.g. chris-plonsky matches chris-plonsky-9700165)
  for (const fp of KNOWN_FALSE_POSITIVES) {
    if (slugClean.startsWith(fp) || fp.startsWith(slugClean)) {
      console.log(`  🚫 Known false positive BLOCKED (partial): ${slugClean} matches ${fp}`);
      return { accepted: false, reason: 'known false positive profile (partial match)' };
    }
  }

  // Check city/name false positives - universal safe approach
  // Only filter if: snippet has no company words AND the matching word
  // is NOT a key part of the company name (Smith in Smith & Nephew)
  const companyWords = companyLower.split(/\s+/).filter(w => w.length > 3);
  const hasAnyCompanyWord = companyWords.some(w => snippetLower.includes(w));
  if (!hasAnyCompanyWord) {
    const fpWords = companyWords.filter(w => COMMON_NAME_WORDS.has(w));
    // Skip FP filter if the common name IS a core part of the company name
    // (e.g. "Smith" in "Smith & Nephew" - people named Smith might work there)
    const coreCompanyWord = companyWords[0]; // first word is the brand
    for (const fpWord of fpWords) {
      // Skip if this word is the first/core word of the company name
      if (fpWord === coreCompanyWord) continue;
      if (slug.includes(fpWord)) {
        return { accepted: false, reason: `city/name false positive: "${fpWord}" in slug, no company in snippet` };
      }
    }
  }

  // Function keyword slugs
  const functionSlugs = [
    '-hr', '-chro', '-cpo', '-cto', '-cmo', '-coo', '-cfo', '-cro',
    '-people', '-talent', '-recruiting', '-culture', '-workforce',
    '-marketing', '-sales', '-engineering', '-product', '-design',
    '-finance', '-legal', '-operations', '-analytics', '-data',
    'human-resource'
  ];
  const hasInstantSlug = functionSlugs.some(s => slug.includes(s));

  // C-suite in slug
  const cSuiteSlugs = ['-cpo', '-chro', '-cto', '-cmo', '-coo', '-cfo', '-ceo', '-cro', '-cio'];
  const hasCsuite = cSuiteSlugs.some(s => slug.includes(s));

  // Company signal in snippet
  const hasCompanySignal = companyWords.some(word => snippetLower.includes(word));

  // Current employment signal
  const currentSignals = ['at ' + companyLower, '· ' + companyLower,
    companyLower + ' |', companyLower + ' ·', 'current', 'currently'];
  const hasCurrentSignal = currentSignals.some(s => snippetLower.includes(s));

  // Past tense rejection
  const pastSignals = ['formerly', 'previously', 'ex-', 'alumni', 'former ', 'left ', 'worked at'];
  const hasPastTense = pastSignals.some(s => snippetLower.includes(s));

  // Extended past-tense patterns checked via regex
  const pastPatterns = [
    /\bpast\b.*\bat\b/i, /\bused to\b/i, /\bleft\b.*\bafter\b/i,
    /\buntil\b/i, /\bended\b/i, /\bno longer\b/i, /\bdeparted\b/i,
    /\bstepped down\b/i, /\btransitioned\b/i, /\bprevious role\b/i,
    /\b20(1[0-9]|2[0-3])\s*[-–]\s*20(2[0-3])\b/  // date ranges ending before 2024
  ];
  const hasPastPattern = pastPatterns.some(p => p.test(snippetLower));

  // Also check page_title for former indicators
  const pageTitleLower = (pageTitle || '').toLowerCase();
  const titleHasFormer = /\bformer\b|\bex-|\bretired\b|\bemeritus\b/i.test(snippetLower + ' ' + pageTitleLower);

  // Surname false positive check — name contains company word
  const contactName = extractNameFromUrl(url);
  if (nameContainsCompanyWord(contactName, companyName) && !hasCurrentSignal) {
    return { accepted: 'claude_decide', confidence: 'low', reason: 'name contains company word — possible surname FP' };
  }

  // Decision
  if ((hasPastTense || hasPastPattern || titleHasFormer) && !hasCurrentSignal) {
    return { accepted: false, reason: 'past tense employment' };
  }
  if (hasCsuite) {
    return { accepted: true, confidence: 'high', reason: 'C-suite title in URL slug' };
  }
  if (hasInstantSlug && hasCompanySignal) {
    return { accepted: true, confidence: 'high', reason: 'function keyword in slug + company confirmed' };
  }
  if (hasInstantSlug && !hasCompanySignal) {
    // Slug has function keyword but no company confirmation - let Claude decide
    return { accepted: 'claude_decide', confidence: 'low', reason: 'slug keyword but no company confirmation' };
  }
  if (hasCompanySignal && hasCurrentSignal) {
    return { accepted: true, confidence: 'high', reason: 'company + current employment confirmed' };
  }
  if (hasCompanySignal) {
    return { accepted: true, confidence: 'medium', reason: 'company name found in snippet' };
  }
  return { accepted: 'claude_decide', confidence: 'low' };
}

function inferTitleFromSlug(slug) {
  const s = slug.toLowerCase();
  if (s.includes('-chro') || s.includes('chief-human')) return 'Chief Human Resources Officer';
  if (s.includes('-cpo') && (s.includes('people') || s.includes('hr'))) return 'Chief People Officer';
  if (s.includes('-cpo')) return 'Chief Product Officer';
  if (s.includes('-cto')) return 'Chief Technology Officer';
  if (s.includes('-cmo')) return 'Chief Marketing Officer';
  if (s.includes('-coo')) return 'Chief Operating Officer';
  if (s.includes('-cfo')) return 'Chief Financial Officer';
  if (s.includes('-cro')) return 'Chief Revenue Officer';
  if (s.includes('-ceo')) return 'CEO';
  if (s.includes('human-resource')) return 'HR Professional';
  if (s.includes('-hr')) return 'HR Professional';
  if (s.includes('-people')) return 'People Team';
  if (s.includes('-talent')) return 'Talent Professional';
  if (s.includes('-recruiting')) return 'Recruiter';
  if (s.includes('-marketing')) return 'Marketing Professional';
  if (s.includes('-sales')) return 'Sales Professional';
  if (s.includes('-engineering')) return 'Engineering Professional';
  if (s.includes('-product')) return 'Product Professional';
  if (s.includes('-design')) return 'Design Professional';
  if (s.includes('-finance')) return 'Finance Professional';
  if (s.includes('-legal')) return 'Legal Professional';
  if (s.includes('-operations')) return 'Operations Professional';
  return '';
}

// Clean garbled company names
// Test cases:
// "SMITH & NEPHEW SNATS INC" → "Smith and Nephew"
// "CohnReznick Advisory LLC" → "CohnReznick"
// "Hanger, Inc." → "Hanger"
// "Dell Technologies EMEA" → "Dell"
// "AbbVie Inc." → "AbbVie"
// "Allergan Aesthetics (AbbVie)" → "Allergan Aesthetics"
// "Housing Authority of the City of Austin" → unchanged
// "Boston Consulting Group" → "Boston Consulting Group" (brand)
// "General Electric" → "General Electric" (brand)
function cleanCompanyName(rawName) {
  if (!rawName) return rawName;
  let cleaned = rawName.trim();
  // 1. Parenthetical
  cleaned = cleaned.replace(/\s*\([^)]+\)\s*$/, '').trim();
  // 2. Universal subsidiary code detection
  // Pattern: [Real Name] [CODE] [SUFFIX] — CODE = all-caps 2-8 chars before legal suffix
  // Requires at least 2 words before the code (so "IBM INC" isn't affected)
  const realCodeWords = new Set(['AND','THE','FOR','NEW','OLD','NORTH','SOUTH','EAST','WEST',
    'GLOBAL','GROUP','US','USA','NA','EMEA','APAC','LATAM','INTERNATIONAL','NATIONAL']);
  cleaned = cleaned.replace(
    /^(.+\s+\S+)\s+([A-Z]{2,8})\s+(INC|LLC|CORP|LTD|CO|PLC)\.?\s*$/,
    (match, realName, code, suffix) => {
      if (realCodeWords.has(code.toUpperCase())) return `${realName} ${code}`.trim();
      // All-caps short codes are almost always subsidiary codes
      if (/^[A-Z]+$/.test(code) && code.length <= 6) {
        console.log(`🧹 Removed subsidiary code "${code}" from "${rawName}"`);
        return realName.trim();
      }
      return `${realName} ${code}`.trim();
    }
  );
  // 3. Legal suffixes
  cleaned = cleaned.replace(/[,\s]+(INC\.?|LLC\.?|CORP\.?|LTD\.?|CO\.?|PLC\.?|INCORPORATED|LIMITED|CORPORATION)(\s+|$)/gi, ' ').trim();
  // 4. Generic trailing words - only strip from 3+ word names to protect brand names
  // Removed: technologies, technology, systems, group, company (part of brand names)
  const generic = ['advisory','advisors','consulting','consultants','solutions','services',
    'holdings','holding','enterprises','enterprise','partners','partnership','associates',
    'division','industries','industry','management','resources','networks','network'];
  const words = cleaned.split(/\s+/);
  if (words.length >= 3) {
    const last = words[words.length - 1].toLowerCase().replace(/[^a-z]/g, '');
    if (generic.includes(last) && words.slice(0, -1).join(' ').length >= 3) {
      cleaned = words.slice(0, -1).join(' ').trim();
    }
  }
  // 5. Regional suffixes
  cleaned = cleaned.replace(/\s+[-–—]?\s*(US|USA|EMEA|APAC|LATAM|NA|EU|UK|AMER|NORAM|ANZ)\s*$/i, '').trim();
  cleaned = cleaned.replace(/\s+(North America|South America|Latin America|Europe|Asia Pacific|Middle East|Africa|Global)\s*$/i, '').trim();
  // 6. Division indicators
  cleaned = cleaned.replace(/\s+(Division|Segment|Business Unit|Department|Region|Office)\s*$/i, '').trim();
  // 7. Punctuation
  cleaned = cleaned.replace(/[,;:.]+$/, '').trim();
  // 8. Whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  // 9. Validate
  if (cleaned.length < 2) { console.log(`⚠️ Cleaning too aggressive for "${rawName}"`); return rawName; }
  if (cleaned !== rawName) console.log(`🧹 Cleaned: "${rawName}" → "${cleaned}"`);
  return cleaned;
}

// Company-name-as-title check
function isTitleJustCompanyName(title, companyName) {
  if (!title || !companyName) return false;
  const t = title.toLowerCase().trim();
  const c = companyName.toLowerCase().trim();
  return t === c || t === c + ' employee' || t === 'employee at ' + c || t === c + ' team member' ||
    t.replace(/[^a-z]/g, '') === c.replace(/[^a-z]/g, '');
}

// Vague title check - generous, only rejects truly empty titles
function isSubEntityFalsePositive(note, title, searchCompany) {
  if (!note && !title) return false;
  var text = ((note || '') + ' ' + (title || '')).toLowerCase();
  var searchLower = searchCompany.toLowerCase().trim();
  var qualifiers = [
    'financial', 'consulting', 'development', 'solutions', 'services',
    'technology', 'technologies', 'group', 'partners', 'ventures',
    'capital', 'management', 'international', 'global', 'digital',
    'health', 'healthcare', 'media', 'studio', 'studios', 'labs',
    'systems', 'software', 'gmbh', 'llc', 'inc', 'ltd', 'corp',
    'app', 'platform'
  ];
  var escapedSearch = searchLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (var i = 0; i < qualifiers.length; i++) {
    var pattern = new RegExp(escapedSearch + '\\s+' + qualifiers[i] + '\\b', 'i');
    if (pattern.test(text)) return true;
  }
  return false;
}

function isFamousExecFalsePositive(contact, searchCompany) {
  var title = contact.title || '';
  var note = contact.note || '';
  if (!title) return false;
  var isCsuite = /(^|\s)(cmo|ceo|coo|cto|cfo|cro|chro|cpo|chief\s)/i.test(title);
  if (!isCsuite) return false;
  var noteLower = note.toLowerCase();
  var companyLower = searchCompany.toLowerCase().trim();
  // Check if note confirms the search company
  var companyWords = companyLower.split(/\s+/).filter(function(w) { return w.length > 2; });
  var noteConfirms = companyWords.some(function(w) { return noteLower.includes(w); });
  if (!noteConfirms) return true;
  return false;
}

function isFranchiseOwner(title, company) {
  var t = (title || '').toLowerCase();
  var c = (company || '').toLowerCase();
  if (/(support center|headquarters|hq|corporate)/i.test(c)) {
    if (/\bowner\b/i.test(t) && !/\bco-owner\b/i.test(t)) return true;
    if (/\bfranchise\b/i.test(t) && !/\bvp\b|director|head of|chief/i.test(t)) return true;
  }
  return false;
}

function isWrongEntityFalsePositive(title, note, companyName) {
  if (!title) return false;
  var titleLower = title.toLowerCase();
  var companyLower = (companyName || '').toLowerCase();

  // Check if title mentions "at [Different Company]"
  var atOrgMatch = titleLower.match(/(?:at|@|for|with)\s+([a-z][a-z0-9\s&]{2,40}?)(?:\s*[,|·]|$)/);
  if (atOrgMatch) {
    var orgInTitle = atOrgMatch[1].trim();
    if (orgInTitle.length > 3 &&
        !orgInTitle.includes(companyLower) &&
        !companyLower.includes(orgInTitle)) {
      console.log('  ❌ Wrong entity: ' + title + ' (searching: ' + companyName + ')');
      return true;
    }
  }

  // Check for sub-entity patterns where title contains all company words
  // plus extra words suggesting a different entity
  var companyWords = companyLower.split(/\s+/).filter(function(w) { return w.length > 2; });
  var hasCompanyWords = companyWords.every(function(w) { return titleLower.includes(w); });

  if (hasCompanyWords) {
    var subEntityIndicators = [
      'fc', 'united', 'city', 'athletic', 'athletics',
      'racing', 'motorsport', 'f1', 'nfl', 'nba', 'nhl',
      'mls', 'mlb', 'premier league', 'bundesliga',
      'salzburg', 'leipzig', 'brasil', 'mexico',
      'media', 'records', 'films', 'studios', 'content house',
      'stadium', 'arena', 'park', 'field'
    ];
    var hasSubEntity = subEntityIndicators.some(function(s) { return titleLower.includes(s); });
    if (hasSubEntity) {
      console.log('  ❌ Sub-entity false positive: "' + title + '" (searching: ' + companyName + ')');
      return true;
    }
  }

  return false;
}

function isTitleTooVague(title, roleType) {
  if (!title) return true;
  const t = title.toLowerCase().trim();

  // Never reject C-suite
  if (/(ceo|coo|cto|cmo|cfo|chro|cpo|president|founder)/i.test(t)) return false;

  // Never reject Skip-Level (executives often have generic snippet titles)
  if (roleType === 'Skip-Level') return false;

  // Accept partial titles with function signals
  const acceptable = ['hr', 'human resources', 'people', 'talent', 'chro', 'cpo', 'hrbp',
    'phr', 'sphr', 'shrm', 'executive', 'senior', 'vp', 'vice president', 'svp', 'evp',
    'director', 'president', 'chief', 'leader', 'marketing', 'engineering', 'product',
    'sales', 'finance', 'operations', 'legal', 'recruiting', 'recruiter'];
  if (acceptable.some(a => t.includes(a))) return false;

  // Vague but has company name — borderline, keep
  // e.g. "Red Bull Employee", "Employee at Dell" — they're confirmed there
  if (/employee|team member|staff/i.test(t) && t.length > 8) return false;

  // Only reject truly vague (single generic word, no company context)
  if (/^employee$/i.test(t) || /^professional$/i.test(t) || /^associate$/i.test(t)) return true;
  if (/^team member$/i.test(t) || /^staff$/i.test(t)) return true;
  if (t.length < 3) return true;

  return false;
}

// Former employee check
function isFormerEmployee(title, note) {
  const text = `${title || ''} ${note || ''}`;
  return /\bformer\b|\bex-|\bpreviously\b|\bretired\b|\balumni\b|\bemeritus\b/i.test(text);
}

// Function relevance - generous, only rejects clearly wrong functions
function isFunctionRelevant(title, jobFunction, roleType) {
  if (!title) return false;
  const t = title.toLowerCase().trim();

  // ALWAYS KEEP — never reject these:

  // Skip-Level contacts
  if (roleType === 'Skip-Level') return true;

  // C-suite
  if (/(ceo|coo|cto|cmo|cfo|chro|cpo|cro|cdo|cio|president|founder|co-founder|managing director)/i.test(t)) return true;

  // Executive/senior titles
  if (/(executive|vice president|\bvp\b|svp|evp|director|senior leader|head of)/i.test(t)) return true;

  // HR certifications
  if (/(phr|sphr|shrm|hrbp)/i.test(t)) return true;

  // Recruiting and TA — never reject
  if (/(recruit|recruiting|recruitment|talent acquisition|talent partner|sourcing|sourcer|staffing|\bta\b)/i.test(t)) return true;

  // HR/People function titles — never reject
  if (/(hr|human resources|people ops|people operations|people partner|people manager|people director|people lead|hrbp|hr business partner|hr generalist|hr manager|hr director|hr coordinator|workforce|compensation|benefits|total rewards|employee relations|labor relations|dei|diversity|inclusion|talent management|learning|training|organizational|culture|engagement)/i.test(t)) return true;

  // General function = accept anything
  if (jobFunction === 'General') return true;

  // Function-specific keywords
  const functionKeywords = {
    'People': ['hr', 'human resources', 'people', 'talent', 'learning', 'training', 'organizational', 'culture', 'workforce', 'od', 'l&d', 'employee', 'engagement', 'inclusion', 'diversity', 'dei'],
    'Marketing': ['marketing', 'brand', 'growth', 'demand', 'content', 'communications', 'creative', 'campaign', 'seo', 'paid', 'digital'],
    'Engineering': ['engineering', 'software', 'technology', 'technical', 'developer', 'devops', 'infrastructure', 'platform', 'data', 'security', 'architect', 'ml', 'ai'],
    'Product': ['product', 'ux', 'user experience', 'design', 'research', 'roadmap', 'program manager'],
    'Sales': ['sales', 'revenue', 'account', 'business development', 'partnerships', 'commercial', 'enterprise'],
    'Finance': ['finance', 'financial', 'accounting', 'treasury', 'fp&a', 'controller', 'audit'],
    'Operations': ['operations', 'ops', 'supply chain', 'logistics', 'procurement', 'biz ops'],
    'Legal': ['legal', 'counsel', 'compliance', 'risk', 'regulatory', 'attorney', 'general counsel'],
    'Data': ['data', 'analytics', 'business intelligence', 'insights', 'bi', 'analyst']
  };

  const keywords = functionKeywords[jobFunction] || [];
  if (keywords.some(kw => t.includes(kw))) return true;

  // Only reject if clearly wrong industry/function with no ambiguity
  const clearlyWrong = {
    'People': [
      /\bchef\b/i, /\bcook\b/i, /\bdriver\b/i, /\bmechanic\b/i, /\belectrician\b/i, /\bplumber\b/i,
      /\bjanitor\b/i, /\bnurse\b/i, /\bphysician\b/i, /\bdoctor\b/i, /\bsurgeon\b/i, /\blifeguard\b/i, /\bsecurity guard\b/i,
      /^engineering (leader|manager|director|vp)/i, /^software (engineer|developer|architect)/i,
      /^(senior |staff |principal )?engineer$/i, /^(vp|director|head) of engineering$/i, /^cto$/i,
      /^(frontend|backend|fullstack|full.stack) (engineer|developer)/i,
      /^data (scientist|engineer|analyst)$/i, /^devops/i, /^sre\b/i,
      /\bentrepreneur\b/i
    ],
    'Marketing': [/\bnurse\b/i, /\bphysician\b/i, /\bsoftware engineer\b/i, /\bentrepreneur\b/i],
    'Engineering': [/\bnurse\b/i, /\bmarketing manager\b/i, /\battorney\b/i, /\bentrepreneur\b/i]
  };

  const wrongPatterns = clearlyWrong[jobFunction] || [];
  if (wrongPatterns.some(p => p.test(t))) return false;

  // Default — KEEP. Better to show a borderline contact than lose a real one
  return true;
}

function titleMentionsDifferentCompany(title, expectedCompany) {
  if (!title || !expectedCompany) return false;
  const t = title.toLowerCase();
  const company = expectedCompany.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();

  // CEO/Founder title mismatch — if they claim CEO/Founder of a different company, flag it
  if (/\b(ceo|founder|co-founder|president)\b/i.test(t)) {
    var ceoCompanyMatch = t.match(
      /(?:ceo|founder|co-founder|president)\s+(?:at|of|@)\s+(.+?)(?:\s*[,|·]|$)/i
    );
    if (ceoCompanyMatch) {
      var claimedCompany = ceoCompanyMatch[1].toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
      if (claimedCompany.length > 2 &&
          !claimedCompany.includes(company) &&
          !company.includes(claimedCompany)) {
        console.log(`⚠️ CEO/Founder title mismatch: "${title}" (searching: ${expectedCompany})`);
        return true;
      }
    }
  }

  const majorCompanies = [
    'google', 'microsoft', 'apple', 'amazon', 'meta', 'facebook',
    'netflix', 'salesforce', 'oracle', 'sap', 'ibm', 'intel',
    'twitter', 'linkedin', 'uber', 'lyft', 'airbnb', 'spotify',
    'slack', 'zoom', 'dropbox', 'stripe', 'square', 'paypal',
    'goldman sachs', 'jpmorgan', 'morgan stanley', 'mckinsey',
    'deloitte', 'pwc', 'kpmg', 'bain', 'bcg', 'accenture'
  ];
  for (const co of majorCompanies) {
    if (t.includes(co) && !company.includes(co)) {
      console.log(`⚠️ Title may reference previous employer: "${title}" (searching: ${expectedCompany})`);
      return true;
    }
  }
  return false;
}

function dedupeContacts(contacts) {
  const seen = new Set();
  return contacts.filter(c => {
    const key = c.linkedin_url.toLowerCase().split('?')[0].replace(/\/+$/, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── LinkedIn company slug lookup ──
async function getLinkedInCompanySlug(companyName, braveKey) {
  // Try full name first, then variations
  const namesToTry = [companyName];
  // Add known abbreviations
  const abbrevMap = { 'Clifton Larson Allen': 'CLA CliftonLarsonAllen', 'CliftonLarsonAllen': 'CLA' };
  if (abbrevMap[companyName]) namesToTry.push(abbrevMap[companyName]);
  // Also try without common suffixes
  const cleaned = companyName.replace(/\s*(Inc|LLC|Corp|Ltd|Group|Co)\s*\.?$/i, '').trim();
  if (cleaned !== companyName) namesToTry.push(cleaned);

  for (const name of namesToTry) {
    try {
      const query = `site:linkedin.com/company "${name}"`;
      console.log('Company slug lookup:', query);
      const params = new URLSearchParams({ q: query, count: '5', text_decorations: 'false', search_lang: 'en' });
      const response = await fetch(
        `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
        { headers: { 'Accept': 'application/json', 'X-Subscription-Token': braveKey } }
      );
      if (!response.ok) continue;
      const data = await response.json();
      const results = (data.web && data.web.results) || [];
      for (const r of results) {
        const match = (r.url || '').match(/linkedin\.com\/company\/([^\/\?]+)/);
        if (match) {
          console.log(`✅ Found LinkedIn slug for "${companyName}": ${match[1]}`);
          return match[1];
        }
      }
    } catch (e) {
      console.error('Slug lookup failed for', name, ':', e.message);
    }
  }
  const fallback = slugifyCompany(companyName);
  console.log(`⚠️ Slug not found for "${companyName}" — using generated: ${fallback}`);
  return fallback;
}

function slugifyCompany(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── LinkedIn geo URN map ──
const LINKEDIN_GEO_URNS = {
  'austin': '103743442', 'round rock': '103743442', 'cedar park': '103743442',
  'new york': '105080838', 'brooklyn': '105080838', 'manhattan': '105080838',
  'san francisco': '102277331', 'oakland': '102277331',
  'los angeles': '102448103', 'santa monica': '102448103', 'pasadena': '102448103',
  'chicago': '103112676', 'evanston': '103112676',
  'seattle': '102885535', 'bellevue': '102885535', 'redmond': '102885535',
  'boston': '102380872', 'cambridge': '102380872',
  'denver': '105763813', 'boulder': '105763813',
  'atlanta': '103996544', 'marietta': '103996544',
  'dallas': '103544739', 'fort worth': '103544739', 'plano': '103544739', 'irving': '103544739',
  'houston': '106929867', 'the woodlands': '106929867',
  'miami': '102918819', 'fort lauderdale': '102918819',
  'washington': '103644278', 'washington dc': '103644278', 'arlington': '103644278', 'bethesda': '103644278',
  'portland': '101978430',
  'san diego': '106091299',
  'phoenix': '102712797', 'scottsdale': '102712797', 'tempe': '102712797',
  'minneapolis': '105044203', 'st paul': '105044203',
  'nashville': '102033146',
  'charlotte': '103068493',
  'philadelphia': '102437668',
  'salt lake city': '106051040',
  'detroit': '102380645',
  'san jose': '106204433', 'sunnyvale': '106204433', 'cupertino': '106204433', 'mountain view': '106204433', 'palo alto': '106204433',
  'columbus': '101716677',
  'indianapolis': '103017440',
  'raleigh': '102459580', 'durham': '102459580',
  'tampa': '101654608', 'st petersburg': '101654608',
  'orlando': '103363856',
  'pittsburgh': '101413020',
  'san antonio': '102463825',
  'jacksonville': '102676224',
  'sacramento': '100906991',
  'las vegas': '102277788',
  'kansas city': '103440085',
  'richmond': '104378955',
  'st louis': '103752558',
  'milwaukee': '101871398',
  'baltimore': '103338958',
  'cleveland': '102009786',
  'boise': '104076313',
};

function getGeoUrn(location) {
  if (!location) return null;
  const loc = location.toLowerCase().replace(/,.*$/, '').trim();

  // Try exact match first
  if (LINKEDIN_GEO_URNS[loc]) return LINKEDIN_GEO_URNS[loc];

  // Try partial match — check if any key is contained in the location string
  for (const [city, urn] of Object.entries(LINKEDIN_GEO_URNS)) {
    if (loc.includes(city)) return urn;
  }

  return null;
}
