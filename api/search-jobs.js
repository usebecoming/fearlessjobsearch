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

    // Build search query from titles
    const query = titles.join(' OR ');
    const location = (locations && locations.length > 0)
      ? locations.filter(l => l.toLowerCase() !== 'remote').join(', ')
      : '';
    const isRemote = locations && locations.some(l => l.toLowerCase() === 'remote');

    // Build JSearch params
    const params = new URLSearchParams({
      query: query + (location ? ` in ${location}` : ''),
      page: '1',
      num_pages: '1',
      date_posted: 'week',
      employment_types: 'FULLTIME',
    });

    if (isRemote) {
      params.set('remote_jobs_only', 'true');
    }

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

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('JSearch API error:', err);
      return res.status(response.status).json({
        error: err.message || `Job search API error ${response.status}`
      });
    }

    const data = await response.json();
    const jobs = (data.data || []).slice(0, 15);

    // Filter out staffing agencies and map to our format
    const agencyKeywords = ['staffing', 'recruiting', 'talent agency', 'manpower', 'adecco', 'randstad', 'robert half', 'hays', 'kforce'];

    const filtered = jobs
      .filter(job => {
        const employer = (job.employer_name || '').toLowerCase();
        return !agencyKeywords.some(kw => employer.includes(kw));
      })
      .map((job, i) => ({
        id: job.job_id || `jsearch-${i}`,
        title: job.job_title || 'Untitled',
        company: job.employer_name || 'Unknown',
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
      }));

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
