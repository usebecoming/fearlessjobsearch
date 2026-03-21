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

    // Expand titles, cap at 5 (originals first, then synonyms)
    const allExpanded = [];
    const seen = new Set();
    // Add user's original titles first
    for (const title of titles) {
      const key = title.toLowerCase();
      if (!seen.has(key)) { seen.add(key); allExpanded.push(title); }
    }
    // Then add expansions
    for (const title of titles) {
      const variations = expandTitle(title);
      for (const v of variations) {
        const key = v.toLowerCase();
        if (!seen.has(key)) { seen.add(key); allExpanded.push(v); }
      }
    }
    const expandedTitles = allExpanded.slice(0, 7);
    console.log(`📋 Original titles: ${titles.join(', ')}`);
    console.log(`📋 Expanded to ${expandedTitles.length} search terms (capped at 7):`);
    expandedTitles.forEach(t => console.log(`   • ${t}`));

    // Single JSearch call with timeout protection
    async function jsearchOne(query, extraParams) {
      const params = new URLSearchParams({
        query,
        page: '1',
        num_pages: '1',
        date_posted: 'week',
        employment_types: 'FULLTIME',
        ...extraParams
      });
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        const response = await fetch(
          `https://jsearch.p.rapidapi.com/search?${params.toString()}`,
          { headers: { 'X-RapidAPI-Key': rapidApiKey, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' }, signal: controller.signal }
        );
        clearTimeout(timeout);
        if (response.ok) {
          const data = await response.json();
          const results = data.data || [];
          console.log(`  JSearch "${query.substring(0,50)}": ${results.length}`);
          return results;
        }
        return [];
      } catch (e) {
        console.log(`  ⚠️ JSearch timeout/error for "${query.substring(0,40)}": ${e.message}`);
        return [];
      }
    }

    // Build all search queries
    const seniority = getSeniority(titles[0] || '');
    const searchQueries = [];
    for (const title of expandedTitles) {
      for (const loc of locationQueries) {
        const isRemoteQuery = loc === '__remote__';
        const locationStr = isRemoteQuery ? '' : loc;
        const query = title + (locationStr ? ` in ${locationStr}` : '');
        const extra = {};
        if ((isRemote && !locationStr) || isRemoteQuery) extra.remote_jobs_only = 'true';
        if (seniority) extra.job_requirements = seniority;
        searchQueries.push({ query, extra });
      }
    }

    // Add resume keyword search
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
        searchQueries.push({ query, extra });
      }
    }

    console.log(`🔍 Running ${searchQueries.length} JSearch queries in parallel...`);

    // Run ALL queries in parallel
    const allResults = await Promise.all(
      searchQueries.map(sq => jsearchOne(sq.query, sq.extra).then(r => {
        if (r.length === 0) {
          // Retry once with longer timeout if first attempt got nothing
          console.log(`  🔄 Retrying: ${sq.query.substring(0,50)}`);
          return jsearchOne(sq.query, sq.extra);
        }
        return r;
      }))
    );

    // Dedupe by job ID
    const seenJobIds = new Set();
    const allJobs = [];
    for (const results of allResults) {
      for (const job of results) {
        const jid = job.job_id || '';
        if (jid && !seenJobIds.has(jid)) { seenJobIds.add(jid); allJobs.push(job); }
      }
    }

    const totalFromJSearch = allJobs.length;
    console.log(`Total from JSearch: ${totalFromJSearch}`);

    // Dedupe by company+title combo
    const seenCompanyTitle = new Set();
    const dedupedJobs = allJobs.filter(job => {
      const key = ((job.employer_name || '') + '|' + (job.job_title || '')).toLowerCase();
      if (seenCompanyTitle.has(key)) return false;
      seenCompanyTitle.add(key);
      return true;
    });
    const afterDedup = dedupedJobs.length;

    // ── Comprehensive job filtering ──

    const suspiciousCompanies = new Set([
      // MLM / Pyramid
      'focus on life biz','primerica','herbalife','amway','cutco','vector marketing',
      'symmetry financial','php agency','world financial group','wfg','northwestern mutual',
      'new york life','mass mutual','massmutual','aflac','globe life','american income life',
      'ail','family first life','ffl','equity national life','transamerica','paclife',
      'pacific life','monat','market america','optavia','isagenix','rodan and fields',
      'rodan + fields','lularoe','young living','doterra','scentsy','tupperware',
      'pampered chef','avon','mary kay',
      // Suspected MLM / misleading
      'alphabe insight','alphabe insight inc','elevation global','elevation global inc',
      'next level talent','mvp vc','dukin','interplay learning','cydcor','devilcorp',
      'smart circle','credico','ds max','granton marketing','innovage',
      'the acquisition group','apex management group','peak performance',
      'peak performance group','synergy management','atlas marketing','atlas management',
      'impact marketing','impact leadership','prime marketing','premier marketing',
      'pyramid consulting',
      // Poor employers
      'crossover','crossover for work','trilogy education','2u inc','2u',
      // Garbled names
      'org_subtype','global_services','operations_bu',
      // Workforce programs (not corporate)
      'year up','year up united','job corps','goodwill industries','workforce solutions',
      'careerstaff',
      // Tutoring / childcare
      'mathnasium','kumon','sylvan learning','huntington learning','learning tree',
      'the learning experience','bright horizons','kindercare','primrose schools',
      // Staffing (backup to agency filter)
      'insight global','experis','manpower','manpowergroup','adecco','randstad',
      'kelly services','robert half','spherion','aerotek','staffmark','staffing solutions',
      'medasource','vivian health','mercury group staffing','sigma inc','next level talent llc'
    ]);

    const suspiciousPatterns = [
      /\b(peak|prime|apex|summit|pinnacle|elite|premier|impact|synergy|momentum|velocity|leverage)\s+(management|marketing|solutions|group|consulting|partners)\b/i,
      /\bleadership\s+(solutions|group|partners|consulting)\s+inc\b/i,
      /org_subtype/i, /^bu\d{3}/i, /_bu\d{3}/i,
      /[A-Z]{2,}_[A-Z]{2,}/
    ];

    const mlmTitlePatterns = [
      /independent.*consultant/i, /performance.based/i, /unlimited.*earning/i,
      /be your own boss/i, /entrepreneurial.*opportunity/i, /commission only/i,
      /uncapped.*commission/i, /financial.*freedom/i, /own your.*schedule/i,
      /\bMLM\b/i, /network marketing/i, /direct sales/i, /independent distributor/i,
      /independent representative/i, /brand ambassador.*commission/i
    ];

    const irrelevantKeywords = [
      'labor & delivery','labor and delivery','l&d rn','registered nurse','nursing',
      'patient care','antepartum','obstetric','maternal','postpartum','nicu',
      'flight nurse','med surg','icu','er nurse','travel nurse','rn ',
      'sdr','bdr','sales development rep','teach english','esl teacher',
      'water safety','lifeguard','daycare','day care','childcare','preschool',
      'kindergarten','elementary school','middle school','high school',
      'workforce development program','documentation specialist'
    ];

    const irrelevantPatterns = [
      /^development director/i, /^director of development/i,
      /\bsvp of development\b/i, /\bvp of development\b/i,
      /\bsoftware development.*engineer/i, /\bservice delivery engineer\b/i,
      /\bvalue engineering\b/i, /\bsales development\b/i,
      /development.*construction/i, /construction.*development/i,
      /\breal estate.*development\b/i
    ];

    let irrelevantRemoved = 0;
    let fundraisingRemoved = 0;
    let agenciesRemoved = 0;

    const agencyKeywords = ['staffing','recruiting','talent agency','manpower','adecco',
      'randstad','robert half','hays','kforce','kelly services','allegis','insight global',
      'korn ferry','heidrick','aerotek','tek systems','teksystems','beacon hill',
      'apex group','modis','volt','spherion','express employment','nesco','addison group',
      'brooksource','procom','collabera','cybercoders','dice','jobspring','placement',
      'search group','executive search','talent solutions','recruiting group'];

    const relevantJobs = dedupedJobs.filter(job => {
      const title = (job.job_title || '').toLowerCase();
      const desc = (job.job_description || '').substring(0, 300).toLowerCase();
      const combined = title + ' ' + desc;
      const company = (job.employer_name || '').toLowerCase().trim();

      // Agency filter (remove, not just flag)
      if (agencyKeywords.some(kw => company.includes(kw))) {
        console.log(`  ❌ Agency: ${job.job_title} at ${job.employer_name}`);
        agenciesRemoved++;
        return false;
      }

      // Suspicious company (exact match)
      if (suspiciousCompanies.has(company)) {
        console.log(`  ❌ Blocklisted: ${job.employer_name}`);
        irrelevantRemoved++;
        return false;
      }
      // Suspicious company (pattern match)
      if (suspiciousPatterns.some(p => p.test(job.employer_name || ''))) {
        console.log(`  ❌ Suspicious pattern: ${job.employer_name}`);
        irrelevantRemoved++;
        return false;
      }
      // MLM title patterns
      if (mlmTitlePatterns.some(p => p.test(job.job_title || ''))) {
        console.log(`  ❌ MLM title: ${job.job_title}`);
        irrelevantRemoved++;
        return false;
      }
      // Keyword match
      if (irrelevantKeywords.some(kw => combined.includes(kw))) {
        console.log(`  ❌ Irrelevant: ${job.job_title} at ${job.employer_name}`);
        irrelevantRemoved++;
        return false;
      }
      // Pattern match
      if (irrelevantPatterns.some(p => p.test(title))) {
        console.log(`  ❌ Irrelevant pattern: ${job.job_title} at ${job.employer_name}`);
        irrelevantRemoved++;
        return false;
      }
      // Fundraising description check
      const fundraisingSignals = ['fundrais', 'donor', 'philanthrop', 'annual fund', 'major gifts', 'capital campaign', 'endowment', 'gift officer', 'nonprofit development'];
      if (fundraisingSignals.some(s => desc.includes(s))) {
        console.log(`  ❌ Fundraising (desc): ${job.job_title} at ${job.employer_name}`);
        fundraisingRemoved++;
        return false;
      }
      // Fundraising "development" disambiguation
      if (isFundraisingDevelopment(job)) {
        console.log(`  ❌ Fundraising dev: ${job.job_title} at ${job.employer_name}`);
        fundraisingRemoved++;
        return false;
      }
      return true;
    });

    // Seniority filter from resume (not search titles)
    const resumeSeniority = detectSeniorityFromResume(rawResumeText);
    console.log(`📊 Seniority from resume: ${resumeSeniority}`);
    let seniorityRemoved = 0;

    const filterBelowSeniority = {
      'csuite': [/\bdirector\b/i, /\bmanager\b/i, /\bspecialist\b/i, /\bcoordinator\b/i, /\bassociate\b/i, /\bassistant\b/i, /\bfacilitator\b/i, /\binstructor\b/i, /\btrainer\b/i, /\banalyst\b/i],
      'svp': [/\bmanager\b/i, /\bspecialist\b/i, /\bcoordinator\b/i, /\bassociate\b/i, /\bassistant\b/i, /\bfacilitator\b/i, /\binstructor\b/i, /\btrainer\b/i, /\banalyst\b/i],
      'vp': [/\bspecialist\b/i, /\bcoordinator\b/i, /\bassociate\b/i, /\bassistant\b/i, /\bfacilitator\b/i, /\binstructor\b/i, /\btrainer\b/i, /\banalyst\b/i, /\bjunior\b/i],
      'director': [/\bspecialist\b/i, /\bcoordinator\b/i, /\bassociate\b/i, /\bassistant\b/i, /\bfacilitator\b/i, /\binstructor\b/i, /\btrainer\b/i, /\bjunior\b/i, /\bentry level\b/i],
      'senior': [/\bcoordinator\b/i, /\bassistant\b/i, /\bjunior\b/i, /\bentry level\b/i, /\binstructor\b/i, /\bfacilitator\b/i, /\bspecialist\b/i, /\bassociate\b/i, /\btrainer\b/i, /\bin training\b/i, /\bapprentice\b/i, /\bintern\b/i, /\brepresentative\b/i, /\bteacher\b/i, /\btutor\b/i],
      'manager': [/\bjunior\b/i, /\bentry level\b/i, /\bassistant\b/i],
    };
    const patternsToFilter = filterBelowSeniority[resumeSeniority] || [];
    const seniorityFiltered = patternsToFilter.length > 0
      ? relevantJobs.filter(job => {
          const t = (job.job_title || '').toLowerCase();
          if (patternsToFilter.some(p => p.test(t))) {
            console.log(`  ❌ Below ${resumeSeniority}: ${job.job_title}`);
            seniorityRemoved++;
            return false;
          }
          return true;
        })
      : relevantJobs;

    // Cap at 30 for Claude scoring
    const jobs = seniorityFiltered.slice(0, 30);

    // Flag staffing agencies
    const filtered = jobs.map((job, i) => {
      return {
        id: job.job_id || `jsearch-${i}`,
        title: job.job_title || 'Untitled',
        company: job.employer_name || 'Unknown',
        isAgency: false,
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
        fitScore: 0,
        fitReason: ''
      };
    });

    // Pipeline summary
    console.log(`\n📊 JOB PIPELINE SUMMARY:`);
    console.log(`  Total from JSearch: ${totalFromJSearch}`);
    console.log(`  After deduplication: ${afterDedup}`);
    console.log(`  Agencies removed: ${agenciesRemoved}`);
    console.log(`  Irrelevant/blocklisted removed: ${irrelevantRemoved}`);
    console.log(`  Fundraising removed: ${fundraisingRemoved}`);
    console.log(`  Resume seniority: ${resumeSeniority}`);
    console.log(`  Below seniority removed: ${seniorityRemoved}`);
    console.log(`  Passed to Claude for scoring: ${filtered.length}`);
    filtered.forEach((job, i) => {
      console.log(`  ${i+1}. ${job.title} at ${job.company}${job.isAgency ? ' [AGENCY]' : ''} — ${job.location}`);
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
function detectSeniorityFromResume(resumeText) {
  if (!resumeText || resumeText.length < 100) {
    console.log('📊 No resume — defaulting to senior');
    return 'senior';
  }
  const body = resumeText.slice(500);
  if (/(chief executive|chief operating|chief marketing|chief technology|chief people|chief hr|chief financial|chief revenue|chief product|\bCEO\b|\bCOO\b|\bCMO\b|\bCTO\b|\bCPO\b|\bCHRO\b|\bCFO\b|\bCRO\b)/i.test(body)) {
    console.log('📊 Resume seniority: C-Suite');
    return 'csuite';
  }
  if (/(executive vice president|EVP|senior vice president|SVP)/i.test(body)) {
    console.log('📊 Resume seniority: SVP/EVP');
    return 'svp';
  }
  if (/(vice president|\bVP\b|\bVP,\b|\bVP of\b)/i.test(body)) {
    console.log('📊 Resume seniority: VP');
    return 'vp';
  }
  if (/\b(senior director|director of|director,|\bdirector\b)/i.test(body)) {
    console.log('📊 Resume seniority: Director');
    return 'director';
  }
  if (/\b(senior manager|senior lead|senior advisor|\bsenior\b|\bsr\.\b)/i.test(body)) {
    console.log('📊 Resume seniority: Senior');
    return 'senior';
  }
  if (/\b(manager of|manager,|\bmanager\b|lead,|\blead\b|principal)\b/i.test(body)) {
    console.log('📊 Resume seniority: Manager');
    return 'manager';
  }
  console.log('📊 Resume seniority: defaulting to senior');
  return 'senior';
}

function isFundraisingDevelopment(job) {
  const title = (job.job_title || '').toLowerCase();
  const desc = (job.job_description || '').substring(0, 300).toLowerCase();
  if (!title.includes('development')) return false;
  const ldKeywords = ['learning', 'talent', 'training', 'organizational', 'leadership', 'people', 'workforce', 'l&d'];
  if (ldKeywords.some(kw => title.includes(kw) || desc.includes(kw))) return false;
  const fundraisingKeywords = ['nonprofit', 'non-profit', 'foundation', 'association', 'fundrais', 'donor', 'philanthrop', 'major gifts', 'annual fund'];
  return fundraisingKeywords.some(kw => desc.includes(kw));
}

function detectSearchSeniority(titles) {
  const text = titles.join(' ').toLowerCase();
  if (/(vp|vice president|svp|evp|chief|cmo|cto|coo|ceo|chro|cpo|cro)/i.test(text)) return 'executive';
  if (/\bdirector\b/i.test(text)) return 'director';
  if (/\bsenior\b|\bsr\b|\blead\b|\bmanager\b|\bhead of\b/i.test(text)) return 'senior';
  return 'any';
}

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
    console.log('⚠️ Resume too short — skipping resume search');
    return null;
  }

  const body = resumeText.slice(500);

  // Aggressive skill extraction
  const skillRegex = /(leadership|coaching|facilitation|organizational development|talent management|learning|training|curriculum|instructional design|executive coaching|career development|change management|performance management|succession planning|employee engagement|culture|workforce development|program management|stakeholder management|strategic planning|analytics|data-driven|SaaS|B2B|startup|enterprise|Fortune 500|consulting|organizational effectiveness|HRBP|HR business partner|talent acquisition|recruiting|compensation|benefits|HRIS|Workday|SAP|SuccessFactors|marketing|demand generation|brand|content|SEO|paid media|product management|roadmap|agile|scrum|engineering|software development|DevOps|cloud|sales|business development|revenue|account management|finance|FP&A|forecasting|budgeting|operations|process improvement|project management|human capital|workforce planning|people analytics|diversity|inclusion|dei|employee relations|total rewards)/gi;

  const keywords = new Set();
  const matches = body.match(skillRegex) || [];
  matches.forEach(m => keywords.add(m.toLowerCase().trim()));

  // Fallback: capitalized multi-word phrases
  if (keywords.size < 2) {
    const phrases = body.match(/[A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)+/g) || [];
    const clean = [...new Set(phrases)].filter(p => p.length > 8 && !/^(January|February|March|April|May|June|July|August|September|October|November|December)/.test(p));
    clean.slice(0, 5).forEach(p => keywords.add(p.toLowerCase()));
  }

  const keywordArray = Array.from(keywords).slice(0, 5);
  if (keywordArray.length < 2) {
    console.log('⚠️ Resume keyword extraction returned too few keywords — skipping resume search');
    return null;
  }

  console.log(`📄 Resume keywords extracted: ${keywordArray.join(', ')}`);
  return keywordArray.join(' ');
}
// deploy 1774050865
