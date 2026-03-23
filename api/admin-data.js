import { verifyUser } from './_auth.js';
import { isAdmin } from './_plans.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify authenticated user
  const auth = await verifyUser(req);
  if (auth.error) {
    return res.status(401).json({ error: auth.error });
  }

  // Admin only
  if (!isAdmin(auth.email)) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Fetch all data in parallel using service key (bypasses RLS)
    const [profilesRes, logsRes, pipelineRes, cacheRes] = await Promise.all([
      fetch(`${supabaseUrl}/rest/v1/profiles?select=*`, {
        headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` }
      }),
      fetch(`${supabaseUrl}/rest/v1/usage_log?select=*&created_at=gte.${thirtyDaysAgo}&order=created_at.desc`, {
        headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` }
      }),
      fetch(`${supabaseUrl}/rest/v1/pipeline_jobs?select=user_id`, {
        headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` }
      }),
      fetch(`${supabaseUrl}/rest/v1/contact_cache?select=company_key,hit_count,created_at`, {
        headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` }
      })
    ]);

    const profiles = profilesRes.ok ? await profilesRes.json() : [];
    const logs = logsRes.ok ? await logsRes.json() : [];
    const pipeline = pipelineRes.ok ? await pipelineRes.json() : [];
    const cache = cacheRes.ok ? await cacheRes.json() : [];

    // Get user emails from auth.users via admin API
    const usersRes = await fetch(`${supabaseUrl}/auth/v1/admin/users?per_page=100`, {
      headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` }
    });
    const usersData = usersRes.ok ? await usersRes.json() : { users: [] };
    const authUsers = usersData.users || [];

    // Build user map with emails
    const userMap = {};
    authUsers.forEach(u => {
      userMap[u.id] = {
        email: u.email,
        created_at: u.created_at
      };
    });

    // Enrich profiles with emails
    const enrichedProfiles = profiles.map(p => ({
      ...p,
      email: userMap[p.id]?.email || 'unknown',
      signup_date: userMap[p.id]?.created_at || p.created_at
    }));

    return res.status(200).json({
      profiles: enrichedProfiles,
      logs,
      pipeline_count: pipeline.length,
      cache_entries: cache.length,
      cache_total_hits: cache.reduce((sum, c) => sum + (c.hit_count || 0), 0)
    });

  } catch (err) {
    console.error('Admin data error:', err);
    return res.status(500).json({ error: 'Failed to load admin data' });
  }
}
