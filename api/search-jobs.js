import { rateLimit } from './_rateLimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rl = rateLimit(req, { maxRequests: 5, windowMs: 60000 });
  if (!rl.allowed) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
  }

  const rapidApiKey = process.env.RAPIDAPI_KEY;
  if (!rapidApiKey) {
    return res.status(500).json({ error: 'Job search API not configured' });
  }

  try {
    const { titles, locations, workTypes } = req.body;

    if (!titles || !Array.isArray(titles) || titles.length === 0) {
      return res.status(400).json({ error: 'At least one job title is required' });
    }

    const physicalLocations = (locations && locations.length > 0)
      ? locations.filter(l => l.toLowerCase() !== 'remote')
      : [];
    const isRemote = locations && locations.some(l => l.toLowerCase() === 'remote');

    // Build search combinations: each title x each location
    // If no physical locations, search without location filter
    const locationQueries = physicalLocations.length > 0 ? physicalLocations : [''];
    // If remote is selected and there are also physical locations, add a remote-only search too
    if (isRemote && physicalLocations.length > 0) locationQueries.push('__remote__');

    // Expand title abbreviations so one input searches multiple variations
    const expandedTitles = [];
    const seen = new Set();
    for (const title of titles) {
      const variations = expandTitle(title);
      for (const v of variations) {
        const key = v.toLowerCase();
        if (!seen.has(key)) { seen.add(key); expandedTitles.push(v); }
      }
    }
    console.log('Expanded titles:', expandedTitles);

    const allJobs = [];
    const seenJobIds = new Set();

    for (const title of expandedTitles) {
      for (const loc of locationQueries) {
        const isRemoteQuery = loc === '__remote__';
        const locationStr = isRemoteQuery ? '' : loc;

        const params = new URLSearchParams({
          query: title + (locationStr ? ` in ${locationStr}` : ''),
          page: '1',
          num_pages: '1',
          date_posted: 'week',
          employment_types: 'FULLTIME',
        });

        if (isRemote && !locationStr) {
          params.set('remote_jobs_only', 'true');
        }
        if (isRemoteQuery) {
          params.set('remote_jobs_only', 'true');
        }

        console.log('JSearch query:', title, locationStr ? `in ${locationStr}` : '', (isRemote && !locationStr) || isRemoteQuery ? '(remote)' : '');

      try {
        const response = await fetch(
          `https://jsearch.p.rapidapi.com/search?${params.toString()}`,
          {
            method: 'GET',
            headers: {
              'X-RapidAPI-Key': rapidApiKey,
              'X-RapidAPI-Host': 'jsearch.p.rapidapi.com'
            }
          }
        );

        if (response.ok) {
          const data = await response.json();
          const results = data.data || [];
          console.log(`JSearch results for "${title}": ${results.length}`);
          for (const job of results) {
            const jid = job.job_id || '';
            if (!seenJobIds.has(jid)) {
              seenJobIds.add(jid);
              allJobs.push(job);
            }
          }
        } else {
          console.error('JSearch error for', title, ':', response.status);
        }
      } catch (e) {
        console.error('JSearch fetch error for', title, ':', e.message);
      }
      }
    }

    console.log(`Total unique jobs across ${titles.length} title(s) x ${locationQueries.length} location(s): ${allJobs.length}`);
    const jobs = allJobs.slice(0, 15);

    // Flag staffing agencies instead of filtering them out
    const agencyKeywords = ['staffing', 'recruiting', 'talent agency', 'manpower', 'adecco', 'randstad', 'robert half', 'hays', 'kforce', 'kelly services', 'allegis', 'insight global', 'korn ferry', 'heidrick', 'aerotek', 'tek systems', 'teksystems', 'beacon hill', 'apex group', 'modis', 'volt', 'spherion', 'express employment', 'nesco', 'addison group', 'brooksource', 'procom', 'collabera', 'cybercoders', 'dice', 'jobspring', 'placement', 'search group', 'executive search', 'talent solutions', 'recruiting group'];

    const filtered = jobs
      .map((job, i) => {
        const employer = (job.employer_name || '').toLowerCase();
        const isAgency = agencyKeywords.some(kw => employer.includes(kw));
        return {
        id: job.job_id || `jsearch-${i}`,
        title: job.job_title || 'Untitled',
        company: job.employer_name || 'Unknown',
        isAgency,
        location: job.job_city && job.job_state
          ? `${job.job_city}, ${job.job_state}`
          : (job.job_is_remote ? 'Remote' : 'Location not specified'),
        type: job.job_employment_type || 'Full-time',
        industry: job.employer_company_type || '',
        posted: formatPostedDate(job.job_posted_at_datetime_utc),
        salary: formatSalary(job.job_min_salary, job.job_max_salary, job.job_salary_currency, job.job_salary_period),
        source: getSource(job.job_apply_link),
        url: job.job_apply_link || '',
        description: (job.job_description || '').substring(0, 800),
        highlights: extractHighlights(job),
        // These will be filled by Claude
        fitScore: 0,
        fitReason: ''
      };
      });

    return res.status(200).json({ jobs: filtered.slice(0, 10) });
  } catch (err) {
    console.error('Search error:', err);
    return res.status(500).json({ error: 'Something went wrong searching for jobs. Please try again.' });
  }
}

function formatPostedDate(dateStr) {
  if (!dateStr) return 'Recently';
  const posted = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.floor((now - posted) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return '1 day ago';
  if (diffDays <= 7) return `${diffDays} days ago`;
  return `${Math.floor(diffDays / 7)} week${diffDays >= 14 ? 's' : ''} ago`;
}

function formatSalary(min, max, currency, period) {
  if (!min && !max) return null;
  const fmt = n => {
    if (n >= 1000) return `$${Math.round(n / 1000)}K`;
    return `$${n}`;
  };
  if (min && max) return `${fmt(min)} - ${fmt(max)}`;
  if (min) return `${fmt(min)}+`;
  if (max) return `Up to ${fmt(max)}`;
  return null;
}

function getSource(applyLink) {
  if (!applyLink) return 'Direct';
  if (applyLink.includes('linkedin.com')) return 'LinkedIn';
  if (applyLink.includes('indeed.com')) return 'Indeed';
  if (applyLink.includes('glassdoor.com')) return 'Glassdoor';
  if (applyLink.includes('ziprecruiter.com')) return 'ZipRecruiter';
  return 'Direct';
}

function extractHighlights(job) {
  const highlights = [];
  if (job.job_is_remote) highlights.push('Remote');
  if (job.job_employment_type) highlights.push(job.job_employment_type);
  if (job.employer_company_type) highlights.push(job.employer_company_type);
  if (job.job_required_experience && job.job_required_experience.required_experience_in_months) {
    const years = Math.round(job.job_required_experience.required_experience_in_months / 12);
    if (years > 0) highlights.push(`${years}+ years`);
  }
  return highlights.slice(0, 3);
}

// Expand title abbreviations into search variations
function expandTitle(title) {
  const variations = [title];
  const t = title.toLowerCase();

  // VP <-> Vice President
  if (t.startsWith('vp ') || t.startsWith('vp of ')) {
    variations.push(title.replace(/^vp\b/i, 'Vice President'));
  } else if (t.includes('vice president')) {
    variations.push(title.replace(/vice president/i, 'VP'));
  }

  // SVP <-> Senior Vice President
  if (t.startsWith('svp ') || t.startsWith('svp of ')) {
    variations.push(title.replace(/^svp\b/i, 'Senior Vice President'));
  } else if (t.includes('senior vice president')) {
    variations.push(title.replace(/senior vice president/i, 'SVP'));
  }

  // EVP <-> Executive Vice President
  if (t.startsWith('evp ') || t.startsWith('evp of ')) {
    variations.push(title.replace(/^evp\b/i, 'Executive Vice President'));
  } else if (t.includes('executive vice president')) {
    variations.push(title.replace(/executive vice president/i, 'EVP'));
  }

  // Director <-> Dir
  if (t.startsWith('dir ') || t.startsWith('dir of ')) {
    variations.push(title.replace(/^dir\b/i, 'Director'));
  }

  // Head of <-> VP of (adjacent level, worth searching)
  if (t.startsWith('head of ')) {
    variations.push(title.replace(/^head of/i, 'VP of'));
    variations.push(title.replace(/^head of/i, 'Director of'));
  }

  // Chief X Officer <-> CXO
  const cxoMap = {
    'cmo': 'Chief Marketing Officer',
    'cto': 'Chief Technology Officer',
    'cfo': 'Chief Financial Officer',
    'coo': 'Chief Operating Officer',
    'cpo': 'Chief Product Officer',
    'cro': 'Chief Revenue Officer',
    'chro': 'Chief Human Resources Officer',
    'cio': 'Chief Information Officer',
  };
  if (cxoMap[t]) {
    variations.push(cxoMap[t]);
  }
  for (const [abbr, full] of Object.entries(cxoMap)) {
    if (t === full.toLowerCase()) {
      variations.push(abbr.toUpperCase());
    }
  }

  return variations;
}
