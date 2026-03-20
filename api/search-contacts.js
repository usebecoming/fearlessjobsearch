export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
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
      console.log('Derived hiring manager titles:', derived.hiringManager);
      console.log('Derived skip-level titles:', derived.skipLevel);

      const allContacts = [];

      // Step 2: Run Brave searches
      // Search 1: Hiring managers (one level above)
      const hmQuery = `site:linkedin.com/in "${company}" (${derived.hiringManager.map(t => `"${t}"`).join(' OR ')})`;
      console.log('Query 1 (Hiring Manager):', hmQuery);
      const hmResults = await braveSearch(hmQuery, braveKey);
      console.log(`Query 1 results: ${hmResults.length} LinkedIn profiles found`);
      allContacts.push(...hmResults.map(r => ({ ...r, searchRole: 'Hiring Manager' })));

      // If few results, try shorter company name
      if (hmResults.length < 3) {
        const shortCompany = company.split(/\s+/)[0];
        if (shortCompany !== company) {
          const hmQuery2 = `site:linkedin.com/in "${shortCompany}" (${derived.hiringManager.map(t => `"${t}"`).join(' OR ')})`;
          console.log('Query 1b (retry shorter company):', hmQuery2);
          const hmResults2 = await braveSearch(hmQuery2, braveKey);
          console.log(`Query 1b results: ${hmResults2.length} LinkedIn profiles found`);
          allContacts.push(...hmResults2.map(r => ({ ...r, searchRole: 'Hiring Manager' })));
        }
      }

      // Search 2: Recruiters
      const recQuery = `site:linkedin.com/in "${company}" (recruiter OR "talent acquisition" OR "senior recruiter" OR "recruiting manager" OR "talent partner")`;
      console.log('Query 2 (Recruiter):', recQuery);
      const recResults = await braveSearch(recQuery, braveKey);
      console.log(`Query 2 results: ${recResults.length} LinkedIn profiles found`);
      allContacts.push(...recResults.map(r => ({ ...r, searchRole: 'Recruiter / TA' })));

      // Search 3: Skip-level (two levels above)
      const slQuery = `site:linkedin.com/in "${company}" (${derived.skipLevel.map(t => `"${t}"`).join(' OR ')})`;
      console.log('Query 3 (Skip-Level):', slQuery);
      const slResults = await braveSearch(slQuery, braveKey);
      console.log(`Query 3 results: ${slResults.length} LinkedIn profiles found`);
      allContacts.push(...slResults.map(r => ({ ...r, searchRole: 'Skip-Level' })));

      // Dedupe and limit
      const deduped = dedupeContacts(allContacts);
      console.log(`Total deduped contacts for ${company}: ${deduped.length}`);
      console.log('Contact URLs:', deduped.map(c => c.linkedin_url));

      results.push({
        job_id: job.job_id,
        company: company,
        job_title: jobTitle,
        location: job.location || '',
        derived_titles: derived,
        raw_contacts: deduped.slice(0, 15)
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
      console.error('Brave API error:', response.status, response.statusText);
      return [];
    }

    const data = await response.json();
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
