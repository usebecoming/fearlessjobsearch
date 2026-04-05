export const PLANS = {
  free: {
    name: 'Free',
    price: 0,
    searches_per_month: 1,
    jobs_per_search: 10,
    contacts_enabled: true,
    outreach_enabled: true,
    pipeline_enabled: true,
    company_target_enabled: false,
    free_contact_limit: 1,
    free_outreach_limit: 1
  },
  starter: {
    name: 'Starter',
    price: 9.99,
    searches_per_month: 3,
    jobs_per_search: 10,
    contacts_enabled: true,
    outreach_enabled: true,
    pipeline_enabled: true,
    company_target_enabled: false
  },
  pro: {
    name: 'Pro',
    price: 29,
    searches_per_month: 10,
    jobs_per_search: 10,
    contacts_enabled: true,
    outreach_enabled: true,
    pipeline_enabled: true,
    company_target_enabled: true
  },
  accelerate: {
    name: 'Accelerate',
    price: 49,
    searches_per_month: 30,
    jobs_per_search: 20,
    contacts_enabled: true,
    outreach_enabled: true,
    pipeline_enabled: true,
    company_target_enabled: true
  }
};

// Map Stripe price IDs to plan keys
export const PRICE_TO_PLAN = {
  'price_1TIrIFK3APtatfMmX1afwhgV': 'starter',
  'price_1TIrImK3APtatfMm3Vfei67o': 'pro',
  'price_1TIrK7K3APtatfMm2oJ9qPMW': 'accelerate'
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
