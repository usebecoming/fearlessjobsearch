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

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!stripeKey) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  try {
    const auth = await verifyUser(req);
    if (auth.error) {
      return res.status(401).json({ error: auth.error });
    }
    const userId = auth.userId;
    const { returnUrl } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID required' });
    }

    // Get stripe_customer_id from Supabase
    const profileRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${userId}&select=stripe_customer_id`,
      {
        headers: {
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`
        }
      }
    );

    const profiles = await profileRes.json();
    const stripeCustomerId = profiles?.[0]?.stripe_customer_id;

    if (!stripeCustomerId) {
      return res.status(400).json({ error: 'No billing account found. Please subscribe first.' });
    }

    // Create Stripe billing portal session
    const origin = req.headers.origin || 'https://fearlessjobsearch.com';
    const portalRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        'customer': stripeCustomerId,
        'return_url': returnUrl || origin
      }).toString()
    });

    if (!portalRes.ok) {
      const err = await portalRes.json().catch(() => ({}));
      return res.status(portalRes.status).json({ error: err.error?.message || 'Billing portal error' });
    }

    const session = await portalRes.json();
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Billing portal error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
