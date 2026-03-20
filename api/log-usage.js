import { rateLimit } from './_rateLimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rl = rateLimit(req, { maxRequests: 20, windowMs: 60000 });
  if (!rl.allowed) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tgicomrycbhrinobvnlr.supabase.co';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseServiceKey) {
    return res.status(200).json({ ok: true, skipped: true });
  }

  try {
    const { user_id, action, details } = req.body;
    if (!user_id || !action) {
      return res.status(200).json({ ok: true, skipped: true });
    }

    const result = await fetch(
      `${supabaseUrl}/rest/v1/usage_log`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ user_id, action, details: details || {} })
      }
    );

    return res.status(200).json({ ok: result.ok });
  } catch (err) {
    console.error('Log usage error:', err);
    return res.status(200).json({ ok: false });
  }
}
