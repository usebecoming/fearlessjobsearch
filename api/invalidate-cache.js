import { verifyUser } from './_auth.js';
import { invalidateContactCache, invalidateOutreachCache } from './_cache.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = await verifyUser(req);
  if (auth.error) {
    return res.status(401).json({ error: auth.error });
  }

  const { type, company, jobFunction, linkedinUrl } = req.body;

  if (type === 'contacts' && company) {
    await invalidateContactCache(company, jobFunction || 'general');
  } else if (type === 'outreach' && linkedinUrl) {
    await invalidateOutreachCache(auth.userId, linkedinUrl, company);
  } else {
    return res.status(400).json({ error: 'Invalid invalidation request' });
  }

  res.json({ success: true });
}
