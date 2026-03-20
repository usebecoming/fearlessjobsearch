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

    // Limit to 3 URLs max
    const toFetch = urls.slice(0, 3);
    const results = [];

    for (const url of toFetch) {
      try {
        console.log('Fetching anchor URL:', url);

        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; FearlessJobSearch/1.0)',
            'Accept': 'text/html,application/xhtml+xml',
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(8000)
        });

        if (!response.ok) {
          console.log('Fetch failed:', response.status);
          results.push({ url, text: '', error: `Could not fetch (${response.status})` });
          continue;
        }

        const html = await response.text();

        // Extract text content from HTML
        const text = extractJobText(html);
        console.log(`Extracted ${text.length} chars from ${url}`);

        results.push({
          url,
          text: text.substring(0, 2000), // Cap at 2000 chars
          title: extractTitle(html)
        });
      } catch (e) {
        console.log('Fetch error for', url, ':', e.message);
        results.push({ url, text: '', error: e.message });
      }
    }

    return res.status(200).json({ results });
  } catch (err) {
    console.error('Fetch job error:', err);
    return res.status(500).json({ error: 'Failed to fetch job links' });
  }
}

function extractJobText(html) {
  // Remove script, style, nav, header, footer tags and their content
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

  // Convert common elements to readable text
  text = text
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

  // Clean up whitespace
  text = text
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line.length > 10)
    .join('\n');

  return text.trim();
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (match) {
    return match[1].replace(/\s+/g, ' ').trim().substring(0, 200);
  }
  return '';
}
