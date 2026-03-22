import { PRICE_TO_PLAN } from './_plans.js';
import crypto from 'crypto';

// ── Email helper (Resend via fetch — no SDK) ──

async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('⚠️ RESEND_API_KEY not set — skipping email'); return; }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Dr. Benjamin Ritter <benjaminritter@lfyconsulting.com>',
      reply_to: 'benjaminritter@lfyconsulting.com',
      to,
      subject,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  console.log(`📧 Email sent to ${to}: "${subject}"`);
}

// ── Email template helpers ──

function emailSig() {
  return `
    <p style="margin:24px 0 0;font-size:13px;color:#666;line-height:1.6;border-top:1px solid #eee;padding-top:16px;">
      — Ben<br>
      Dr. Benjamin Ritter | Live for Yourself Consulting<br>
      ICF PCC | EdD Organizational Leadership<br>
      benjaminritter@lfyconsulting.com<br>
      <span style="color:#999;">Account or billing questions: support@lfyconsulting.com</span>
    </p>`;
}

function stepBlock(label, html) {
  return `
    <div style="background:#f9f9f9;border-left:3px solid #3b82f6;border-radius:6px;padding:12px 16px;margin:12px 0;">
      <p style="font-size:11px;font-weight:600;color:#3b82f6;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 4px;">${label}</p>
      <p style="font-size:13px;color:#222;line-height:1.6;margin:0;">${html}</p>
    </div>`;
}

function planBox(title, items) {
  const rows = items.map(i =>
    `<li style="font-size:13px;color:#333;padding:3px 0;list-style:none;">\u2713 \u00a0${i}</li>`
  ).join('');
  return `
    <div style="margin-top:20px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <div style="background:#f3f4f6;padding:8px 14px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#666;border-bottom:1px solid #e5e7eb;">${title}</div>
      <ul style="margin:0;padding:10px 14px;">${rows}</ul>
    </div>`;
}

// ── Email templates ──

function emailResumeReview(firstName) {
  return `
    <div style="font-family:sans-serif;font-size:14px;line-height:1.8;color:#222;max-width:600px;">
      <p>${firstName},</p>
      <p>Your purchase is confirmed. Here's what to do next.</p>
      ${stepBlock('Step 1 \u2014 Book your session',
        'Grab your 60-minute slot:<br><a href="https://cal.com/drbenjaminritter/coaching-sessions?duration=60&overlayCalendar=true" style="color:#3b82f6;">https://cal.com/drbenjaminritter/coaching-sessions</a>')}
      ${stepBlock('Step 2 \u2014 Complete the intake form',
        'This is where you\'ll upload your resume:<br><a href="https://forms.gle/deP2oP9xE1osrHCU9" style="color:#3b82f6;">https://forms.gle/deP2oP9xE1osrHCU9</a>')}
      <p>Once I have both, we're all set.</p>
      <p>Looking forward to it.</p>
      ${emailSig()}
    </div>`;
}

function emailResumeLinkedIn(firstName) {
  return `
    <div style="font-family:sans-serif;font-size:14px;line-height:1.8;color:#222;max-width:600px;">
      <p>${firstName},</p>
      <p>Your purchase is confirmed. Here's what to do next.</p>
      ${stepBlock('Step 1 \u2014 Book your session',
        'Grab your 60-minute slot:<br><a href="https://cal.com/drbenjaminritter/coaching-sessions?duration=60&overlayCalendar=true" style="color:#3b82f6;">https://cal.com/drbenjaminritter/coaching-sessions</a>')}
      ${stepBlock('Step 2 \u2014 Complete the intake form',
        'Upload your resume and include your LinkedIn URL:<br><a href="https://forms.gle/deP2oP9xE1osrHCU9" style="color:#3b82f6;">https://forms.gle/deP2oP9xE1osrHCU9</a>')}
      <p>Once I have both, we're all set.</p>
      <p>Looking forward to it.</p>
      ${emailSig()}
    </div>`;
}

function emailWelcomeStarter(firstName) {
  return `
    <div style="font-family:sans-serif;font-size:14px;line-height:1.8;color:#222;max-width:600px;">
      <p>${firstName},</p>
      <p>You're set up. No more scrolling through listings built for people searching below your level. Fearless Job Search scores every role for seniority fit \u2014 what you see at the top is worth your time.</p>
      <p>Here's how to turn this into real conversations.</p>
      ${stepBlock('Step 1 \u2014 Run your search',
        'Enter your target title, industry, and location. The tool pulls live listings and ranks them by fit. Your one included search is ready \u2014 use it on the role you\'re most serious about right now.')}
      ${stepBlock('Step 2 \u2014 Find the decision-makers',
        'Pick a role. Hit "Find Decision-Makers." You\'ll get the real contacts at that company \u2014 not HR, not a black hole. The people who actually influence the hire.')}
      ${stepBlock('Step 3 \u2014 Generate your outreach and send it',
        'Click "Generate Outreach" on any contact. You get a personalized message built on your background and their role. Edit it, make it yours, and send it. The goal is a conversation \u2014 not a perfect email.')}
      ${stepBlock('Step 4 \u2014 Download your list and follow through',
        'Export your matched jobs and contacts. Put them somewhere you\'ll see every day. Send the messages. Follow up. Book the calls. That\'s what moves this forward \u2014 not the list sitting in a tab.')}
      <p>If you hit a wall, reply here. I read these.</p>
      ${planBox('What\'s included in Starter', [
        '1 search per month',
        'Up to 10 matched job listings per search',
        'Decision-maker contact discovery',
        'AI-generated personalized outreach messages',
      ])}
      ${emailSig()}
    </div>`;
}

function emailWelcomePro(firstName) {
  return `
    <div style="font-family:sans-serif;font-size:14px;line-height:1.8;color:#222;max-width:600px;">
      <p>${firstName},</p>
      <p>Four searches a month is enough to run a serious multi-track campaign \u2014 different titles, different industries, and the specific companies you already know you want. Most people using Pro have active conversations within two weeks. Here's the approach that works.</p>
      ${stepBlock('Step 1 \u2014 Deploy your searches across tracks',
        'Don\'t use all four on the same title. One for your primary target role. One for adjacent titles. One by industry. One in Company Target Mode on the companies you actually want. Four searches pointed in different directions = a full pipeline by end of week one.')}
      ${stepBlock('Step 2 \u2014 Use Company Target Mode',
        'Skip the job board entirely for companies you already have in mind. Enter the company, get current openings scored for your fit, and surface the right contacts \u2014 all in one shot. Use this on your top 3\u20135 targets first.')}
      ${stepBlock('Step 3 \u2014 Generate outreach and send it this week',
        'For each search, generate outreach for your top contacts and send it. Not next week \u2014 this week. Follow up the week after. Four searches gives you the volume to stay consistent without burning out on copy.')}
      ${stepBlock('Step 4 \u2014 Download your pipeline and work it daily',
        'Export your jobs and contacts. Review it every day. The goal isn\'t to track applications \u2014 it\'s to book conversations. Treat every contact like a warm lead, not a form submission.')}
      <p>If you hit a wall, reply here. I read these.</p>
      ${planBox('What\'s included in Pro', [
        '4 searches per month',
        'Up to 10 matched job listings per search',
        'Company Target Mode \u2014 search by company, not just keyword',
        'Decision-maker contact discovery',
        'AI-generated personalized outreach messages',
      ])}
      ${emailSig()}
    </div>`;
}

function emailWelcomeAccelerate(firstName) {
  return `
    <div style="font-family:sans-serif;font-size:14px;line-height:1.8;color:#222;max-width:600px;">
      <p>${firstName},</p>
      <p>You've got the full toolkit \u2014 10 searches per month, 20 roles per search, Company Target Mode, contact discovery, outreach generation, and priority support.</p>
      <p>Here's how to use it well.</p>
      ${stepBlock('Start with a focused target list',
        'Before running searches, write down the 5\u201310 companies you\'d actually want to work at and the 2\u20133 titles that represent your next move. Focused targeting beats scattered volume every time.')}
      ${stepBlock('Use Company Target Mode on every serious company',
        'For each company on your list, run a Company Target Mode search. Current openings, fit scores, right contacts \u2014 all at once. This is how you go from "I want to work at X" to a real conversation.')}
      ${stepBlock('Build your pipeline and stay active in it',
        'Flag the roles you\'re serious about. Generate outreach for those contacts. Download the list and keep it in front of you. Send the messages. Follow up. Book the calls. The pipeline only moves if you\'re working it.')}
      <p>If you hit a wall \u2014 outreach isn't landing, you're not sure which companies to target, something feels off \u2014 reply here. I read these.</p>
      ${planBox('What\'s included in Accelerate', [
        '10 searches per month',
        'Up to 20 matched job listings per search',
        'Company Target Mode \u2014 search by company, not just keyword',
        'Decision-maker contact discovery',
        'AI-generated personalized outreach messages',
        'Priority support',
      ])}
      ${emailSig()}
    </div>`;
}

// ── Price ID maps ──

const COACHING_PRICE_IDS = new Set([
  'price_1TDFhJK3APtatfMmjK9kHib4',  // Resume Review $500
  'price_1TDFi0K3APtatfMmtU7ZLSsk',  // Resume + LinkedIn $750
]);

const SUBSCRIPTION_PRICE_META = {
  'price_1TCuhfK3APtatfMmhlcWdsdW': { plan: 'Starter',           amount: '$29/mo',  template: 'starter' },
  'price_1TCuiKK3APtatfMmOQCSWWd4': { plan: 'Pro',               amount: '$59/mo',  template: 'pro' },
  'price_1TCujoK3APtatfMmz0GggJn4': { plan: 'Accelerate Monthly', amount: '$99/mo',   template: 'accelerate' },
  'price_1TCukaK3APtatfMmKNbheswb': { plan: 'Accelerate Yearly',  amount: '$999/yr', template: 'accelerate' },
};

const COACHING_PRODUCTS = {
  'price_1TDFhJK3APtatfMmjK9kHib4': { name: 'Resume Review',     amount: '$500', template: 'resume_review' },
  'price_1TDFi0K3APtatfMmtU7ZLSsk': { name: 'Resume + LinkedIn', amount: '$750', template: 'resume_linkedin' },
};

const BEN_EMAIL = 'benjaminritter@lfyconsulting.com';

// ── Stripe signature verification ──

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
  const now = Math.floor(Date.now() / 1000);
  if (now - parseInt(timestamp) > 300) {
    throw new Error('Timestamp too old');
  }
  return JSON.parse(payload);
}

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

// ── Stripe customer retrieval helper ──

async function getStripeCustomer(customerId, stripeKey) {
  const res = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
    headers: { 'Authorization': `Bearer ${stripeKey}` }
  });
  if (!res.ok) return null;
  return res.json();
}

// ── Webhook handler ──

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
    const rawBody = await getRawBody(req);
    const sig = req.headers['stripe-signature'];

    let event;
    if (webhookSecret) {
      if (!sig) {
        console.error('\u274c Missing stripe-signature header');
        return res.status(400).json({ error: 'Missing stripe-signature header' });
      }
      try {
        event = verifyStripeSignature(rawBody, sig, webhookSecret);
        console.log(`\ud83d\udce8 Verified webhook event: ${event.type}`);
      } catch (sigErr) {
        console.error(`\u274c Webhook signature verification failed: ${sigErr.message}`);
        return res.status(400).json({ error: `Webhook signature failed: ${sigErr.message}` });
      }
    } else {
      console.warn('\u26a0\ufe0f STRIPE_WEBHOOK_SECRET not set \u2014 processing without signature verification');
      event = JSON.parse(rawBody);
    }

    const eventType = event.type;
    console.log(`\ud83d\udce8 Stripe webhook: ${eventType}`);

    // ── checkout.session.completed ──
    if (eventType === 'checkout.session.completed') {
      const session = event.data.object;
      const supabaseUserId = session.metadata?.supabase_user_id;
      const metadataPlan = session.metadata?.plan;
      const stripeCustomerId = session.customer;

      console.log('Checkout completed:', { supabaseUserId, metadataPlan, stripeCustomerId });

      if (!supabaseUserId) {
        console.error('\u274c No supabase_user_id in session metadata');
        return res.status(200).json({ received: true, warning: 'No user ID in metadata' });
      }

      try {
        const liResponse = await fetch(
          `https://api.stripe.com/v1/checkout/sessions/${session.id}/line_items`,
          { headers: { 'Authorization': `Bearer ${stripeKey}` } }
        );
        if (liResponse.ok) {
          const liData = await liResponse.json();
          const priceId = liData.data?.[0]?.price?.id;

          // ── Coaching purchase ──
          if (COACHING_PRICE_IDS.has(priceId)) {
            console.log('\u2705 Coaching session purchase \u2014 no plan update');

            // Send coaching confirmation emails
            try {
              const product = COACHING_PRODUCTS[priceId];
              const customerEmail = session.customer_details?.email;
              const fullName = session.customer_details?.name || '';
              const firstName = fullName.split(' ')[0] || 'there';

              const html = product.template === 'resume_review'
                ? emailResumeReview(firstName)
                : emailResumeLinkedIn(firstName);

              const subject = product.template === 'resume_review'
                ? 'Your resume review is confirmed \u2014 here\'s what happens next'
                : 'Your Resume + LinkedIn package is confirmed \u2014 next steps';

              await Promise.all([
                sendEmail({ to: customerEmail, subject, html }),
                sendEmail({
                  to: BEN_EMAIL,
                  subject: `New coaching purchase: ${product.name} (${product.amount})`,
                  html: `
                    <div style="font-family:sans-serif;font-size:14px;line-height:1.8;color:#222;">
                      <p>New coaching purchase on Fearless Job Search.</p>
                      <p>
                        <strong>Customer:</strong> ${fullName}<br>
                        <strong>Email:</strong> ${customerEmail}<br>
                        <strong>Product:</strong> ${product.name}<br>
                        <strong>Amount:</strong> ${product.amount}<br>
                        <strong>Stripe session:</strong> ${session.id}
                      </p>
                      <p>Confirmation email sent to customer automatically.</p>
                    </div>`,
                }),
              ]);
            } catch (emailErr) {
              console.error('Coaching email error:', emailErr.message);
            }

            return res.status(200).json({ received: true, type: 'coaching' });
          }

          // ── Subscription checkout ──
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
                  search_count_month: 0,
                  search_reset_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
                  updated_at: new Date().toISOString()
                })
              }
            );
            console.log(`\u2705 Plan updated: ${supabaseUserId} \u2192 ${plan} (status: ${updateRes.status})`);
          }

          // Send subscription welcome email
          // Sent here (not in subscription.created) because profile is updated here
          try {
            const meta = SUBSCRIPTION_PRICE_META[priceId];
            if (meta) {
              const customerEmail = session.customer_details?.email;
              const fullName = session.customer_details?.name || '';
              const firstName = fullName.split(' ')[0] || 'there';

              const welcomeHtml =
                meta.template === 'starter'   ? emailWelcomeStarter(firstName) :
                meta.template === 'pro'       ? emailWelcomePro(firstName) :
                                                emailWelcomeAccelerate(firstName);

              const welcomeSubject =
                meta.template === 'starter'   ? 'You\'re in. Here\'s how to get your first conversation booked' :
                meta.template === 'pro'       ? 'Pro is live. You\'ve got enough firepower to run a real campaign' :
                                                'Accelerate is active \u2014 here\'s the strategy that works';

              await Promise.all([
                sendEmail({ to: customerEmail, subject: welcomeSubject, html: welcomeHtml }),
                sendEmail({
                  to: BEN_EMAIL,
                  subject: `New subscriber: ${meta.plan} \u2014 ${fullName || customerEmail}`,
                  html: `
                    <div style="font-family:sans-serif;font-size:14px;line-height:1.8;color:#222;">
                      <p>New subscription on Fearless Job Search.</p>
                      <p>
                        <strong>Customer:</strong> ${fullName}<br>
                        <strong>Email:</strong> ${customerEmail}<br>
                        <strong>Plan:</strong> ${meta.plan}<br>
                        <strong>Amount:</strong> ${meta.amount}<br>
                        <strong>Stripe customer:</strong> ${stripeCustomerId}
                      </p>
                      <p>Welcome email sent to customer automatically.</p>
                    </div>`,
                }),
              ]);
            }
          } catch (emailErr) {
            console.error('Subscription welcome email error:', emailErr.message);
          }
        }
      } catch (e) {
        console.error('Error checking line items:', e.message);
      }
    }

    // ── customer.subscription.updated ──
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
        console.log(`\u2705 Subscription updated: ${stripeCustomerId} \u2192 ${effectivePlan} (${subStatus})`);
      }

      // Notify Ben on plan change (not just status change)
      try {
        const prevPriceId = event.data.previous_attributes?.items?.data?.[0]?.price?.id;
        if (prevPriceId && prevPriceId !== priceId) {
          const newMeta  = SUBSCRIPTION_PRICE_META[priceId]  || { plan: priceId };
          const prevMeta = SUBSCRIPTION_PRICE_META[prevPriceId] || { plan: prevPriceId };
          const customer = await getStripeCustomer(stripeCustomerId, stripeKey);
          const fullName = customer?.name || customer?.email || stripeCustomerId;

          await sendEmail({
            to: BEN_EMAIL,
            subject: `Plan change: ${fullName} \u2014 ${prevMeta.plan} \u2192 ${newMeta.plan}`,
            html: `
              <div style="font-family:sans-serif;font-size:14px;line-height:1.8;color:#222;">
                <p>A subscriber changed plans on Fearless Job Search.</p>
                <p>
                  <strong>Customer:</strong> ${fullName}<br>
                  <strong>Email:</strong> ${customer?.email || 'unknown'}<br>
                  <strong>Previous plan:</strong> ${prevMeta.plan}<br>
                  <strong>New plan:</strong> ${newMeta.plan}<br>
                  <strong>Stripe customer:</strong> ${stripeCustomerId}
                </p>
              </div>`,
          });
        }
      } catch (emailErr) {
        console.error('Plan change email error:', emailErr.message);
      }
    }

    // ── customer.subscription.deleted ──
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
        console.log(`\u2705 Subscription canceled: ${stripeCustomerId} \u2192 free`);
      }

      // Notify Ben
      try {
        const priceId = subscription.items?.data?.[0]?.price?.id;
        const meta = SUBSCRIPTION_PRICE_META[priceId] || { plan: priceId || 'unknown' };
        const customer = await getStripeCustomer(stripeCustomerId, stripeKey);
        const fullName = customer?.name || customer?.email || stripeCustomerId;

        await sendEmail({
          to: BEN_EMAIL,
          subject: `Cancellation: ${meta.plan} \u2014 ${fullName}`,
          html: `
            <div style="font-family:sans-serif;font-size:14px;line-height:1.8;color:#222;">
              <p>A subscriber cancelled on Fearless Job Search.</p>
              <p>
                <strong>Customer:</strong> ${fullName}<br>
                <strong>Email:</strong> ${customer?.email || 'unknown'}<br>
                <strong>Plan:</strong> ${meta.plan}<br>
                <strong>Stripe customer:</strong> ${stripeCustomerId}
              </p>
            </div>`,
        });
      } catch (emailErr) {
        console.error('Cancellation email error:', emailErr.message);
      }
    }

    // ── invoice.payment_failed ──
    if (eventType === 'invoice.payment_failed') {
      const invoice = event.data.object;
      const stripeCustomerId = invoice.customer;

      console.log(`\u26a0\ufe0f Payment failed: ${stripeCustomerId}`);

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
