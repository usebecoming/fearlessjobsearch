const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_EMAILS = ['ritterbenjamin@gmail.com', 'benjaminritter@lfyconsulting.com'];

async function supabaseQuery(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || 'return=representation',
      ...options.headers
    },
    method: options.method || 'GET',
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase ${res.status}: ${text}`);
  }
  // PATCH with return=minimal returns empty body — don't parse
  if (options.prefer === 'return=minimal') return null;
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

async function supabaseGetUserById(userId) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    }
  });
  if (!res.ok) return null;
  return res.json();
}

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
      bcc: 'benjaminritter@lfyconsulting.com',
      subject,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  console.log(`📧 Email sent to ${to}: "${subject}"`);
}

function sig() {
  return `
    <p style="margin:24px 0 0;font-size:13px;color:#666;line-height:1.6;border-top:1px solid #eee;padding-top:16px;">
      — Ben<br>
      Dr. Benjamin Ritter | <a href="https://liveforyourselfconsulting.com/" style="color:#666;">Live for Yourself Consulting</a><br>
      Author, <em>Becoming Fearless</em> | ICF PCC<br>
      benjaminritter@lfyconsulting.com<br>
      <a href="https://www.linkedin.com/in/drbenjaminritter-leadershipdevelopment/" style="color:#3b82f6;">Connect on LinkedIn</a>
    </p>`;
}

function sigFull() {
  return `
    <p style="margin:24px 0 0;font-size:13px;color:#666;line-height:1.6;border-top:1px solid #eee;padding-top:16px;">
      — Ben<br>
      Dr. Benjamin Ritter<br>
      <a href="https://liveforyourselfconsulting.com/" style="color:#666;">Live for Yourself Consulting</a>
    </p>`;
}

function wrap(body) {
  return `<div style="font-family:sans-serif;font-size:14px;line-height:1.8;color:#222;max-width:600px;">${body}</div>`;
}

// ── EMAIL TEMPLATES ──

function emailDay2(firstName) {
  return wrap(`
    <p>${firstName ? firstName + ',' : 'Hi,'}</p>
    <p>You signed up but haven't run your first search yet.</p>
    <p>Takes less than 5 minutes. Here's what happens when you do:</p>
    <p>Upload your resume. Enter your target titles and location. Fearless Job Search pulls live listings from LinkedIn, Indeed, Glassdoor, and ZipRecruiter — scores each one against your actual experience — and surfaces the roles worth your time.</p>
    <p>Then pick one. Get the hiring manager, internal recruiter, and skip-level executive at that company. Real LinkedIn profiles. Current employment confirmed.</p>
    <p>Then get your outreach written. Four messages across 14 days, in your voice, at peer level. Ready to copy and send.</p>
    <p>That's one search. That's what you signed up for.</p>
    <p><a href="https://fearlessjobsearch.com/" style="color:#3b82f6;font-weight:500;">Run your first search now →</a></p>
    ${sig()}
  `);
}

function emailDay5(firstName) {
  return wrap(`
    <p>${firstName ? firstName + ',' : 'Hi,'}</p>
    <p>S.R. is a VP of HR in financial services. She'd been applying online for two months and hearing nothing.</p>
    <p>She ran one search. Got the decision-makers at three companies she'd been targeting. Sent the outreach the tool wrote for her.</p>
    <p>Six days later she had a conversation booked with the VP of People at her top target company.</p>
    <p>Not because she got lucky. Because she stopped applying and started talking to the right people.</p>
    <p>That's what this tool does. And your first search is free.</p>
    <p><a href="https://fearlessjobsearch.com/" style="color:#3b82f6;font-weight:500;">fearlessjobsearch.com →</a></p>
    <p style="font-size:13px;color:#777;margin-top:16px;font-style:italic;">P.S. 80% of senior roles are filled through relationships before they're ever posted. Every day you wait is a day someone else is building that relationship.</p>
    ${sig()}
  `);
}

function emailDay7(firstName) {
  return wrap(`
    <p>${firstName ? firstName + ',' : 'Hi,'}</p>
    <p>You ran your first search. You saw the contacts. You saw the outreach.</p>
    <p>Now you know it works.</p>
    <p>The free plan gives you one search to experience the product. To keep going — more companies, more contacts, more outreach — you need to upgrade.</p>
    <p>Starter is $29/month. That's three searches per month, 10 matched roles per search, up to 90 verified contacts, and full outreach sequences.</p>
    <p>At the senior level, landing one conversation sooner is worth tens of thousands of dollars. This is the least expensive part of your job search.</p>
    <p><a href="https://fearlessjobsearch.com/" style="color:#3b82f6;font-weight:500;">Upgrade now →</a></p>
    <p>If you have questions just reply. I read every email.</p>
    ${sig()}
  `);
}

function emailDay10(firstName) {
  return wrap(`
    <p>${firstName ? firstName + ',' : 'Hi,'}</p>
    <p>You signed up for Fearless Job Search a little while ago. I wanted to check in — have you had a chance to run your first search?</p>
    <p>If you haven't yet, here's what you're missing: the tool scores every job against your actual resume, not just keywords. Most users are surprised by what surfaces — roles they wouldn't have found scrolling LinkedIn or Indeed.</p>
    <p>But the real value isn't the job list. It's what comes after.</p>
    <p><strong>80% of senior roles are filled through relationships.</strong> With a paid plan, Fearless Job Search finds the exact hiring managers, recruiters, and executives to contact at every company — verified on LinkedIn, with current employment confirmed. Then it writes your outreach for you. Personalized. Peer-level. Ready to send.</p>
    <p>Plans start at $29/mo. Most of my coaching clients land conversations within the first week.</p>
    <p><a href="https://fearlessjobsearch.com/" style="color:#3b82f6;font-weight:500;">Run your first search →</a></p>
    <p>If you have questions or want to talk through your search strategy, just reply to this email. I read every one.</p>
    ${sig()}
  `);
}

function emailDay14(firstName) {
  return wrap(`
    <p>${firstName ? firstName + ',' : 'Hi,'}</p>
    <p>I'm not going to keep nudging you. This is my last email about upgrading.</p>
    <p>If the timing isn't right, that's okay. The free plan is still there whenever you need it.</p>
    <p>If you're still in active search and want to move faster — <a href="https://fearlessjobsearch.com/" style="color:#3b82f6;font-weight:500;">fearlessjobsearch.com</a>. Starter is $29/month, cancel anytime.</p>
    <p>Either way, I hope you land something great.</p>
    <p>One thing I know for certain: the leaders who get in front of the right people first win. Not the ones with the best resume.</p>
    <p>Whenever you're ready.</p>
    ${sigFull()}
  `);
}

// ── EMAIL SEQUENCE LOGIC ──

const EMAIL_SEQUENCE = [
  { day: 2,  key: 'day2',  subject: 'Your search is waiting.',                          needsNoSearch: true,  template: emailDay2 },
  { day: 5,  key: 'day5',  subject: 'She had her first conversation in 6 days.',        needsNoSearch: false, template: emailDay5 },
  { day: 7,  key: 'day7',  subject: "You've seen it work. Here's what's next.",          needsSearch: true,    template: emailDay7 },
  { day: 10, key: 'day10', subject: "You haven't run your first search yet",             needsNoSearch: false, template: emailDay10 },
  { day: 14, key: 'day14', subject: 'Last note from me.',                                needsNoSearch: false, template: emailDay14 },
];

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('🕐 Running email sequence cron...');

  try {
    // Get all free users
    const profiles = await supabaseQuery(
      'profiles?plan=eq.free&select=id,plan,search_count_month,created_at,last_email_sent&limit=50'
    );

    if (!profiles || profiles.length === 0) {
      console.log('✅ No free users to process');
      return res.json({ sent: 0 });
    }

    const now = new Date();
    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const profile of profiles) {
      try {
        const createdAt = new Date(profile.created_at);
        const daysSinceSignup = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));
        const lastSent = profile.last_email_sent || '';
        const hasSearched = (profile.search_count_month || 0) > 0;

        // Find the next email to send
        let emailToSend = null;
        for (const email of EMAIL_SEQUENCE) {
          if (daysSinceSignup >= email.day && !lastSent.includes(email.key)) {
            // Check conditions
            if (email.needsNoSearch && hasSearched) continue;
            if (email.needsSearch && !hasSearched) continue;
            emailToSend = email;
            break;
          }
        }

        if (!emailToSend) {
          skipped++;
          continue;
        }

        // Get user email
        const userData = await supabaseGetUserById(profile.id);
        if (!userData?.email) { skipped++; continue; }

        const userEmail = userData.email;
        if (ADMIN_EMAILS.includes(userEmail.toLowerCase())) { skipped++; continue; }

        const firstName = userData.user_metadata?.full_name ? userData.user_metadata.full_name.split(' ')[0] : '';

        // Send the email
        await sendEmail({
          to: userEmail,
          subject: emailToSend.subject,
          html: emailToSend.template(firstName),
        });

        // Mark as sent
        const newLastSent = lastSent ? lastSent + ',' + emailToSend.key : emailToSend.key;
        await supabaseQuery(`profiles?id=eq.${profile.id}`, {
          method: 'PATCH',
          body: { last_email_sent: newLastSent },
          prefer: 'return=minimal'
        });

        sent++;
        console.log(`✅ Sent ${emailToSend.key} to ${userEmail} (day ${daysSinceSignup})`);

      } catch (err) {
        console.error(`❌ Failed for user ${profile.id}:`, err.message);
        failed++;
      }
    }

    console.log(`📊 Email sequence: ${sent} sent, ${skipped} skipped, ${failed} failed`);
    return res.json({ sent, skipped, failed });

  } catch (err) {
    console.error('Cron error:', err);
    return res.status(500).json({ error: err.message });
  }
}
