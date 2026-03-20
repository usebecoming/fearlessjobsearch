import { rateLimit } from './_rateLimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rl = rateLimit(req, { maxRequests: 3, windowMs: 60000 });
  if (!rl.allowed) {
    return res.status(429).json({ error: 'Too many requests. Please wait and try again.' });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  try {
    const { plan, email, userId } = req.body;

    const prices = {
      starter: process.env.STRIPE_PRICE_STARTER,
      pro: process.env.STRIPE_PRICE_PRO,
      unlimited_monthly: process.env.STRIPE_PRICE_UNLIMITED_MONTHLY,
      unlimited_yearly: process.env.STRIPE_PRICE_UNLIMITED_YEARLY
    };

    const priceId = prices[plan];
    if (!priceId) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const origin = req.headers.origin || 'https://fearlessjobsearch.com';

    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        'mode': 'subscription',
        'success_url': `${origin}?checkout=success`,
        'cancel_url': `${origin}?checkout=cancel`,
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': '1',
        ...(email ? { 'customer_email': email } : {}),
        'metadata[user_id]': userId || '',
        'metadata[plan]': plan
      }).toString()
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({
        error: err.error?.message || 'Stripe error'
      });
    }

    const session = await response.json();
    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
