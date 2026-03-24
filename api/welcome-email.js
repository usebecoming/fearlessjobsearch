import { verifyUser } from './_auth.js';

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
  console.log(`📧 Welcome email sent to ${to}`);
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

function welcomeEmailHtml(firstName) {
  return `
    <div style="font-family:sans-serif;font-size:14px;line-height:1.8;color:#222;max-width:600px;">
      <p>${firstName},</p>

      <p>Welcome to Fearless Job Search. I'm Ben — I've coached over 500 senior leaders at companies like Amazon, Google, DoorDash, and Pinterest through career transitions. One thing became clear: the way senior leaders find jobs is fundamentally different from how job boards work.</p>

      <p>At your level, most roles are filled through relationships. Not applications. Not recruiter outreach. Real conversations with the right people at the right companies.</p>

      <p>That's what this tool does. It finds the roles worth your time, surfaces the exact hiring managers and executives to contact, and writes personalized outreach that sounds like you — not a template. It's the same strategy I've used with my coaching clients for years, now available as a tool.</p>

      <p>Here's what you can do right now on the free plan:</p>
      <ul style="margin:8px 0 16px 0;padding-left:20px;">
        <li style="margin-bottom:6px;">Run a search and see 3 AI-matched roles scored against your resume</li>
        <li style="margin-bottom:6px;">See how the scoring and filtering works for your specific background</li>
      </ul>
      <p><a href="https://fearlessjobsearch.com/" style="color:#3b82f6;font-weight:500;">Start your first search →</a></p>

      <p>When you're ready to go further, that's where the real value is — <strong>80% of senior roles are filled through relationships, not job boards.</strong> With a paid plan you get verified decision-maker contacts at every company, personalized outreach sequences written from your resume, company targeting, and pipeline tracking. Plans start at $29/mo.</p>

      <p>I read every reply to this email. If you have questions about the tool, your search, or your next move — just respond.</p>

      ${emailSig()}
    </div>`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify authenticated user
  const auth = await verifyUser(req);
  if (auth.error) {
    return res.status(401).json({ error: auth.error });
  }

  const { email, name } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Missing email' });
  }

  const firstName = (name || '').split(' ')[0] || 'there';

  try {
    await sendEmail({
      to: email,
      subject: "Welcome — here's why I built this",
      html: welcomeEmailHtml(firstName),
    });

    // Also notify Ben
    try {
      await sendEmail({
        to: 'benjaminritter@lfyconsulting.com',
        subject: `New free signup: ${name || email}`,
        html: `
          <div style="font-family:sans-serif;font-size:14px;line-height:1.8;color:#222;">
            <p>New free account created on Fearless Job Search.</p>
            <p><strong>Name:</strong> ${name || 'Not provided'}<br>
            <strong>Email:</strong> ${email}</p>
          </div>`,
      });
    } catch (e) {
      console.error('Ben notification failed:', e.message);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Welcome email error:', err.message);
    return res.status(500).json({ error: 'Email failed' });
  }
}
