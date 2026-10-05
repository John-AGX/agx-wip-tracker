// Fixtures for the head-strip harness. Shaped exactly like what
// nodegraph/ui.js renderSidebarJobCard and js/leads.js mountLeadCard build,
// so what the harness draws is what the app draws.
window.HARNESS = {
  JOB: {
    kind: 'job',
    accent: '#f59e0b',
    status: { label: 'In Progress', color: '#34d399' },
    title: 'RV2019 · Lakeside Village — Bldg 14 Reroof',
    subtitle: 'Vanguard Property Group',
    ring: { pct: 62 },
    facts: [
      { icon: 'calendar', text: 'Sep 24 → Nov 3' },
      { icon: 'check-circle', text: 'Actual Oct 2 → Nov 14' },
      { icon: 'map-pin', text: '5020 Mill Pond Rd, Tampa, FL',
        map: { address: '5020 Mill Pond Rd, Tampa, FL 33610', lat: 27.9881, lng: -82.4012 } },
      { icon: 'briefcase', text: 'Renovation' },
      { icon: 'building-community', text: 'Tampa' },
      { icon: 'user', text: 'Jennifer Bonilla' },
      { icon: 'external-link', text: 'BT Open' },
      { icon: 'hash', text: 'PO 4471' },
      { icon: 'banknotes', text: 'Owed $12,480.75', tone: 'money' }
    ],
    tasks: [
      { title: 'Confirm crane window with property mgr', due: 'Tomorrow', overdue: false },
      { title: 'Chase signed CO #3', due: 'Sep 28', overdue: true }
    ],
    canAddTask: true
  },
  LEAD: {
    kind: 'lead',
    accent: '#a78bfa',
    status: { label: 'Proposal Sent', color: '#a78bfa' },
    title: 'Harbor Pointe — Roof + Soffit Replacement',
    subtitle: 'Harbor Pointe HOA',
    ring: { pct: 45 },
    facts: [
      { icon: '', text: '$312,480.00', tone: 'money' },
      { icon: 'calendar', text: 'Oct 18' },
      { icon: 'map-pin', text: '1800 Harbor Pointe Dr, Clearwater, FL',
        map: { address: '1800 Harbor Pointe Dr, Clearwater, FL', lat: 27.9659, lng: -82.8001 } }
    ],
    stats: [{ label: 'Age', value: '31d' }],
    tasks: [{ title: 'Follow up on proposal', due: 'Friday', overdue: false }],
    canAddTask: true
  }
};
