// Simple in-memory rate limiter for Vercel serverless functions
// Resets when the function cold-starts (every ~5-15 min of inactivity)
const rateLimitMap = new Map();

export function rateLimit(req, { maxRequests = 5, windowMs = 60000 } = {}) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';

  const now = Date.now();
  const key = ip;

  if (!rateLimitMap.has(key)) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxRequests - 1, ip };
  }

  const entry = rateLimitMap.get(key);

  // Reset window if expired
  if (now > entry.resetAt) {
    entry.count = 1;
    entry.resetAt = now + windowMs;
    return { allowed: true, remaining: maxRequests - 1, ip };
  }

  entry.count++;
  const remaining = Math.max(0, maxRequests - entry.count);

  if (entry.count > maxRequests) {
    return { allowed: false, remaining: 0, ip };
  }

  return { allowed: true, remaining, ip };
}
