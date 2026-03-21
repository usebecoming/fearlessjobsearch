import { PRICE_TO_PLAN } from './_plans.js';

// Coaching session price IDs - skip plan update for these
const COACHING_PRICE_IDS = [];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!stripeKey) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  try {
    const event = req.body;
    const eventType = event.type;
    console.log(`📨 Stripe webhook: ${eventType}`);

    if (eventType === 'checkout.session.completed') {
      const session = event.data.object;
      const supabaseUserId = session.metadata?.supabase_user_id;
      const metadataPlan = session.metadata?.plan;
      const stripeCustomerId = session.customer;

      console.log('Checkout completed:', { supabaseUserId, metadataPlan, stripeCustomerId });

      if (!supabaseUserId) {
        console.error('❌ No supabase_user_id in session metadata');
        return res.status(200).json({ received: true, warning: 'No user ID in metadata' });
      }

      // Check if coaching session
      try {
        const liResponse = await fetch(
          `https://api.stripe.com/v1/checkout/sessions/${session.id}/line_items`,
          { headers: { 'Authorization': `Bearer ${stripeKey}` } }
        );
        if (liResponse.ok) {
          const liData = await liResponse.json();
          const priceId = liData.data?.[0]?.price?.id;

          if (COACHING_PRICE_IDS.includes(priceId)) {
            console.log('✅ Coaching session purchase — no plan update');
            return res.status(200).json({ received: true, type: 'coaching' });
          }

          // Determine plan from price ID
          const plan = PRICE_TO_PLAN[priceId] || metadataPlan || 'starter';

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
                  plan: plan,
                  stripe_customer_id: stripeCustomerId || '',
                  subscription_status: 'active',
                  subscription_id: session.subscription || '',
                  updated_at: new Date().toISOString()
                })
              }
            );
            console.log(`✅ Plan updated: ${supabaseUserId} → ${plan} (status: ${updateRes.status})`);
          }
        }
      } catch (e) {
        console.error('Error checking line items:', e.message);
      }
    }

    if (eventType === 'customer.subscription.updated') {
      const subscription = event.data.object;
      const stripeCustomerId = subscription.customer;
      const status = subscription.status;
      const priceId = subscription.items?.data?.[0]?.price?.id;
      const plan = PRICE_TO_PLAN[priceId];

      console.log('Subscription updated:', { stripeCustomerId, status, priceId, plan });

      const effectivePlan = ['active', 'trialing'].includes(status)
        ? (plan || 'free')
        : 'free';

      let subStatus = status;
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
              plan: effectivePlan,
              subscription_status: subStatus,
              subscription_id: subscription.id,
              current_period_end: subscription.current_period_end
                ? new Date(subscription.current_period_end * 1000).toISOString()
                : null,
              updated_at: new Date().toISOString()
            })
          }
        );
        console.log(`✅ Subscription updated: ${stripeCustomerId} → ${effectivePlan} (${subStatus})`);
      }
    }

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
              subscription_id: null,
              current_period_end: null,
              updated_at: new Date().toISOString()
            })
          }
        );
        console.log(`✅ Subscription canceled: ${stripeCustomerId} → free`);
      }
    }

    if (eventType === 'invoice.payment_failed') {
      const invoice = event.data.object;
      const stripeCustomerId = invoice.customer;

      console.log(`⚠️ Payment failed: ${stripeCustomerId}`);

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
              subscription_status: 'past_due',
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

export const config = {
  api: {
    bodyParser: true
  }
};
