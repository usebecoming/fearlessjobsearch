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
      const contacts = [];

      // Claude determines the right titles to search for based on the job
      // But we do the Brave searches here with smart queries
      const company = job.company;
      const title = job.title;
      const department = extractDepartment(title);

      // 1. Hiring Manager - one level above the role
      const hmTitles = getHiringManagerTitles(title);
      const hmQuery = `site:linkedin.com/in "${company}" ${hmTitles.map(t => `"${t}"`).join(' OR ')}`;
      const hmResults = await braveSearch(hmQuery, braveKey);
      contacts.push(...hmResults.map(r => ({ ...r, searchRole: 'Hiring Manager' })));

      // 2. Skip-Level - two levels above or C-suite
      const slTitles = getSkipLevelTitles(title, department);
      const slQuery = `site:linkedin.com/in "${company}" ${slTitles.map(t => `"${t}"`).join(' OR ')}`;
      const slResults = await braveSearch(slQuery, braveKey);
      contacts.push(...slResults.map(r => ({ ...r, searchRole: 'Skip-Level' })));

      // 3. Recruiter / TA
      const recQuery = `site:linkedin.com/in "${company}" recruiter OR "talent acquisition" OR "talent partner"`;
      const recResults = await braveSearch(recQuery, braveKey);
      contacts.push(...recResults.map(r => ({ ...r, searchRole: 'Recruiter / TA' })));

      results.push({
        job_id: job.job_id,
        company: job.company,
        job_title: job.title,
        contacts: dedupeContacts(contacts).slice(0, 6)
      });
    }

    return res.status(200).json({ results });
  } catch (err) {
    console.error('Contact search error:', err);
    return res.status(500).json({ error: 'Something went wrong searching for contacts. Please try again.' });
  }
}

async function braveSearch(query, apiKey) {
  try {
    const params = new URLSearchParams({
      q: query,
      count: '5',
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
      console.error('Brave search error:', response.status);
      return [];
    }

    const data = await response.json();
    const results = (data.web && data.web.results) || [];

    return results
      .filter(r => r.url && r.url.includes('linkedin.com/in/'))
      .map(r => {
        const name = extractNameFromLinkedIn(r.title, r.url);
        const title = extractTitleFromSnippet(r.description || r.title);
        return {
          name: name,
          title: title,
          linkedin: r.url.replace(/^https?:\/\//, '').replace(/\/$/, ''),
          linkedinUrl: r.url,
          snippet: (r.description || '').substring(0, 200)
        };
      })
      .filter(r => r.name && r.name.length > 2);
  } catch (err) {
    console.error('Brave search request failed:', err);
    return [];
  }
}

function extractNameFromLinkedIn(title, url) {
  // Try to get name from the LinkedIn URL slug
  const slug = url.split('linkedin.com/in/')[1];
  if (slug) {
    const cleanSlug = slug.split('?')[0].replace(/\/$/, '');
    const parts = cleanSlug.split('-').filter(p => p.length > 0 && !/^\d+$/.test(p));
    if (parts.length >= 2) {
      return parts.slice(0, 3).map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
    }
  }

  // Fallback: try to get from the page title
  if (title) {
    const cleaned = title
      .replace(/\s*[-|].*linkedin.*/i, '')
      .replace(/\s*\|.*$/i, '')
      .replace(/linkedin/i, '')
      .trim();
    if (cleaned.length > 2 && cleaned.length < 60) {
      return cleaned.split(' ').slice(0, 3).join(' ');
    }
  }

  return '';
}

function extractTitleFromSnippet(snippet) {
  if (!snippet) return '';
  // Common patterns in LinkedIn snippets
  const patterns = [
    /(?:^|\s)([A-Z][^.]*?)\s+at\s+/i,
    /(?:^|\s)([A-Z][^.]*?)\s+[-|]\s+/i,
    /(?:Title|Role|Position):\s*([^.]+)/i,
  ];
  for (const pattern of patterns) {
    const match = snippet.match(pattern);
    if (match && match[1] && match[1].length < 80) {
      return match[1].trim();
    }
  }
  return snippet.substring(0, 80);
}

function extractDepartment(jobTitle) {
  const title = jobTitle.toLowerCase();
  if (title.includes('marketing')) return 'Marketing';
  if (title.includes('product')) return 'Product';
  if (title.includes('engineering') || title.includes('software')) return 'Engineering';
  if (title.includes('sales')) return 'Sales';
  if (title.includes('finance') || title.includes('cfo')) return 'Finance';
  if (title.includes('operations') || title.includes('coo')) return 'Operations';
  if (title.includes('people') || title.includes('hr') || title.includes('human')) return 'People';
  if (title.includes('data') || title.includes('analytics')) return 'Data';
  if (title.includes('design')) return 'Design';
  if (title.includes('legal')) return 'Legal';
  if (title.includes('strategy')) return 'Strategy';
  return 'Leadership';
}

function getHiringManagerTitles(jobTitle) {
  const title = jobTitle.toLowerCase();
  // Map job level to one level up
  if (title.includes('director')) {
    const dept = extractDepartment(jobTitle);
    return [`VP of ${dept}`, `VP ${dept}`, `SVP ${dept}`, `Head of ${dept}`];
  }
  if (title.includes('vp') || title.includes('vice president')) {
    const dept = extractDepartment(jobTitle);
    return [`SVP ${dept}`, `Chief ${dept.charAt(0)}O`, `EVP ${dept}`, `C-level ${dept}`];
  }
  if (title.includes('head of')) {
    const dept = extractDepartment(jobTitle);
    return [`VP of ${dept}`, `VP ${dept}`, `SVP ${dept}`];
  }
  if (title.includes('svp') || title.includes('senior vice president')) {
    const dept = extractDepartment(jobTitle);
    return [`Chief`, `CEO`, `COO`, `President`];
  }
  if (title.includes('chief') || title.includes('cmo') || title.includes('cto') || title.includes('cpo') || title.includes('cro')) {
    return [`CEO`, `President`, `COO`, `Founder`];
  }
  if (title.includes('manager')) {
    const dept = extractDepartment(jobTitle);
    return [`Director of ${dept}`, `Director ${dept}`, `Head of ${dept}`, `VP ${dept}`];
  }
  // Default: search one level up
  const dept = extractDepartment(jobTitle);
  return [`VP ${dept}`, `Director ${dept}`, `Head of ${dept}`];
}

function getSkipLevelTitles(jobTitle, department) {
  const title = jobTitle.toLowerCase();
  if (title.includes('director') || title.includes('head of')) {
    return [`SVP`, `Chief`, `CMO`, `CTO`, `CPO`, `CRO`, `COO`];
  }
  if (title.includes('vp') || title.includes('vice president')) {
    return [`CEO`, `President`, `Founder`, `COO`];
  }
  if (title.includes('manager')) {
    return [`VP ${department}`, `SVP ${department}`, `Chief`];
  }
  return [`CEO`, `President`, `COO`, `Founder`];
}

function dedupeContacts(contacts) {
  const seen = new Set();
  return contacts.filter(c => {
    const key = c.linkedin.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
