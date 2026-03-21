import { PRICE_TO_PLAN } from './_plans.js';
import crypto from 'crypto';

// Coaching session price IDs - skip plan update for these
const COACHING_PRICE_IDS = new Set([
  'price_1TDFhJK3APtatfMmjK9kHib4',  // Resume Review & Rewrite
  'price_1TDFi0K3APtatfMmtU7ZLSsk'   // Resume + LinkedIn
]);

function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader || !secret) throw new Error('Missing signature or secret');
  const parts = sigHeader.split(',');
  const tPart = parts.find(p => p.startsWith('t='));
  const v1Part = parts.find(p => p.startsWith('v1='));
  if (!tPart || !v1Part) throw new Error('Invalid signature format');
  const timestamp = tPart.split('=')[1];
  const signature = v1Part.split('=')[1];
  const signedPayload = `${timestamp}.${payload}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new Error('Signature mismatch');
  }
  // Reject events older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (now - parseInt(timestamp) > 300) {
    throw new Error('Timestamp too old');
  }
  return JSON.parse(payload);
}

// Read raw body from request stream (bodyParser disabled)
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    if (typeof req.body === 'string') { resolve(req.body); return; }
    if (Buffer.isBuffer(req.body)) { resolve(req.body.toString()); return; }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!stripeKey) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  try {
    // Verify Stripe signature
    const rawBody = await getRawBody(req);
    const sig = req.headers['stripe-signature'];

    let event;
    if (webhookSecret) {
      // Secret is configured — require valid signature
      if (!sig) {
        console.error('❌ Missing stripe-signature header');
        return res.status(400).json({ error: 'Missing stripe-signature header' });
      }
      try {
        event = verifyStripeSignature(rawBody, sig, webhookSecret);
        console.log(`📨 Verified webhook event: ${event.type}`);
      } catch (sigErr) {
        console.error(`❌ Webhook signature verification failed: ${sigErr.message}`);
        return res.status(400).json({ error: `Webhook signature failed: ${sigErr.message}` });
      }
    } else {
      // No secret configured — dev mode only, log warning
      console.warn('⚠️ STRIPE_WEBHOOK_SECRET not set — processing without signature verification');
      event = JSON.parse(rawBody);
    }

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

          if (COACHING_PRICE_IDS.has(priceId)) {
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
    bodyParser: false
  }
};
