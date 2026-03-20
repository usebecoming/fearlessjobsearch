import { rateLimit } from './_rateLimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rl = rateLimit(req, { maxRequests: 5, windowMs: 60000 });
  if (!rl.allowed) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
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

    const results = [];

    for (const job of jobs) {
      const company = job.company;
      const jobTitle = job.title;

      // Skip if no company
      if (!company || company === 'Unknown' || company.length < 2) {
        console.log(`Skipping: no valid company name for "${jobTitle}"`);
        results.push({ job_id: job.job_id, company, job_title: jobTitle, location: job.location || '', derived: {}, raw_contacts: [] });
        continue;
      }

      console.log(`\n=== CONTACTS FOR: ${jobTitle} at ${company} ===`);

      // Step 1: Derive function, titles, hierarchy
      const derived = deriveAll(jobTitle);
      console.log('Function:', derived.func);
      console.log('HM titles:', derived.hmTitles);
      console.log('Skip-Level titles:', derived.slTitles);
      console.log('Recruiter terms:', derived.recTerms);

      const companyNames = getCompanyVariations(company);
      const allContacts = [];

      // Step 2: Run 3 Brave searches with function-specific queries

      // Search 1: Hiring managers
      const hmQuery = derived.hmTitles.map(t => `"${t}"`).join(' OR ');
      for (const co of companyNames) {
        const q = `site:linkedin.com/in "${co}" (${hmQuery})`;
        console.log(`  HM query [${co}]:`, q);
        const r = await braveSearch(q, braveKey);
        console.log(`  HM results: ${r.length}`);
        allContacts.push(...r.map(c => ({ ...c, searchRole: 'Hiring Manager' })));
        if (r.length >= 3) break;
      }

      // Fallback: broader HM search if few results
      if (allContacts.filter(c => c.searchRole === 'Hiring Manager').length < 3) {
        for (const co of companyNames) {
          const q = `site:linkedin.com/in "${co}" (${getDeptSearchTerms(derived.func)}) (VP OR SVP OR "Head of" OR Director OR Chief)`;
          console.log(`  HM broad [${co}]:`, q);
          const r = await braveSearch(q, braveKey);
          console.log(`  HM broad results: ${r.length}`);
          allContacts.push(...r.map(c => ({ ...c, searchRole: 'Hiring Manager' })));
          if (r.length >= 3) break;
        }
      }

      // Search 2: Recruiters (function-specific)
      const recQuery = derived.recTerms.map(t => `"${t}"`).join(' OR ');
      for (const co of companyNames) {
        const q = `site:linkedin.com/in "${co}" (${recQuery})`;
        console.log(`  Recruiter query [${co}]:`, q);
        const r = await braveSearch(q, braveKey);
        console.log(`  Recruiter results: ${r.length}`);
        allContacts.push(...r.map(c => ({ ...c, searchRole: 'Recruiter / TA' })));
        if (r.length >= 3) break;
      }

      // Search 3: Skip-level
      const slQuery = derived.slTitles.map(t => `"${t}"`).join(' OR ');
      for (const co of companyNames) {
        const q = `site:linkedin.com/in "${co}" (${slQuery})`;
        console.log(`  Skip-Level query [${co}]:`, q);
        const r = await braveSearch(q, braveKey);
        console.log(`  Skip-Level results: ${r.length}`);
        allContacts.push(...r.map(c => ({ ...c, searchRole: 'Skip-Level' })));
        if (r.length >= 3) break;
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

      // Fix 2: Founder search for small companies (if <2 contacts)
      let dedupedSoFar = dedupeContacts(allContacts);
      if (dedupedSoFar.length < 2) {
        console.log('Few contacts, searching for founder/CEO...');
        const founderQuery = `site:linkedin.com/in "${company}" (Founder OR "Co-Founder" OR CEO OR President)`;
        const founderResults = await braveSearch(founderQuery, braveKey);
        console.log(`Founder search: ${founderResults.length} results`);
        allContacts.push(...founderResults.map(r => ({ ...r, searchRole: 'Skip-Level', isFounder: true })));
      }

      const finalContacts = dedupeContacts(allContacts);

      // Enrich contacts: flag URL slugs that contain function keywords
      finalContacts.forEach(c => {
        const slug = (c.linkedin_url || '').toLowerCase();
        if (/-hr|-people|-talent|-recruiting|-culture|-learning/.test(slug)) {
          c.slugHasFunction = true;
        }
      });

      console.log(`Final contacts for ${company}: ${finalContacts.length}`);

      // Look up LinkedIn company slug for fallback links
      const companySlug = await getLinkedInCompanySlug(company, braveKey);
      const geoUrn = getGeoUrn(job.location);

      // Fix 3: Detect professional services / law firm
      const isProfServices = /law|legal|llp|llc|consulting|advisors|partners|group|associates/i.test(company);
      let extraSlTitles = [];
      if (isProfServices && derived.func === 'People') {
        extraSlTitles = ['Chief Administrative Officer', 'Chief Talent Officer', 'Managing Partner', 'Administrative Partner', 'Director of Administration'];
        console.log('Professional services detected, added alternative skip-level titles');
      }

      results.push({
        job_id: job.job_id,
        company,
        job_title: jobTitle,
        location: job.location || '',
        derived: {
          func: derived.func,
          hmTitles: derived.hmTitles,
          slTitles: [...derived.slTitles, ...extraSlTitles],
          recTerms: derived.recTerms
        },
        raw_contacts: finalContacts.slice(0, 20),
        linkedin_slug: companySlug,
        geo_urn: geoUrn,
        is_professional_services: isProfServices
      });
    }

    console.log(`\n=== TOTAL: ${results.reduce((s, r) => s + r.raw_contacts.length, 0)} contacts across ${results.length} jobs ===`);
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

  console.log(`✅ Function detected: ${func} for "${jobTitle}"`);
  return { func, level, hmTitles, slTitles, recTerms };
}

function deriveFunction(jobTitle) {
  const text = jobTitle.toLowerCase();

  // People/HR must be checked FIRST (before Engineering catches "development")
  if (/hr|human resources|people ops|people operations|talent development|talent management|learning|l&d|organizational development|\bod\b|training|culture|workforce|hris|compensation|benefits|recruiting|recruiter|talent acquisition|performance|engagement/i.test(text)) {
    return 'People';
  }
  if (/engineering|software|developer|devops|infrastructure|platform|backend|frontend|fullstack|data engineer|ml engineer|site reliability/i.test(text)) {
    return 'Engineering';
  }
  if (/product management|product manager|product strategy|product lead|product director|product vp/i.test(text)) {
    return 'Product';
  }
  if (/marketing|brand|demand gen|growth|content|seo|campaigns|communications|pr |public relations/i.test(text)) {
    return 'Marketing';
  }
  if (/sales|revenue|account executive|business development|bd |partnerships|channel/i.test(text)) {
    return 'Sales';
  }
  if (/finance|accounting|fp&a|financial planning|controller|treasury|audit/i.test(text)) {
    return 'Finance';
  }
  if (/design|ux|user experience|ui |creative|visual/i.test(text)) {
    return 'Design';
  }
  if (/legal|compliance|counsel|risk|regulatory/i.test(text)) {
    return 'Legal';
  }
  if (/operations|supply chain|logistics|facilities|biz ops/i.test(text)) {
    return 'Operations';
  }
  if (/data science|analytics|business intelligence|bi |insights|data analyst/i.test(text)) {
    return 'Data';
  }
  if (/security|infosec|cybersecurity|information security/i.test(text)) {
    return 'Security';
  }
  if (/customer|client|success|support|customer experience/i.test(text)) {
    return 'Customer Success';
  }
  if (/strategy|planning|transformation|corporate development/i.test(text)) {
    return 'Strategy';
  }

  console.warn(`⚠️ Could not detect function for: "${jobTitle}" — defaulting to General`);
  return 'General';
}

function deriveLevel(jobTitle) {
  const t = jobTitle.toLowerCase();
  if (t.includes('ceo') || t.includes('president') || t.includes('founder')) return 'ceo';
  if (t.includes('chief') || t.includes('cmo') || t.includes('cto') || t.includes('cfo') || t.includes('cpo') || t.includes('cro') || t.includes('coo') || t.includes('chro')) return 'csuite';
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
    'senior_manager': [`Director of ${func}`, `Senior Director ${func}`, `Head of ${func}`],
    'director': [`VP of ${func}`, `VP ${func}`, `Vice President ${func}`, `Head of ${func}`],
    'senior_director': [`VP of ${func}`, `SVP ${func}`, `Senior Vice President ${func}`],
    'head': [`VP of ${func}`, `VP ${func}`, `SVP ${func}`],
    'vp': [`SVP ${func}`, `Senior Vice President ${func}`, `EVP ${func}`, ...csuiteTitles],
    'svp': [...csuiteTitles, 'CEO', 'President'],
    'csuite': ['CEO', 'President', 'Founder'],
    'ceo': ['Chairman', 'Board Member'],
  };

  if (func === 'General') {
    return ['CEO', 'COO', 'President', 'Managing Director'];
  }
  return levelMap[level] || [`VP of ${func}`, `Director ${func}`, `Head of ${func}`];
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
  return levelMap[level] || ['CEO', 'President', 'COO'];
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

function extractNameFromUrl(url) {
  let slug = '';
  if (url.includes('linkedin.com/in/')) slug = url.split('linkedin.com/in/')[1];
  else if (url.includes('linkedin.com/pub/')) slug = url.split('linkedin.com/pub/')[1];
  if (!slug) return '';
  const parts = slug.split('/')[0].split('-').filter(p => p.length > 0 && !/^\d+$/.test(p));
  if (parts.length < 2) return '';
  return parts.slice(0, 3).map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
}

// ── Company name variations ──

function getCompanyVariations(company) {
  const variations = [company];
  const known = {
    'RTX': ['Raytheon', 'RTX Corporation'],
    'Meta': ['Facebook', 'Meta Platforms'],
    'Alphabet': ['Google'], 'Google': ['Alphabet'],
    'Amazon': ['AWS', 'Amazon Web Services'], 'AWS': ['Amazon'],
    'Microsoft': ['MSFT'],
    'JPMorgan': ['JP Morgan', 'JPMorgan Chase', 'Chase'],
    'Goldman Sachs': ['Goldman'],
    'McKinsey': ['McKinsey & Company'],
    'BCG': ['Boston Consulting Group'],
    'Salesforce': ['Salesforce.com'],
    'CrowdStrike': ['Crowdstrike'],
    'Palo Alto Networks': ['Palo Alto'],
  };
  const upper = company.toUpperCase();
  for (const [key, aliases] of Object.entries(known)) {
    if (key.toUpperCase() === upper) { variations.push(...aliases); break; }
  }
  const firstWord = company.split(/\s+/)[0];
  if (firstWord !== company && firstWord.length > 3) variations.push(firstWord);
  return [...new Set(variations)];
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
  try {
    const query = `site:linkedin.com/company "${companyName}"`;
    console.log('Company slug lookup:', query);
    const params = new URLSearchParams({ q: query, count: '3', text_decorations: 'false', search_lang: 'en' });
    const response = await fetch(
      `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
      { headers: { 'Accept': 'application/json', 'X-Subscription-Token': braveKey } }
    );
    if (!response.ok) return slugifyCompany(companyName);
    const data = await response.json();
    const results = (data.web && data.web.results) || [];
    for (const r of results) {
      const match = (r.url || '').match(/linkedin\.com\/company\/([^\/\?]+)/);
      if (match) {
        console.log('Found LinkedIn slug:', match[1]);
        return match[1];
      }
    }
  } catch (e) {
    console.error('Slug lookup failed:', e.message);
  }
  return slugifyCompany(companyName);
}

function slugifyCompany(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── LinkedIn geo URN map ──
const LINKEDIN_GEO_URNS = {
  'austin': '103743442', 'new york': '105080838', 'san francisco': '102277331',
  'los angeles': '102448103', 'chicago': '103112676', 'seattle': '102885535',
  'boston': '102380872', 'denver': '105763813', 'atlanta': '103996544',
  'dallas': '103544739', 'houston': '106929867', 'miami': '102918819',
  'washington': '103644278', 'washington dc': '103644278', 'portland': '101978430',
  'san diego': '106091299', 'phoenix': '102712797', 'minneapolis': '105044203',
  'nashville': '102033146', 'charlotte': '103068493', 'philadelphia': '102437668',
  'salt lake city': '106051040', 'detroit': '102380645', 'san jose': '106204433',
  'columbus': '101716677', 'indianapolis': '103017440', 'raleigh': '102459580',
  'tampa': '101654608', 'orlando': '103363856', 'pittsburgh': '101413020',
  'san antonio': '102463825', 'jacksonville': '102676224', 'sacramento': '100906991',
  'las vegas': '102277788', 'kansas city': '103440085', 'richmond': '104378955',
  'st louis': '103752558', 'milwaukee': '101871398', 'baltimore': '103338958',
  'cleveland': '102009786', 'boise': '104076313',
};

function getGeoUrn(location) {
  if (!location) return null;
  const loc = location.toLowerCase().replace(/,.*$/, '').trim();
  return LINKEDIN_GEO_URNS[loc] || null;
}
