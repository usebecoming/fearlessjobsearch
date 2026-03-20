import { rateLimit } from './_rateLimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rl = rateLimit(req, { maxRequests: 10, windowMs: 60000 });
  if (!rl.allowed) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  try {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'No URLs provided' });
    }

    const rapidApiKey = process.env.RAPIDAPI_KEY;
    const toFetch = urls.slice(0, 3);
    const results = [];

    console.log(`\n🔗 ANCHOR LINK PROCESSING:`);

    for (const url of toFetch) {
      const parsed = parseAnchorLink(url);
      console.log(`  URL: ${url}`);
      console.log(`  Type: ${parsed.type}`);

      let jobDetails = { found: false };

      // Step 2: LinkedIn job URLs - use JSearch
      if (parsed.type === 'linkedin_job' && rapidApiKey) {
        console.log(`  🔗 Fetching via JSearch: job ID ${parsed.jobId}`);
        try {
          const response = await fetch(
            `https://jsearch.p.rapidapi.com/job-details?job_id=${encodeURIComponent(parsed.jobId)}&extended_publisher_details=false`,
            {
              headers: {
                'X-RapidAPI-Key': rapidApiKey,
                'X-RapidAPI-Host': 'jsearch.p.rapidapi.com'
              }
            }
          );
          if (response.ok) {
            const data = await response.json();
            const job = (data.data || [])[0];
            if (job) {
              console.log(`  ✅ Fetched: ${job.job_title} at ${job.employer_name}`);
              jobDetails = {
                found: true,
                source: 'jsearch',
                title: job.job_title || '',
                company: job.employer_name || '',
                description: (job.job_description || '').substring(0, 2000),
                location: job.job_city && job.job_state ? `${job.job_city}, ${job.job_state}` : (job.job_is_remote ? 'Remote' : ''),
                salary: formatSalary(job.job_min_salary, job.job_max_salary),
                seniority: job.job_required_experience?.required_experience_in_months ? Math.round(job.job_required_experience.required_experience_in_months / 12) + '+ years' : '',
                skills: job.job_required_skills || [],
                url: job.job_apply_link || url
              };
            }
          } else {
            console.log(`  ⚠️ JSearch returned ${response.status}`);
          }
        } catch (e) {
          console.log(`  ⚠️ JSearch fetch failed: ${e.message}`);
        }

        // Fallback: try with linkedin- prefix
        if (!jobDetails.found) {
          try {
            const response2 = await fetch(
              `https://jsearch.p.rapidapi.com/job-details?job_id=linkedin-${encodeURIComponent(parsed.jobId)}&extended_publisher_details=false`,
              {
                headers: {
                  'X-RapidAPI-Key': rapidApiKey,
                  'X-RapidAPI-Host': 'jsearch.p.rapidapi.com'
                }
              }
            );
            if (response2.ok) {
              const data2 = await response2.json();
              const job2 = (data2.data || [])[0];
              if (job2) {
                console.log(`  ✅ Fetched (linkedin- prefix): ${job2.job_title} at ${job2.employer_name}`);
                jobDetails = {
                  found: true,
                  source: 'jsearch',
                  title: job2.job_title || '',
                  company: job2.employer_name || '',
                  description: (job2.job_description || '').substring(0, 2000),
                  location: job2.job_city && job2.job_state ? `${job2.job_city}, ${job2.job_state}` : '',
                  url: job2.job_apply_link || url
                };
              }
            }
          } catch (e) {
            console.log(`  ⚠️ JSearch linkedin- prefix failed: ${e.message}`);
          }
        }
      }

      // Generic URLs - try direct fetch
      if (!jobDetails.found) {
        console.log(`  🌐 Trying direct fetch: ${url}`);
        try {
          const response = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; FearlessJobSearch/1.0)',
              'Accept': 'text/html,application/xhtml+xml',
            },
            redirect: 'follow',
            signal: AbortSignal.timeout(8000)
          });

          if (response.ok) {
            const html = await response.text();
            const text = extractJobText(html);
            const pageTitle = extractTitle(html);
            if (text.length > 50) {
              console.log(`  ✅ Direct fetch: ${text.length} chars extracted`);
              jobDetails = {
                found: true,
                source: 'direct',
                title: pageTitle.split(/\s*[-|]\s*/)[0].trim(),
                text: text.substring(0, 2000),
                description: text.substring(0, 2000),
                url
              };
            }
          }
        } catch (e) {
          console.log(`  ⚠️ Direct fetch failed: ${e.message}`);
        }
      }

      console.log(`  Result: ${jobDetails.found ? '✅ Found' : '❌ Not found'}`);
      if (jobDetails.found) {
        console.log(`  Title: ${jobDetails.title || 'unknown'}`);
        console.log(`  Company: ${jobDetails.company || 'unknown'}`);
      }

      results.push({
        url,
        ...jobDetails
      });
    }

    return res.status(200).json({ results });
  } catch (err) {
    console.error('Fetch job error:', err);
    return res.status(500).json({ error: 'Failed to fetch job links' });
  }
}

function parseAnchorLink(url) {
  // LinkedIn job URLs
  const linkedInJobMatch = url.match(/linkedin\.com\/jobs\/view\/[^\/]*?(\d{8,})/);
  if (linkedInJobMatch) {
    return { type: 'linkedin_job', jobId: linkedInJobMatch[1], originalUrl: url };
  }
  // Indeed
  const indeedMatch = url.match(/indeed\.com\/viewjob\?jk=([a-z0-9]+)/i);
  if (indeedMatch) {
    return { type: 'indeed_job', jobId: indeedMatch[1], originalUrl: url };
  }
  return { type: 'generic', originalUrl: url };
}

function formatSalary(min, max) {
  if (!min && !max) return '';
  const fmt = n => n >= 1000 ? `$${Math.round(n / 1000)}K` : `$${n}`;
  if (min && max) return `${fmt(min)} - ${fmt(max)}`;
  if (min) return `${fmt(min)}+`;
  return '';
}

function extractJobText(html) {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(l => l.length > 10).join('\n').trim();
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/\s+/g, ' ').trim().substring(0, 200) : '';
}
