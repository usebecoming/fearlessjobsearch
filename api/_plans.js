export const PLANS = {
  free: {
    name: 'Free',
    price: 0,
    searches_per_month: 1,
    jobs_per_search: 3,
    contacts_enabled: false,
    outreach_enabled: false,
    pipeline_enabled: false,
    company_target_enabled: false
  },
  starter: {
    name: 'Starter',
    price: 29,
    searches_per_month: 3,
    jobs_per_search: 10,
    contacts_enabled: true,
    outreach_enabled: true,
    pipeline_enabled: true,
    company_target_enabled: false
  },
  pro: {
    name: 'Pro',
    price: 59,
    searches_per_month: 6,
    jobs_per_search: 10,
    contacts_enabled: true,
    outreach_enabled: true,
    pipeline_enabled: true,
    company_target_enabled: true
  },
  accelerate_monthly: {
    name: 'Accelerate',
    price: 99,
    searches_per_month: 15,
    jobs_per_search: 20,
    contacts_enabled: true,
    outreach_enabled: true,
    pipeline_enabled: true,
    company_target_enabled: true
  },
  accelerate_yearly: {
    name: 'Accelerate (Annual)',
    price: 999,
    searches_per_month: 15,
    jobs_per_search: 20,
    contacts_enabled: true,
    outreach_enabled: true,
    pipeline_enabled: true,
    company_target_enabled: true
  }
};

// Map Stripe price IDs to plan keys
export const PRICE_TO_PLAN = {
  'price_1TCuhfK3APtatfMmhlcWdsdW': 'starter',
  'price_1TCuiKK3APtatfMmOQCSWWd4': 'pro',
  'price_1TCujoK3APtatfMmz0GggJn4': 'accelerate_monthly',
  'price_1TCukaK3APtatfMmKNbheswb': 'accelerate_yearly'
};

export const ADMIN_EMAILS = [
  'ritterbenjamin@gmail.com'
];

export function getPlan(planKey) {
  return PLANS[planKey] || PLANS.free;
}

export function isAdmin(email) {
  return ADMIN_EMAILS.includes(email?.toLowerCase());
}
