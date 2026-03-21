// Persistent cache for contact and outreach results
// Contact cache is SHARED across users (same company = same contacts)
// Outreach cache is USER-SCOPED (personalized to each resume)

const CONTACT_TTL_HOURS = 48;
const OUTREACH_TTL_HOURS = 72;

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

async function supabaseQuery(path, options = {}) {
  const sb = getSupabase();
  if (!sb) return null;

  const res = await fetch(`${sb.url}/rest/v1/${path}`, {
    ...options,
    headers: {
      'apikey': sb.key,
      'Authorization': `Bearer ${sb.key}`,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || 'return=minimal',
      ...(options.headers || {})
    }
  });
  return res;
}

function buildCompanyKey(companyName, jobFunction) {
  const normalized = (companyName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  const fn = (jobFunction || 'general').toLowerCase();
  return `${normalized}_${fn}`;
}

function buildContactKey(linkedinUrl, company) {
  const slug = (linkedinUrl || '')
    .replace(/.*linkedin\.com\/in\//, '')
    .replace(/\/$/, '')
    .replace(/[^a-z0-9_-]/gi, '');
  const co = (company || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return `${slug}_${co}`;
}

// ── CONTACT CACHE (shared across users) ──

export async function getContactCache(companyName, jobFunction) {
  try {
    const key = buildCompanyKey(companyName, jobFunction);
    const now = new Date().toISOString();

    const res = await supabaseQuery(
      `contact_cache?company_key=eq.${encodeURIComponent(key)}&expires_at=gt.${now}&select=contacts,fallback_links,company_slug,hit_count,created_at`,
      { prefer: 'return=representation' }
    );

    if (!res || !res.ok) return null;
    const rows = await res.json();
    if (!rows || rows.length === 0) return null;

    const data = rows[0];

    // Increment hit count async — fire and forget
    supabaseQuery(
      `contact_cache?company_key=eq.${encodeURIComponent(key)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ hit_count: (data.hit_count || 0) + 1 })
      }
    ).catch(() => {});

    console.log(`💾 Contact cache HIT: ${key} (served ${(data.hit_count || 0) + 1} times)`);

    return {
      contacts: data.contacts || [],
      fallbackLinks: data.fallback_links,
      companySlug: data.company_slug,
      cachedAt: data.created_at,
      fromCache: true
    };
  } catch (err) {
    console.error(`Contact cache read error: ${err.message}`);
    return null;
  }
}

export async function setContactCache(
  companyName,
  jobFunction,
  contacts,
  fallbackLinks,
  companySlug,
  braveQueryCount = 0
) {
  try {
    const key = buildCompanyKey(companyName, jobFunction);
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + CONTACT_TTL_HOURS);

    await supabaseQuery(
      `contact_cache?on_conflict=company_key`,
      {
        method: 'POST',
        body: JSON.stringify({
          company_key: key,
          company_raw: companyName,
          job_function: jobFunction,
          contacts: contacts,
          fallback_links: fallbackLinks,
          company_slug: companySlug,
          brave_query_count: braveQueryCount,
          expires_at: expiresAt.toISOString(),
          hit_count: 0
        }),
        prefer: 'resolution=merge-duplicates,return=minimal'
      }
    );

    console.log(`💾 Contact cache SET: ${key} (${contacts.length} contacts, ${braveQueryCount} Brave queries saved next time)`);
  } catch (err) {
    console.error(`Contact cache write error: ${err.message}`);
  }
}

// ── OUTREACH CACHE (per user) ──

export async function getOutreachCache(userId, linkedinUrl, company) {
  try {
    const key = buildContactKey(linkedinUrl, company);

    const res = await supabaseQuery(
      `outreach_cache?user_id=eq.${userId}&contact_key=eq.${encodeURIComponent(key)}&expires_at=gt.${new Date().toISOString()}&select=messages,created_at`,
      { prefer: 'return=representation' }
    );

    if (!res || !res.ok) return null;
    const rows = await res.json();
    if (!rows || rows.length === 0) return null;

    console.log(`💾 Outreach cache HIT: ${key}`);
    return { messages: rows[0].messages, cachedAt: rows[0].created_at, fromCache: true };
  } catch (err) {
    console.error(`Outreach cache read error: ${err.message}`);
    return null;
  }
}

export async function setOutreachCache(userId, linkedinUrl, company, messages) {
  try {
    const key = buildContactKey(linkedinUrl, company);
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + OUTREACH_TTL_HOURS);

    // Use upsert on user_id + contact_key
    await supabaseQuery(
      `outreach_cache`,
      {
        method: 'POST',
        body: JSON.stringify({
          user_id: userId,
          contact_key: key,
          messages: messages,
          expires_at: expiresAt.toISOString()
        }),
        prefer: 'resolution=merge-duplicates,return=minimal',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' }
      }
    );

    console.log(`💾 Outreach cache SET: ${key}`);
  } catch (err) {
    console.error(`Outreach cache write error: ${err.message}`);
  }
}

// ── CACHE INVALIDATION ──

export async function invalidateContactCache(companyName, jobFunction) {
  try {
    const key = buildCompanyKey(companyName, jobFunction);
    await supabaseQuery(
      `contact_cache?company_key=eq.${encodeURIComponent(key)}`,
      { method: 'DELETE' }
    );
    console.log(`🗑️ Contact cache invalidated: ${key}`);
  } catch (err) {
    console.error(`Cache invalidation error: ${err.message}`);
  }
}

export async function invalidateOutreachCache(userId, linkedinUrl, company) {
  try {
    const key = buildContactKey(linkedinUrl, company);
    await supabaseQuery(
      `outreach_cache?user_id=eq.${userId}&contact_key=eq.${encodeURIComponent(key)}`,
      { method: 'DELETE' }
    );
    console.log(`🗑️ Outreach cache invalidated: ${key}`);
  } catch (err) {
    console.error(`Cache invalidation error: ${err.message}`);
  }
}

export async function deleteUserOutreachCache(userId) {
  try {
    await supabaseQuery(
      `outreach_cache?user_id=eq.${userId}`,
      { method: 'DELETE' }
    );
    console.log(`🗑️ All outreach cache deleted for user: ${userId}`);
  } catch (err) {
    console.error(`User outreach cache deletion error: ${err.message}`);
  }
}

export { buildCompanyKey, buildContactKey };
