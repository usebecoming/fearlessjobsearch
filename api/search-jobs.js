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
    console.log(`📋 Original titles: ${titles.join(', ')}`);
    console.log(`📋 Expanded to ${expandedTitles.length} search terms:`);
    expandedTitles.forEach(t => console.log(`   • ${t}`));

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
    const rawResumeText = req.body.resumeKeywords || '';
    const resumeKeywords = extractResumeKeywords(rawResumeText);
    if (resumeKeywords) {
      console.log('Resume keyword search:', resumeKeywords);
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

// ── 1. Synonym map ──
const SYNONYM_MAP = {
  'learning and development': ['Learning and Development', 'L&D', 'Training and Development', 'Organizational Development', 'Talent Development', 'People Development', 'Leadership Development'],
  'talent development': ['Talent Development', 'Learning and Development', 'L&D', 'Training and Development', 'Organizational Development', 'Leadership Development'],
  'training': ['Training and Development', 'Learning and Development', 'L&D', 'Instructional Design', 'Talent Development'],
  'l&d': ['Learning and Development', 'L&D', 'Training and Development', 'Talent Development'],
  'hr': ['Human Resources', 'People Operations', 'People & Culture', 'HRBP', 'HR Business Partner'],
  'human resources': ['HR', 'People Operations', 'People & Culture', 'Workforce'],
  'talent acquisition': ['Recruiting', 'Talent Acquisition', 'HR Recruiting'],
  'growth': ['Growth Marketing', 'Demand Generation', 'Demand Gen', 'Performance Marketing', 'Revenue Marketing'],
  'brand': ['Brand Marketing', 'Brand Strategy', 'Integrated Marketing'],
  'content': ['Content Strategy', 'Content Marketing', 'Editorial', 'Communications'],
  'marketing': ['Marketing', 'Growth Marketing', 'Demand Generation'],
  'product': ['Product Management', 'Product Strategy', 'Product Lead'],
  'ux': ['User Experience', 'UX Design', 'Product Design'],
  'engineering': ['Software Engineering', 'Software Development'],
  'data': ['Data Science', 'Analytics', 'Business Intelligence', 'Data Analytics'],
  'sales': ['Sales', 'Business Development', 'Account Management', 'Enterprise Sales'],
  'partnerships': ['Business Development', 'Strategic Partnerships', 'Channel Partnerships'],
  'operations': ['Operations', 'Business Operations', 'Strategy and Operations'],
  'finance': ['Finance', 'FP&A', 'Financial Planning and Analysis', 'Corporate Finance'],
};

// ── 2. Seniority prefix extraction ──
function extractSeniorityPrefix(title) {
  const prefixes = [
    'Senior Vice President of', 'Senior Vice President',
    'Executive Vice President of', 'Executive Vice President',
    'Vice President of', 'Vice President',
    'Senior Director of', 'Senior Director',
    'Director of', 'Director',
    'Head of',
    'Senior Manager of', 'Senior Manager',
    'Manager of', 'Manager',
    'SVP of', 'SVP', 'EVP of', 'EVP', 'VP of', 'VP',
    'Lead', 'Senior', 'Sr.',
    'CMO', 'CTO', 'CPO', 'CHRO', 'CFO', 'COO', 'CEO'
  ];
  for (const prefix of prefixes) {
    if (title.toLowerCase().startsWith(prefix.toLowerCase())) {
      return title.substring(0, prefix.length);
    }
  }
  return '';
}

// ── 3. Clean title expansion ──
function expandTitle(title) {
  const variations = new Set();
  variations.add(title);
  const t = title.toLowerCase();

  // Abbreviation expansion
  if (/^vp\b/i.test(title)) variations.add(title.replace(/^vp\b/i, 'Vice President'));
  if (/vice president/i.test(title)) variations.add(title.replace(/vice president/i, 'VP'));
  if (/^svp\b/i.test(title)) variations.add(title.replace(/^svp\b/i, 'Senior Vice President'));
  if (/senior vice president/i.test(title)) variations.add(title.replace(/senior vice president/i, 'SVP'));
  if (/^evp\b/i.test(title)) variations.add(title.replace(/^evp\b/i, 'Executive Vice President'));
  if (/executive vice president/i.test(title)) variations.add(title.replace(/executive vice president/i, 'EVP'));
  if (/^head of/i.test(title)) {
    variations.add(title.replace(/^head of/i, 'VP of'));
    variations.add(title.replace(/^head of/i, 'Director of'));
  }

  const cxoMap = { 'cmo': 'Chief Marketing Officer', 'cto': 'Chief Technology Officer', 'cfo': 'Chief Financial Officer', 'coo': 'Chief Operating Officer', 'cpo': 'Chief Product Officer', 'cro': 'Chief Revenue Officer', 'chro': 'Chief Human Resources Officer', 'cio': 'Chief Information Officer' };
  if (cxoMap[t]) variations.add(cxoMap[t]);
  for (const [abbr, full] of Object.entries(cxoMap)) {
    if (t === full.toLowerCase()) variations.add(abbr.toUpperCase());
  }

  // Synonym expansion with seniority prefix
  const prefix = extractSeniorityPrefix(title);
  for (const [keyword, synonyms] of Object.entries(SYNONYM_MAP)) {
    if (t.includes(keyword)) {
      for (const syn of synonyms) {
        if (prefix) {
          // Check if prefix already ends with "of"
          const needsOf = !prefix.toLowerCase().endsWith(' of') && !prefix.toLowerCase().endsWith(',');
          variations.add(needsOf ? `${prefix} of ${syn}` : `${prefix} ${syn}`);
        } else {
          variations.add(syn);
        }
      }
    }
  }

  // Strip connectors for all variations
  const final = new Set();
  for (const v of variations) {
    final.add(v);
    const stripped = v.replace(/\bof the\b/gi, '').replace(/\bof\b/gi, '').replace(/,\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if (stripped !== v) final.add(stripped);
  }

  return [...final];
}

// ── 4. Seniority filter ──
function getSeniority(title) {
  const t = title.toLowerCase();
  if (/\b(coordinator|specialist|associate|assistant)\b/.test(t)) return 'entry_level,mid_level';
  if (/\b(manager|lead|senior)\b/.test(t) && !/\b(director|vp|vice president)\b/.test(t)) return 'mid_level,senior_level';
  if (/\b(director|head of)\b/.test(t)) return 'senior_level,director';
  if (/\b(vp|vice president|svp|evp)\b/.test(t)) return 'vp';
  if (/\b(chief|cmo|cto|cfo|coo|cpo|cro|chro|ceo|president)\b/.test(t)) return 'executive';
  return '';
}

// ── 5. Resume keyword extraction ──
function extractResumeKeywords(resumeText) {
  if (!resumeText || resumeText.length < 100) {
    console.log('⚠️ Resume too short for keyword extraction');
    return null;
  }

  // Skip header (name, email, phone, address)
  const bodyText = resumeText.slice(300);
  const cleaned = bodyText
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, '')
    .replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/gi, '')
    .replace(/\b(present|current|today)\b/gi, '');

  const skillPatterns = [
    /\b(leadership|coaching|facilitation|organizational development|talent management|learning|training|curriculum|instructional design)\b/gi,
    /\b(marketing|demand generation|brand|content|SEO|paid media|analytics)\b/gi,
    /\b(product management|roadmap|agile|scrum|user research)\b/gi,
    /\b(engineering|software development|architecture|DevOps|cloud)\b/gi,
    /\b(sales|business development|revenue|account management)\b/gi,
    /\b(finance|FP&A|forecasting|budgeting|financial modeling)\b/gi,
    /\b(operations|process improvement|project management|PMO)\b/gi,
    /\b(SaaS|B2B|B2C|fintech|healthtech|edtech|ecommerce|enterprise)\b/gi,
    /\b(executive|director|VP|vice president|C-suite|leadership team)\b/gi
  ];

  const keywords = new Set();
  skillPatterns.forEach(pattern => {
    const matches = cleaned.match(pattern) || [];
    matches.forEach(m => keywords.add(m.trim()));
  });

  const keywordArray = Array.from(keywords).slice(0, 5);
  if (keywordArray.length < 2) {
    console.log('⚠️ Resume keyword extraction returned too few keywords — skipping resume search');
    return null;
  }

  console.log(`📄 Resume keywords extracted: ${keywordArray.join(', ')}`);
  return keywordArray.join(' ');
}
