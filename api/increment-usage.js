import { rateLimit } from './_rateLimit.js';
import { verifyUser } from './_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rl = rateLimit(req, { maxRequests: 10, windowMs: 60000 });
  if (!rl.allowed) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseServiceKey) {
    return res.status(200).json({ ok: true });
  }

  try {
    const auth = await verifyUser(req);
    if (auth.error) {
      return res.status(401).json({ error: auth.error });
    }
    const user_id = auth.userId;

    // Get current count
    const getRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${user_id}&select=search_count_month`,
      {
        headers: {
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`
        }
      }
    );

    const profiles = await getRes.json();
    const currentCount = profiles[0]?.search_count_month || 0;

    // Increment
    await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${user_id}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          search_count_month: currentCount + 1
        })
      }
    );

    return res.status(200).json({ ok: true, count: currentCount + 1 });
  } catch (err) {
    console.error('Increment usage error:', err);
    return res.status(200).json({ ok: true });
  }
}
