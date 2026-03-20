// Stripe webhook handler
// Listens for: checkout.session.completed, customer.subscription.updated, customer.subscription.deleted

// Coaching session price IDs - skip plan update for these
const COACHING_PRICE_IDS = [
  // Add coaching price IDs here if you create them in Stripe
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const supabaseUrl = process.env.SUPABASE_URL || 'https://tgicomrycbhrinobvnlr.supabase.co';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!stripeKey) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  try {
    // Parse the event
    const event = req.body;
    const eventType = event.type;
    console.log('Stripe webhook event:', eventType);

    // Handle checkout.session.completed
    if (eventType === 'checkout.session.completed') {
      const session = event.data.object;
      const supabaseUserId = session.metadata?.supabase_user_id;
      const plan = session.metadata?.plan;
      const stripeCustomerId = session.customer;

      console.log('Checkout completed:', { supabaseUserId, plan, stripeCustomerId });

      if (!supabaseUserId) {
        console.error('No supabase_user_id in session metadata');
        return res.status(200).json({ received: true, warning: 'No user ID in metadata' });
      }

      // Check if this is a coaching session purchase - skip plan update
      if (session.line_items || plan === 'coaching') {
        // Fetch line items to check
        try {
          const liResponse = await fetch(
            `https://api.stripe.com/v1/checkout/sessions/${session.id}/line_items`,
            { headers: { 'Authorization': `Bearer ${stripeKey}` } }
          );
          if (liResponse.ok) {
            const liData = await liResponse.json();
            const isCoaching = (liData.data || []).some(item =>
              COACHING_PRICE_IDS.includes(item.price?.id)
            );
            if (isCoaching) {
              console.log('Coaching session purchase - skipping plan update');
              return res.status(200).json({ received: true, type: 'coaching' });
            }
          }
        } catch (e) {
          console.error('Error checking line items:', e.message);
        }
      }

      // Update user's plan in Supabase
      if (supabaseServiceKey) {
        const updateRes = await fetch(
          `${supabaseUrl}/rest/v1/profiles?id=eq.${supabaseUserId}`,
          {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'apikey': supabaseServiceKey,
              'Authorization': `Bearer ${supabaseServiceKey}`,
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify({
              plan: plan || 'starter',
              stripe_customer_id: stripeCustomerId || '',
              subscription_status: 'active',
              updated_at: new Date().toISOString()
            })
          }
        );
        console.log('Supabase profile update:', updateRes.status);
      }
    }

    // Handle subscription updated (plan change, payment issue)
    if (eventType === 'customer.subscription.updated') {
      const subscription = event.data.object;
      const stripeCustomerId = subscription.customer;
      const status = subscription.status; // active, past_due, canceled, unpaid

      console.log('Subscription updated:', { stripeCustomerId, status });

      // Map Stripe status to our status
      let subStatus = 'active';
      if (status === 'past_due') subStatus = 'past_due';
      if (status === 'canceled' || status === 'unpaid') subStatus = 'cancelled';

      if (supabaseServiceKey && stripeCustomerId) {
        await fetch(
          `${supabaseUrl}/rest/v1/profiles?stripe_customer_id=eq.${stripeCustomerId}`,
          {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'apikey': supabaseServiceKey,
              'Authorization': `Bearer ${supabaseServiceKey}`,
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify({
              subscription_status: subStatus,
              updated_at: new Date().toISOString()
            })
          }
        );
      }
    }

    // Handle subscription deleted (cancelled)
    if (eventType === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const stripeCustomerId = subscription.customer;

      console.log('Subscription deleted:', { stripeCustomerId });

      if (supabaseServiceKey && stripeCustomerId) {
        await fetch(
          `${supabaseUrl}/rest/v1/profiles?stripe_customer_id=eq.${stripeCustomerId}`,
          {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'apikey': supabaseServiceKey,
              'Authorization': `Bearer ${supabaseServiceKey}`,
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify({
              plan: 'free',
              subscription_status: 'cancelled',
              updated_at: new Date().toISOString()
            })
          }
        );
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(200).json({ received: true, error: err.message });
  }
}

// Vercel config to receive raw body for webhook signature verification
export const config = {
  api: {
    bodyParser: true
  }
};
