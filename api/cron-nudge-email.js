const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

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
  return res.json();
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
  console.log(`📧 Nudge email sent to ${to}`);
}

function emailSig() {
  return `
    <p style="margin:24px 0 0;font-size:13px;color:#666;line-height:1.6;border-top:1px solid #eee;padding-top:16px;">
      — Ben<br>
      Dr. Benjamin Ritter | <a href="https://liveforyourselfconsulting.com/" style="color:#666;">Live for Yourself Consulting</a><br>
      Author, <em>Becoming Fearless</em> | ICF PCC<br>
      benjaminritter@lfyconsulting.com<br>
      <a href="https://www.linkedin.com/in/drbenjaminritter-leadershipdevelopment/" style="color:#3b82f6;">Connect on LinkedIn</a>
    </p>`;
}

function nudgeEmailHtml(firstName) {
  return `
    <div style="font-family:sans-serif;font-size:14px;line-height:1.8;color:#222;max-width:600px;">
      <p>${firstName},</p>

      <p>You signed up for Fearless Job Search a little while ago. I wanted to check in — have you had a chance to run your first search?</p>

      <p>If you haven't yet, here's what you're missing: the tool scores every job against your actual resume, not just keywords. Most users are surprised by what surfaces — roles they wouldn't have found scrolling LinkedIn or Indeed.</p>

      <p>But the real value isn't the job list. It's what comes after.</p>

      <p><strong>80% of senior roles are filled through relationships.</strong> With a paid plan, Fearless Job Search finds the exact hiring managers, recruiters, and executives to contact at every company — verified on LinkedIn, with current employment confirmed. Then it writes your outreach for you. Personalized. Peer-level. Ready to send.</p>

      <p>Here's what that looks like:</p>
      <ul style="margin:8px 0 16px 0;padding-left:20px;">
        <li style="margin-bottom:6px;">Up to 10 verified decision-makers per company</li>
        <li style="margin-bottom:6px;">4-message outreach sequences written from your resume</li>
        <li style="margin-bottom:6px;">Company target mode — find contacts even when no jobs are posted</li>
        <li style="margin-bottom:6px;">Pipeline tracking to manage your entire campaign</li>
      </ul>

      <p>Plans start at $29/mo. Most of my coaching clients land conversations within the first week.</p>

      <p><a href="https://fearlessjobsearch.com/" style="color:#3b82f6;font-weight:500;">Run your first search →</a></p>

      <p>If you have questions or want to talk through your search strategy, just reply to this email. I read every one.</p>

      ${emailSig()}
    </div>`;
}

export default async function handler(req, res) {
  // Verify this is a cron call
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('🕐 Running nudge email cron job...');

  try {
    // Find free users who signed up 10+ days ago and haven't been nudged
    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);

    const profiles = await supabaseQuery(
      `profiles?plan=eq.free&nudge_email_sent=eq.false&created_at=lt.${tenDaysAgo.toISOString()}&select=id,plan,nudge_email_sent,created_at&limit=20`
    );

    if (!profiles || profiles.length === 0) {
      console.log('✅ No users to nudge');
      return res.json({ sent: 0, message: 'No eligible users' });
    }

    console.log(`📋 Found ${profiles.length} free users to nudge`);

    let sent = 0;
    let failed = 0;

    for (const profile of profiles) {
      try {
        // Get email from auth.users
        const userData = await supabaseGetUserById(profile.id);

        if (!userData?.email) {
          console.warn(`⚠️ Could not get email for user ${profile.id}`);
          failed++;
          continue;
        }

        const email = userData.email;
        const firstName = (userData.user_metadata?.full_name || email.split('@')[0] || 'there').split(' ')[0];

        // Skip admin emails
        if (['ritterbenjamin@gmail.com', 'benjaminritter@lfyconsulting.com'].includes(email.toLowerCase())) {
          console.log(`⏭️ Skipping admin: ${email}`);
          continue;
        }

        // Send the nudge email
        await sendEmail({
          to: email,
          subject: "You haven't run your first search yet",
          html: nudgeEmailHtml(firstName),
        });

        // Mark as sent
        await supabaseQuery(`profiles?id=eq.${profile.id}`, {
          method: 'PATCH',
          body: { nudge_email_sent: true },
          prefer: 'return=minimal'
        });

        sent++;
        console.log(`✅ Nudged: ${email}`);

      } catch (emailErr) {
        console.error(`❌ Failed to nudge user ${profile.id}:`, emailErr.message);
        failed++;
      }
    }

    console.log(`📊 Nudge complete: ${sent} sent, ${failed} failed`);
    return res.json({ sent, failed, total: profiles.length });

  } catch (err) {
    console.error('Cron nudge error:', err);
    return res.status(500).json({ error: err.message });
  }
}
