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
      console.log(`\n=== SEARCHING CONTACTS FOR: ${jobTitle} at ${company} ===`);

      // Step 1: Derive correct titles
      const derived = deriveTitles(jobTitle);
      const dept = derived.department;
      console.log('Department:', dept);
      console.log('Derived hiring manager titles:', derived.hiringManager);
      console.log('Derived skip-level titles:', derived.skipLevel);

      // Get company name variations for retry
      const companyNames = getCompanyVariations(company);
      console.log('Company variations:', companyNames);

      const allContacts = [];

      // Skip if no company name
      if (!company || company === 'Unknown' || company.length < 2) {
        console.log('Skipping: no valid company name');
        results.push({ job_id: job.job_id, company, job_title: jobTitle, location: job.location || '', derived_titles: derived, raw_contacts: [] });
        continue;
      }

      // Helper: run query with company name fallbacks
      async function searchWithFallback(queryBuilder, role) {
        for (const coName of companyNames) {
          const query = queryBuilder(coName);
          console.log(`  Query [${role}] with "${coName}":`, query);
          const r = await braveSearch(query, braveKey);
          console.log(`  Results: ${r.length} profiles`);
          allContacts.push(...r.map(c => ({ ...c, searchRole: role })));
          if (r.length >= 3) break;
        }
      }

      // Query 1: Hiring managers - use derived titles loosely (no exact quotes on multi-word)
      const hmKeywords = derived.hiringManager.map(t => t.length > 15 ? t.split(' ').slice(0, 2).join(' ') : t);
      await searchWithFallback(
        co => `site:linkedin.com/in "${co}" ${hmKeywords.map(t => `"${t}"`).join(' OR ')}`,
        'Hiring Manager'
      );

      // Query 2: Broader hiring manager - just department + leadership level
      await searchWithFallback(
        co => `site:linkedin.com/in "${co}" ${dept} VP OR Director OR Head OR SVP OR Chief`,
        'Hiring Manager'
      );

      // Query 3: Recruiters - keep it simple, just recruiter at company
      await searchWithFallback(
        co => `site:linkedin.com/in "${co}" recruiter OR "talent acquisition" OR "talent partner" OR "people partner"`,
        'Recruiter / TA'
      );

      // Query 4: Skip-level - C-suite and top leadership
      await searchWithFallback(
        co => `site:linkedin.com/in "${co}" CEO OR COO OR CTO OR CMO OR CPO OR CRO OR President OR "Chief"`,
        'Skip-Level'
      );

      // Query 5: If still few results, try without site:linkedin filter (finds LinkedIn profiles indexed elsewhere)
      if (allContacts.length < 5) {
        console.log('  Few results, trying broader search...');
        await searchWithFallback(
          co => `linkedin.com/in "${co}" ${dept} VP OR Director OR recruiter`,
          'Hiring Manager'
        );
      }

      // Dedupe and limit
      const deduped = dedupeContacts(allContacts);
      console.log(`Total deduped contacts for ${company}: ${deduped.length}`);
      console.log('Contact URLs:', deduped.map(c => c.linkedin_url));

      // Try Apollo as fallback if Brave found very few
      const apolloKey = process.env.APOLLO_API_KEY;
      if (deduped.length < 3 && apolloKey) {
        console.log('Few Brave results, trying Apollo fallback...');
        const apolloContacts = await apolloSearch(company, derived, dept, apolloKey);
        console.log(`Apollo returned: ${apolloContacts.length} contacts`);
        allContacts.push(...apolloContacts);
      }

      const finalContacts = dedupeContacts(allContacts);

      results.push({
        job_id: job.job_id,
        company: company,
        job_title: jobTitle,
        location: job.location || '',
        derived_titles: derived,
        raw_contacts: finalContacts.slice(0, 20)
      });
    }

    console.log(`\n=== TOTAL: ${results.reduce((s, r) => s + r.raw_contacts.length, 0)} contacts across ${results.length} jobs ===`);
    return res.status(200).json({ results });
  } catch (err) {
    console.error('Contact search error:', err);
    return res.status(500).json({ error: 'Something went wrong searching for contacts. Please try again.' });
  }
}

// Step 1: Derive hiring manager and skip-level titles from job title
function deriveTitles(jobTitle) {
  const title = jobTitle.toLowerCase();
  const dept = extractDepartment(jobTitle);
  const deptShort = getDeptAbbrev(dept);

  // Hierarchy: Coordinator → Manager → Director → VP → SVP/EVP → C-Suite → CEO
  let hiringManager = [];
  let skipLevel = [];

  if (title.includes('coordinator') || title.includes('specialist') || title.includes('analyst')) {
    hiringManager = [`Manager of ${dept}`, `${dept} Manager`, `Senior Manager ${dept}`];
    skipLevel = [`Director of ${dept}`, `Director ${dept}`, `Head of ${dept}`];
  } else if (title.includes('manager') && !title.includes('senior manager') && !title.includes('general manager')) {
    hiringManager = [`Director of ${dept}`, `Director ${dept}`, `Head of ${dept}`, `Senior Director ${dept}`];
    skipLevel = [`VP of ${dept}`, `VP ${dept}`, `Vice President ${dept}`];
  } else if (title.includes('senior manager') || title.includes('associate director')) {
    hiringManager = [`Director of ${dept}`, `Senior Director ${dept}`, `Head of ${dept}`];
    skipLevel = [`VP of ${dept}`, `VP ${dept}`, `SVP ${dept}`];
  } else if (title.includes('director') && !title.includes('senior director') && !title.includes('executive director')) {
    hiringManager = [`VP of ${dept}`, `VP ${dept}`, `Vice President ${dept}`, `Head of ${dept}`];
    skipLevel = [`SVP ${dept}`, `Senior Vice President`, deptShort ? `C${deptShort}O` : 'COO', 'Chief'];
  } else if (title.includes('senior director') || title.includes('executive director')) {
    hiringManager = [`VP of ${dept}`, `SVP ${dept}`, `Senior Vice President ${dept}`];
    skipLevel = [deptShort ? `C${deptShort}O` : 'COO', 'CEO', 'President'];
  } else if (title.includes('head of')) {
    hiringManager = [`VP of ${dept}`, `VP ${dept}`, `SVP ${dept}`];
    skipLevel = [deptShort ? `C${deptShort}O` : 'COO', 'CEO', 'President'];
  } else if (title.includes('vp') || title.includes('vice president')) {
    hiringManager = [`SVP ${dept}`, `Senior Vice President ${dept}`, `EVP ${dept}`, deptShort ? `C${deptShort}O` : `Chief ${dept} Officer`];
    skipLevel = ['CEO', 'President', 'COO', 'Founder'];
  } else if (title.includes('svp') || title.includes('senior vice president') || title.includes('evp')) {
    hiringManager = [deptShort ? `C${deptShort}O` : `Chief ${dept} Officer`, 'CEO', 'President'];
    skipLevel = ['CEO', 'President', 'Chairman', 'Founder'];
  } else if (title.includes('chief') || title.includes('cmo') || title.includes('cto') || title.includes('cpo') || title.includes('cfo') || title.includes('cro') || title.includes('coo')) {
    hiringManager = ['CEO', 'President', 'Founder', 'Managing Director'];
    skipLevel = ['Chairman', 'Board', 'Founder'];
  } else if (title.includes('ceo') || title.includes('president') || title.includes('founder')) {
    hiringManager = ['Chairman', 'Board Member', 'Founder'];
    skipLevel = ['Board Member', 'Investor'];
  } else {
    // Default: treat as mid-level
    hiringManager = [`Director of ${dept}`, `VP ${dept}`, `Head of ${dept}`];
    skipLevel = [`SVP ${dept}`, 'COO', 'CEO'];
  }

  return { hiringManager, skipLevel, department: dept };
}

function extractDepartment(jobTitle) {
  const title = jobTitle.toLowerCase();
  const deptMap = [
    [['marketing', 'brand', 'growth', 'demand gen'], 'Marketing'],
    [['product'], 'Product'],
    [['engineering', 'software', 'development', 'technical', 'technology'], 'Engineering'],
    [['sales', 'business development', 'account'], 'Sales'],
    [['finance', 'accounting', 'controller'], 'Finance'],
    [['operations', 'supply chain', 'logistics'], 'Operations'],
    [['people', 'hr', 'human resources', 'talent'], 'People'],
    [['data', 'analytics', 'insights', 'intelligence'], 'Data'],
    [['design', 'creative', 'ux', 'ui'], 'Design'],
    [['legal', 'compliance', 'regulatory'], 'Legal'],
    [['strategy', 'planning', 'transformation'], 'Strategy'],
    [['revenue', 'commercial'], 'Revenue'],
    [['customer', 'client', 'success', 'support'], 'Customer Success'],
    [['content', 'communications', 'pr', 'editorial'], 'Communications'],
    [['partnerships', 'alliances', 'channels'], 'Partnerships'],
    [['security', 'information security', 'infosec'], 'Security'],
  ];
  for (const [keywords, dept] of deptMap) {
    if (keywords.some(k => title.includes(k))) return dept;
  }
  return 'Operations';
}

function getDeptAbbrev(dept) {
  const map = {
    'Marketing': 'M', 'Product': 'P', 'Engineering': 'T',
    'Finance': 'F', 'Operations': 'O', 'People': 'H',
    'Revenue': 'R', 'Data': 'D', 'Security': 'IS',
    'Customer Success': 'C', 'Communications': 'C',
  };
  return map[dept] || '';
}

// Step 2: Brave Search with URL extraction (Step 3)
// Fetches two pages of 20 results each for ~40 total raw results
async function braveSearch(query, apiKey) {
  try {
    const allWebResults = [];

    // Page 1: results 0-19
    const params1 = new URLSearchParams({
      q: query,
      count: '20',
      offset: '0',
      text_decorations: 'false',
      search_lang: 'en'
    });
    const res1 = await fetch(
      `https://api.search.brave.com/res/v1/web/search?${params1.toString()}`,
      {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey
        }
      }
    );
    if (res1.ok) {
      const data1 = await res1.json();
      allWebResults.push(...((data1.web && data1.web.results) || []));
    } else {
      console.error('Brave API error page 1:', res1.status, res1.statusText);
    }

    // Page 2: results 20-39
    const params2 = new URLSearchParams({
      q: query,
      count: '20',
      offset: '20',
      text_decorations: 'false',
      search_lang: 'en'
    });
    const res2 = await fetch(
      `https://api.search.brave.com/res/v1/web/search?${params2.toString()}`,
      {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey
        }
      }
    );
    if (res2.ok) {
      const data2 = await res2.json();
      allWebResults.push(...((data2.web && data2.web.results) || []));
    }

    console.log(`  Brave raw results: ${allWebResults.length} total web results (2 pages)`);
    const data = { web: { results: allWebResults } };
    const webResults = (data.web && data.web.results) || [];
    console.log(`  Brave raw results: ${webResults.length} total web results`);

    const contacts = [];
    for (const r of webResults) {
      const url = r.url || '';

      // Step 3: Extract and validate LinkedIn URL
      // Reject company pages and job listings
      if (url.includes('linkedin.com/company/')) continue;
      if (url.includes('linkedin.com/jobs/')) continue;
      if (url.includes('linkedin.com/pulse/')) continue;
      if (url.includes('linkedin.com/posts/')) continue;

      // Must be a profile page (/in/ or /pub/)
      if (!url.includes('linkedin.com/in/') && !url.includes('linkedin.com/pub/')) continue;

      // Clean the URL - strip query params and tracking
      let cleanUrl = url.split('?')[0].split('#')[0].replace(/\/+$/, '');
      if (!cleanUrl.startsWith('http')) cleanUrl = 'https://' + cleanUrl;

      // Extract name from URL slug
      const name = extractNameFromUrl(cleanUrl);
      if (!name || name.length < 3) continue;

      contacts.push({
        name: name,
        linkedin_url: cleanUrl,
        snippet: (r.description || r.title || '').substring(0, 400),
        page_title: (r.title || '').substring(0, 200)
      });
    }

    console.log(`  After URL filtering: ${contacts.length} valid LinkedIn profiles`);
    return contacts;
  } catch (err) {
    console.error('Brave search failed:', err.message);
    return [];
  }
}

function extractNameFromUrl(url) {
  let slug = '';
  if (url.includes('linkedin.com/in/')) {
    slug = url.split('linkedin.com/in/')[1];
  } else if (url.includes('linkedin.com/pub/')) {
    slug = url.split('linkedin.com/pub/')[1];
  }
  if (!slug) return '';

  const parts = slug.split('/')[0].split('-').filter(p => p.length > 0 && !/^\d+$/.test(p));
  if (parts.length < 2) return '';

  return parts.slice(0, 3).map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
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

// Company name variations for retry logic
function getCompanyVariations(company) {
  const variations = [company];
  const known = {
    'RTX': ['Raytheon', 'RTX Corporation'],
    'Meta': ['Facebook', 'Meta Platforms'],
    'Alphabet': ['Google'],
    'Google': ['Alphabet'],
    'Amazon': ['AWS', 'Amazon Web Services'],
    'AWS': ['Amazon', 'Amazon Web Services'],
    'Microsoft': ['MSFT'],
    'JPMorgan': ['JP Morgan', 'JPMorgan Chase', 'Chase'],
    'JP Morgan': ['JPMorgan', 'JPMorgan Chase'],
    'Goldman Sachs': ['Goldman'],
    'McKinsey': ['McKinsey & Company'],
    'BCG': ['Boston Consulting Group'],
    'Bain': ['Bain & Company'],
    'Deloitte': ['Deloitte Consulting'],
    'EY': ['Ernst & Young'],
    'PwC': ['PricewaterhouseCoopers'],
    'KPMG': ['KPMG US'],
    'Salesforce': ['Salesforce.com'],
    'CrowdStrike': ['Crowdstrike'],
    'Palo Alto Networks': ['Palo Alto'],
    'ServiceNow': ['Service Now'],
  };

  // Check known aliases
  const upper = company.toUpperCase();
  for (const [key, aliases] of Object.entries(known)) {
    if (key.toUpperCase() === upper) {
      variations.push(...aliases);
      break;
    }
  }

  // Also try first word if multi-word (e.g. "Live Nation" → "Live Nation", "Live")
  const firstWord = company.split(/\s+/)[0];
  if (firstWord !== company && firstWord.length > 3) {
    variations.push(firstWord);
  }

  return [...new Set(variations)];
}

// Apollo.io fallback search
async function apolloSearch(company, derived, dept, apiKey) {
  try {
    // Search for people at the company with relevant titles
    const titles = [...derived.hiringManager, ...derived.skipLevel, 'Recruiter', 'Talent Acquisition'];
    const response = await fetch('https://api.apollo.io/api/v1/mixed_people/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      },
      body: JSON.stringify({
        api_key: apiKey,
        q_organization_name: company,
        person_titles: titles.slice(0, 5),
        page: 1,
        per_page: 10
      })
    });

    if (!response.ok) {
      console.error('Apollo API error:', response.status);
      return [];
    }

    const data = await response.json();
    const people = data.people || [];

    return people
      .filter(p => p.linkedin_url && p.linkedin_url.includes('linkedin.com/in/'))
      .map(p => ({
        name: [p.first_name, p.last_name].filter(Boolean).join(' '),
        linkedin_url: p.linkedin_url.split('?')[0],
        snippet: `${p.title || ''} at ${p.organization?.name || company}`,
        page_title: `${p.first_name} ${p.last_name} - ${p.title || ''}`,
        searchRole: categorizeApolloRole(p.title, derived)
      }));
  } catch (err) {
    console.error('Apollo search failed:', err.message);
    return [];
  }
}

function categorizeApolloRole(title, derived) {
  if (!title) return 'Hiring Manager';
  const t = title.toLowerCase();
  if (t.includes('recruit') || t.includes('talent acq') || t.includes('talent partner')) return 'Recruiter / TA';
  if (t.includes('ceo') || t.includes('president') || t.includes('coo') || t.includes('chairman')) return 'Skip-Level';
  return 'Hiring Manager';
}
