import { rateLimit } from './_rateLimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rl = rateLimit(req, { maxRequests: 2, windowMs: 60000 });
  if (!rl.allowed) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseServiceKey) {
    return res.status(500).json({ error: 'Not configured' });
  }

  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'User ID required' });
    }

    console.log(`🗑️ Deleting account: ${userId}`);

    // Delete from all user tables (service key bypasses RLS)
    const tables = ['pipeline', 'search_profiles', 'usage_log', 'favorites'];
    for (const table of tables) {
      await fetch(
        `${supabaseUrl}/rest/v1/${table}?user_id=eq.${userId}`,
        {
          method: 'DELETE',
          headers: {
            'apikey': supabaseServiceKey,
            'Authorization': `Bearer ${supabaseServiceKey}`,
            'Prefer': 'return=minimal'
          }
        }
      );
    }

    // Delete profile
    await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${userId}`,
      {
        method: 'DELETE',
        headers: {
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`,
          'Prefer': 'return=minimal'
        }
      }
    );

    // Delete auth user via Supabase Admin API
    await fetch(
      `${supabaseUrl}/auth/v1/admin/users/${userId}`,
      {
        method: 'DELETE',
        headers: {
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`
        }
      }
    );

    console.log(`✅ Account deleted: ${userId}`);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Delete account error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
