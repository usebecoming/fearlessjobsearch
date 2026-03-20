import { rateLimit } from './_rateLimit.js';

const ADMIN_EMAILS = ['ritterbenjamin@gmail.com', 'ben@liveforyourselfconsulting.com'];

const PLAN_LIMITS = {
  free: 0,
  starter: 1,
  pro: 4,
  unlimited: 999999
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rl = rateLimit(req, { maxRequests: 10, windowMs: 60000 });
  if (!rl.allowed) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tgicomrycbhrinobvnlr.supabase.co';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseServiceKey) {
    // If no service key, allow all (dev mode)
    return res.status(200).json({ allowed: true, plan: 'unlimited', searches_remaining: 999 });
  }

  try {
    const { user_id, email } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'User ID required' });
    }

    // Admin bypass
    if (email && ADMIN_EMAILS.includes(email)) {
      return res.status(200).json({ allowed: true, plan: 'unlimited', searches_remaining: 999, admin: true });
    }

    // Fetch user profile
    const profileRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${user_id}&select=plan,subscription_status,search_count_month,search_reset_date`,
      {
        headers: {
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`
        }
      }
    );

    if (!profileRes.ok) {
      console.error('Profile fetch error:', profileRes.status);
      return res.status(200).json({ allowed: true, plan: 'free', searches_remaining: 0 });
    }

    const profiles = await profileRes.json();
    const profile = profiles[0];

    if (!profile) {
      return res.status(200).json({ allowed: false, plan: 'free', searches_remaining: 0, reason: 'No profile found' });
    }

    let plan = profile.plan || 'free';
    let searchCount = profile.search_count_month || 0;
    let resetDate = profile.search_reset_date ? new Date(profile.search_reset_date) : null;
    const subStatus = profile.subscription_status || '';

    // Past due = treat as free
    if (subStatus === 'past_due') {
      plan = 'free';
    }

    // Cancelled = treat as free
    if (subStatus === 'cancelled') {
      plan = 'free';
    }

    // Check if reset date has passed - reset counter
    const now = new Date();
    if (resetDate && now > resetDate) {
      searchCount = 0;
      resetDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days from now

      // Update in Supabase
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
            search_count_month: 0,
            search_reset_date: resetDate.toISOString()
          })
        }
      );
    }

    // If no reset date set yet, set one
    if (!resetDate) {
      resetDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
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
            search_reset_date: resetDate.toISOString()
          })
        }
      );
    }

    const limit = PLAN_LIMITS[plan] || 0;
    const remaining = Math.max(0, limit - searchCount);
    const allowed = searchCount < limit;

    return res.status(200).json({
      allowed,
      plan,
      searches_used: searchCount,
      searches_remaining: remaining,
      searches_limit: limit,
      resets_at: resetDate ? resetDate.toISOString() : null,
      reason: allowed ? null : `You've used your ${limit} search${limit !== 1 ? 'es' : ''} this month. Upgrade for more.`
    });
  } catch (err) {
    console.error('Check usage error:', err);
    // Fail open - allow the search
    return res.status(200).json({ allowed: true, plan: 'free', searches_remaining: 0 });
  }
}
