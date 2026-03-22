import { rateLimit } from './_rateLimit.js';
import { verifyUser } from './_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rl = rateLimit(req, { maxRequests: 5, windowMs: 60000 });
  if (!rl.allowed) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
  }

  // Verify authenticated user from JWT
  const auth = await verifyUser(req);
  if (auth.error) {
    return res.status(401).json({ error: auth.error });
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
        // Log the actual error so we can diagnose it
        const errorBody = await response.text().catch(() => '(unreadable)');
        console.log(`  ❌ JSearch HTTP ${response.status} for "${query.substring(0,40)}": ${errorBody.substring(0,200)}`);
        return [];
      } catch (e) {
        console.log(`  ⚠️ JSearch timeout/error for "${query.substring(0,40)}": ${e.message}`);
        return [];
      }
    }

    // Build all search queries
    const searchQueries = [];
    for (const title of expandedTitles) {
      for (const loc of locationQueries) {
        const isRemoteQuery = loc === '__remote__';
        const locationStr = isRemoteQuery ? '' : loc;
        const query = title + (locationStr ? ` in ${locationStr}` : '');
        const extra = {};
        if ((isRemote && !locationStr) || isRemoteQuery) extra.remote_jobs_only = 'true';
        searchQueries.push({ query, extra });
      }
    }

    // Resume processing
    const rawResumeText = req.body.resumeKeywords || '';
    if (rawResumeText) {
      console.log(`📄 Resume received: ${rawResumeText.length} chars`);
    } else {
      console.log(`📄 No resume uploaded — using default seniority and skipping keyword search`);
    }
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

    console.log(`🔍 Running ${searchQueries.length} JSearch queries in batches of 4...`);

    const BATCH_SIZE = 3;
    const BATCH_DELAY_MS = 1000;
    const allResults = [];

    for (let i = 0; i < searchQueries.length; i += BATCH_SIZE) {
      const batch = searchQueries.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(sq => jsearchOne(sq.query, sq.extra))
      );
      allResults.push(...batchResults);
      if (i + BATCH_SIZE < searchQueries.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }
    }

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

    // Dedupe by normalized company+title combo
    const seenCompanyTitle = new Set();
    const dedupedJobs = allJobs.filter(job => {
      const company = (job.employer_name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
      const title = (job.job_title || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
      const key = `${company}||${title}`;
      if (seenCompanyTitle.has(key)) return false;
      seenCompanyTitle.add(key);
      return true;
    });
    const afterDedup = dedupedJobs.length;

    // ── Detect search function from titles ──
    const searchFunc = detectSearchFunction(expandedTitles);
    console.log(`📊 Search function: ${searchFunc}`);

    // ── Context-aware job filtering ──

    const universalBlocklist = new Set([
      'primerica','herbalife','amway','cutco','vector marketing','symmetry financial',
      'php agency','world financial group','wfg','american income life','ail',
      'family first life','ffl','monat','market america','optavia','isagenix',
      'rodan and fields','rodan + fields','lularoe','young living','doterra','scentsy',
      'tupperware','pampered chef','avon','mary kay','alphabe insight','alphabe insight inc',
      'elevation global','elevation global inc','cydcor','smart circle','credico','ds max',
      'granton marketing','innovage','org_subtype','global_services','operations_bu',
      'pyramid consulting',
      'living the dream','living the dream austin','ltda',
      'life is good coaching','dream life','your best life','limitless life',
      'unleash your potential','the success principles','power of you','the coaching institute'
    ]);

    const conditionalBlocklist = {
      'People': new Set(['focus on life biz','dukin','mvp vc','next level talent','next level talent llc',
        'interplay learning','year up','year up united','job corps','goodwill industries','workforce solutions',
        'mathnasium','kumon','sylvan learning','huntington learning','the learning experience',
        'bright horizons','kindercare','primrose schools','crossover','crossover for work']),
      'Marketing': new Set(['focus on life biz','dukin','mvp vc','digital media solutions','fluent inc']),
      'Engineering': new Set(['year up','year up united','job corps','general assembly','trilogy education','2u','2u inc','coding dojo','hack reactor','fullstack academy']),
      'Sales': new Set(['focus on life biz','dukin','northwestern mutual','new york life','mass mutual','massmutual','aflac','globe life','transamerica','american income life']),
      'Finance': new Set(['focus on life biz','primerica'])
    };

    const suspiciousPatterns = [
      /\b(peak|prime|apex|summit|pinnacle|elite|premier|impact|synergy|momentum|velocity|leverage)\s+(management|marketing|solutions|group|consulting|partners)\b/i,
      /\bleadership\s+(solutions|group|partners|consulting)\s+inc\b/i,
      /org_subtype/i, /^bu\d{3}/i, /_bu\d{3}/i, /[A-Z]{2,}_[A-Z]{2,}/,
      /^living the \w+$/i, /^dream\s+(life|career|big)/i,
      /^your\s+(best|dream|ideal)\s+life/i,
      /^(unleash|unlock|ignite|inspire)\s+your/i
    ];

    const mlmTitlePatterns = [
      /independent.*consultant/i, /performance.based/i, /unlimited.*earning/i,
      /be your own boss/i, /entrepreneurial.*opportunity/i, /commission only/i,
      /uncapped.*commission/i, /financial.*freedom/i, /own your.*schedule/i,
      /\bMLM\b/i, /network marketing/i, /direct sales/i, /independent distributor/i,
      /independent representative/i, /brand ambassador.*commission/i
    ];

    // Function-specific irrelevant patterns
    const funcIrrelevant = {
      'People': [/\bl&d rn\b/i, /labor.*delivery/i, /registered nurse/i, /\brn,?\b/i, /nursing/i,
        /patient care/i, /obstetric/i, /maternal/i, /postpartum/i, /nicu/i,
        /\bsdr\b/i, /\bbdr\b/i, /sales development rep/i,
        /development.*construction/i, /construction.*development/i,
        /\bdaycare\b/i, /\bday care\b/i, /\bchildcare\b/i,
        /\bsoftware.*engineer/i, /\bdata engineer/i, /\bvalue engineering\b/i],
      'Marketing': [/software.*engineer/i, /data engineer/i, /registered nurse/i],
      'Engineering': [/marketing manager/i, /brand manager/i, /registered nurse/i],
      'Sales': [/registered nurse/i, /software engineer/i, /data engineer/i]
    };

    const universalIrrelevant = [/teach english overseas/i, /\besl teacher\b/i, /org_subtype/i,
      /\bteacher\b/i, /\btutor\b/i, /\blifeguard\b/i, /\bwater safety\b/i,
      /^development director/i, /^director of development/i, /\breal estate.*development\b/i];

    const agencyKeywords = ['staffing','recruiting','talent agency','manpower','adecco',
      'randstad','robert half','hays','kforce','kelly services','allegis','insight global',
      'korn ferry','heidrick','aerotek','tek systems','teksystems','beacon hill',
      'apex group','modis','volt','spherion','express employment','nesco','addison group',
      'brooksource','procom','collabera','cybercoders','dice','jobspring','placement',
      'search group','executive search','talent solutions','recruiting group'];

    const fundraisingSignals = ['fundrais','donor','philanthrop','annual fund','major gifts',
      'capital campaign','endowment','gift officer','nonprofit development'];

    let irrelevantRemoved = 0;
    let fundraisingRemoved = 0;
    let agenciesRemoved = 0;

    const allJobsBeforeSeniority = []; // save for potential loosening later

    const relevantJobs = dedupedJobs.filter(job => {
      const title = (job.job_title || '').toLowerCase();
      const desc = (job.job_description || '').substring(0, 300).toLowerCase();
      const company = (job.employer_name || '').toLowerCase().trim();

      // Confidential/undisclosed companies — no value for networking
      if (/^confidential$|^undisclosed|^company confidential|^hiring company|^not disclosed/.test(company)) {
        console.log(`  ❌ Confidential company: ${job.job_title} at ${job.employer_name}`);
        irrelevantRemoved++;
        return false;
      }

      // Agency removal
      if (agencyKeywords.some(kw => company.includes(kw))) {
        console.log(`  ❌ Agency: ${job.job_title} at ${job.employer_name}`);
        agenciesRemoved++;
        return false;
      }
      // Universal blocklist
      if (universalBlocklist.has(company)) {
        console.log(`  ❌ Blocklisted: ${job.employer_name}`);
        irrelevantRemoved++;
        return false;
      }
      // Conditional blocklist
      const funcBlock = conditionalBlocklist[searchFunc];
      if (funcBlock && funcBlock.has(company)) {
        console.log(`  ❌ ${searchFunc} blocklist: ${job.employer_name}`);
        irrelevantRemoved++;
        return false;
      }
      // Suspicious patterns
      if (suspiciousPatterns.some(p => p.test(job.employer_name || ''))) {
        console.log(`  ❌ Suspicious: ${job.employer_name}`);
        irrelevantRemoved++;
        return false;
      }
      // MLM titles
      if (mlmTitlePatterns.some(p => p.test(job.job_title || ''))) {
        console.log(`  ❌ MLM title: ${job.job_title}`);
        irrelevantRemoved++;
        return false;
      }
      // Universal irrelevant
      if (universalIrrelevant.some(p => p.test(title))) {
        console.log(`  ❌ Irrelevant: ${job.job_title}`);
        irrelevantRemoved++;
        return false;
      }
      // Function-specific irrelevant
      const fPatterns = funcIrrelevant[searchFunc] || [];
      if (fPatterns.some(p => p.test(title))) {
        console.log(`  ❌ Wrong for ${searchFunc}: ${job.job_title}`);
        irrelevantRemoved++;
        return false;
      }
      // Fundraising description check
      if (fundraisingSignals.some(s => desc.includes(s))) {
        console.log(`  ❌ Fundraising: ${job.job_title} at ${job.employer_name}`);
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

    // Loosen seniority if too few results
    let finalFiltered = seniorityFiltered;
    if (seniorityFiltered.length < 10 && seniorityRemoved > 0) {
      console.log(`⚠️ Only ${seniorityFiltered.length} jobs — loosening seniority to add manager/lead roles`);
      const managerLevel = relevantJobs.filter(job => {
        const t = (job.job_title || '').toLowerCase();
        return (/\bmanager\b/i.test(t) || /\blead\b/i.test(t)) && !seniorityFiltered.some(sf => sf.job_id === job.job_id);
      });
      const needed = Math.min(10 - seniorityFiltered.length, managerLevel.length);
      if (needed > 0) {
        const toAdd = managerLevel.slice(0, needed);
        toAdd.forEach(j => { j.seniorityCaveat = true; console.log(`  + Adding: ${j.job_title} at ${j.employer_name}`); });
        finalFiltered = [...seniorityFiltered, ...toAdd];
      }
    }

    // Relevance filter — remove titles unrelated to search function
    let relevanceRemoved = 0;
    const relevanceFiltered = finalFiltered.filter(job => {
      if (isTitleRelevant(job.job_title || '', titles)) return true;
      console.log(`  ❌ Not relevant to ${searchFunc}: ${job.job_title} at ${job.employer_name}`);
      relevanceRemoved++;
      return false;
    });

    // Cap at 20 for Claude scoring
    const jobs = relevanceFiltered.slice(0, 20);

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
    console.log(`  Relevance filter removed: ${relevanceRemoved}`);
    console.log(`  Passed to Claude for scoring: ${filtered.length}`);
    filtered.forEach((job, i) => {
      console.log(`  ${i+1}. ${job.title} at ${job.company}${job.isAgency ? ' [AGENCY]' : ''} — ${job.location}`);
    });

    return res.status(200).json({ jobs: filtered.slice(0, 20) });
  } catch (err) {
    console.error('Search error:', err);
    return res.status(500).json({ error: 'Something went wrong searching for jobs. Please try again.' });
  }
}

function isTitleRelevant(jobTitle, searchTitles) {
  const normalized = jobTitle.toLowerCase();

  const termSets = {
    hr: ['hr', 'human resources', 'people', 'talent', 'workforce', 'organizational', 'culture', 'recruiting', 'recruitment', 'hrbp', 'hris', 'learning', 'training', 'l&d', 'development'],
    finance: ['finance', 'financial', 'cfo', 'accounting', 'treasury', 'controller', 'fp&a'],
    tech: ['engineering', 'technology', 'software', 'cto', 'product', 'data', 'infrastructure', 'developer'],
    marketing: ['marketing', 'cmo', 'brand', 'growth', 'demand', 'content', 'communications'],
    sales: ['sales', 'revenue', 'cro', 'account', 'business development', 'partnerships'],
    ops: ['operations', 'coo', 'supply chain', 'logistics', 'procurement'],
    legal: ['legal', 'counsel', 'compliance', 'risk', 'regulatory']
  };

  // Find which term set matches the search titles
  let matchedTerms = null;
  for (const [, terms] of Object.entries(termSets)) {
    if (searchTitles.some(t => terms.some(kw => t.toLowerCase().includes(kw)))) {
      matchedTerms = terms;
      break;
    }
  }

  if (!matchedTerms) return true; // unknown function — don't filter

  // Job title must contain a function keyword OR be senior leadership
  const seniorGeneralist = ['ceo', 'president', 'chief of staff', 'managing director', 'general manager', 'vp ', 'vice president', 'svp', 'evp', 'director', 'chro', 'cpo', 'head of'];
  const isSenior = seniorGeneralist.some(t => normalized.includes(t));
  const hasFunction = matchedTerms.some(kw => normalized.includes(kw));

  return hasFunction || isSenior;
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
// Smart resume body detection
function getResumeBody(resumeText) {
  if (!resumeText) return '';
  const headers = [/\bSUMMARY\b/i, /\bPROFESSIONAL SUMMARY\b/i, /\bEXECUTIVE SUMMARY\b/i,
    /\bPROFILE\b/i, /\bOBJECTIVE\b/i, /\bEXPERIENCE\b/i, /\bPROFESSIONAL EXPERIENCE\b/i,
    /\bWORK EXPERIENCE\b/i, /\bEMPLOYMENT\b/i, /\bSKILLS\b/i, /\bKEY SKILLS\b/i, /\bCORE COMPETENCIES\b/i];
  let earliest = resumeText.length;
  for (const p of headers) {
    const m = resumeText.search(p);
    if (m !== -1 && m < earliest) earliest = m;
  }
  const skipTo = Math.max(Math.min(earliest, 400), 50);
  console.log(`📄 Resume body starts at char ${skipTo} of ${resumeText.length}`);
  return resumeText.slice(skipTo);
}

function detectSeniorityFromResume(resumeText) {
  if (!resumeText || resumeText.length < 50) {
    console.log('📊 No resume — defaulting to senior');
    return 'senior';
  }

  const body = getResumeBody(resumeText);

  // Extract text segments that look like job title lines
  // Split on newlines, pipes, bullets, dashes, em-dashes
  const segments = body
    .split(/[\n\r\|•·–—]+/)
    .map(s => s.trim())
    .filter(s => s.length > 5 && s.length < 80)
    .filter(s => !s.includes('@'))
    .filter(s => !/^\d/.test(s))
    .filter(s => !/[.?!]$/.test(s))
    .filter(s => !/\b(and|or|but|for|with|the|of|in|at|to|a|an)\b.*\b(and|or|but|for|with|the|of|in|at|to|a|an)\b/i.test(s));

  console.log(`📄 Title candidate segments: ${segments.length}`);

  // Title patterns — only match at START of segment
  // "Partnering with CEO" won't match; "Director, Talent Development" will
  const titleLevels = [
    {
      level: 'csuite', score: 10,
      patterns: [
        /^chief\s+\w+\s+officer/i,
        /^(ceo|coo|cto|cmo|chro|cpo|cfo|cro|cdo|cio)$/i,
        /^(ceo|coo|cto|cmo|chro|cpo|cfo|cro|cdo|cio)[,\s]/i,
        /^(founder|co-founder|president)$/i,
        /^(founder|co-founder|president)[,\s]/i,
        /^managing director/i
      ]
    },
    {
      level: 'svp', score: 8,
      patterns: [/^senior vice president/i, /^svp\b/i, /^executive vice president/i, /^evp\b/i]
    },
    {
      level: 'vp', score: 6,
      patterns: [/^vice president/i, /^vp\s+of/i, /^vp,/i, /^vp\s+\w/i, /^head of/i, /^global head/i]
    },
    {
      level: 'director', score: 4,
      patterns: [/^director\s+of/i, /^director,/i, /^senior director/i, /^regional director/i, /^national director/i]
    },
    {
      level: 'senior', score: 2,
      patterns: [/^senior\s+(?:manager|consultant|advisor|specialist|analyst|strategist|lead|partner|talent)/i, /^principal\b/i, /^lead\s+\w/i, /^staff\s+\w/i]
    },
    {
      level: 'manager', score: 1,
      patterns: [/^(?:\w+\s+)?manager\b/i, /^consultant\b/i, /^advisor\b/i, /^specialist\b/i]
    }
  ];

  let highestLevel = null;
  let highestScore = 0;

  for (const segment of segments) {
    for (const { level, score, patterns } of titleLevels) {
      if (patterns.some(p => p.test(segment))) {
        console.log(`  📌 Title match: "${segment}" → ${level}`);
        if (score > highestScore) {
          highestScore = score;
          highestLevel = level;
        }
        break;
      }
    }
  }

  // If no title segments found — try scanning continuous text
  // but only for very explicit own-title patterns
  if (!highestLevel) {
    console.log('📄 No title segments found — scanning continuous text');
    const ownTitlePatterns = [
      { level: 'director', score: 4, pattern: /\b(?:served|serve|working|work|acted|act)\s+as\s+(?:a\s+)?director/i },
      { level: 'director', score: 4, pattern: /\bmy\s+role\s+as\s+(?:a\s+)?director/i },
      { level: 'senior', score: 2, pattern: /\b(?:served|serve|working|work)\s+as\s+(?:a\s+)?senior/i },
      { level: 'manager', score: 1, pattern: /\b(?:served|serve|working|work)\s+as\s+(?:a\s+)?manager/i }
    ];
    for (const { level, score, pattern } of ownTitlePatterns) {
      if (pattern.test(body)) {
        console.log(`  📌 Own-title pattern matched: ${level}`);
        if (score > highestScore) {
          highestScore = score;
          highestLevel = level;
        }
      }
    }
  }

  if (!highestLevel) {
    console.log('📊 No seniority detected — defaulting to senior');
    highestLevel = 'senior';
  }

  // One-level-down rule
  const searchLevel = {
    csuite: 'vp',
    svp: 'director',
    vp: 'director',
    director: 'senior',
    senior: 'senior',
    manager: 'manager'
  };

  const finalLevel = searchLevel[highestLevel] || 'senior';
  console.log(`📊 Detected: ${highestLevel} → Searching at: ${finalLevel}`);
  return finalLevel;
}

function isFundraisingDevelopment(job) {
  const title = (job.job_title || '').toLowerCase();
  const desc = (job.job_description || '').substring(0, 400).toLowerCase();

  // Title patterns that universally indicate fundraising
  const fundraisingTitlePatterns = [
    // "X of Development" where X is a seniority title = fundraising ~95% of the time
    /\b(?:svp|evp|vp|vice president|director|senior director|executive director|president|officer|manager|associate|coordinator|specialist)\s+of\s+development\b/i,
    // "Development Director/Officer/Manager" = fundraising
    /\bdevelopment\s+(?:director|officer|manager|associate|coordinator|executive|lead|specialist)\b/i,
    // Explicit fundraising terms in title
    /\bmajor\s+gifts?\b/i,
    /\bannual\s+(?:fund|giving|campaign)\b/i,
    /\bplanned\s+giving\b/i,
    /\bdonor\s+(?:relations?|engagement|stewardship|services?)\b/i,
    /\bfundraising\b/i,
    /\bphilanthrop/i,
    /\bgrant\s+(?:writing|management|development|making)\b/i,
    /\bcorporate\s+(?:giving|philanthropy|relations)\b/i
  ];

  // Check title first — L&D keywords override
  const ldKeywords = ['learning', 'talent', 'training', 'organizational', 'leadership', 'people', 'workforce', 'l&d', 'coaching', 'curriculum', 'instructional', 'facilitati'];
  const hasLDKeyword = ldKeywords.some(kw => title.includes(kw) || desc.includes(kw));

  // If title matches a fundraising pattern and no L&D keywords → filter
  if (!hasLDKeyword && fundraisingTitlePatterns.some(p => p.test(title))) {
    return true;
  }

  // Original description-based check for titles containing "development"
  if (!title.includes('development')) return false;
  if (hasLDKeyword) return false;
  const fundraisingDescSignals = ['nonprofit', 'non-profit', 'foundation', 'association', 'fundrais', 'donor', 'philanthrop', 'major gifts', 'annual fund', 'capital campaign', 'endowment', 'stewardship', '501', 'charitable'];
  return fundraisingDescSignals.some(kw => desc.includes(kw));
}

function detectSearchFunction(titles) {
  const text = titles.join(' ').toLowerCase();

  // Pre-check: explicit People/L&D patterns that commonly fail the main regex
  // These catch titles with unusual word combinations like "Talent and Leadership Development Partner"
  const explicitPeoplePatterns = [
    /talent.*partner/i, /talent.*development/i, /talent.*lead/i,
    /talent\s+and\s+leadership/i, /talent\s+&\s+leadership/i,
    /talent\s+(?:and|&)?\s*(?:leadership|learning|organizational)\s+development/i,
    /leadership.*development/i, /senior\s+leadership\s+development/i,
    /leadership\s+development\s+(?:partner|architect|manager|lead|director|specialist|consultant|advisor|strategist)/i,
    /learning.*development/i,
    /learning\s+development\s+(?:partner|architect|manager|lead|director|specialist|consultant|advisor|strategist)/i,
    /learning.*designer/i, /learning.*architect/i, /learning.*strategist/i,
    /people.*lead/i, /people.*partner/i, /people.*advisor/i, /people.*consultant/i,
    /people\s+leader\s+impact/i, /people\s+impact/i,
    /organizational.*development/i, /organisation.*development/i,
    /development.*architect/i, /development.*strategist/i, /development.*partner/i,
    /performance.*development/i, /performance.*consulting/i, /performance.*partner/i,
    /culture.*partner/i, /culture.*lead/i, /culture.*consultant/i, /culture.*manager/i,
    /engagement.*partner/i, /engagement.*lead/i, /engagement.*consultant/i, /engagement.*manager/i,
    /workforce.*development/i, /workforce.*planning/i, /workforce.*consultant/i, /workforce.*partner/i,
    /capability.*development/i, /capability.*building/i, /capability.*partner/i,
    /change\s+(?:management|lead|partner|consultant)/i
  ];
  if (explicitPeoplePatterns.some(p => p.test(text))) {
    console.log(`✅ Function detected via explicit pattern: People for "${titles.join(', ')}"`);
    return 'People';
  }

  if (/(learning|training|talent|people|hr|organizational|workforce|l&d|coaching|leadership development|human capital)/i.test(text)) return 'People';
  if (/(marketing|brand|growth|demand|content|communications|seo)/i.test(text)) return 'Marketing';
  if (/(engineering|software|developer|technical|data science|devops|platform)/i.test(text)) return 'Engineering';
  if (/(product|ux|user experience)/i.test(text)) return 'Product';
  if (/(sales|revenue|business development|account management)/i.test(text)) return 'Sales';
  if (/(finance|accounting|fp&a|treasury)/i.test(text)) return 'Finance';
  if (/(operations|supply chain|logistics|strategy.*operations)/i.test(text)) return 'Operations';
  if (/(legal|compliance|counsel|regulatory)/i.test(text)) return 'Legal';
  if (/(data|analytics|business intelligence)/i.test(text)) return 'Data';
  return 'General';
}

function detectSearchSeniority(titles) {
  const text = titles.join(' ').toLowerCase();
  if (/(vp|vice president|svp|evp|chief|cmo|cto|coo|ceo|chro|cpo|cro)/i.test(text)) return 'executive';
  if (/\bdirector\b/i.test(text)) return 'director';
  if (/\bsenior\b|\bsr\b|\blead\b|\bmanager\b|\bhead of\b/i.test(text)) return 'senior';
  return 'any';
}

// getSeniority removed — JSearch job_requirements param only accepts
// under_3_years_experience, more_than_3_years_experience, no_experience, no_degree
// Our custom values (vp, executive, etc.) caused 400 errors on every query.
// Seniority filtering is handled post-JSearch by detectSeniorityFromResume instead.

// ── 5. Resume keyword extraction ──
// Comprehensive skill regex
const SKILL_REGEX = /leadership development|talent development|talent management|learning and development|l&d|organizational development|organizational design|organizational effectiveness|executive coaching|career coaching|career development|change management|performance management|succession planning|employee engagement|employee relations|culture transformation|workforce development|workforce planning|people analytics|hrbp|hr business partner|human resources|people operations|people strategy|talent acquisition|recruiting|compensation|benefits|facilitation|instructional design|curriculum design|adult learning|360 feedback|team effectiveness|demand generation|demand gen|brand strategy|brand marketing|content strategy|content marketing|growth marketing|digital marketing|performance marketing|product management|product strategy|user experience|agile|scrum|software engineering|software development|devops|cloud|data science|machine learning|business intelligence|sales strategy|revenue growth|business development|account management|enterprise sales|customer success|financial planning|fp&a|financial modeling|process improvement|supply chain|project management|program management|six sigma|lean|cross-functional|transformation|saas|b2b|startup|enterprise|fortune 500|consulting|advisory/gi;

function extractResumeKeywords(resumeText) {
  if (!resumeText || resumeText.length < 100) {
    console.log('⚠️ Resume too short or empty — skipping keyword search');
    return null;
  }
  const body = getResumeBody(resumeText);
  const skillMatches = [...new Set((body.match(SKILL_REGEX) || []).map(s => s.toLowerCase().trim()))];
  SKILL_REGEX.lastIndex = 0; // reset global regex
  console.log(`📄 Raw keyword matches: ${skillMatches.length} terms found`);

  if (skillMatches.length >= 2) {
    const meaningful = skillMatches.filter(k => k.length > 4).filter(k => !['executive','strategic','senior','leader','enterprise'].includes(k)).slice(0, 6);
    if (meaningful.length >= 2) {
      console.log(`📄 Resume keywords: ${meaningful.join(', ')}`);
      return meaningful.join(' ');
    }
  }

  // Fallback: capitalized phrases
  const phrases = [...new Set((body.match(/[A-Z][a-z]{3,}(?:\s+[A-Z][a-z]{3,})+/g) || [])
    .filter(p => p.length > 8)
    .filter(p => !/^(January|February|March|April|May|June|July|August|September|October|November|December|Present|Current)/.test(p))
  )].slice(0, 4);

  if (phrases.length >= 2) {
    console.log(`📄 Resume keywords (phrase fallback): ${phrases.join(', ')}`);
    return phrases.join(' ');
  }

  console.log('⚠️ Resume keyword extraction returned too few keywords — skipping');
  return null;
}
