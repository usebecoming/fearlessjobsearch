import { rateLimit } from './_rateLimit.js';
import { isAdmin } from './_plans.js';

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
  const stripeKey = process.env.STRIPE_SECRET_KEY;

  if (!supabaseServiceKey) {
    return res.status(500).json({ error: 'Not configured' });
  }

  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'User ID required' });
    }

    console.log(`🗑️ Delete account started: ${userId}`);
    console.log(`🔑 Service key present: ${!!supabaseServiceKey}`);

    // Step 1 — Get profile for Stripe cancellation
    const profileRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${userId}&select=stripe_customer_id,subscription_id,plan`,
      {
        headers: {
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`
        }
      }
    );
    const profiles = await profileRes.json();
    const profile = profiles?.[0];
    console.log(`📋 Profile found: ${!!profile}, plan: ${profile?.plan}, sub: ${profile?.subscription_id}`);

    // Block admin deletion
    if (profile && isAdmin(profile.email)) {
      return res.status(403).json({ error: 'Admin accounts cannot be self-deleted' });
    }

    // Step 2 — Cancel Stripe subscription
    if (stripeKey && profile?.subscription_id && profile?.plan !== 'free') {
      try {
        const stripeRes = await fetch(`https://api.stripe.com/v1/subscriptions/${profile.subscription_id}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${stripeKey}` }
        });
        console.log(`✅ Step 1: Stripe cancel status: ${stripeRes.status}`);
      } catch (e) {
        console.error(`⚠️ Stripe cancellation failed (non-fatal): ${e.message}`);
      }
    } else {
      console.log(`✅ Step 1: No Stripe subscription to cancel`);
    }

    // Step 3 — Delete from all data tables
    const tables = ['pipeline', 'search_profiles', 'usage_log', 'favorites'];
    for (const table of tables) {
      const delRes = await fetch(
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
      console.log(`  Deleted from ${table}: ${delRes.status}`);
    }

    // Delete profile row
    const profDelRes = await fetch(
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
    console.log(`✅ Step 2: Data tables cleared, profile delete: ${profDelRes.status}`);

    // Step 4 — Delete auth user
    const authDelRes = await fetch(
      `${supabaseUrl}/auth/v1/admin/users/${userId}`,
      {
        method: 'DELETE',
        headers: {
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`
        }
      }
    );
    const authDelStatus = authDelRes.status;
    const authDelBody = await authDelRes.text();
    console.log(`Auth delete response: ${authDelStatus} — ${authDelBody}`);

    if (authDelStatus >= 400) {
      console.error(`❌ Step 3: Auth user deletion failed: ${authDelStatus} ${authDelBody}`);
      return res.status(500).json({
        success: false,
        error: `Data deleted but auth user deletion failed (${authDelStatus}). Contact support.`
      });
    }

    console.log(`✅ Step 3: Auth user deleted`);
    console.log(`✅ Account fully deleted: ${userId}`);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('❌ Delete account error:', err);
    return res.status(500).json({ error: err.message || 'Something went wrong.' });
  }
}
