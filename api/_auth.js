// Verify the Supabase JWT and extract the authenticated user ID
// Use this in all API endpoints that accept userId from request body
export async function verifyUser(req) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseServiceKey) {
    // Dev mode — no service key, trust request body
    return { error: null, userId: req.body?.userId || req.body?.user_id, email: null };
  }

  // Get JWT from Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Missing authorization header', userId: null, email: null };
  }

  const token = authHeader.replace('Bearer ', '');

  try {
    // Verify token with Supabase Auth API
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        'apikey': supabaseServiceKey,
        'Authorization': `Bearer ${token}`
      }
    });

    if (!res.ok) {
      return { error: 'Invalid or expired token', userId: null, email: null };
    }

    const user = await res.json();
    if (!user?.id) {
      return { error: 'Could not resolve user', userId: null, email: null };
    }

    // If request body has userId, verify it matches the authenticated user
    const requestedId = req.body?.userId || req.body?.user_id;
    if (requestedId && requestedId !== user.id) {
      console.error(`❌ userId mismatch: requested ${requestedId}, authenticated ${user.id}`);
      return { error: 'Unauthorized — userId does not match session', userId: null, email: null };
    }

    return { error: null, userId: user.id, email: user.email };
  } catch (err) {
    console.error('Auth verification error:', err.message);
    return { error: 'Auth verification failed', userId: null, email: null };
  }
}
