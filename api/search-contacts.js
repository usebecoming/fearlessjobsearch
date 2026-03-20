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
      const company = job.company;
      const department = extractDepartment(job.title);

      // Search 1: People at this company in this department (leadership)
      const deptQuery = `site:linkedin.com/in "${company}" "${department}" (VP OR Director OR Head OR SVP OR Chief)`;
      console.log('Brave query 1:', deptQuery);
      const deptResults = await braveSearch(deptQuery, braveKey);
      console.log('Brave results 1:', deptResults.length, 'contacts');
      contacts.push(...deptResults);

      // Search 2: Recruiters at this company
      const recQuery = `site:linkedin.com/in "${company}" (recruiter OR "talent acquisition" OR "talent partner" OR "people partner")`;
      console.log('Brave query 2:', recQuery);
      const recResults = await braveSearch(recQuery, braveKey);
      console.log('Brave results 2:', recResults.length, 'contacts');
      contacts.push(...recResults);

      // Search 3: C-suite at this company
      const csuiteQuery = `site:linkedin.com/in "${company}" (CEO OR COO OR "Chief" OR President OR "General Manager")`;
      console.log('Brave query 3:', csuiteQuery);
      const csuiteResults = await braveSearch(csuiteQuery, braveKey);
      console.log('Brave results 3:', csuiteResults.length, 'contacts');
      contacts.push(...csuiteResults);

      const dedupedContacts = dedupeContacts(contacts).slice(0, 12);
      console.log('Total contacts for', company, ':', dedupedContacts.length);
      console.log('Contact URLs:', dedupedContacts.map(c => c.linkedin));

      results.push({
        job_id: job.job_id,
        company: job.company,
        job_title: job.title,
        raw_contacts: dedupedContacts
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
    const webResults = (data.web && data.web.results) || [];

    return webResults
      .filter(r => r.url && r.url.includes('linkedin.com/in/'))
      .map(r => ({
        name: extractNameFromResult(r.title, r.url),
        snippet: (r.description || r.title || '').substring(0, 300),
        linkedin: r.url,
        pageTitle: r.title || ''
      }))
      .filter(r => r.name && r.name.length > 2);
  } catch (err) {
    console.error('Brave search request failed:', err);
    return [];
  }
}

function extractNameFromResult(title, url) {
  // Try from URL slug first (most reliable)
  const slug = url.split('linkedin.com/in/')[1];
  if (slug) {
    const cleanSlug = slug.split('?')[0].replace(/\/$/, '');
    const parts = cleanSlug.split('-').filter(p => p.length > 0 && !/^\d+$/.test(p));
    if (parts.length >= 2) {
      return parts.slice(0, 3).map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
    }
  }

  // Fallback: from page title
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
  if (title.includes('growth')) return 'Growth';
  if (title.includes('revenue')) return 'Revenue';
  if (title.includes('customer')) return 'Customer';
  return '';
}

function dedupeContacts(contacts) {
  const seen = new Set();
  return contacts.filter(c => {
    const key = c.linkedin.toLowerCase().split('?')[0].replace(/\/$/, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
