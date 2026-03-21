import { rateLimit } from './_rateLimit.js';
import { getPlan, isAdmin } from './_plans.js';

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
    return res.status(200).json({ allowed: true, plan: 'unlimited', searches_remaining: 999 });
  }

  try {
    const { user_id, email, action } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'User ID required' });
    }

    // Admin bypass
    if (isAdmin(email)) {
      return res.status(200).json({ allowed: true, plan: 'unlimited', searches_remaining: 999, admin: true });
    }

    // Fetch user profile
    const profileRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${user_id}&select=plan,subscription_status,search_count_month,search_reset_date,current_period_end`,
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

    let planKey = profile.plan || 'free';
    let searchCount = profile.search_count_month || 0;
    let resetDate = profile.search_reset_date ? new Date(profile.search_reset_date) : null;
    const subStatus = profile.subscription_status || '';

    // Inactive subscriptions = free tier
    if (planKey !== 'free' && !['active', 'trialing'].includes(subStatus)) {
      planKey = 'free';
    }

    const plan = getPlan(planKey);

    // Reset monthly count if new month
    const now = new Date();
    if (resetDate && now > resetDate) {
      searchCount = 0;
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
          body: JSON.stringify({ search_count_month: 0, search_reset_date: resetDate.toISOString() })
        }
      );
    }

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
          body: JSON.stringify({ search_reset_date: resetDate.toISOString() })
        }
      );
    }

    // Action-based gating
    switch (action) {
      case 'search_jobs':
        if (searchCount >= plan.searches_per_month) {
          return res.status(200).json({
            allowed: false,
            reason: 'search_limit_reached',
            limit: plan.searches_per_month,
            used: searchCount,
            plan: planKey,
            upgrade_required: true
          });
        }
        return res.status(200).json({
          allowed: true,
          plan: planKey,
          searches_used: searchCount,
          searches_remaining: plan.searches_per_month - searchCount,
          searches_limit: plan.searches_per_month,
          resets_at: resetDate ? resetDate.toISOString() : null
        });

      case 'find_contacts':
        if (!plan.contacts_enabled) {
          return res.status(200).json({
            allowed: false,
            reason: 'contacts_not_on_plan',
            plan: planKey,
            upgrade_required: true,
            minimum_plan: 'starter'
          });
        }
        return res.status(200).json({ allowed: true, plan: planKey });

      case 'generate_outreach':
        if (!plan.outreach_enabled) {
          return res.status(200).json({
            allowed: false,
            reason: 'outreach_not_on_plan',
            plan: planKey,
            upgrade_required: true,
            minimum_plan: 'starter'
          });
        }
        return res.status(200).json({ allowed: true, plan: planKey });

      case 'company_target':
        if (!plan.company_target_enabled) {
          return res.status(200).json({
            allowed: false,
            reason: 'company_target_not_on_plan',
            plan: planKey,
            upgrade_required: true,
            minimum_plan: 'pro'
          });
        }
        return res.status(200).json({ allowed: true, plan: planKey });

      default:
        // Default: check search limit (backwards compat)
        const remaining = Math.max(0, plan.searches_per_month - searchCount);
        return res.status(200).json({
          allowed: searchCount < plan.searches_per_month,
          plan: planKey,
          searches_used: searchCount,
          searches_remaining: remaining,
          searches_limit: plan.searches_per_month,
          resets_at: resetDate ? resetDate.toISOString() : null,
          reason: searchCount >= plan.searches_per_month ? `You've used your ${plan.searches_per_month} search${plan.searches_per_month !== 1 ? 'es' : ''} this month. Upgrade for more.` : null
        });
    }
  } catch (err) {
    console.error('Check usage error:', err);
    return res.status(200).json({ allowed: true, plan: 'free', searches_remaining: 0 });
  }
}
