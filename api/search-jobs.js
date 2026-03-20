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

    // Helper: run JSearch and collect results
    async function jsearchQuery(query, extraParams) {
      for (const page of [1, 2]) { // Pull page 1 and page 2
        const params = new URLSearchParams({
          query,
          page: String(page),
          num_pages: '1',
          date_posted: 'week',
          employment_types: 'FULLTIME',
          ...extraParams
        });
        try {
          const response = await fetch(
            `https://jsearch.p.rapidapi.com/search?${params.toString()}`,
            { headers: { 'X-RapidAPI-Key': rapidApiKey, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' } }
          );
          if (response.ok) {
            const data = await response.json();
            const results = data.data || [];
            if (page === 1) console.log(`  JSearch "${query.substring(0,50)}": ${results.length} results`);
            for (const job of results) {
              const jid = job.job_id || '';
              if (jid && !seenJobIds.has(jid)) { seenJobIds.add(jid); allJobs.push(job); }
            }
            if (results.length < 5) break; // No point fetching page 2
          }
        } catch (e) {
          console.error('JSearch error:', e.message);
        }
      }
    }

    // Run title-based searches
    const seniority = getSeniority(titles[0] || '');
    console.log('Seniority filter:', seniority || 'none');

    for (const title of expandedTitles) {
      for (const loc of locationQueries) {
        const isRemoteQuery = loc === '__remote__';
        const locationStr = isRemoteQuery ? '' : loc;
        const query = title + (locationStr ? ` in ${locationStr}` : '');
        const extra = {};
        if ((isRemote && !locationStr) || isRemoteQuery) extra.remote_jobs_only = 'true';
        if (seniority) extra.job_requirements = seniority;
        await jsearchQuery(query, extra);
      }
    }

    // Resume keyword search (additional query)
    const { resumeKeywords } = req.body;
    if (resumeKeywords && resumeKeywords.length > 10) {
      console.log('Resume keyword search:', resumeKeywords.substring(0, 60));
      for (const loc of locationQueries) {
        const isRemoteQuery = loc === '__remote__';
        const locationStr = isRemoteQuery ? '' : loc;
        const query = resumeKeywords + (locationStr ? ` in ${locationStr}` : '');
        const extra = {};
        if ((isRemote && !locationStr) || isRemoteQuery) extra.remote_jobs_only = 'true';
        await jsearchQuery(query, extra);
      }
    }

    console.log(`Total unique jobs: ${allJobs.length}`);

    // Dedupe by company+title combo (in addition to job ID dedup above)
    const seenCompanyTitle = new Set();
    const dedupedJobs = allJobs.filter(job => {
      const key = ((job.employer_name || '') + '|' + (job.job_title || '')).toLowerCase();
      if (seenCompanyTitle.has(key)) return false;
      seenCompanyTitle.add(key);
      return true;
    });
    console.log(`After company+title dedup: ${dedupedJobs.length}`);

    // Cap at 30 for Claude scoring, Claude returns top 10
    const jobs = dedupedJobs.slice(0, 30);

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

    return res.status(200).json({ jobs: filtered.slice(0, 30) });
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

// ── 1. Keyword synonyms by function ──
const FUNCTION_SYNONYMS = {
  'talent development': ['Learning & Development', 'L&D', 'Training and Development', 'Organizational Development', 'OD', 'People Development', 'Talent Management'],
  'hr': ['Human Resources', 'People Operations', 'People & Culture', 'Workforce'],
  'human resources': ['HR', 'People Operations', 'People & Culture'],
  'people operations': ['HR', 'Human Resources', 'People & Culture'],
  'growth': ['Demand Generation', 'Demand Gen', 'Performance Marketing', 'Revenue Marketing', 'Growth Marketing'],
  'demand gen': ['Growth', 'Demand Generation', 'Performance Marketing', 'Revenue Marketing'],
  'demand generation': ['Growth', 'Demand Gen', 'Performance Marketing'],
  'brand': ['Brand Marketing', 'Brand Strategy', 'Integrated Marketing', 'Creative'],
  'content': ['Content Strategy', 'Content Marketing', 'Editorial', 'Communications'],
  'product': ['Product Management', 'Product Strategy'],
  'product management': ['Product', 'Product Strategy'],
  'ux': ['User Experience', 'Product Design', 'UX Design'],
  'user experience': ['UX', 'Product Design', 'UX Design'],
  'engineering': ['Software Engineering', 'Software Development', 'Technology'],
  'software engineering': ['Engineering', 'Software Development', 'Technology'],
  'data': ['Data Science', 'Analytics', 'Business Intelligence', 'BI'],
  'data science': ['Data', 'Analytics', 'Business Intelligence'],
  'analytics': ['Data', 'Data Science', 'Business Intelligence'],
  'sales': ['Business Development', 'BD', 'Revenue', 'Account Management', 'Enterprise Sales'],
  'business development': ['Sales', 'BD', 'Partnerships', 'Strategic Alliances'],
  'partnerships': ['Business Development', 'Strategic Alliances', 'Channel'],
  'finance': ['FP&A', 'Financial Planning', 'Corporate Finance', 'Treasury'],
  'fp&a': ['Finance', 'Financial Planning', 'Corporate Finance'],
  'operations': ['Business Operations', 'BizOps', 'Strategy & Operations', 'Strategy and Operations'],
};

// ── 2. Strip connectors ──
function stripConnectors(title) {
  return [
    title,
    title.replace(/\bof the\b/gi, '').replace(/\bof\b/gi, '').replace(/,\s*/g, ' ').replace(/\s+/g, ' ').trim(),
  ];
}

// Expand title with abbreviations + synonyms + connector stripping
function expandTitle(title) {
  const variations = new Set();
  variations.add(title);
  const t = title.toLowerCase();

  // Title abbreviation expansion (VP, SVP, EVP, CXO, etc.)
  if (/^vp\b/i.test(title)) variations.add(title.replace(/^vp\b/i, 'Vice President'));
  if (/vice president/i.test(title)) variations.add(title.replace(/vice president/i, 'VP'));
  if (/^svp\b/i.test(title)) variations.add(title.replace(/^svp\b/i, 'Senior Vice President'));
  if (/senior vice president/i.test(title)) variations.add(title.replace(/senior vice president/i, 'SVP'));
  if (/^evp\b/i.test(title)) variations.add(title.replace(/^evp\b/i, 'Executive Vice President'));
  if (/executive vice president/i.test(title)) variations.add(title.replace(/executive vice president/i, 'EVP'));
  if (/^dir\b/i.test(title)) variations.add(title.replace(/^dir\b/i, 'Director'));
  if (/^head of/i.test(title)) {
    variations.add(title.replace(/^head of/i, 'VP of'));
    variations.add(title.replace(/^head of/i, 'Director of'));
  }

  const cxoMap = { 'cmo': 'Chief Marketing Officer', 'cto': 'Chief Technology Officer', 'cfo': 'Chief Financial Officer', 'coo': 'Chief Operating Officer', 'cpo': 'Chief Product Officer', 'cro': 'Chief Revenue Officer', 'chro': 'Chief Human Resources Officer', 'cio': 'Chief Information Officer' };
  if (cxoMap[t]) variations.add(cxoMap[t]);
  for (const [abbr, full] of Object.entries(cxoMap)) {
    if (t === full.toLowerCase()) variations.add(abbr.toUpperCase());
  }

  // Function synonym expansion
  for (const [keyword, synonyms] of Object.entries(FUNCTION_SYNONYMS)) {
    if (t.includes(keyword)) {
      // Extract the level prefix (e.g. "VP of", "Director of", "Head of")
      const match = title.match(/^(.*?)\b(of\s+|,\s*|\s+)(.*)/i);
      if (match) {
        const prefix = match[1].trim();
        for (const syn of synonyms.slice(0, 3)) { // Limit to top 3 synonyms
          variations.add(`${prefix} of ${syn}`);
        }
      }
    }
  }

  // Strip connectors for all variations
  const withStripped = new Set();
  for (const v of variations) {
    for (const s of stripConnectors(v)) {
      withStripped.add(s);
    }
  }

  return [...withStripped];
}

// ── 5. Seniority filter ──
function getSeniority(title) {
  const t = title.toLowerCase();
  if (/\b(coordinator|specialist|associate|assistant)\b/.test(t)) return 'entry_level,mid_level';
  if (/\b(manager|lead|senior)\b/.test(t) && !/\b(director|vp|vice president)\b/.test(t)) return 'mid_level,senior_level';
  if (/\b(director|head of)\b/.test(t)) return 'senior_level,director';
  if (/\b(vp|vice president|svp|evp)\b/.test(t)) return 'vp';
  if (/\b(chief|cmo|cto|cfo|coo|cpo|cro|chro|ceo|president)\b/.test(t)) return 'executive';
  return '';
}

// ── 4. Extract resume keywords ──
function extractResumeKeywords(resumeText) {
  if (!resumeText || resumeText.length < 50) return '';
  const t = resumeText.toLowerCase();
  const keywords = [];

  // Industry keywords
  const industries = ['saas', 'b2b', 'b2c', 'fintech', 'healthtech', 'edtech', 'e-commerce', 'ecommerce', 'biotech', 'pharma', 'healthcare', 'financial services', 'consulting', 'media', 'retail', 'manufacturing', 'logistics', 'real estate', 'insurance', 'telecom'];
  for (const ind of industries) {
    if (t.includes(ind)) keywords.push(ind);
  }

  // Skill keywords
  const skills = ['demand generation', 'pipeline', 'revenue growth', 'digital transformation', 'talent acquisition', 'organizational development', 'leadership development', 'change management', 'product strategy', 'go-to-market', 'GTM', 'enterprise sales', 'brand strategy', 'data analytics', 'machine learning', 'cloud', 'agile', 'devops', 'supply chain', 'M&A', 'fundraising', 'investor relations'];
  for (const skill of skills) {
    if (t.includes(skill.toLowerCase())) keywords.push(skill);
  }

  return keywords.slice(0, 5).join(' ');
}
