function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
// ============================================================================
// SSB Scheduler app.js — Module 2 build
// ============================================================================
// What changed in Module 2:
//   * Loads pools, operating_hours, and session_instructors from the new schema.
//   * Sessions now carry pool_id, lesson_type_id, instructors[], and computed
//     capacity (current / max / status). Body counts use the same arithmetic
//     as the pool_occupancy() Postgres function.
//   * Weekly grid has a pool filter (All / Pool A / Pool B / ...). In All mode
//     each day-column splits into per-pool sub-columns.
//   * Each event renders a capacity chip with green / amber / red coloring.
//     Over-capacity sessions also get an amber border. Nothing is enforced;
//     the scheduler still has full freedom to save anything. Hard enforcement
//     is Module 3.
//   * Session modal: pool selector; lesson-type change auto-defaults the
//     duration from scheduler_lesson_types.default_duration_minutes; a small
//     capacity preview shows current vs max after edits.
//   * Settings: new Pools panel, new Operating Hours panel, lesson-type rows
//     gain an Edit toggle that exposes age range / ratio / billing / default
//     pool / coach-in-pool / default duration.
//   * Operating hours drive the visible grid bounds. Default seed (8 AM to 9
//     PM, every day, 30-min blocks) produces the same grid as before.
// ============================================================================

const {
  useState,
  useEffect,
  useMemo
} = React;

// ───────────────────────────────────────────────────────────────────── constants

const DAYS_S = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAYS_F = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const SLOT_MIN = 30;
const ROW_H = 42;
const DEFAULT_OPEN = 480; // 8:00 AM fallback if operating_hours table is empty
const DEFAULT_CLOSE = 1260; // 9:00 PM fallback

const DEFAULT_TYPES = {
  "LTS": {
    bg: "#DBEAFE",
    bd: "#3B82F6",
    tx: "#1E40AF"
  },
  "LTS Adult": {
    bg: "#CFFAFE",
    bd: "#06B6D4",
    tx: "#0E7490"
  },
  "Personal 1": {
    bg: "#FED7AA",
    bd: "#F97316",
    tx: "#C2410C"
  },
  "Personal 2": {
    bg: "#FEF9C3",
    bd: "#CA8A04",
    tx: "#854D0E"
  },
  "Fam3": {
    bg: "#D1FAE5",
    bd: "#10B981",
    tx: "#065F46"
  },
  "Fam4": {
    bg: "#DCFCE7",
    bd: "#22C55E",
    tx: "#14532D"
  },
  "Fam5": {
    bg: "#D9F99D",
    bd: "#84CC16",
    tx: "#365314"
  },
  "Toddler": {
    bg: "#FCE7F3",
    bd: "#EC4899",
    tx: "#831843"
  },
  "Baby&Me": {
    bg: "#EDE9FE",
    bd: "#8B5CF6",
    tx: "#4C1D95"
  },
  "Personal Clara": {
    bg: "#FEE2E2",
    bd: "#EF4444",
    tx: "#7F1D1D"
  }
};

// ───────────────────────────────────────────────────────────────────── REST glue

const cfg = window.APP_CONFIG || {};
const BASE_HEADERS = {
  apikey: cfg.supabaseAnonKey || '',
  Authorization: `Bearer ${cfg.supabaseAnonKey || ''}`,
  'Content-Type': 'application/json'
};
function apiUrl(path) {
  return `${cfg.supabaseUrl}/rest/v1/${path}`;
}
async function rest(path, opts = {}) {
  const mergedHeaders = {
    ...BASE_HEADERS,
    ...(opts.headers || {})
  };
  const res = await fetch(apiUrl(path), {
    ...opts,
    headers: mergedHeaders
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(txt || `HTTP ${res.status}`);
  return txt ? JSON.parse(txt) : null;
}
async function selectRows(table, select = '*', extra = '') {
  return rest(`${table}?select=${select}${extra}`);
}
async function insertRows(table, payload, select = '*') {
  return rest(`${table}?select=${select}`, {
    method: 'POST',
    headers: {
      Prefer: 'return=representation'
    },
    body: JSON.stringify(Array.isArray(payload) ? payload : [payload])
  });
}
async function patchRows(table, match, payload, select = '*') {
  const q = Object.entries(match).map(([k, v]) => `&${encodeURIComponent(k)}=eq.${encodeURIComponent(v)}`).join('');
  return rest(`${table}?select=${select}${q}`, {
    method: 'PATCH',
    headers: {
      Prefer: 'return=representation'
    },
    body: JSON.stringify(payload)
  });
}
async function deleteRows(table, match, select = '*') {
  const q = Object.entries(match).map(([k, v]) => `&${encodeURIComponent(k)}=eq.${encodeURIComponent(v)}`).join('');
  return rest(`${table}?select=${select}${q}`, {
    method: 'DELETE',
    headers: {
      Prefer: 'return=representation'
    }
  });
}

// ───────────────────────────────────────────────────────────────────── helpers

function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fromDateStr(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function todayStr() {
  return toDateStr(new Date());
}
function minuteToTime(mins) {
  const h24 = Math.floor(mins / 60),
    m = mins % 60,
    ampm = h24 < 12 ? 'AM' : 'PM';
  const h = h24 % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}
// Short time: drops :00 on the hour — "8 AM", "5 PM", "10:30 AM"
function shortTime(mins) {
  const h24 = Math.floor(mins / 60),
    m = mins % 60,
    ampm = h24 < 12 ? 'AM' : 'PM',
    h = h24 % 12 || 12;
  return m === 0 ? `${h} ${ampm}` : `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}
function shortRange(startMin, durMin) {
  return `${shortTime(startMin)}–${shortTime(startMin + durMin)}`;
}
// Compact label for whole-hour agenda rows: "10 AM", "12 PM", "1:30 PM".
function hourLabel(mins) {
  const h24 = Math.floor(mins / 60),
    m = mins % 60,
    ampm = h24 < 12 ? 'AM' : 'PM';
  const h = h24 % 12 || 12;
  return m === 0 ? `${h} ${ampm}` : `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}
// Display-only: shorten a full name to its first two words ("Ashton Ang Zi Yang" → "Ashton Ang"). Full name is untouched in the database.
function shortName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 3).join(' ');
}
// clip20: truncate name to 20 chars max (with ellipsis) for tight weekly grid cells
function clip22(name) {
  const n = shortName(name);
  return n.length > 18 ? n.slice(0, 17) + '…' : n;
}
// toTitleCase: capitalize first letter of every word; used to auto-correct name inputs
function toTitleCase(s) {
  return (s || '').replace(/\b\w/g, c => c.toUpperCase());
}
// Age shown in years, e.g. " (5)". Blank when unknown.
function ageSuffix(s) {
  return s && s.age !== null && s.age !== undefined && s.age !== '' ? ` (${s.age})` : '';
}
// Compute total months between a DOB and today. Birthday-aware (subtracts a
// month if today is before the day-of-month). Returns null on invalid input.
function ageMonthsFromDob(dob) {
  if (!dob) return null;
  try {
    const d = typeof dob === 'string' ? fromDateStr(dob) : new Date(dob);
    const now = new Date();
    let months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
    if (now.getDate() < d.getDate()) months--;
    return Math.max(0, months);
  } catch (_) {
    return null;
  }
}
// Display age: half-year precision for under-5s (e.g. 1.5, 2.0, 4.5),
// integer years for 5+. Matches the precision the swim school actually
// uses when slotting toddlers into age-banded classes.
function ageFromDob(dob) {
  const m = ageMonthsFromDob(dob);
  if (m == null) return null;
  if (m < 60) return Math.floor(m / 6) / 2;
  return Math.floor(m / 12);
}
function ageDisplay(age) {
  if (age === null || age === undefined || age === '') return '—';
  return `${age}y`;
}
function studentLabel(s) {
  return s.name + ageSuffix(s) + (s && s.remark ? ` — ${s.remark}` : '');
}
// Build the modal's student rows: existing students first, padded with blanks
// up to the lesson type's ratio (so "max 4" shows 4 boxes). Falls back to 4.
function buildStudentRows(existing, cap) {
  const rows = (existing || []).map(s => ({
    studentId: s.studentId || null,
    name: s.name || '',
    age: s.age === null || s.age === undefined ? '' : String(s.age),
    remark: s.remark || '',
    attendance: s.attendance || 'pending'
  }));
  const c = Number(cap) > 0 ? Number(cap) : 4;
  const target = Math.max(c, rows.length, 1);
  while (rows.length < target) rows.push({
    studentId: null,
    name: '',
    age: '',
    remark: '',
    attendance: 'pending'
  });
  return rows;
}
// Re-normalize rows when the lesson type changes: keep filled rows, pad to the new ratio.
function rebuildRowsForCap(rows, cap) {
  const filled = (rows || []).filter(r => (r.name || '').trim() || r.studentId);
  const c = Number(cap) > 0 ? Number(cap) : 4;
  const target = Math.max(c, filled.length, 1);
  const out = filled.slice();
  while (out.length < target) out.push({
    studentId: null,
    name: '',
    age: '',
    remark: '',
    attendance: 'pending'
  });
  return out;
}
function formatRange(startMin, durationMin) {
  return `${minuteToTime(startMin)}–${minuteToTime(startMin + durationMin)}`;
}
// Compact form for tight cards: drops ":00" and the space before AM/PM, keeps
// non-zero minutes ("11AM", "11:30AM", "12PM-1PM").
function compactTime(mins) {
  const h24 = Math.floor(mins / 60),
    m = mins % 60,
    ampm = h24 < 12 ? 'AM' : 'PM';
  const h = h24 % 12 || 12;
  return m === 0 ? `${h}${ampm}` : `${h}:${String(m).padStart(2, '0')}${ampm}`;
}
function compactRange(startMin, durationMin) {
  return `${compactTime(startMin)}-${compactTime(startMin + durationMin)}`;
}
function longDate(s) {
  return fromDateStr(s).toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}
function monthCells(d) {
  const y = d.getFullYear(),
    m = d.getMonth();
  const first = new Date(y, m, 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(y, m, 1 - offset);
  return Array.from({
    length: 42
  }, (_, i) => {
    const x = new Date(start);
    x.setDate(start.getDate() + i);
    return x;
  });
}
function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function dateToWeekdayIndex(dateStr) {
  return (fromDateStr(dateStr).getDay() + 6) % 7;
}
function excludeFromStudentTotals(sessionType) {
  const t = String(sessionType || '').toLowerCase();
  return t.includes('replacement') || t.includes('trial');
}
function weekBounds(dateStr) {
  const d = fromDateStr(dateStr);
  const monday = new Date(d);
  monday.setDate(d.getDate() - (d.getDay() + 6) % 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    start: monday,
    end: sunday
  };
}
function weekStartStr(dateStr) {
  return toDateStr(weekBounds(dateStr).start);
}
function addDays(dateStr, days) {
  const d = fromDateStr(dateStr);
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

// M2: dynamic grid bounds from operating_hours rows. Falls back to 8 AM - 9 PM.
// Uses the widest window across all open days so days that close earlier just
// show empty cells past their close time.
function computeGridBounds(operatingHours) {
  const open = (operatingHours || []).filter(h => h.is_open !== false);
  if (!open.length) return {
    startMin: DEFAULT_OPEN,
    endMin: DEFAULT_CLOSE
  };
  const startMin = Math.min(...open.map(h => Number(h.open_minute)));
  const endMin = Math.max(...open.map(h => Number(h.close_minute)));
  // Snap to the SLOT_MIN grid so row arithmetic stays clean.
  return {
    startMin: Math.floor(startMin / SLOT_MIN) * SLOT_MIN,
    endMin: Math.ceil(endMin / SLOT_MIN) * SLOT_MIN
  };
}

// M2: mirrors the Postgres pool_occupancy() rounding so JS and DB agree on
// when one session blocks another.
function sessionCapacity(session, lessonType) {
  const ratio = Number(lessonType && lessonType.students_per_instructor || 0);
  const instCount = Math.max(0, (session.instructors || []).length);
  const max = ratio > 0 ? ratio * Math.max(1, instCount) : 0;
  const current = (session.students || []).length;
  let status = 'unknown';
  if (max > 0) {
    if (current > max) status = 'over';else if (current === max) status = 'full';else if (current / max >= 0.8) status = 'tight';else status = 'open';
  }
  return {
    current,
    max,
    status
  };
}
function capacityChipColors(status) {
  switch (status) {
    case 'open':
      return {
        bg: '#E4F6EC',
        tx: '#138A53',
        bd: '#BFE8CF'
      };
    case 'tight':
      return {
        bg: '#FCEFD6',
        tx: '#B45309',
        bd: '#F2DCA8'
      };
    case 'full':
      return {
        bg: '#FCE7D6',
        tx: '#C2410C',
        bd: '#F3D2B0'
      };
    case 'over':
      return {
        bg: '#FCE7E7',
        tx: '#D63B3B',
        bd: '#F3C9C9'
      };
    default:
      return {
        bg: '#F0F0F5',
        tx: '#6C6C7E',
        bd: '#E1E1EC'
      };
  }
}

// M2: print helpers preserved as before.
function printWeeklyView() {
  document.body.setAttribute('data-print-view', 'weekly');
  window.print();
  setTimeout(() => document.body.removeAttribute('data-print-view'), 300);
}
function printDailyView(dateStr) {
  document.body.setAttribute('data-print-view', 'daily');
  document.body.setAttribute('data-print-date', dateStr || '');
  window.print();
  setTimeout(() => {
    document.body.removeAttribute('data-print-view');
    document.body.removeAttribute('data-print-date');
  }, 300);
}
function printWeeklyTable() {
  const s = document.createElement('style');
  s.id = 'wt-page-style';
  s.textContent = '@page{size:A3 landscape;margin:8mm}';
  document.head.appendChild(s);
  document.body.setAttribute('data-print-view', 'weekly-table');
  window.print();
  setTimeout(() => {
    document.body.removeAttribute('data-print-view');
    const el = document.getElementById('wt-page-style');
    if (el) el.remove();
  }, 500);
}

// M2: assign _col / _total within a set of overlapping sessions. Extracted from
// the prior inline logic so it can be reused per (day, pool) tuple.
function packParallelColumns(items) {
  const sorted = items.slice().sort((a, b) => a.startMinute - b.startMinute || (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || String(a.id).localeCompare(String(b.id)));
  const cols = [];
  const out = [];
  sorted.forEach(item => {
    const end = item.startMinute + item.durationMinutes;
    let idx = 0;
    while (idx < cols.length && cols[idx] > item.startMinute) idx++;
    cols[idx] = end;
    out.push({
      ...item,
      _col: idx
    });
  });
  const total = Math.max(cols.length, 1);
  return out.map(x => ({
    ...x,
    _total: total
  }));
}

// ============================================================================
// App
// ============================================================================

// M2.1: human week-range label, e.g. "May 25 – 31, 2026" or "May 25 – Jun 1, 2026".
function weekRangeLabel(wkStart) {
  const start = fromDateStr(wkStart);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const sM = start.toLocaleDateString(undefined, {
    month: 'short'
  });
  const eM = end.toLocaleDateString(undefined, {
    month: 'short'
  });
  const sY = start.getFullYear(),
    eY = end.getFullYear();
  if (sY !== eY) return `${sM} ${start.getDate()}, ${sY} – ${eM} ${end.getDate()}, ${eY}`;
  if (sM === eM) return `${sM} ${start.getDate()} – ${end.getDate()}, ${eY}`;
  return `${sM} ${start.getDate()} – ${eM} ${end.getDate()}, ${eY}`;
}

// M2.1: one navigation band shared by Weekly and Daily. A week stepper with a
// readable range label, a "This Week" reset, and a right-aligned actions slot.
function PeriodNav({
  rangeLabel,
  onPrev,
  onNext,
  onToday,
  isCurrent,
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "period-nav"
  }, /*#__PURE__*/React.createElement("div", {
    className: "period-nav-left"
  }, /*#__PURE__*/React.createElement("div", {
    className: "period-stepper"
  }, /*#__PURE__*/React.createElement("button", {
    className: "step-btn",
    onClick: onPrev,
    title: "Previous week",
    "aria-label": "Previous week"
  }, "\u2039"), /*#__PURE__*/React.createElement("div", {
    className: "period-label"
  }, rangeLabel), /*#__PURE__*/React.createElement("button", {
    className: "step-btn",
    onClick: onNext,
    title: "Next week",
    "aria-label": "Next week"
  }, "\u203A")), /*#__PURE__*/React.createElement("button", {
    className: `today-btn ${isCurrent ? 'is-current' : ''}`,
    onClick: onToday,
    disabled: isCurrent,
    title: "Jump to the current week"
  }, "This Week")), children ? /*#__PURE__*/React.createElement("div", {
    className: "period-nav-actions"
  }, children) : null);
}
function App() {
  const [view, setView] = useState('schedule'); // 'schedule'|'accounts'|'enroll'|'settings'|'students'
  const [scheduleSection, setScheduleSection] = useState('week'); // 'week'|'day'|'month'
  const [adminSection, setAdminSection] = useState('pools'); // 'summary'|'pools'|'instructors'|'lessonTypes'
  const [accountSection, setAccountSection] = useState('accounts');
  // Clear sticky search box when switching account sub-tabs
  useEffect(() => {
    setAccountSearchQ('');
  }, [accountSection]); // 'accounts'|'familyGroups'|'invoices'|'receipts'|'pendingCredits'|'aging'|'codes'
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [sessions, setSessions] = useState([]);
  const [students, setStudents] = useState([]);
  const [familyGroups, setFamilyGroups] = useState([]);
  const [groupMemberships, setGroupMemberships] = useState([]);
  const [creditBalances, setCreditBalances] = useState([]);
  const [creditPurchases, setCreditPurchases] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]);
  const [codes, setCodes] = useState([]);
  const [replacementPending, setReplacementPending] = useState([]);
  const [tcAcceptances, setTcAcceptances] = useState([]);
  const [remarks, setRemarks] = useState({});
  const [options, setOptions] = useState({
    instructors: [],
    durations: [],
    lessonTypes: [],
    pools: [],
    operatingHours: [],
    packages: [],
    branches: []
  });
  const [monthCursor, setMonthCursor] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(todayStr());
  const [selectedPoolId, setSelectedPoolId] = useState(null);
  // Search box lifted to App so it can live in the sticky sub-bar
  const [accountSearchQ, setAccountSearchQ] = useState('');
  // Branch filter — remembered across sessions; defaults to last selection or HQ.
  const [currentBranchId, setCurrentBranchIdRaw] = useState(() => {
    try {
      return window.localStorage.getItem('ssb.currentBranchId') || null;
    } catch (_) {
      return null;
    }
  });
  function setCurrentBranchId(id) {
    setCurrentBranchIdRaw(id);
    setSelectedPoolId(null); // reset pool filter when branch changes
    try {
      if (id) window.localStorage.setItem('ssb.currentBranchId', id);else window.localStorage.removeItem('ssb.currentBranchId');
    } catch (_) {}
  }
  const [enabledTypes, setEnabledTypes] = useState(null);
  const [selectedInstructors, setSelectedInstructors] = useState(new Set());
  const [modal, _setModal] = useState(null);
  // modalRef is always the latest modal value — updated synchronously
  // inside every setModal call so saveSession never reads stale data.
  const modalRef = React.useRef(null);
  function setModal(valOrFn) {
    if (typeof valOrFn === 'function') {
      _setModal(prev => {
        const next = valOrFn(prev);
        modalRef.current = next;
        return next;
      });
    } else {
      modalRef.current = valOrFn;
      _setModal(valOrFn);
    }
  }
  const [saveBusy, setSaveBusy] = useState(false);
  const [remarkDraft, setRemarkDraft] = useState('');
  // ── Invoicing state ────────────────────────────────────────────────
  const [invoices, setInvoices] = useState([]);
  const [invoiceLines, setInvoiceLines] = useState([]);
  const [pmts, setPmts] = useState([]);
  const [pendingCredits, setPendingCredits] = useState([]);
  const [invoiceSettings, setInvoiceSettings] = useState({
    invoice_prefix: 'INV',
    receipt_prefix: 'RCT',
    next_invoice_seq: 1,
    next_receipt_seq: 1,
    leading_zeros: 3,
    include_date: true,
    date_format: 'YYYYMM',
    allow_delete_invoice: false
  });
  useEffect(() => {
    boot();
  }, []);
  // Default branch on first load: prefer SSGT (HQ), else first active branch.
  useEffect(() => {
    if (currentBranchId) return;
    if (!options.branches?.length) return;
    const hq = options.branches.find(b => (b.code || '').toUpperCase() === 'SSGT') || options.branches.find(b => b.is_active !== false) || options.branches[0];
    if (hq) setCurrentBranchId(hq.id);
  }, [options.branches]);
  useEffect(() => {
    if (cfg.supabaseUrl && cfg.supabaseAnonKey) loadRemarks(monthCursor).catch(handleErr);
  }, [monthCursor]);
  useEffect(() => {
    setRemarkDraft(remarks[selectedDate] || '');
  }, [selectedDate, remarks]);
  function handleErr(err) {
    console.error(err);
    setError(err?.message || String(err));
    setStatus('Error');
  }
  async function boot() {
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
      setError('Missing config.js values.');
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError('');
      // Phase 1 — critical: options + sessions needed to render the first view.
      await Promise.all([loadOptions(), loadSessions()]);
      setLoading(false);
      setStatus('Connected');
      // Phase 2 — background: load everything else after first paint.
      Promise.all([loadStudents(), loadGroups(), loadGroupMemberships(), loadCreditBalances(), loadCreditPurchases(), loadSubscriptions(), loadCodes(), loadReplacementPending(), loadTcAcceptances(), loadRemarks(monthCursor), loadInvoiceData()]).catch(e => console.warn('Background load warning:', e));
    } catch (err) {
      handleErr(err);
      setLoading(false);
    }
  }

  // ── Invoice loaders ────────────────────────────────────────────────
  async function loadInvoiceData() {
    try {
      const [invRows, lineRows, payRows, pcRows, settRows] = await Promise.all([selectRows('invoices', '*', '&order=created_at.desc'), selectRows('invoice_lines', '*', '&order=invoice_id.asc,sort_order.asc'), selectRows('payments', '*', '&order=invoice_id.asc,created_at.asc'), selectRows('pending_credits', '*', '&order=created_at.desc'), selectRows('invoice_settings', '*').catch(() => [])]);
      setInvoices(invRows || []);
      setInvoiceLines(lineRows || []);
      setPmts(payRows || []);
      setPendingCredits(pcRows || []);
      if (settRows?.[0]) setInvoiceSettings(settRows[0]);
    } catch (e) {
      console.warn('Invoice tables not found — run migrations first.', e);
    }
  }

  // ── Number formatting ──────────────────────────────────────────────
  // Pure helper — builds a formatted number string from a settings object
  // and a raw sequence integer. Used for live preview and generation.
  function formatInvoiceNumber(sett, seq) {
    const now = new Date();
    const y = now.getFullYear(),
      m = String(now.getMonth() + 1).padStart(2, '0');
    const yy = String(y).slice(-2);
    const datePart = sett.include_date !== false ? {
      YYYYMM: `-${y}${m}`,
      YYYY: `-${y}`,
      MM: `-${m}`,
      MMYY: `-${m}${yy}`,
      none: ''
    }[sett.date_format || 'YYYYMM'] ?? `-${y}${m}` : '';
    const pad = Math.max(1, Number(sett.leading_zeros) || 3);
    const seqStr = String(seq).padStart(pad, '0');
    return `${sett.invoice_prefix || 'INV'}${datePart}-${seqStr}`;
  }
  function formatReceiptNumber(sett, seq) {
    const now = new Date();
    const y = now.getFullYear(),
      m = String(now.getMonth() + 1).padStart(2, '0');
    const yy = String(y).slice(-2);
    const datePart = sett.include_date !== false ? {
      YYYYMM: `-${y}${m}`,
      YYYY: `-${y}`,
      MM: `-${m}`,
      MMYY: `-${m}${yy}`,
      none: ''
    }[sett.date_format || 'YYYYMM'] ?? `-${y}${m}` : '';
    const pad = Math.max(1, Number(sett.leading_zeros) || 3);
    const seqStr = String(seq).padStart(pad, '0');
    return `${sett.receipt_prefix || 'RCT'}${datePart}-${seqStr}`;
  }

  // Save invoice settings (upsert on id=1)
  async function saveInvoiceSettings(patch) {
    try {
      await patchRows('invoice_settings', {
        id: 1
      }, patch);
      await loadInvoiceData();
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to save settings');
    }
  }

  // ── Invoice CRUD ───────────────────────────────────────────────────
  async function createInvoice({
    accountName,
    accountEmail,
    accountPhone,
    lines,
    notes,
    dueDate
  }) {
    // Read current settings (fresh from DB to get latest seq)
    const settRows = await selectRows('invoice_settings', '*').catch(() => []);
    const sett = settRows?.[0] || invoiceSettings;
    const seq = Number(sett.next_invoice_seq) || 1;
    const invoiceNumber = formatInvoiceNumber(sett, seq);
    // Increment counter immediately so concurrent creates don't collide
    await patchRows('invoice_settings', {
      id: 1
    }, {
      next_invoice_seq: seq + 1
    }).catch(() => {});
    const totalAmount = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
    const now = new Date();
    const inserted = await insertRows('invoices', {
      invoice_number: invoiceNumber,
      account_name: accountName,
      account_email: accountEmail || null,
      account_phone: accountPhone || null,
      status: 'draft',
      issue_date: toDateStr(now),
      due_date: dueDate || null,
      notes: notes || null,
      total_amount: totalAmount,
      amount_paid: 0,
      branch_id: currentBranchId && currentBranchId !== 'all' ? currentBranchId : null
    });
    const invoiceId = inserted?.[0]?.id;
    if (invoiceId && lines.length) {
      await insertRows('invoice_lines', lines.map((l, i) => ({
        invoice_id: invoiceId,
        description: l.description,
        lesson_type_name: l.lessonTypeName || null,
        lesson_type_id: l.lessonTypeId || null,
        package_name: l.packageName || null,
        package_id: l.packageId || null,
        family_group_id: l.familyGroupId || null,
        family_group_name: l.familyGroupName || null,
        student_names: l.studentNames || null,
        student_ids: l.studentIds || null,
        amount: Number(l.amount || 0),
        quantity: 1,
        is_billable: true,
        line_type: l.lineType || 'package',
        credits_per_swimmer: l.creditsPerSwimmer || null,
        billing_mode: l.billingMode || null,
        sort_order: i
      })));
    }
    await loadInvoiceData();
    return invoiceId;
  }
  async function recordPayment({
    invoiceId,
    amount,
    paymentDate,
    paymentMethod,
    referenceNumber,
    notes: pNotes
  }) {
    // Read current settings (fresh) for receipt number
    const settRows = await selectRows('invoice_settings', '*').catch(() => []);
    const sett = settRows?.[0] || invoiceSettings;
    const seq = Number(sett.next_receipt_seq) || 1;
    const receiptNumber = formatReceiptNumber(sett, seq);
    await patchRows('invoice_settings', {
      id: 1
    }, {
      next_receipt_seq: seq + 1
    }).catch(() => {});
    const inserted = await insertRows('payments', {
      invoice_id: invoiceId,
      receipt_number: receiptNumber,
      amount: Number(amount),
      payment_date: paymentDate || todayStr(),
      payment_method: paymentMethod || 'cash',
      reference_number: referenceNumber || null,
      notes: pNotes || null
    });
    const paymentId = inserted?.[0]?.id;
    // Seed pending_credits from billable lines
    if (paymentId) {
      const invLines = invoiceLines.filter(l => l.invoice_id === invoiceId && l.is_billable);
      const creditRows = [];
      invLines.forEach(l => {
        if (l.family_group_id) {
          creditRows.push({
            invoice_id: invoiceId,
            payment_id: paymentId,
            family_group_id: l.family_group_id,
            lesson_type_id: l.lesson_type_id,
            package_id: l.package_id,
            description: l.description,
            credits_per_swimmer: l.credits_per_swimmer || 4,
            status: 'pending'
          });
        } else if (l.student_ids) {
          l.student_ids.split(',').map(s => s.trim()).filter(Boolean).forEach(sid => {
            creditRows.push({
              invoice_id: invoiceId,
              payment_id: paymentId,
              student_id: sid,
              lesson_type_id: l.lesson_type_id,
              package_id: l.package_id,
              description: l.description,
              credits_per_swimmer: l.credits_per_swimmer || 4,
              status: 'pending'
            });
          });
        }
      });
      if (creditRows.length) await insertRows('pending_credits', creditRows);
    }
    // Recalculate invoice status
    const invoice = invoices.find(i => i.id === invoiceId);
    const existingPaid = pmts.filter(p => p.invoice_id === invoiceId).reduce((s, p) => s + Number(p.amount), 0);
    const totalPaid = existingPaid + Number(amount);
    const newStatus = totalPaid >= Number(invoice?.total_amount || 0) ? 'paid' : totalPaid > 0 ? 'partial' : 'sent';
    await patchRows('invoices', {
      id: invoiceId
    }, {
      amount_paid: totalPaid,
      status: newStatus,
      updated_at: new Date().toISOString()
    });
    await loadInvoiceData();
    return {
      receiptNumber
    };
  }
  async function confirmCredit(credit) {
    // Write credits directly — skips the `subscriptions` table (which is
    // optional / not yet migrated) and writes straight to credit_purchases
    // + student_credit_balances, which are always present.
    try {
      const creditsNum = credit.credits_per_swimmer || 4;
      const date = toDateStr(new Date());
      // Resolve which swimmers receive the credit
      let affectedStudents = [];
      if (credit.family_group_id) {
        const members = membersByGroup && membersByGroup[credit.family_group_id] || [];
        affectedStudents = credit.lesson_type_id ? members.filter(m => (m.lessonTypeIds || []).includes(credit.lesson_type_id)) : members;
      } else if (credit.student_id) {
        const stu = studentById[credit.student_id];
        if (stu) affectedStudents = [stu];
      }
      if (!affectedStudents.length) {
        alert('No swimmers found to credit.');
        return;
      }
      // Insert credit_purchases rows
      await insertRows('credit_purchases', affectedStudents.map(s => ({
        student_id: s.id,
        lesson_type_id: credit.lesson_type_id,
        purchase_date: date,
        credits_added: creditsNum,
        source: 'pending_credit_confirmed',
        notes: `Confirmed from pending credit ${credit.id}`
      })));
      // Bump each balance
      for (const s of affectedStudents) {
        await bumpBalance(s.id, credit.lesson_type_id, creditsNum);
      }
      // Mark the pending credit as confirmed
      await patchRows('pending_credits', {
        id: credit.id
      }, {
        status: 'confirmed',
        confirmed_at: new Date().toISOString()
      });
      await Promise.all([loadCreditBalances(), loadInvoiceData(), loadStudents()]);
      setStatus(`Confirmed: +${creditsNum} credits to ${affectedStudents.length} swimmer${affectedStudents.length === 1 ? '' : 's'}.`);
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to confirm credit');
    }
  }
  async function reverseCredit(credit) {
    if (!confirm('Reverse this pending credit? Credits will not be allocated.')) return;
    try {
      await patchRows('pending_credits', {
        id: credit.id
      }, {
        status: 'reversed',
        reversed_at: new Date().toISOString()
      });
      await loadInvoiceData();
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to reverse');
    }
  }
  async function voidInvoice(id) {
    if (!confirm('Void this invoice? This cannot be undone.')) return;
    try {
      await patchRows('invoices', {
        id
      }, {
        status: 'void',
        updated_at: new Date().toISOString()
      });
      await loadInvoiceData();
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to void');
    }
  }
  async function deleteInvoice(id) {
    if (!confirm('Permanently delete this invoice, all its lines, and all payments? This cannot be undone.')) return;
    try {
      await deleteRows('payments', {
        invoice_id: id
      });
      await deleteRows('pending_credits', {
        invoice_id: id
      }).catch(() => {});
      await deleteRows('invoice_lines', {
        invoice_id: id
      });
      await deleteRows('invoices', {
        id
      });
      await loadInvoiceData();
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to delete invoice');
    }
  }
  async function updateInvoiceStatus(id, newStatus) {
    try {
      await patchRows('invoices', {
        id
      }, {
        status: newStatus,
        updated_at: new Date().toISOString()
      });
      await loadInvoiceData();
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to update status');
    }
  }

  // ── Invoice line CRUD (Phase 2) ────────────────────────────────────
  async function recalcInvoiceTotal(invoiceId) {
    // Re-sum billable lines and push to invoices.total_amount
    const lines = invoiceLines.filter(l => l.invoice_id === invoiceId && l.is_billable);
    const total = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
    await patchRows('invoices', {
      id: invoiceId
    }, {
      total_amount: total,
      updated_at: new Date().toISOString()
    });
  }
  async function addInvoiceLine(invoiceId, lineData) {
    try {
      const existing = invoiceLines.filter(l => l.invoice_id === invoiceId);
      await insertRows('invoice_lines', {
        invoice_id: invoiceId,
        description: lineData.description || 'Custom line',
        amount: Number(lineData.amount || 0),
        quantity: 1,
        is_billable: true,
        line_type: lineData.lineType || 'other',
        lesson_type_name: lineData.lessonTypeName || null,
        package_name: lineData.packageName || null,
        sort_order: existing.length
      });
      await loadInvoiceData();
      // Recalc after reload so new line is in invoiceLines
      const refreshed = await selectRows('invoice_lines', '*', `&invoice_id=eq.${invoiceId}&is_billable=eq.true`).catch(() => []);
      const total = (refreshed || []).reduce((s, l) => s + Number(l.amount || 0), 0);
      await patchRows('invoices', {
        id: invoiceId
      }, {
        total_amount: total,
        updated_at: new Date().toISOString()
      });
      await loadInvoiceData();
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to add line');
    }
  }
  async function updateInvoiceLine(lineId, patch) {
    try {
      await patchRows('invoice_lines', {
        id: lineId
      }, patch);
      // Find the invoice this line belongs to
      const line = invoiceLines.find(l => l.id === lineId);
      if (line) {
        await loadInvoiceData();
        const refreshed = await selectRows('invoice_lines', '*', `&invoice_id=eq.${line.invoice_id}&is_billable=eq.true`).catch(() => []);
        const total = (refreshed || []).reduce((s, l) => s + Number(l.amount || 0), 0);
        await patchRows('invoices', {
          id: line.invoice_id
        }, {
          total_amount: total,
          updated_at: new Date().toISOString()
        });
      }
      await loadInvoiceData();
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to update line');
    }
  }
  async function deleteInvoiceLine(lineId) {
    if (!confirm('Remove this line from the invoice?')) return;
    try {
      const line = invoiceLines.find(l => l.id === lineId);
      await deleteRows('invoice_lines', {
        id: lineId
      });
      if (line) {
        await loadInvoiceData();
        const refreshed = await selectRows('invoice_lines', '*', `&invoice_id=eq.${line.invoice_id}&is_billable=eq.true`).catch(() => []);
        const total = (refreshed || []).reduce((s, l) => s + Number(l.amount || 0), 0);
        await patchRows('invoices', {
          id: line.invoice_id
        }, {
          total_amount: total,
          updated_at: new Date().toISOString()
        });
      }
      await loadInvoiceData();
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to delete line');
    }
  }

  // M2: also loads pools and operating_hours.
  async function loadOptions() {
    const [instructors, durations, lessonTypes, pools, operatingHours, packages, branches] = await Promise.all([selectRows('scheduler_instructors', '*', '&order=sort_order.asc,name.asc'), selectRows('scheduler_durations', '*', '&order=sort_order.asc,slots.asc'), selectRows('scheduler_lesson_types', '*', '&order=sort_order.asc,name.asc'), selectRows('pools', '*', '&order=sort_order.asc,name.asc'), selectRows('operating_hours', '*', '&order=weekday.asc'), selectRows('packages', '*', '&order=sort_order.asc,name.asc').catch(() => []), selectRows('branches', '*', '&order=sort_order.asc,name.asc').catch(() => [])]);
    setOptions({
      instructors: instructors || [],
      durations: durations || [],
      lessonTypes: lessonTypes || [],
      pools: pools || [],
      operatingHours: operatingHours || [],
      packages: packages || [],
      branches: branches || []
    });
    // Expose branches to module-level print helpers (printInvoice, printReceipt)
    // which sit outside the App component and need to resolve invoice.branch_id.
    try {
      window.__SSB_BRANCHES__ = branches || [];
    } catch (_) {}
  }

  // M2: students are loaded via PostgREST resource embedding (nested inside
  // each session row) rather than a separate flat query. This bypasses the
  // Supabase default 1000-row limit on weekly_session_students — when the
  // table exceeded 1000 rows, newly saved students were silently cut off.
  async function loadSessions() {
    const [sessionRows, instructorJoinRows, instructorCatalog] = await Promise.all([rest('weekly_sessions?select=*,weekly_session_students(*)&order=week_start_date.asc,weekday.asc,start_minute.asc,created_at.asc'), selectRows('session_instructors', '*'), selectRows('scheduler_instructors', '*')]);
    const instructorById = {};
    (instructorCatalog || []).forEach(i => {
      instructorById[i.id] = i;
    });
    const instructorsBySession = {};
    (instructorJoinRows || []).forEach(r => {
      const key = String(r.session_id);
      if (!instructorsBySession[key]) instructorsBySession[key] = [];
      const inst = instructorById[r.instructor_id];
      if (inst) instructorsBySession[key].push({
        id: inst.id,
        name: inst.name
      });
    });
    const merged = (sessionRows || []).map(r => {
      const students = (r.weekly_session_students || []).map(s => ({
        id: s.id,
        studentId: s.student_id || null,
        name: s.student_name || '',
        age: s.student_age === null || s.student_age === undefined ? null : Number(s.student_age),
        remark: s.remark || '',
        isReplacement: !!s.is_replacement,
        replacementFrom: s.replacement_from || '',
        attendance: s.attendance_status || 'pending'
      }));
      return {
        id: r.id,
        weekStartDate: r.week_start_date || weekStartStr(todayStr()),
        day: Number(r.weekday) - 1,
        startMinute: Number(r.start_minute),
        durationMinutes: Number(r.duration_minutes),
        type: r.lesson_type || '',
        lessonTypeId: r.lesson_type_id || null,
        poolId: r.pool_id || null,
        familyGroupId: r.family_group_id || null,
        legacyInstructor: r.instructor || '',
        rescheduledFromDay: r.rescheduled_from_day != null ? Number(r.rescheduled_from_day) - 1 : null,
        rescheduledFromStartMinute: r.rescheduled_from_start_minute != null ? Number(r.rescheduled_from_start_minute) : null,
        cancelledAt: r.cancelled_at || null,
        cancelledReason: r.cancelled_reason || null,
        cancelledTargetSessionId: r.cancelled_target_session_id || null,
        sortOrder: Number(r.sort_order ?? 0),
        students,
        instructors: instructorsBySession[String(r.id)] || []
      };
    });
    setSessions(merged);
  }
  async function loadStudents() {
    try {
      const [rows, enrollmentRows] = await Promise.all([selectRows('students', '*', '&order=name.asc'), selectRows('student_enrollments', '*').catch(() => []) // table may not exist yet
      ]);
      const byStudent = {};
      (enrollmentRows || []).forEach(e => {
        if (!byStudent[e.student_id]) byStudent[e.student_id] = [];
        byStudent[e.student_id].push({
          id: e.id,
          lessonTypeId: e.lesson_type_id,
          packageId: e.package_id
        });
      });
      setStudents((rows || []).map(r => {
        const dob = r.date_of_birth || null;
        // DOB is the source of truth — age is recomputed every load so it
        // tracks today's date (a 4-year-old becomes 5 on their birthday
        // without any data write). Fallback to stored age only when DOB is
        // missing (legacy rows pre-migration).
        const ageNow = dob != null ? ageFromDob(dob) : r.age === null || r.age === undefined ? null : Number(r.age);
        return {
          id: r.id,
          name: r.name || '',
          dob: dob,
          age: ageNow,
          gender: r.gender || null,
          package: r.package || '',
          packageId: r.package_id || null,
          familyGroupId: r.family_group_id || null,
          lessonTypeIds: Array.isArray(r.lesson_type_ids) ? r.lesson_type_ids : [],
          enrollments: byStudent[r.id] || [],
          isActive: r.is_active !== false,
          guardianName: r.guardian_name || '',
          guardianEmail: r.guardian_email || '',
          guardianPhone: r.guardian_phone || '',
          guardianIc: r.guardian_ic || '',
          guardianTin: r.guardian_tin || '',
          accountId: r.account_id || null,
          branchId: r.branch_id || null,
          emergencyPhone: r.emergency_phone || '',
          emergencyName: r.emergency_name || '',
          emergencyRelationship: r.emergency_relationship || '',
          emergencySameAsGuardian: !!r.emergency_same_as_guardian,
          tcAcceptedAt: r.tc_accepted_at || null,
          tcAcceptanceId: r.tc_acceptance_id || null
        };
      }));
    } catch (e) {
      console.warn('Swimmer registry not available yet (run the students migration):', e?.message || e);
      setStudents([]);
    }
  }
  async function loadGroups() {
    try {
      const rows = await selectRows('family_groups', '*', '&order=name.asc');
      setFamilyGroups((rows || []).map(r => ({
        id: r.id,
        name: r.name || '',
        packageId: r.package_id || null,
        groupType: r.group_type || 'discount'
      })));
    } catch (e) {
      console.warn('Family groups not available yet (run the family groups migration):', e?.message || e);
      setFamilyGroups([]);
    }
  }

  // Many-to-many membership loader. A swimmer can belong to multiple
  // family groups (one per unique lesson_type+package). See migration
  // `supabase_family_group_members_migration.sql`. On a fresh DB before
  // that migration runs, the query 404s and we fall back to deriving
  // memberships from the legacy students.family_group_id column.
  async function loadGroupMemberships() {
    try {
      const rows = await selectRows('family_group_members', '*');
      setGroupMemberships((rows || []).map(r => ({
        familyGroupId: r.family_group_id,
        studentId: r.student_id
      })));
    } catch (e) {
      console.warn('family_group_members table not yet available (run the migration). Falling back to legacy single-FK derivation:', e?.message || e);
      // Fallback: derive from students.family_group_id (read in loadStudents)
      setGroupMemberships(null); // null sentinel — useMemo uses students as source instead
    }
  }
  async function loadCreditBalances() {
    try {
      const rows = await selectRows('student_credit_balances', '*');
      setCreditBalances(rows || []);
    } catch (e) {
      console.warn('Credit balances not available (run the replacement+credits migration):', e?.message || e);
      setCreditBalances([]);
    }
  }

  // ── Credit Purchases ────────────────────────────────────────────────
  // Every credit-issuing event (sign-up, top-up, gift, manual adjustment)
  // recorded as its own row. The running balance in
  // student_credit_balances is the denormalised cache. Use:
  //   - addCreditPurchase to record a purchase AND bump the balance
  //   - reverseCreditPurchase (delete) to remove a purchase AND
  //     decrement the balance accordingly
  async function loadCreditPurchases() {
    try {
      const rows = await selectRows('credit_purchases', '*', '&order=purchase_date.desc,created_at.desc');
      setCreditPurchases(rows || []);
    } catch (e) {
      console.warn('Credit purchases not available (run the ghost+credits migration):', e?.message || e);
      setCreditPurchases([]);
    }
  }
  async function addCreditPurchase({
    studentId,
    lessonTypeId,
    purchaseDate,
    creditsAdded,
    source,
    notes
  }) {
    try {
      setError('');
      const add = Number(creditsAdded);
      if (!studentId || !lessonTypeId || !add) return;
      await insertRows('credit_purchases', [{
        student_id: studentId,
        lesson_type_id: lessonTypeId,
        purchase_date: purchaseDate || toDateStr(new Date()),
        credits_added: add,
        source: source || 'manual',
        notes: notes || null
      }]);
      // Bump the running balance row. If none exists yet, create it
      // with this purchase as the seed.
      const key = creditKey(studentId, lessonTypeId);
      const bal = creditByKey[key];
      if (bal) {
        const newRemaining = Math.max(0, (Number(bal.remaining_balance) || 0) + add);
        const newInitial = Math.max(0, (Number(bal.initial_balance) || 0) + Math.max(0, add));
        await patchRows('student_credit_balances', {
          student_id: studentId,
          lesson_type_id: lessonTypeId
        }, {
          remaining_balance: newRemaining,
          initial_balance: newInitial,
          updated_at: new Date().toISOString()
        });
      } else {
        // First purchase for this (student, LT) — seed the balance row.
        await insertRows('student_credit_balances', [{
          student_id: studentId,
          lesson_type_id: lessonTypeId,
          initial_balance: Math.max(0, add),
          remaining_balance: Math.max(0, add)
        }]);
      }
      await Promise.all([loadCreditBalances(), loadCreditPurchases()]);
      setStatus(`Recorded ${add > 0 ? '+' : ''}${add} credit${Math.abs(add) === 1 ? '' : 's'} for swimmer.`);
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to add credit purchase');
    }
  }
  async function deleteCreditPurchase(purchase) {
    if (!purchase || !purchase.id) return;
    if (!confirm(`Delete this credit record: ${purchase.credits_added > 0 ? '+' : ''}${purchase.credits_added} on ${purchase.purchase_date}?\n\nThe running balance will be adjusted accordingly.`)) return;
    try {
      await deleteRows('credit_purchases', {
        id: purchase.id
      });
      // Reverse the running balance.
      const key = creditKey(purchase.student_id, purchase.lesson_type_id);
      const bal = creditByKey[key];
      if (bal) {
        const next = Math.max(0, (Number(bal.remaining_balance) || 0) - Number(purchase.credits_added));
        const init = Math.max(0, (Number(bal.initial_balance) || 0) - Math.max(0, Number(purchase.credits_added)));
        await patchRows('student_credit_balances', {
          student_id: purchase.student_id,
          lesson_type_id: purchase.lesson_type_id
        }, {
          remaining_balance: next,
          initial_balance: init,
          updated_at: new Date().toISOString()
        });
      }
      await Promise.all([loadCreditBalances(), loadCreditPurchases()]);
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to delete credit record');
    }
  }

  // ── Subscriptions ────────────────────────────────────────────────────
  // A subscription is one purchase event. For an individual swimmer it
  // credits N credits to one balance. For a family group it credits N to
  // each eligible member's balance (creating one credit_purchases row per
  // member, all sharing the same subscription_id). Cancelling reverses by
  // inserting negative-credit purchases — the ledger keeps the full audit
  // trail and the running balance corrects itself.
  async function loadSubscriptions() {
    try {
      const rows = await selectRows('subscriptions', '*', '&order=subscription_date.desc,created_at.desc');
      setSubscriptions(rows || []);
    } catch (e) {
      console.warn('Subscriptions not available (run subscriptions migration):', e?.message || e);
      setSubscriptions([]);
    }
  }
  async function loadCodes() {
    try {
      const rows = await selectRows('scheduler_codes', '*', '&order=created_at.desc');
      setCodes(rows || []);
    } catch (e) {
      console.warn('Codes table not available (run codes migration):', e?.message || e);
      setCodes([]);
    }
  }
  async function addCode(input) {
    // Normalises the form payload into the storage-shape, then inserts.
    // Returns the inserted row so the caller can immediately render it.
    try {
      setError('');
      const row = {
        code: (input.code || '').trim().toUpperCase(),
        code_type: input.codeType || 'discount',
        owner_student_id: input.ownerStudentId || null,
        discount_type: input.discountType || null,
        discount_value: input.discountValue != null && input.discountValue !== '' ? Number(input.discountValue) : null,
        referrer_reward_type: input.referrerRewardType || null,
        referrer_reward_value: input.referrerRewardValue != null && input.referrerRewardValue !== '' ? Number(input.referrerRewardValue) : null,
        valid_from: input.validFrom || null,
        valid_until: input.validUntil || null,
        max_uses: input.maxUses != null && input.maxUses !== '' ? Number(input.maxUses) : null,
        max_uses_per_customer: input.maxUsesPerCustomer != null && input.maxUsesPerCustomer !== '' ? Number(input.maxUsesPerCustomer) : 1,
        applies_to: input.appliesTo || 'all',
        applicable_package_ids: input.applicablePackageIds || null,
        minimum_amount: input.minimumAmount != null && input.minimumAmount !== '' ? Number(input.minimumAmount) : null,
        is_active: input.isActive !== false,
        notes: input.notes || null
      };
      if (!row.code) throw new Error('Code string is required');
      const ins = await insertRows('scheduler_codes', row);
      await loadCodes();
      return ins?.[0] || null;
    } catch (e) {
      setError(`addCode: ${e?.message || e}`);
      throw e;
    }
  }
  async function updateCode(id, patch) {
    try {
      setError('');
      const body = {};
      if ('code' in patch) body.code = (patch.code || '').trim().toUpperCase();
      if ('codeType' in patch) body.code_type = patch.codeType;
      if ('ownerStudentId' in patch) body.owner_student_id = patch.ownerStudentId || null;
      if ('discountType' in patch) body.discount_type = patch.discountType || null;
      if ('discountValue' in patch) body.discount_value = patch.discountValue != null && patch.discountValue !== '' ? Number(patch.discountValue) : null;
      if ('referrerRewardType' in patch) body.referrer_reward_type = patch.referrerRewardType || null;
      if ('referrerRewardValue' in patch) body.referrer_reward_value = patch.referrerRewardValue != null && patch.referrerRewardValue !== '' ? Number(patch.referrerRewardValue) : null;
      if ('validFrom' in patch) body.valid_from = patch.validFrom || null;
      if ('validUntil' in patch) body.valid_until = patch.validUntil || null;
      if ('maxUses' in patch) body.max_uses = patch.maxUses != null && patch.maxUses !== '' ? Number(patch.maxUses) : null;
      if ('maxUsesPerCustomer' in patch) body.max_uses_per_customer = patch.maxUsesPerCustomer != null && patch.maxUsesPerCustomer !== '' ? Number(patch.maxUsesPerCustomer) : 1;
      if ('appliesTo' in patch) body.applies_to = patch.appliesTo;
      if ('applicablePackageIds' in patch) body.applicable_package_ids = patch.applicablePackageIds || null;
      if ('minimumAmount' in patch) body.minimum_amount = patch.minimumAmount != null && patch.minimumAmount !== '' ? Number(patch.minimumAmount) : null;
      if ('isActive' in patch) body.is_active = !!patch.isActive;
      if ('notes' in patch) body.notes = patch.notes || null;
      await patchRows('scheduler_codes', `id=eq.${id}`, body);
      await loadCodes();
    } catch (e) {
      setError(`updateCode: ${e?.message || e}`);
      throw e;
    }
  }
  async function deleteCode(id) {
    try {
      setError('');
      await deleteRows('scheduler_codes', `id=eq.${id}`);
      await loadCodes();
    } catch (e) {
      setError(`deleteCode: ${e?.message || e}`);
      throw e;
    }
  }

  // bumpBalance: idempotent helper that either creates or updates the
  // student_credit_balances cache after a purchase is inserted.
  // adjustBalanceTo: hard-set the remaining balance for (student, lt) to a
  // target number by inserting a single credit_purchase row whose
  // credits_added equals the required delta. Audit-friendly (source
  // 'manual', notes default to "Manual adjustment to N"), reverses the
  // problem where a legacy direct-seeded balance can't be cancelled
  // because it has no purchase or subscription record to undo.
  async function adjustBalanceTo(studentId, lessonTypeId, targetBalance, notes) {
    try {
      setError('');
      const key = creditKey(studentId, lessonTypeId);
      const bal = creditByKey[key];
      const current = bal ? Number(bal.remaining_balance) || 0 : 0;
      const target = Math.max(0, Number(targetBalance) || 0);
      const delta = target - current;
      if (delta === 0) {
        alert(`Balance is already ${target}.`);
        return;
      }
      await insertRows('credit_purchases', [{
        student_id: studentId,
        lesson_type_id: lessonTypeId,
        purchase_date: toDateStr(new Date()),
        credits_added: delta,
        source: 'manual',
        notes: notes || `Manual adjustment: ${current} → ${target}`
      }]);
      await bumpBalance(studentId, lessonTypeId, delta);
      await Promise.all([loadCreditBalances(), loadCreditPurchases()]);
      setStatus(`Adjusted balance: ${current} → ${target} (Δ ${delta > 0 ? '+' : ''}${delta}).`);
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to adjust balance');
    }
  }
  async function bumpBalance(studentId, lessonTypeId, delta) {
    const key = creditKey(studentId, lessonTypeId);
    const bal = creditByKey[key];
    const d = Number(delta);
    if (bal) {
      const newRemaining = Math.max(0, (Number(bal.remaining_balance) || 0) + d);
      const newInitial = Math.max(0, (Number(bal.initial_balance) || 0) + Math.max(0, d));
      await patchRows('student_credit_balances', {
        student_id: studentId,
        lesson_type_id: lessonTypeId
      }, {
        remaining_balance: newRemaining,
        initial_balance: newInitial,
        updated_at: new Date().toISOString()
      });
    } else if (d > 0) {
      await insertRows('student_credit_balances', [{
        student_id: studentId,
        lesson_type_id: lessonTypeId,
        initial_balance: d,
        remaining_balance: d
      }]);
    }
  }

  // addSubscription({ subjectType, subjectId, lessonTypeId, creditsPerSwimmer, ... })
  // For 'student': credits one swimmer. For 'family_group': credits every
  // member enrolled in the given lesson type. Returns the subscription row.
  async function addSubscription({
    subjectType,
    subjectId,
    lessonTypeId,
    creditsPerSwimmer,
    source,
    notes,
    amountPaid,
    receiptNumber,
    subscriptionDate,
    packageId,
    quantity = 1
  }) {
    try {
      setError('');
      const credits = Number(creditsPerSwimmer);
      const qty = Math.max(1, Number(quantity) || 1);
      if (!subjectId || !lessonTypeId || !credits) {
        alert('Subscription requires a subject, lesson type, and credits.');
        return null;
      }
      // Resolve affected swimmers based on subject type.
      let affectedStudents = [];
      if (subjectType === 'student') {
        const stu = studentById[subjectId];
        if (!stu) {
          alert('Swimmer not found.');
          return null;
        }
        affectedStudents = [stu];
      } else if (subjectType === 'family_group') {
        const members = membersByGroup && membersByGroup[subjectId] || [];
        affectedStudents = members.filter(m => (m.lessonTypeIds || []).includes(lessonTypeId));
        if (!affectedStudents.length) {
          alert('No members of this group are enrolled in the selected lesson type.');
          return null;
        }
      } else {
        alert('Unknown subscription subject type.');
        return null;
      }
      const totalCreditsPerSwimmer = credits * qty;
      const date = subscriptionDate || toDateStr(new Date());
      // Insert the parent subscription row.
      const subRows = await insertRows('subscriptions', [{
        subject_type: subjectType,
        subject_id: subjectId,
        lesson_type_id: lessonTypeId,
        package_id: packageId || null,
        credits_per_swimmer: totalCreditsPerSwimmer,
        swimmer_count: affectedStudents.length,
        subscription_date: date,
        source: source || 'subscription',
        notes: notes || null,
        amount_paid: amountPaid != null ? Number(amountPaid) : null,
        receipt_number: receiptNumber || null
      }]);
      const sub = subRows?.[0];
      if (!sub) {
        alert('Failed to create subscription.');
        return null;
      }
      // Insert credit_purchases for each affected swimmer.
      const purchasePayload = affectedStudents.map(s => ({
        student_id: s.id,
        lesson_type_id: lessonTypeId,
        purchase_date: date,
        credits_added: totalCreditsPerSwimmer,
        source: source || 'subscription',
        notes: notes || null,
        subscription_id: sub.id
      }));
      await insertRows('credit_purchases', purchasePayload);
      // Bump each balance.
      for (const s of affectedStudents) {
        await bumpBalance(s.id, lessonTypeId, totalCreditsPerSwimmer);
      }
      await Promise.all([loadCreditBalances(), loadCreditPurchases(), loadSubscriptions()]);
      setStatus(`Added subscription: +${totalCreditsPerSwimmer} credits to ${affectedStudents.length} swimmer${affectedStudents.length === 1 ? '' : 's'}.`);
      return sub;
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to add subscription');
      return null;
    }
  }

  // cancelSubscription(subscription): inserts negative-credit purchases
  // matching each original purchase (linked by subscription_id), then
  // marks the subscription as cancelled_at = now.
  async function cancelSubscription(subscription, reason) {
    if (!subscription || !subscription.id) return;
    if (subscription.cancelled_at) {
      alert('This subscription is already cancelled.');
      return;
    }
    if (!confirm(`Cancel subscription from ${subscription.subscription_date}?\n\nThis reverses the ${subscription.credits_per_swimmer} credits per swimmer for ${subscription.swimmer_count} swimmer${subscription.swimmer_count === 1 ? '' : 's'}. The original purchase records stay in the ledger; offsetting negative entries will be added.`)) return;
    try {
      // Fetch the original purchase rows for this subscription so we can
      // reverse each one (handles the case where some swimmers' purchases
      // were since edited or the row count differs from swimmer_count).
      const originals = (creditPurchases || []).filter(p => p.subscription_id === subscription.id && Number(p.credits_added) > 0);
      if (!originals.length) {
        alert('No original purchase records found for this subscription.');
        return;
      }
      const date = toDateStr(new Date());
      const reversals = originals.map(orig => ({
        student_id: orig.student_id,
        lesson_type_id: orig.lesson_type_id,
        purchase_date: date,
        credits_added: -Number(orig.credits_added),
        source: 'cancellation',
        notes: `Cancellation of subscription from ${subscription.subscription_date}${reason ? ` — ${reason}` : ''}`,
        subscription_id: subscription.id
      }));
      await insertRows('credit_purchases', reversals);
      // Reverse each balance.
      for (const r of reversals) {
        await bumpBalance(r.student_id, r.lesson_type_id, r.credits_added);
      }
      // Mark subscription cancelled.
      await patchRows('subscriptions', {
        id: subscription.id
      }, {
        cancelled_at: new Date().toISOString(),
        cancelled_reason: reason || null
      });
      await Promise.all([loadCreditBalances(), loadCreditPurchases(), loadSubscriptions()]);
      setStatus(`Cancelled subscription — ${reversals.length} reversal${reversals.length === 1 ? '' : 's'} recorded.`);
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to cancel subscription');
    }
  }

  // Pending-replacement state — swimmers who were removed from their booked
  // class for the week and are awaiting placement into another same-LT class.
  async function loadReplacementPending() {
    try {
      const rows = await selectRows('replacement_pending', '*');
      setReplacementPending(rows || []);
    } catch (e) {
      console.warn('Replacement pending not available (run the replacement pending migration):', e?.message || e);
      setReplacementPending([]);
    }
  }

  // Key by student+LT+week so the modal can quickly check if a candidate has
  // a pending state for the active week. Resolved entries are deleted, not
  // flagged, so anything in this map is currently awaiting placement.
  const pendingByKey = useMemo(() => {
    const m = {};
    replacementPending.forEach(p => {
      m[`${p.student_id}:${p.lesson_type_id}:${p.week_start_date}`] = p;
    });
    return m;
  }, [replacementPending]);

  // ── markForReplacement: remove a swimmer from their booked class for the
  // week and queue them as a replacement candidate. The row in
  // weekly_session_students is deleted and a replacement_pending entry is
  // created (so they appear with an "R-pending" flag in same-LT dropdowns).
  async function markForReplacement({
    studentId,
    sessionId,
    weekStartDate,
    lessonTypeId,
    lessonTypeName,
    day,
    startMinute
  }) {
    if (!studentId || !sessionId || !lessonTypeId) {
      alert('Cannot mark for replacement: missing session information.');
      return false;
    }
    const label = `${DAYS_S[day]} ${minuteToTime(startMinute)}`;
    if (!confirm(`Move this swimmer out of ${lessonTypeName} ${label} for replacement?\n\nThey will become a replacement candidate in any other ${lessonTypeName} class this week. The original slot will be released.`)) return false;
    try {
      await deleteRows('weekly_session_students', {
        session_id: sessionId,
        student_id: studentId
      });
      // Upsert pending entry — re-marking the same swimmer simply refreshes it.
      await rest('replacement_pending?on_conflict=student_id,week_start_date,lesson_type_id', {
        method: 'POST',
        headers: {
          Prefer: 'return=representation,resolution=merge-duplicates'
        },
        body: JSON.stringify([{
          student_id: studentId,
          week_start_date: weekStartDate,
          lesson_type_id: lessonTypeId,
          original_session_label: label,
          original_session_id: sessionId
        }])
      });
      await Promise.all([loadSessions(), loadReplacementPending()]);
      return true;
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to mark for replacement');
      return false;
    }
  }
  async function clearPendingReplacement({
    studentId,
    weekStartDate,
    lessonTypeId
  }) {
    try {
      await deleteRows('replacement_pending', {
        student_id: studentId,
        week_start_date: weekStartDate,
        lesson_type_id: lessonTypeId
      });
      await loadReplacementPending();
    } catch (_) {}
  }
  async function cancelPendingReplacement(pending, opts = {
    restore: true
  }) {
    if (!pending || !pending.id) return false;
    const student = studentById[pending.student_id];
    const swimmerName = student?.name || 'this swimmer';
    const originalSession = sessions.find(s => s.id === pending.original_session_id);
    const sessionExists = !!pending.original_session_id && !!originalSession;
    const today = todayStr();
    const origWeek = pending.week_start_date || '';
    const datePassed = origWeek && origWeek < today;

    // ── Case 1: original session was deleted or moved ─────────────────
    if (!sessionExists && pending.original_session_id) {
      alert(`Original slot no longer available.\n\n` + `${swimmerName}'s original class "${pending.original_session_label}" has been deleted or moved.\n\n` + `${swimmerName} will remain in the pending replacement queue. You must place them in an active session to resolve this.`);
      return false; // stay in limbo — no action taken
    }

    // ── Case 2: no original session ID at all (can only clear limbo) ──
    if (!sessionExists) {
      if (!confirm(`Remove ${swimmerName} from the pending-replacement queue?\n\nNo original session is recorded. They will be cleared from limbo.`)) return false;
      await deleteRows('replacement_pending', {
        id: pending.id
      });
      await Promise.all([loadSessions(), loadReplacementPending()]);
      setStatus(`Cleared limbo entry for ${swimmerName}.`);
      return true;
    }

    // ── Case 3: original session exists — offer restore ───────────────
    if (sessionExists) {
      const lt = lessonTypeById(pending.lesson_type_id);
      const cap = sessionCapacity(originalSession, lt);
      if (cap.max > 0 && cap.current >= cap.max) {
        if (!confirm(`${pending.original_session_label} is now full (${cap.current}/${cap.max}). Restore ${swimmerName} anyway (class will be over capacity)?`)) return false;
      }
      // Date-passed: show a non-blocking advisory alert, then a single confirm
      if (datePassed) {
        alert(`⚠️ The original session week (${origWeek}) has already passed.\n\n` + `${swimmerName} will be restored to "${pending.original_session_label}" for record-keeping. ` + `Please manually review their attendance and credit status for that session.`);
      }
      if (!confirm(`Restore ${swimmerName} to "${pending.original_session_label}"?${datePassed ? '\n\n(Past session — attendance & credits need manual review)' : ''}`)) return false;
      try {
        await insertRows('weekly_session_students', [{
          session_id: pending.original_session_id,
          student_id: pending.student_id,
          student_name: student?.name || swimmerName,
          student_age: student?.age != null ? Number(student.age) : null,
          is_replacement: false,
          attendance_status: 'pending'
        }]);
        await deleteRows('replacement_pending', {
          id: pending.id
        });
        await Promise.all([loadSessions(), loadReplacementPending()]);
        setStatus(`Restored ${swimmerName} to ${pending.original_session_label}${datePassed ? ' — mark attendance manually' : ''}.`);
        return true;
      } catch (err) {
        handleErr(err);
        alert(err.message || 'Failed to restore');
        return false;
      }
    }
  }

  // ── Full Class Replacement module ────────────────────────────────────
  // Two paths to cancel an entire scheduled class for the week:
  //
  //  (A) forwardClassToNextWeek — deletes the session for THIS week. No
  //      attendance is marked, so no credits deduct. Swimmers attend the
  //      same slot next week as normal. The scheduler is responsible for
  //      ensuring next week's session exists (Duplicate Previous Week
  //      handles that when needed).
  //
  //  (B) startFullClassMove — sets `pendingMove`, closes the modal, and
  //      drops the WeekView into "pick a slot" mode. The next slot click
  //      anywhere in the weekly grid calls placePendingMove(targetDay,
  //      targetStartMinute), which UPDATEs the session row in place
  //      (preserving its id, students, instructors, attendance, and credit
  //      ties — only weekday + start_minute change). The rescheduled_from_*
  //      columns mark it as moved so a future Duplicate Previous Week
  //      restores the canonical slot.
  const [pendingMove, setPendingMove] = useState(null);
  async function forwardClassToNextWeek(sessionId, sourceLabel) {
    if (!sessionId) return;
    const src = sessions.find(s => s.id === sessionId);
    if (!src) {
      alert('Source session not found.');
      return;
    }
    if (src.cancelledAt) {
      alert('This session is already cancelled.');
      return;
    }
    const nextWeekStart = addDays(src.weekStartDate, 7);

    // Two paths, depending on whether next week already holds the same
    // recurring slot:
    //   (A) Match exists → don't create another copy; just point the
    //       cancellation marker at the existing next-week session.
    //   (B) No match → clone the session forward: insert a new row in
    //       next week, copy the non-replacement student rows and the
    //       instructor links, then mark this week's row as cancelled.
    // In both paths the original row stays in the DB — it becomes a
    // greyed-out "ghost" in the weekly grid, restorable by clicking.
    // Replacement students are week-scoped one-offs and are NEVER carried
    // forward — they belong to the original week's replacement bucket.
    const existingNextWeek = sessions.find(s => s.weekStartDate === nextWeekStart && s.day === src.day && s.startMinute === src.startMinute && s.lessonTypeId === src.lessonTypeId && (s.poolId || null) === (src.poolId || null) && !s.cancelledAt);
    const enrolledRegular = (src.students || []).filter(s => !s.isReplacement);
    const swimmerCount = enrolledRegular.length;
    const confirmMsg = existingNextWeek ? `Forward ${sourceLabel} to next week (${nextWeekStart})?\n\nNext week already has the same class at the same slot — this week's run is cancelled and the ${swimmerCount} swimmer${swimmerCount === 1 ? '' : 's'} will attend that existing session.\n\nThe original spot stays visible as a greyed-out shell; click it to restore. Credits already consumed this week will be refunded.` : `Forward ${sourceLabel} to next week (${nextWeekStart})?\n\nThis week's session is cancelled and recreated next week (same day, same time) with the same ${swimmerCount} swimmer${swimmerCount === 1 ? '' : 's'}.\n\nThe original spot stays visible as a greyed-out shell; click it to restore. Credits already consumed this week will be refunded.`;
    if (!confirm(confirmMsg)) return;
    try {
      // Refund credits for any swimmer whose attendance was already marked
      // attended/absent on this session — those credits were deducted on
      // the prior save but shouldn't have been, since the class is now
      // being forwarded (i.e., it didn't actually happen this week).
      if (src.lessonTypeId) {
        for (const s of src.students || []) {
          if (!s.studentId) continue;
          const att = s.attendance || 'pending';
          if (att === 'attended' || att === 'absent') {
            await adjustCredit(s.studentId, src.lessonTypeId, 1);
          }
        }
      }
      let targetId = existingNextWeek ? existingNextWeek.id : null;
      if (!existingNextWeek) {
        // Clone into next week.
        const inserted = await insertRows('weekly_sessions', [{
          week_start_date: nextWeekStart,
          weekday: src.day + 1,
          start_minute: src.startMinute,
          duration_minutes: src.durationMinutes,
          lesson_type: src.type,
          lesson_type_id: src.lessonTypeId,
          pool_id: src.poolId || null,
          family_group_id: src.familyGroupId || null,
          instructor: src.legacyInstructor || null
        }]);
        targetId = inserted?.[0]?.id;
        if (targetId) {
          if (enrolledRegular.length) {
            await insertRows('weekly_session_students', enrolledRegular.map(s => ({
              session_id: targetId,
              student_id: s.studentId || null,
              student_name: s.name || '',
              student_age: s.age != null ? Number(s.age) : null,
              remark: s.remark || null,
              is_replacement: false,
              attendance_status: 'pending' // fresh week, fresh attendance
            })));
          }
          if (src.instructors && src.instructors.length) {
            try {
              await insertRows('session_instructors', src.instructors.map(i => ({
                session_id: targetId,
                instructor_id: i.id
              })));
            } catch (_) {} // session_instructors table may not exist on older DBs — instructor name is also on the session row as a fallback
          }
        }
      }

      // Mark this week's session as cancelled-forwarded, pointing at the
      // target. Don't delete — the original stays as a ghost.
      await patchRows('weekly_sessions', {
        id: sessionId
      }, {
        cancelled_at: new Date().toISOString(),
        cancelled_reason: 'forwarded',
        cancelled_target_session_id: targetId || null
      });
      await loadSessions();
      setModal(null);
      setStatus(existingNextWeek ? `Forwarded ${sourceLabel} → ${nextWeekStart} (merged into existing next-week session). Original is greyed out — click to restore.` : `Forwarded ${sourceLabel} → ${nextWeekStart} (cloned ${swimmerCount} swimmer${swimmerCount === 1 ? '' : 's'} forward). Original is greyed out — click to restore.`);
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to forward class');
    }
  }

  // restoreCancelledSession — unwind a forward/reschedule. Deletes the
  // target session (which holds students + instructors that were cloned
  // over) and clears the cancellation marker on the original so it
  // becomes live again at its original spot. We don't reverse any credit
  // refunds the cancellation issued — those were correct for the period
  // the class was missing; if attendance is re-marked the credits will
  // re-deduct on save normally.
  async function restoreCancelledSession(sessionId) {
    const ghost = sessions.find(s => s.id === sessionId);
    if (!ghost) {
      alert('Session not found.');
      return;
    }
    if (!ghost.cancelledAt) {
      alert('This session is not cancelled.');
      return;
    }
    const label = `${ghost.type} on ${DAYS_F[ghost.day]} ${minuteToTime(ghost.startMinute)}`;
    const reasonLabel = ghost.cancelledReason === 'forwarded' ? 'forward to next week' : ghost.cancelledReason === 'rescheduled' ? 'reschedule' : 'cancellation';
    if (!confirm(`Restore ${label} to its original spot?\n\nThis undoes the ${reasonLabel}: the replacement session will be deleted and this slot becomes live again with its swimmers.`)) return;
    try {
      // Delete the target (replacement) session if we have one and it
      // still exists. The on-delete-set-null FK means we don't strictly
      // need to clear cancelled_target_session_id first, but we do it
      // anyway in the PATCH below.
      if (ghost.cancelledTargetSessionId) {
        const target = sessions.find(s => s.id === ghost.cancelledTargetSessionId);
        if (target) {
          await deleteRows('weekly_session_students', {
            session_id: target.id
          });
          try {
            await deleteRows('session_instructors', {
              session_id: target.id
            });
          } catch (_) {}
          await deleteRows('weekly_sessions', {
            id: target.id
          });
        }
      }
      // Clear the cancellation marker on the original.
      await patchRows('weekly_sessions', {
        id: sessionId
      }, {
        cancelled_at: null,
        cancelled_reason: null,
        cancelled_target_session_id: null
      });
      await loadSessions();
      setStatus(`Restored ${label} to its original slot.`);
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to restore session');
    }
  }
  function startFullClassMove({
    sessionId,
    sourceLabel,
    lessonTypeName,
    weekStartDate,
    originalDay,
    originalStartMinute,
    swimmerCount
  }) {
    if (!sessionId) return;
    setPendingMove({
      sessionId,
      sourceLabel,
      lessonTypeName,
      weekStartDate,
      originalDay,
      originalStartMinute,
      swimmerCount
    });
    setModal(null);
    setStatus(`Click an empty slot in the weekly grid to drop ${lessonTypeName} (${sourceLabel}).`);
  }
  function cancelPendingMove() {
    setPendingMove(null);
    setStatus('');
  }
  async function placePendingMove(targetDay, targetStartMinute) {
    if (!pendingMove) return;
    const src = sessions.find(s => s.id === pendingMove.sessionId);
    if (!src) {
      alert('Source session not found.');
      setPendingMove(null);
      return;
    }
    if (src.cancelledAt) {
      alert('This session is already cancelled.');
      setPendingMove(null);
      return;
    }
    const targetLabel = `${DAYS_F[targetDay]} ${minuteToTime(targetStartMinute)}`;
    if (!confirm(`Move ${pendingMove.lessonTypeName} (${pendingMove.swimmerCount} swimmer${pendingMove.swimmerCount === 1 ? '' : 's'}) from ${pendingMove.sourceLabel} to ${targetLabel}?\n\nThe original spot stays visible as a greyed-out shell — click it to restore.`)) return;
    try {
      // Refund any credits already consumed on the original — same logic
      // as Forward: the class is being moved so attendance to date is
      // wiped on the clone (it starts at "pending").
      if (src.lessonTypeId) {
        for (const s of src.students || []) {
          if (!s.studentId) continue;
          const att = s.attendance || 'pending';
          if (att === 'attended' || att === 'absent') {
            await adjustCredit(s.studentId, src.lessonTypeId, 1);
          }
        }
      }

      // Clone the session at the new slot. Same week, new weekday +
      // start_minute. We carry rescheduled_from_* on the CLONE (not the
      // ghost) so a future Duplicate Previous Week still restores the
      // canonical slot for the next week.
      const enrolledRegular = (src.students || []).filter(s => !s.isReplacement);
      const inserted = await insertRows('weekly_sessions', [{
        week_start_date: src.weekStartDate,
        weekday: targetDay + 1,
        start_minute: targetStartMinute,
        duration_minutes: src.durationMinutes,
        lesson_type: src.type,
        lesson_type_id: src.lessonTypeId,
        pool_id: src.poolId || null,
        family_group_id: src.familyGroupId || null,
        instructor: src.legacyInstructor || null,
        rescheduled_from_day: src.day + 1,
        rescheduled_from_start_minute: src.startMinute
      }]);
      const targetId = inserted?.[0]?.id;
      if (targetId) {
        if (enrolledRegular.length) {
          await insertRows('weekly_session_students', enrolledRegular.map(s => ({
            session_id: targetId,
            student_id: s.studentId || null,
            student_name: s.name || '',
            student_age: s.age != null ? Number(s.age) : null,
            remark: s.remark || null,
            is_replacement: false,
            attendance_status: 'pending'
          })));
        }
        if (src.instructors && src.instructors.length) {
          try {
            await insertRows('session_instructors', src.instructors.map(i => ({
              session_id: targetId,
              instructor_id: i.id
            })));
          } catch (_) {}
        }
      }

      // Mark original as cancelled-rescheduled, pointing at the clone.
      await patchRows('weekly_sessions', {
        id: pendingMove.sessionId
      }, {
        cancelled_at: new Date().toISOString(),
        cancelled_reason: 'rescheduled',
        cancelled_target_session_id: targetId || null
      });
      await loadSessions();
      setPendingMove(null);
      setStatus(`Moved ${pendingMove.lessonTypeName} to ${targetLabel}. Original spot greyed out — click to restore.`);
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to move class');
    }
  }
  async function loadTcAcceptances() {
    try {
      const rows = await selectRows('tc_acceptances', '*');
      setTcAcceptances(rows || []);
    } catch (e) {
      console.warn('T&C acceptances not available (run the student profile migration):', e?.message || e);
      setTcAcceptances([]);
    }
  }
  async function saveTcAcceptance({
    studentId,
    guardianName,
    guardianEmail,
    lessonTypeName
  }) {
    try {
      const acceptanceId = `TC-${Date.now().toString(36).toUpperCase().slice(-7)}`;
      const now = new Date().toISOString();
      // Upsert — one record per swimmer, updates on re-acceptance.
      await rest('tc_acceptances?on_conflict=student_id', {
        method: 'POST',
        headers: {
          Prefer: 'return=representation,resolution=merge-duplicates'
        },
        body: JSON.stringify([{
          student_id: studentId,
          acceptance_id: acceptanceId,
          accepted_at: now,
          guardian_name: guardianName,
          guardian_email: guardianEmail,
          lesson_type_name: lessonTypeName
        }])
      });
      // Mirror acceptance info onto the student row for quick list display.
      await patchRows('students', {
        id: studentId
      }, {
        tc_accepted_at: now,
        tc_acceptance_id: acceptanceId
      });
      await Promise.all([loadTcAcceptances(), loadStudents()]);
      return acceptanceId;
    } catch (err) {
      handleErr(err);
      throw err;
    }
  }

  // creditBalanceKey — quickly look up a balance by student + lesson type.
  function creditKey(studentId, lessonTypeId) {
    return `${studentId}:${lessonTypeId}`;
  }
  const creditByKey = useMemo(() => {
    const m = {};
    creditBalances.forEach(b => {
      m[creditKey(b.student_id, b.lesson_type_id)] = b;
    });
    return m;
  }, [creditBalances]);
  // Purchases-by-key memo — same shape as creditByKey but holds the
  // chronological purchase list. Each value is an array of purchase
  // rows sorted by purchase_date descending (newest first).
  const purchasesByKey = useMemo(() => {
    const m = {};
    creditPurchases.forEach(p => {
      const k = creditKey(p.student_id, p.lesson_type_id);
      (m[k] = m[k] || []).push(p);
    });
    return m;
  }, [creditPurchases]);
  // Purchases grouped by student (across all lesson types) for the
  // Swimmers tab's expandable credit panel.
  const purchasesByStudent = useMemo(() => {
    const m = {};
    creditPurchases.forEach(p => {
      (m[p.student_id] = m[p.student_id] || []).push(p);
    });
    return m;
  }, [creditPurchases]);
  async function loadRemarks(cursor) {
    const start = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1);
    const end = new Date(cursor.getFullYear(), cursor.getMonth() + 2, 0);
    const rows = await selectRows('calendar_remarks', '*', `&calendar_date=gte.${toDateStr(start)}&calendar_date=lte.${toDateStr(end)}&order=calendar_date.asc`);
    const map = {};
    (rows || []).forEach(r => {
      map[r.calendar_date] = r.remark || '';
    });
    setRemarks(map);
  }
  function activeInstructors() {
    return options.instructors.filter(x => x.is_active !== false);
  }
  function activeDurations() {
    return options.durations.filter(x => x.is_active !== false);
  }
  function activeLessonTypes() {
    return options.lessonTypes.filter(x => x.is_active !== false);
  }
  function activePools() {
    let pools = options.pools.filter(x => x.is_active !== false);
    // Branch filter: when a branch is selected, only that branch's pools.
    // 'all' or null falls through to show every pool.
    if (currentBranchId && currentBranchId !== 'all') {
      pools = pools.filter(p => !p.branch_id || p.branch_id === currentBranchId);
    }
    return pools;
  }
  function allActivePools() {
    return options.pools.filter(x => x.is_active !== false);
  }
  function activeBranches() {
    return (options.branches || []).filter(x => x.is_active !== false);
  }
  function branchById(id) {
    return (options.branches || []).find(b => b.id === id) || null;
  }
  function activePackages() {
    return options.packages.filter(x => x.is_active !== false);
  }
  function packageById(id) {
    return options.packages.find(p => p.id === id) || null;
  }
  function lessonTypeByName(name) {
    return options.lessonTypes.find(t => t.name === name) || null;
  }
  function lessonTypeById(id) {
    return options.lessonTypes.find(t => t.id === id) || null;
  }
  function poolById(id) {
    return options.pools.find(p => p.id === id) || null;
  }
  function instructorByName(name) {
    return options.instructors.find(i => i.name === name) || null;
  }
  function colorsFor(type) {
    const x = lessonTypeByName(type);
    return x ? {
      bg: x.bg_color,
      bd: x.border_color,
      tx: x.text_color
    } : DEFAULT_TYPES[type] || {
      bg: '#E2E8F0',
      bd: '#64748B',
      tx: '#0F172A'
    };
  }
  const gridBounds = useMemo(() => computeGridBounds(options.operatingHours), [options.operatingHours]);
  const gridSlots = Math.max(1, Math.round((gridBounds.endMin - gridBounds.startMin) / SLOT_MIN));
  function slotToMinute(slot) {
    return gridBounds.startMin + slot * SLOT_MIN;
  }
  function minuteToSlot(min) {
    return Math.round((min - gridBounds.startMin) / SLOT_MIN);
  }
  const selectedWeekStart = weekStartStr(selectedDate);
  const currentWeekStart = weekStartStr(todayStr());
  const isFutureSelectedWeek = selectedWeekStart > currentWeekStart;
  function sessionsForDate(dateStr) {
    const day = dateToWeekdayIndex(dateStr);
    const ws = weekStartStr(dateStr);
    return sessions.filter(s => s.weekStartDate === ws && s.day === day).sort((a, b) => a.startMinute - b.startMinute);
  }
  const weekSessions = useMemo(() => sessions.filter(s => s.weekStartDate === selectedWeekStart), [sessions, selectedWeekStart]);

  // M2.1: pool is no longer a structural column split — it's a badge. We pack
  // all of a day's sessions (optionally filtered to one pool) into a single
  // aligned column grid. peak = the day's maximum simultaneous sessions, which
  // drives that day's width so the busiest cluster still clears a readable
  // minimum. Null-pool sessions fold into the first active pool for filtering.
  // ── Combined filter pipeline ───────────────────────────────────────────
  // Two filter dimensions stack: lesson types (enabledTypes set) and
  // instructors (selectedInstructors set). A session is shown only when
  // both filters pass. Instructor selection has a cascade: picking
  // instructors auto-narrows the visible lesson types to the union of what
  // they teach (the user's intent: "select instructor → only their classes
  // visible"). Manual type toggles afterward refine within that set.
  function passesFilters(s) {
    if (enabledTypes !== null && !enabledTypes.has(s.type)) return false;
    if (selectedInstructors.size > 0) {
      const ids = (s.instructors || []).map(i => i.id);
      if (!ids.some(id => selectedInstructors.has(id))) return false;
    }
    return true;
  }
  function filteredSessionsForDate(dateStr) {
    return sessionsForDate(dateStr).filter(passesFilters);
  }
  const weekBlocks = useMemo(() => {
    const allActive = activePools(); // already branch-filtered
    const allPoolIds = new Set(allActive.map(p => p.id));
    const fallbackPoolId = allActive[0]?.id || null;
    return Array.from({
      length: 7
    }, (_, day) => {
      let items = weekSessions.filter(s => s.day === day);
      if (!selectedPoolId) {
        // Default: show all pools that belong to the current branch
        if (allPoolIds.size > 0) items = items.filter(s => allPoolIds.has(s.poolId || fallbackPoolId));
      } else {
        // Specific pool selected
        items = items.filter(s => (s.poolId || fallbackPoolId) === selectedPoolId);
      }
      items = items.filter(passesFilters);
      const packed = packParallelColumns(items);
      const peak = packed.length ? packed[0]._total : 1;
      return {
        packed,
        peak: Math.max(1, peak)
      };
    });
  }, [weekSessions, selectedPoolId, enabledTypes, selectedInstructors, options.pools, currentBranchId]);

  // ── Lesson-type legend filters ──
  const allTypesShown = useMemo(() => {
    if (enabledTypes === null) return true;
    const names = activeLessonTypes().map(t => t.name);
    return names.length > 0 && names.every(n => enabledTypes.has(n));
  }, [enabledTypes, options.lessonTypes]);
  function isTypeEnabled(name) {
    return enabledTypes === null ? true : enabledTypes.has(name);
  }
  function toggleType(name) {
    setEnabledTypes(prev => {
      const base = prev === null ? new Set(activeLessonTypes().map(t => t.name)) : new Set(prev);
      if (base.has(name)) base.delete(name);else base.add(name);
      return base;
    });
  }
  function toggleAllTypes() {
    setEnabledTypes(allTypesShown ? new Set() : null);
  }

  // ── Instructor legend filters with cascade ──
  function isInstructorActive(id) {
    return selectedInstructors.has(id);
  }
  function toggleInstructor(id) {
    const next = new Set(selectedInstructors);
    if (next.has(id)) next.delete(id);else next.add(id);
    setSelectedInstructors(next);
    // Cascade: instructor selection rewrites the visible types to the union
    // of what the selected instructors teach this week. Deselecting the last
    // instructor restores the all-types-on state.
    if (next.size === 0) {
      setEnabledTypes(null);
    } else {
      const taught = new Set();
      sessions.forEach(s => {
        if ((s.instructors || []).some(i => next.has(i.id))) taught.add(s.type);
      });
      setEnabledTypes(taught);
    }
  }
  function clearInstructors() {
    setSelectedInstructors(new Set());
    setEnabledTypes(null);
  }

  // All-pools packing, ignoring the filter — used for the printed weekly table
  // so a printout is always the complete record.
  const weekBlocksAllPools = useMemo(() => {
    return Array.from({
      length: 7
    }, (_, day) => packParallelColumns(weekSessions.filter(s => s.day === day)));
  }, [weekSessions]);
  const summary = useMemo(() => {
    const byType = {},
      byInst = {},
      byPool = {};
    activeLessonTypes().forEach(x => byType[x.name] = 0);
    activeInstructors().forEach(x => byInst[x.name] = 0);
    activePools().forEach(p => byPool[p.name] = 0);
    let totalStudents = 0;
    let totalSessions = 0;
    weekSessions.forEach(s => {
      // Cancelled ghosts don't count — they're shells of classes that
      // didn't happen this week. Their swimmers moved with the
      // replacement session, which is already in the list (possibly in
      // a different week or slot).
      if (s.cancelledAt) return;
      totalSessions += 1;
      const excluded = excludeFromStudentTotals(s.type);
      const count = excluded ? 0 : s.students.length;
      byType[s.type] = (byType[s.type] || 0) + count;
      const pool = poolById(s.poolId);
      if (pool) byPool[pool.name] = (byPool[pool.name] || 0) + count;
      s.instructors.forEach(inst => {
        byInst[inst.name] = (byInst[inst.name] || 0) + count;
      });
      totalStudents += count;
    });
    return {
      byType,
      byInst,
      byPool,
      totalStudents,
      totalSessions
    };
  }, [weekSessions, options, currentBranchId]);
  function defaultFormForStart(startMinute, poolId) {
    const firstType = activeLessonTypes()[0];
    const firstInst = activeInstructors()[0];
    const firstPool = poolId || firstType && firstType.default_pool_id || activePools()[0] && activePools()[0].id || null;
    const dur = firstType && firstType.default_duration_minutes || 50;
    return {
      type: firstType?.name || '',
      lessonTypeId: firstType?.id || null,
      instructorId: firstInst?.id || null,
      instructorName: firstInst?.name || '',
      poolId: firstPool,
      durationMinutes: dur,
      studentRows: buildStudentRows([], firstType?.students_per_instructor),
      // Always present so the modal's .filter/.some() chains never hit undefined,
      // even when the modal opens in 'add' mode with no existing replacements.
      replacementRows: []
    };
  }
  function openAdd(day, slot, poolId) {
    const startMinute = slotToMinute(slot);
    setModal({
      mode: 'add',
      id: null,
      weekStartDate: selectedWeekStart,
      day,
      startMinute,
      form: defaultFormForStart(startMinute, poolId)
    });
  }

  // Same as openAdd but uses an explicit weekStartDate and accepts startMinute
  // directly (not a slot index) — used by EnrollView which passes raw minute
  // values from its hour grid and doesn't have access to App's minuteToSlot.
  function openAddForWeek(weekStartDate, day, startMinute, poolId) {
    setModal({
      mode: 'add',
      id: null,
      weekStartDate,
      day,
      startMinute,
      form: defaultFormForStart(startMinute, poolId)
    });
  }
  function openAddAtTime(day, startMinute, poolId) {
    setModal({
      mode: 'add',
      id: null,
      weekStartDate: selectedWeekStart,
      day,
      startMinute,
      form: defaultFormForStart(startMinute, poolId)
    });
  }
  function openEdit(item) {
    // Ghost session — clicking the greyed-out shell prompts to restore
    // it to its original slot, undoing the forward/reschedule. We hand
    // off to restoreCancelledSession rather than opening the editor;
    // the underlying row is locked while cancelled (no edits allowed).
    if (item && item.cancelledAt) {
      restoreCancelledSession(item.id);
      return;
    }
    const firstInst = item.instructors[0] || null;
    const regularStudents = (item.students || []).filter(s => !s.isReplacement);
    const replacementStudents = (item.students || []).filter(s => s.isReplacement);
    // Snapshot attendance so saveSession can compute credit deltas only for
    // actual state transitions (pending↔attended, pending↔absent).
    const originalAttendance = {};
    (item.students || []).forEach(s => {
      if (s.studentId) originalAttendance[s.studentId] = s.attendance || 'pending';
    });
    setModal({
      mode: 'edit',
      id: item.id,
      weekStartDate: item.weekStartDate,
      day: item.day,
      startMinute: item.startMinute,
      rescheduledFromDay: item.rescheduledFromDay ?? null,
      rescheduledFromStartMinute: item.rescheduledFromStartMinute ?? null,
      originalAttendance,
      originalReplacementRows: replacementStudents.map(s => {
        const dec = decodeReplacementFrom(s.replacementFrom || '');
        return {
          studentId: s.studentId,
          name: s.name,
          replacementFrom: dec.label,
          originalSessionId: dec.sessionId,
          lessonTypeId: lessonTypeByName(item.type)?.id || null
        };
      }),
      form: {
        type: item.type,
        lessonTypeId: item.lessonTypeId,
        instructorId: firstInst ? firstInst.id : instructorByName(item.legacyInstructor)?.id || null,
        instructorName: firstInst ? firstInst.name : item.legacyInstructor || '',
        poolId: item.poolId,
        familyGroupId: item.familyGroupId || null,
        durationMinutes: item.durationMinutes,
        studentRows: buildStudentRows(regularStudents, lessonTypeByName(item.type)?.students_per_instructor),
        replacementRows: replacementStudents.map(s => {
          const dec = decodeReplacementFrom(s.replacementFrom || '');
          return {
            studentId: s.studentId,
            name: s.name,
            age: s.age,
            replacementFrom: dec.label,
            originalSessionId: dec.sessionId,
            attendance: s.attendance || 'pending'
          };
        })
      }
    });
  }

  // M4: open an existing session from the Enroll matcher, pre-dropping the
  // chosen swimmer into the first empty slot so the user just confirms + saves.
  function openEnroll(item, swimmers) {
    // swimmers may be: a single student object (legacy callers) or an array.
    const list = Array.isArray(swimmers) ? swimmers : swimmers ? [swimmers] : [];
    const firstInst = item.instructors[0] || null;
    const rows = buildStudentRows(item.students, lessonTypeByName(item.type)?.students_per_instructor);
    list.forEach(student => {
      if (!student) return;
      if (rows.some(r => r.studentId === student.id)) return;
      const slot = {
        studentId: student.id,
        name: student.name,
        age: student.age == null ? '' : String(student.age)
      };
      const idx = rows.findIndex(r => !r.studentId && !(r.name || '').trim());
      if (idx >= 0) rows[idx] = slot;else rows.push(slot);
    });
    setModal({
      mode: 'edit',
      id: item.id,
      weekStartDate: item.weekStartDate,
      day: item.day,
      startMinute: item.startMinute,
      form: {
        type: item.type,
        lessonTypeId: item.lessonTypeId,
        instructorId: firstInst ? firstInst.id : instructorByName(item.legacyInstructor)?.id || null,
        instructorName: firstInst ? firstInst.name : item.legacyInstructor || '',
        poolId: item.poolId,
        durationMinutes: item.durationMinutes,
        studentRows: rows,
        replacementRows: []
      }
    });
  }

  // M4: open a fresh session prefilled with the matcher's type/day/time and the
  const [highlightedSessionId, setHighlightedSessionId] = useState(null);

  // ── jumpToSession: navigate to Weekly View + pulse-highlight the card ──
  // Called when a swimmer's scheduled session badge is clicked in the
  // Accounts panel. Switches to Weekly View, scrolls to the right week,
  // and pulses the specific session card for 10 seconds — no modal opens.
  // ── saveDragOrder: persist slot reordering to DB ──────────────────
  // Called after a drag-and-drop drop in WeekView or DailyView.
  // orderedIds is the new [id, id, ...] sequence for all sessions in that slot.
  async function saveDragOrder(orderedIds) {
    try {
      await Promise.all(orderedIds.map((id, i) => patchRows('weekly_sessions', {
        id
      }, {
        sort_order: i
      })));
      await loadSessions();
    } catch (e) {
      console.warn('saveDragOrder failed:', e);
    }
  }
  function jumpToSession(session) {
    setSelectedDate(addDays(session.weekStartDate, session.day));
    setView('schedule');
    setScheduleSection('week');
    setTimeout(() => {
      setHighlightedSessionId(session.id);
      // After React renders the highlighted card, scroll it to centre of viewport
      setTimeout(() => {
        const el = document.querySelector('.wa-card-highlight');
        if (el) el.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
          inline: 'nearest'
        });
      }, 120);
      setTimeout(() => setHighlightedSessionId(null), 10000);
    }, 80);
  }

  // swimmer already in slot 1. weekStartDate is explicit so it lands in the week
  // the matcher was searching, regardless of the app's current selected week.
  function openCreateFor(weekStart, day, startMinute, lessonType, swimmers) {
    const list = Array.isArray(swimmers) ? swimmers.filter(Boolean) : swimmers ? [swimmers] : [];
    const firstInst = activeInstructors()[0] || null;
    const existing = list.map(s => ({
      studentId: s.id,
      name: s.name,
      age: s.age
    }));
    setSelectedDate(addDays(weekStart, day));
    setModal({
      mode: 'add',
      id: null,
      weekStartDate: weekStart,
      day,
      startMinute,
      form: {
        type: lessonType?.name || activeLessonTypes()[0]?.name || '',
        lessonTypeId: lessonType?.id || null,
        instructorId: firstInst?.id || null,
        instructorName: firstInst?.name || '',
        poolId: lessonType && lessonType.default_pool_id || activePools()[0] && activePools()[0].id || null,
        durationMinutes: lessonType && lessonType.default_duration_minutes || 50,
        studentRows: buildStudentRows(existing, lessonType?.students_per_instructor),
        replacementRows: []
      }
    });
  }

  // M2: save now writes pool_id, lesson_type_id, and a session_instructors
  // row. The legacy instructor text column is kept in sync so a downgrade or
  // partial deploy doesn't lose data. Deleted students/instructors are
  // wiped-and-rewritten on every save — the dataset is small enough that the
  // simplicity is worth the extra round-trip.
  async function saveSession() {
    // Always read the latest modal via ref — avoids a stale-closure race where
    // the user clicks Save immediately after picking a student before React
    // has committed the state update.
    const m = modalRef.current;
    if (!m) return;
    try {
      setSaveBusy(true);
      setError('');
      const lt = lessonTypeByName(m.form.type) || lessonTypeById(m.form.lessonTypeId);
      const inst = options.instructors.find(i => i.id === m.form.instructorId) || instructorByName(m.form.instructorName);
      const payload = {
        week_start_date: m.weekStartDate || selectedWeekStart,
        weekday: m.day + 1,
        start_minute: m.startMinute,
        duration_minutes: Number(m.form.durationMinutes),
        lesson_type: m.form.type || '',
        lesson_type_id: lt ? lt.id : null,
        pool_id: m.form.poolId || null,
        family_group_id: null,
        instructor: inst ? inst.name : '',
        rescheduled_from_day: m.rescheduledFromDay != null ? m.rescheduledFromDay + 1 : null,
        rescheduled_from_start_minute: m.rescheduledFromStartMinute ?? null
      };
      let sessionId = m.id;
      // ── Replacement undo check ──────────────────────────────────────
      // If editing an existing session, detect replacement students who were
      // present in the original (originalReplacementRows) but are now absent
      // from replacementRows. Warn the user and offer to restore them to
      // replacement_pending so the slot isn't silently lost.
      if (m.id && (m.originalReplacementRows || []).length > 0) {
        const newReplIds = new Set((m.form.replacementRows || []).filter(r => r.studentId).map(r => r.studentId));
        const removed = (m.originalReplacementRows || []).filter(r => r.studentId && !newReplIds.has(r.studentId));
        if (removed.length > 0) {
          const lines = removed.map(r => {
            const fromLabel = r.replacementFrom || '(original slot unknown)';
            return `• ${r.name} — originally from "${fromLabel}"`;
          });
          const proceed = confirm(`The following replacement student${removed.length > 1 ? 's were' : ' was'} removed:\n\n${lines.join('\n')}\n\n` + `They will return to the Pending Replacements panel.\n` + `A "Cancel & restore" button will let you send them back to their original slot — even if that date has passed.\n\n` + `Proceed with saving?`);
          if (!proceed) {
            setSaveBusy(false);
            return;
          }
          // Re-insert into replacement_pending — now with original_session_id restored!
          const lt2 = lessonTypeByName(m.form.type) || lessonTypeById(m.form.lessonTypeId);
          for (const r of removed) {
            if (r.studentId && lt2?.id) {
              try {
                await rest('replacement_pending?on_conflict=student_id,week_start_date,lesson_type_id', {
                  method: 'POST',
                  headers: {
                    Prefer: 'return=representation,resolution=merge-duplicates'
                  },
                  body: JSON.stringify([{
                    student_id: r.studentId,
                    week_start_date: m.weekStartDate || selectedWeekStart,
                    lesson_type_id: lt2.id,
                    original_session_label: r.replacementFrom || '',
                    original_session_id: r.originalSessionId || null // ← preserved from encoded replacementFrom
                  }])
                });
              } catch (_) {}
            }
          }
          await loadReplacementPending();
        }
      }
      // ────────────────────────────────────────────────────────────────
      if (m.id) {
        const updated = await patchRows('weekly_sessions', {
          id: m.id
        }, payload);
        sessionId = updated?.[0]?.id || m.id;
        await deleteRows('weekly_session_students', {
          session_id: sessionId
        });
        await deleteRows('session_instructors', {
          session_id: sessionId
        });
      } else {
        const inserted = await insertRows('weekly_sessions', payload);
        sessionId = inserted?.[0]?.id;
        if (!sessionId) throw new Error('Session was created but no ID was returned — cannot save students.');
      }
      // Regular enrolled students
      const allStudentRows = m.form.studentRows || [];
      const rows = allStudentRows.map(r => ({
        studentId: r.studentId || null,
        name: (r.name || '').trim(),
        age: r.age,
        remark: (r.remark || '').trim(),
        attendance: r.attendance || 'pending'
      })).filter(r => r.name || r.studentId);
      const filledInForm = allStudentRows.filter(r => r.studentId || (r.name || '').trim()).length;
      setStatus(`Session saved — ${rows.length} student(s) written${rows.length !== filledInForm ? ` (form showed ${filledInForm} filled)` : ''}.`);
      if (rows.length === 0 && filledInForm > 0) {
        alert(`DEBUG: Form has ${filledInForm} filled slot(s) but 0 passed the filter.\nFirst slot: ${JSON.stringify(allStudentRows[0])}\nCheck console for details.`);
        console.log('studentRows at save:', JSON.stringify(allStudentRows));
      }
      if (sessionId && rows.length) {
        await insertRows('weekly_session_students', rows.map(r => ({
          session_id: sessionId,
          student_id: r.studentId || null,
          student_name: r.name,
          student_age: r.age === '' || r.age === null || r.age === undefined ? null : Number(r.age),
          remark: r.remark || null,
          is_replacement: false,
          replacement_from: null,
          attendance_status: r.attendance || 'pending'
        })));
        // ── VERIFY: immediately read back what's in the DB ──
        const verify = await selectRows('weekly_session_students', '*', `&session_id=eq.${sessionId}`);
        console.log('DB verify after insert:', verify?.length, 'rows for session', sessionId, JSON.stringify(verify));
        setStatus(`Wrote ${rows.length} student(s) → DB shows ${verify?.length ?? '?'} for this session. sessionId=${sessionId}`);
      }
      // Replacement students
      const replRows = (m.form.replacementRows || []).filter(r => r.name || r.studentId);
      if (sessionId && replRows.length) {
        await insertRows('weekly_session_students', replRows.map(r => ({
          session_id: sessionId,
          student_id: r.studentId || null,
          student_name: (r.name || '').trim(),
          student_age: r.age != null ? Number(r.age) : null,
          remark: r.remark || null,
          is_replacement: true,
          replacement_from: (r.replacementFrom || '').trim() || null,
          attendance_status: r.attendance || 'pending'
        })));
        const wk = m.weekStartDate || selectedWeekStart;
        for (const r of replRows) {
          if (r.studentId && lt?.id && pendingByKey[`${r.studentId}:${lt.id}:${wk}`]) {
            try {
              await deleteRows('replacement_pending', {
                student_id: r.studentId,
                week_start_date: wk,
                lesson_type_id: lt.id
              });
            } catch (_) {}
          }
        }
        await loadReplacementPending();
      }
      if (sessionId && inst) {
        await insertRows('session_instructors', [{
          session_id: sessionId,
          instructor_id: inst.id
        }]);
      }
      if (lt && lt.id && sessionId) {
        // Credits are never auto-seeded when creating/saving sessions.
        // All credits flow from Pending Credits → payment receipt only.
        await loadCreditBalances();
      }
      if (sessionId && lt?.id) {
        const orig = m.originalAttendance || {};
        const allSavedRows = [...rows, ...replRows.map(r => ({
          studentId: r.studentId,
          attendance: r.attendance || 'pending'
        }))];
        const isConsuming = s => s === 'attended' || s === 'absent';
        for (const r of allSavedRows) {
          if (!r.studentId) continue;
          const oldS = orig[r.studentId] || 'pending';
          const newS = r.attendance || 'pending';
          if (oldS === newS) continue;
          if (!isConsuming(oldS) && isConsuming(newS)) {
            await adjustCredit(r.studentId, lt.id, -1);
          } else if (isConsuming(oldS) && !isConsuming(newS)) {
            await adjustCredit(r.studentId, lt.id, 1);
          }
        }
      }
      await loadSessions();
      setModal(null);
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to save session');
    } finally {
      setSaveBusy(false);
    }
  }
  async function adjustCredit(studentId, lessonTypeId, delta) {
    const key = creditKey(studentId, lessonTypeId);
    const bal = creditByKey[key];
    if (!bal) return;
    const next = Math.max(0, (bal.remaining_balance || 0) + delta);
    try {
      await patchRows('student_credit_balances', {
        student_id: studentId,
        lesson_type_id: lessonTypeId
      }, {
        remaining_balance: next,
        updated_at: new Date().toISOString()
      });
      await loadCreditBalances();
    } catch (err) {
      alert(err.message || 'Failed to adjust credit');
    }
  }
  async function initCredit(studentId, lessonTypeId, initial) {
    const n = Number(initial);
    if (!n || n < 0) return;
    try {
      await rest(`student_credit_balances?select=*`, {
        method: 'POST',
        headers: {
          Prefer: 'return=representation,resolution=merge-duplicates'
        },
        body: JSON.stringify([{
          student_id: studentId,
          lesson_type_id: lessonTypeId,
          initial_balance: n,
          remaining_balance: n
        }])
      });
      await loadCreditBalances();
    } catch (err) {
      alert(err.message || 'Failed to set credits');
    }
  }
  async function deleteSession() {
    if (!modal?.id) return;
    if (!confirm('Delete this scheduled session for the selected week?')) return;
    try {
      await deleteRows('weekly_session_students', {
        session_id: modal.id
      });
      await deleteRows('session_instructors', {
        session_id: modal.id
      });
      await deleteRows('weekly_sessions', {
        id: modal.id
      });
      await loadSessions();
      setModal(null);
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to delete session');
    }
  }
  async function saveRemark() {
    try {
      setError('');
      const val = remarkDraft.trim();
      if (remarks[selectedDate] !== undefined) {
        if (val) await patchRows('calendar_remarks', {
          calendar_date: selectedDate
        }, {
          remark: val
        });else await deleteRows('calendar_remarks', {
          calendar_date: selectedDate
        });
      } else if (val) {
        await insertRows('calendar_remarks', {
          calendar_date: selectedDate,
          remark: val
        });
      }
      await loadRemarks(monthCursor);
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to save remark');
    }
  }

  // ───── Settings mutations ─────────────────────────────────────────────────

  async function addOption(kind, extra = {}) {
    try {
      if (kind === 'instructor') await insertRows('scheduler_instructors', {
        name: extra.name,
        gender: extra.gender || null,
        sort_order: options.instructors.length + 1,
        is_active: true
      });
      if (kind === 'duration') await insertRows('scheduler_durations', {
        label: extra.label,
        slots: Number(extra.slots),
        sort_order: options.durations.length + 1,
        is_active: true
      });
      if (kind === 'lessonType') {
        const inserted = await insertRows('scheduler_lesson_types', {
          name: extra.name,
          bg_color: extra.bg,
          border_color: extra.bd,
          text_color: extra.tx,
          sort_order: options.lessonTypes.length + 1,
          is_active: true
        });
        const newId = inserted?.[0]?.id;
        if (newId) {
          // Auto-relink: any decoupled sessions that still carry this exact name (and no link) reattach to the new type.
          await rest(`weekly_sessions?lesson_type=eq.${encodeURIComponent(extra.name)}&lesson_type_id=is.null`, {
            method: 'PATCH',
            headers: {
              Prefer: 'return=minimal'
            },
            body: JSON.stringify({
              lesson_type_id: newId
            })
          });
          // Seed the two default packages every lesson type ships with.
          await insertRows('packages', [{
            lesson_type_id: newId,
            name: 'Normal',
            sort_order: 1,
            is_active: true,
            billing_mode: 'monthly'
          }, {
            lesson_type_id: newId,
            name: 'Trial',
            sort_order: 2,
            is_active: true,
            billing_mode: 'monthly'
          }]);
        }
        await loadSessions();
      }
      if (kind === 'pool') await insertRows('pools', {
        name: extra.name,
        capacity_total: Number(extra.capacity),
        sort_order: options.pools.length + 1,
        is_active: true
      });
      if (kind === 'package') {
        const ltId = extra.lessonTypeId || null;
        const siblings = ltId ? options.packages.filter(p => p.lesson_type_id === ltId) : options.packages.filter(p => !p.lesson_type_id);
        await insertRows('packages', {
          lesson_type_id: ltId,
          name: extra.name,
          pax: extra.pax === '' || extra.pax == null ? null : Number(extra.pax),
          amount: extra.amount === '' || extra.amount == null ? null : Number(extra.amount),
          billing_mode: extra.billingMode || 'monthly',
          billing_count: extra.billingCount === '' || extra.billingCount == null ? null : Number(extra.billingCount),
          is_group: !!extra.isGroup,
          fallback_per_pax: extra.fallbackPerPax === '' || extra.fallbackPerPax == null ? null : Number(extra.fallbackPerPax),
          sort_order: siblings.length + 1,
          is_active: true
        });
      }
      await loadOptions();
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to add option');
    }
  }

  // Edit a lesson type. If the name changes, cascade the new name onto every
  // linked session's text column so colors and labels stay correct everywhere.
  async function saveLessonType(row, patch) {
    try {
      setError('');
      await patchRows('scheduler_lesson_types', {
        id: row.id
      }, patch);
      if (patch.name && patch.name !== row.name) {
        await rest(`weekly_sessions?lesson_type_id=eq.${encodeURIComponent(row.id)}`, {
          method: 'PATCH',
          headers: {
            Prefer: 'return=minimal'
          },
          body: JSON.stringify({
            lesson_type: patch.name
          })
        });
      }
      await loadOptions();
      await loadSessions();
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to update lesson type');
    }
  }

  // Delete a lesson type but keep its classes. Sessions are decoupled
  // (lesson_type_id → null) while their lesson_type text name is preserved, so
  // re-creating a type with the same name relinks them automatically.
  async function deleteLessonType(row) {
    const linked = sessions.filter(s => s.lessonTypeId === row.id).length;
    const msg = linked > 0 ? `${linked} class${linked === 1 ? '' : 'es'} currently use "${row.name}".\n\nDeleting will UNLINK them: the classes stay in the schedule and keep the name "${row.name}", but lose this color/metadata link. Re-creating a lesson type with the exact same name will automatically relink them.\n\nProceed?` : `Delete lesson type "${row.name}"? No classes are currently using it.`;
    if (!confirm(msg)) return;
    try {
      setError('');
      if (linked > 0) {
        await rest(`weekly_sessions?lesson_type_id=eq.${encodeURIComponent(row.id)}`, {
          method: 'PATCH',
          headers: {
            Prefer: 'return=minimal'
          },
          body: JSON.stringify({
            lesson_type_id: null
          })
        });
      }
      await deleteRows('scheduler_lesson_types', {
        id: row.id
      });
      await loadOptions();
      await loadSessions();
      setStatus(linked > 0 ? `Unlinked ${linked} class${linked === 1 ? '' : 'es'}; "${row.name}" kept on the schedule.` : `Deleted "${row.name}".`);
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to delete lesson type');
    }
  }
  async function toggleOption(table, row) {
    try {
      await patchRows(table, {
        id: row.id
      }, {
        is_active: !row.is_active
      });
      await loadOptions();
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to update option');
    }
  }
  async function deleteOption(table, row, label) {
    if (!confirm(`Delete "${label}" from this dropdown list? Existing schedule rows will stay unchanged.`)) return;
    try {
      await deleteRows(table, {
        id: row.id
      });
      await loadOptions();
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to delete option');
    }
  }

  // Instructor delete is special: a FK on session_instructors blocks the raw
  // delete when the instructor is assigned to any class. We surface the usage
  // count in a tailored confirm, preserve the deleted name on each affected
  // session's legacy `instructor` column so the scheduler can still see who
  // used to teach it (rendered greyed-out with an amber ⚠), then drop the
  // FK rows and the instructor itself. Classes and students are left intact.
  async function deleteInstructor(row) {
    try {
      const affected = sessions.filter(s => s.instructors.some(i => i.id === row.id));
      const message = affected.length ? `"${row.name}" is currently assigned to ${affected.length} class${affected.length === 1 ? '' : 'es'}.\n\n` + `Deleting will leave those classes without an instructor. Their card will show an amber ⚠ warning until you reassign someone from the instructor list — the classes, students, times, and pool stay exactly as they are.\n\n` + `Proceed with deletion?` : `Delete "${row.name}" from the instructor list? No classes reference this instructor.`;
      if (!confirm(message)) return;
      // Preserve the name on each affected session's legacy text column so the
      // scheduler still sees a greyed-out reference until reassignment.
      for (const s of affected) {
        const remaining = s.instructors.filter(i => i.id !== row.id);
        if (remaining.length === 0 && !s.legacyInstructor) {
          await patchRows('weekly_sessions', {
            id: s.id
          }, {
            instructor: row.name
          });
        }
      }
      // Drop FK rows first so the parent delete can succeed.
      await deleteRows('session_instructors', {
        instructor_id: row.id
      });
      await deleteRows('scheduler_instructors', {
        id: row.id
      });
      await Promise.all([loadOptions(), loadSessions()]);
      setStatus(`Deleted "${row.name}"${affected.length ? ` · ${affected.length} class${affected.length === 1 ? '' : 'es'} now need a new instructor` : ''}.`);
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to delete instructor');
    }
  }
  async function patchOption(table, idOrMatch, patch) {
    try {
      const match = typeof idOrMatch === 'object' && idOrMatch !== null ? idOrMatch : {
        id: idOrMatch
      };
      await patchRows(table, match, patch);
      await loadOptions();
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to update option');
    }
  }
  async function updatePool(id, patch) {
    try {
      await patchRows('pools', {
        id
      }, patch);
      await loadOptions();
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to update pool');
    }
  }

  // ── Branches CRUD ────────────────────────────────────────────────────────
  async function addBranch({
    name,
    code,
    color
  }) {
    try {
      const next = (options.branches || []).length + 1;
      await insertRows('branches', {
        name,
        code: code || null,
        color: color || null,
        sort_order: next,
        is_active: true
      });
      await loadOptions();
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to add branch');
    }
  }
  async function updateBranch(id, patch) {
    try {
      await patchRows('branches', {
        id
      }, patch);
      await loadOptions();
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to update branch');
    }
  }
  async function deleteBranch(id) {
    if (!confirm('Delete this branch?\n\nAny pools/students/invoices linked to it will be unlinked (set to null). They will appear under "All branches" until reassigned.')) return;
    try {
      await deleteRows('branches', {
        id
      });
      await Promise.all([loadOptions(), loadStudents(), loadInvoiceData()]);
      // If we were viewing it, fall back to HQ
      if (currentBranchId === id) {
        const hq = (options.branches || []).find(b => (b.code || '').toUpperCase() === 'SSGT' && b.id !== id);
        setCurrentBranchId(hq ? hq.id : null);
      }
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to delete branch');
    }
  }

  // Reorder a settings list by reindexing sort_order across the whole list, so
  // the result is clean and gap-free regardless of the existing values.
  async function reorderOption(table, list, index, dir) {
    const arr = (list || []).slice();
    const j = index + dir;
    if (j < 0 || j >= arr.length) return;
    const tmp = arr[index];
    arr[index] = arr[j];
    arr[j] = tmp;
    try {
      await Promise.all(arr.map((r, i) => patchRows(table, {
        id: r.id
      }, {
        sort_order: i + 1
      })));
      await loadOptions();
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to reorder');
    }
  }

  // ───── Swimmer registry CRUD ──────────────────────────────────────────────
  async function addStudent({
    name,
    dateOfBirth,
    gender,
    enrollments,
    guardianName,
    guardianEmail,
    guardianPhone,
    guardianIc,
    guardianTin,
    emergencyName,
    emergencyPhone,
    emergencyRelationship,
    emergencySameAsGuardian,
    tcAcceptedAt,
    tcAcceptanceId,
    accountId,
    branchId
  }) {
    try {
      setError('');
      const validEnrollments = (enrollments || []).filter(e => e.lessonTypeId);
      const lessonTypeIds = [...new Set(validEnrollments.map(e => e.lessonTypeId))];
      const primaryPackageId = validEnrollments[0]?.packageId || null;
      const primaryPkg = primaryPackageId ? packageById(primaryPackageId) : null;
      const sameAsG = !!emergencySameAsGuardian;
      const dob = dateOfBirth || null;
      const computedAge = dob ? ageFromDob(dob) : null;
      const inserted = await insertRows('students', {
        name,
        date_of_birth: dob,
        age: computedAge,
        gender: gender || null,
        package_id: primaryPackageId,
        package: primaryPkg ? primaryPkg.name : null,
        lesson_type_ids: lessonTypeIds,
        is_active: true,
        account_id: accountId || null,
        // inherit account group from parent account
        branch_id: branchId || currentBranchId || null,
        // stamp with current branch by default
        guardian_name: guardianName || null,
        guardian_email: guardianEmail || null,
        guardian_phone: guardianPhone || null,
        guardian_ic: guardianIc || null,
        guardian_tin: guardianTin || null,
        emergency_name: sameAsG ? guardianName || null : emergencyName || null,
        emergency_phone: sameAsG ? guardianPhone || null : emergencyPhone || null,
        emergency_relationship: sameAsG ? 'Parent / Guardian' : emergencyRelationship || null,
        emergency_same_as_guardian: sameAsG,
        // T&C inheritance: a swimmer added under an existing account
        // inherits the account-level T&C acceptance so the whole household
        // shares one consent record.
        tc_accepted_at: tcAcceptedAt || null,
        tc_acceptance_id: tcAcceptanceId || null
      });
      const studentId = inserted?.[0]?.id;
      if (studentId && validEnrollments.length) {
        try {
          await insertRows('student_enrollments', validEnrollments.map(e => ({
            student_id: studentId,
            lesson_type_id: e.lessonTypeId,
            package_id: e.packageId || null
          })));
        } catch (err) {
          console.warn('Could not insert enrollments (table may not exist yet):', err?.message || err);
        }
        // Credits are NOT auto-seeded here. They must flow through the
        // Pending Credits → payment receipt → Confirm workflow only.
      }
      await loadStudents();
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to add swimmer');
    }
  }
  async function updateStudent(id, patch) {
    try {
      setError('');
      const body = {};
      if ('name' in patch) body.name = patch.name;
      if ('dateOfBirth' in patch) {
        const dob = patch.dateOfBirth || null;
        body.date_of_birth = dob;
        body.age = dob ? ageFromDob(dob) : null;
      }
      if ('gender' in patch) body.gender = patch.gender || null;
      if ('guardianName' in patch) body.guardian_name = patch.guardianName || null;
      if ('guardianEmail' in patch) body.guardian_email = patch.guardianEmail || null;
      if ('guardianPhone' in patch) body.guardian_phone = patch.guardianPhone || null;
      if ('guardianIc' in patch) body.guardian_ic = patch.guardianIc || null;
      if ('guardianTin' in patch) body.guardian_tin = patch.guardianTin || null;
      if ('emergencySameAsGuardian' in patch) body.emergency_same_as_guardian = !!patch.emergencySameAsGuardian;
      if ('emergencyPhone' in patch) body.emergency_phone = patch.emergencyPhone || null;
      if ('emergencyName' in patch) body.emergency_name = patch.emergencyName || null;
      if ('emergencyRelationship' in patch) body.emergency_relationship = patch.emergencyRelationship || null;
      if ('isActive' in patch) body.is_active = !!patch.isActive;
      // Enrollments: mirror onto legacy columns for backward compat, then
      // sync the student_enrollments table (delete-all then insert).
      if ('enrollments' in patch) {
        const validEnrollments = (patch.enrollments || []).filter(e => e.lessonTypeId);
        const lessonTypeIds = [...new Set(validEnrollments.map(e => e.lessonTypeId))];
        const primaryPackageId = validEnrollments[0]?.packageId || null;
        const primaryPkg = primaryPackageId ? packageById(primaryPackageId) : null;
        body.lesson_type_ids = lessonTypeIds;
        body.package_id = primaryPackageId;
        body.package = primaryPkg ? primaryPkg.name : null;
      }
      await patchRows('students', {
        id
      }, body);
      if ('enrollments' in patch) {
        const validEnrollments = (patch.enrollments || []).filter(e => e.lessonTypeId);
        try {
          await deleteRows('student_enrollments', {
            student_id: id
          });
          if (validEnrollments.length) {
            await insertRows('student_enrollments', validEnrollments.map(e => ({
              student_id: id,
              lesson_type_id: e.lessonTypeId,
              package_id: e.packageId || null
            })));
          }
        } catch (err) {
          console.warn('Could not sync enrollments (table may not exist yet):', err?.message || err);
        }
        // Credits are NOT auto-seeded when enrollments change.
        // They flow from Pending Credits → payment confirmation only.
        await loadCreditBalances();
      }
      await loadStudents();
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to update swimmer');
    }
  }
  async function deleteStudent(row) {
    const enrolled = sessions.filter(s => s.students.some(st => st.studentId === row.id)).length;
    const msg = enrolled > 0 ? `${row.name} is attached to ${enrolled} scheduled session${enrolled === 1 ? '' : 's'}.\n\nDeleting from the registry keeps those enrollments on the schedule (the name stays) but unlinks them. Proceed?` : `Delete swimmer "${row.name}" from the registry?`;
    if (!confirm(msg)) return;
    try {
      setError('');
      await deleteRows('students', {
        id: row.id
      });
      await loadStudents();
      await loadSessions();
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to delete swimmer');
    }
  }
  async function deleteAccount(pg) {
    if (!pg?.swimmers?.length) {
      alert('No swimmers found on this account.');
      return;
    }
    const swimmerList = pg.swimmers.map(s => `• ${s.name}`).join('\n');
    if (!confirm(`PERMANENTLY DELETE account "${pg.name}" and all ${pg.swimmers.length} swimmer${pg.swimmers.length === 1 ? '' : 's'}?\n\n${swimmerList}\n\n` + `This removes their enrollments, credit balances, and pending replacement entries.\n\n` + `⚠️ This cannot be undone. Session names on the timetable remain but become unlinked.`)) return;
    try {
      setError('');
      for (const s of pg.swimmers) {
        await deleteRows('student_credit_balances', {
          student_id: s.id
        }).catch(() => {});
        await deleteRows('student_enrollments', {
          student_id: s.id
        }).catch(() => {});
        await deleteRows('replacement_pending', {
          student_id: s.id
        }).catch(() => {});
        await deleteRows('pending_credits', {
          student_id: s.id
        }).catch(() => {});
        await deleteRows('students', {
          id: s.id
        });
      }
      await loadStudents();
      await loadSessions();
      setStatus(`Deleted account "${pg.name}" — ${pg.swimmers.length} swimmer${pg.swimmers.length === 1 ? '' : 's'} removed.`);
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to delete account');
    }
  }

  // ───── Family groups (single-payer bundles) ──────────────────────────────
  async function addGroup({
    name,
    packageId,
    groupType
  }) {
    try {
      setError('');
      const ins = await insertRows('family_groups', {
        name,
        package_id: packageId || null,
        group_type: groupType || 'discount'
      });
      await loadGroups();
      return ins?.[0] || null;
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to create family group');
      return null;
    }
  }
  async function updateGroup(id, patch) {
    try {
      setError('');
      const body = {};
      if ('name' in patch) body.name = patch.name;
      if ('packageId' in patch) body.package_id = patch.packageId || null;
      if ('groupType' in patch) body.group_type = patch.groupType;
      await patchRows('family_groups', {
        id
      }, body);
      await loadGroups();
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to update family group');
    }
  }
  async function deleteGroup(row, silent) {
    if (!silent) {
      const memberCount = (membersByGroup[row.id] || []).length;
      if (!confirm(memberCount > 0 ? `Delete family group "${row.name}"? Its ${memberCount} member${memberCount === 1 ? '' : 's'} stay in the swimmer registry but will no longer be billed as a group.` : `Delete family group "${row.name}"?`)) return;
    }
    try {
      setError('');
      await deleteRows('family_groups', {
        id: row.id
      });
      await loadGroups();
      await loadGroupMemberships();
      await loadStudents();
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to delete family group');
    }
  }
  // ── Multi-group membership write API ────────────────────────────────
  // A swimmer can be in many groups (one per unique lesson_type+package).
  // Uniqueness — "swimmer can't be in two groups with the same (lesson_type,
  // package)" — is enforced here because it touches two tables and can't
  // be a single DB constraint without denormalization. We check before
  // inserting; the UI also surfaces a "Already in <other group>" message
  // earlier so users see it without hitting the alert.
  // `targetOverride` is for callers (like handleCreate in ParentGroupManager)
  // who just INSERTED the group and have the row in hand — React's state
  // batching means familyGroups in our closure won't reflect the insert
  // until the next render, so the find-by-id below would fail. The
  // override lets the caller skip that lookup. Shape must match the
  // familyGroups row: { id, name, packageId, groupType }.
  async function addStudentToGroup(studentId, groupId, targetOverride) {
    try {
      setError('');
      const target = targetOverride || familyGroups.find(g => g.id === groupId);
      if (!target) {
        alert('Group not found.');
        return false;
      }
      // Check uniqueness: is the swimmer already in another group with
      // the same (lesson_type, package)? Skip if target group has no
      // package set yet — that's a misconfiguration the UI surfaces
      // separately.
      if (target.packageId) {
        const existingGroupIds = groupIdsByStudent[studentId] || new Set();
        for (const otherId of existingGroupIds) {
          if (otherId === groupId) return true; // already in this group — no-op
          const other = familyGroups.find(g => g.id === otherId);
          if (other && other.packageId === target.packageId) {
            alert(`This swimmer is already in "${other.name}" which has the same package. A swimmer can only be in one group per (lesson type, package) combination — remove them from "${other.name}" first.`);
            return false;
          }
        }
      }
      await insertRows('family_group_members', {
        family_group_id: groupId,
        student_id: studentId
      });
      await loadGroupMemberships();
      return true;
    } catch (err) {
      // Idempotent: PK conflict on duplicate add is silently OK
      if (err?.message && /duplicate|conflict|23505/i.test(err.message)) {
        await loadGroupMemberships();
        return true;
      }
      handleErr(err);
      alert(err.message || 'Failed to add swimmer to group');
      return false;
    }
  }
  async function removeStudentFromGroup(studentId, groupId) {
    try {
      setError('');
      await deleteRows('family_group_members', {
        family_group_id: groupId,
        student_id: studentId
      });
      await loadGroupMemberships();
      return true;
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to remove swimmer from group');
      return false;
    }
  }
  // Back-compat shim — old call sites still pass setStudentGroup(id, groupId|null).
  // groupId is non-null → ADD to group (with uniqueness check).
  // groupId is null     → REMOVE from any/all groups (used when "uncheck all").
  async function setStudentGroup(studentId, groupId) {
    if (groupId) {
      return addStudentToGroup(studentId, groupId);
    }
    // null = remove from all groups the swimmer is in
    const ids = Array.from(groupIdsByStudent[studentId] || []);
    for (const gid of ids) {
      await removeStudentFromGroup(studentId, gid);
    }
    return true;
  }

  // Move an item from one index to another (used by drag-and-drop), then reindex.
  async function moveOption(table, list, from, to) {
    if (from === to || from == null || to == null) return;
    const arr = (list || []).slice();
    if (from < 0 || to < 0 || from >= arr.length || to >= arr.length) return;
    const [it] = arr.splice(from, 1);
    arr.splice(to, 0, it);
    try {
      await Promise.all(arr.map((r, i) => patchRows(table, {
        id: r.id
      }, {
        sort_order: i + 1
      })));
      await loadOptions();
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to reorder');
    }
  }

  // duplicateSessionForward: clone ONE session into N future weeks at the
  // same weekday + start_minute. Same lesson type, same pool, same
  // instructor, same regular students (replacements excluded — they're
  // week-scoped one-offs). Attendance resets to 'pending' on the clones.
  // If a clone slot already has a matching session in a target week, that
  // week is skipped silently (avoids creating parallel duplicates).
  async function duplicateSessionForward(sessionId, weekCount) {
    const src = sessions.find(s => s.id === sessionId);
    if (!src) {
      alert('Source session not found.');
      return;
    }
    if (src.cancelledAt) {
      alert('Cannot duplicate a cancelled session — restore it first.');
      return;
    }
    const n = Math.max(1, Math.min(52, Number(weekCount) || 1));
    const enrolledRegular = (src.students || []).filter(s => !s.isReplacement);
    if (!confirm(`Duplicate "${src.type}" on ${DAYS_F[src.day]} ${minuteToTime(src.startMinute)} to the next ${n} week${n === 1 ? '' : 's'}?\n\n${enrolledRegular.length} swimmer${enrolledRegular.length === 1 ? '' : 's'} will be cloned. Attendance resets to pending each week. Weeks that already have a matching session at the same slot will be skipped.`)) return;
    let created = 0;
    try {
      for (let w = 1; w <= n; w++) {
        const targetWeekStart = addDays(src.weekStartDate, 7 * w);
        const inserted = await insertRows('weekly_sessions', [{
          week_start_date: targetWeekStart,
          weekday: src.day + 1,
          start_minute: src.startMinute,
          duration_minutes: src.durationMinutes,
          lesson_type: src.type,
          lesson_type_id: src.lessonTypeId,
          pool_id: src.poolId || null,
          family_group_id: null,
          instructor: src.legacyInstructor || null
        }]);
        const newId = inserted?.[0]?.id;
        if (newId) {
          if (enrolledRegular.length) {
            await insertRows('weekly_session_students', enrolledRegular.map(s => ({
              session_id: newId,
              student_id: s.studentId || null,
              student_name: s.name || '',
              student_age: s.age != null ? Number(s.age) : null,
              remark: s.remark || null,
              is_replacement: false,
              attendance_status: 'pending'
            })));
          }
          if (src.instructors && src.instructors.length) {
            try {
              await insertRows('session_instructors', src.instructors.map(i => ({
                session_id: newId,
                instructor_id: i.id
              })));
            } catch (_) {}
          }
          created++;
        }
      }
      await loadSessions();
      setModal(null);
      setStatus(`Duplicated: ${created} session${created === 1 ? '' : 's'} created for the next ${n} week${n === 1 ? '' : 's'}.`);
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to duplicate session forward');
    }
  }
  async function duplicatePreviousWeek() {
    try {
      if (!isFutureSelectedWeek) {
        alert('Week duplication is only available for a future week.');
        return;
      }
      const prevWeekStart = addDays(selectedWeekStart, -7);
      const sourceSessions = sessions.filter(s => s.weekStartDate === prevWeekStart && !s.cancelledAt).sort((a, b) => a.day - b.day || a.startMinute - b.startMinute);
      if (!sourceSessions.length) {
        alert('No classes found in the previous week to duplicate.');
        return;
      }
      // Pre-count trial swimmers in the source so we can mention it in the confirm prompt.
      const trialInSource = sourceSessions.reduce((n, s) => n + (s.students || []).filter(st => st.studentId && trialStudentIds.has(st.studentId)).length, 0);
      const trialNote = trialInSource ? `\n\nNote: ${trialInSource} trial swimmer${trialInSource === 1 ? '' : 's'} on these classes won’t be carried over — trial bookings are one-offs by design. Re-add them next week if they convert to a regular package.` : '';
      if (!confirm(`Duplicate all classes from ${prevWeekStart} into ${selectedWeekStart}? Existing classes in the selected week will remain.${trialNote}`)) return;
      // Rescheduled personal sessions: restore original day/time for the new week.
      // Replacement students: one-off only — skip on duplicate.
      const payload = sourceSessions.map(s => ({
        week_start_date: selectedWeekStart,
        // If session was rescheduled for last week, restore its canonical position.
        weekday: s.rescheduledFromDay != null ? s.rescheduledFromDay + 1 : s.day + 1,
        start_minute: s.rescheduledFromStartMinute != null ? s.rescheduledFromStartMinute : s.startMinute,
        duration_minutes: s.durationMinutes,
        lesson_type: s.type,
        lesson_type_id: s.lessonTypeId,
        pool_id: s.poolId,
        family_group_id: s.familyGroupId || null,
        instructor: s.legacyInstructor,
        rescheduled_from_day: null,
        // clear reschedule flag in the new week
        rescheduled_from_start_minute: null
      }));
      const inserted = await insertRows('weekly_sessions', payload);
      const studentPayload = [];
      const instructorPayload = [];
      let skippedTrials = 0,
        skippedReplacements = 0;
      (inserted || []).forEach((row, idx) => {
        const src = sourceSessions[idx];
        (src.students || []).forEach(st => {
          if (st.isReplacement) {
            skippedReplacements++;
            return;
          } // one-off — do not carry forward
          if (st.studentId && trialStudentIds.has(st.studentId)) {
            skippedTrials++;
            return;
          }
          studentPayload.push({
            session_id: row.id,
            student_id: st.studentId || null,
            student_name: st.name,
            student_age: st.age === null || st.age === undefined ? null : Number(st.age)
          });
        });
        (src.instructors || []).forEach(it => instructorPayload.push({
          session_id: row.id,
          instructor_id: it.id
        }));
      });
      if (studentPayload.length) await insertRows('weekly_session_students', studentPayload);
      if (instructorPayload.length) await insertRows('session_instructors', instructorPayload);
      await loadSessions();
      const skips = [skippedTrials ? `${skippedTrials} trial` : null, skippedReplacements ? `${skippedReplacements} replacement` : null].filter(Boolean);
      setStatus(`Duplicated ${sourceSessions.length} class${sourceSessions.length === 1 ? '' : 'es'} from previous week${skips.length ? ` · skipped ${skips.join(' and ')} swimmer${skippedTrials + skippedReplacements === 1 ? '' : 's'}` : ''}.`);
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to duplicate previous week');
    }
  }
  async function clearDayClasses(dayIndex) {
    try {
      if (!isFutureSelectedWeek) {
        alert('You can only remove all classes for a future week. Current week and past weeks are protected.');
        return;
      }
      const dayLabel = DAYS_F[dayIndex];
      const targets = sessions.filter(s => s.weekStartDate === selectedWeekStart && s.day === dayIndex);
      if (!targets.length) {
        alert(`No classes found for ${dayLabel} in the selected week.`);
        return;
      }
      if (!confirm(`Remove all classes for ${dayLabel} in the week starting ${selectedWeekStart}? This will not affect the current week or any past week.`)) return;
      for (const s of targets) {
        await deleteRows('weekly_session_students', {
          session_id: s.id
        });
        await deleteRows('session_instructors', {
          session_id: s.id
        });
        await deleteRows('weekly_sessions', {
          id: s.id
        });
      }
      await loadSessions();
      setStatus(`Removed ${targets.length} class${targets.length === 1 ? '' : 'es'} for ${dayLabel}.`);
    } catch (err) {
      handleErr(err);
      alert(err.message || 'Failed to remove day classes');
    }
  }

  // Export the selected week as a multi-tab attendance roster (one tab per day
  // that has classes), mirroring the AquaLabz monthly-roster layout: numbered
  // student rows with Name/Age/Gender/Remarks, a per-date attendance column,
  // a payment/notes column, and a teacher signature line per class.
  function exportWeekExcel() {
    if (typeof XLSX === 'undefined') {
      alert('Excel library is still loading. Please try again in a moment.');
      return;
    }
    const DSHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const sheets = [];
    for (let day = 0; day < 7; day++) {
      const ds = addDays(selectedWeekStart, day);
      const dObj = fromDateStr(ds);
      const daySessions = weekSessions.filter(s => s.day === day).sort((a, b) => a.startMinute - b.startMinute || String(a.type).localeCompare(String(b.type)));
      if (!daySessions.length) continue;
      const dateLabel = `${dObj.getDate()}/${dObj.getMonth() + 1}/${dObj.getFullYear()}`;
      const longDay = dObj.toLocaleDateString(undefined, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      });
      const aoa = [];
      const merges = [];
      const mergeFull = r => merges.push({
        s: {
          r,
          c: 0
        },
        e: {
          r,
          c: 6
        }
      });
      mergeFull(aoa.length);
      aoa.push([`AquaLabz — ${longDay}`, '', '', '', '', '', '']);
      mergeFull(aoa.length);
      aoa.push(['✓ = attended,  X = absent', '', '', '', '', '', '']);
      aoa.push(['', '', '', '', '', '', '']);
      daySessions.forEach(s => {
        const lt = lessonTypeByName(s.type);
        const cap = lt && lt.students_per_instructor ? Number(lt.students_per_instructor) : 0;
        const instr = s.instructors.map(i => i.name).join(', ') || s.legacyInstructor || '';
        const pool = poolById(s.poolId)?.name || '';
        const titleBits = [s.type || 'Class', formatRange(s.startMinute, s.durationMinutes)];
        if (pool) titleBits.push(pool);
        if (instr) titleBits.push(instr);
        mergeFull(aoa.length);
        aoa.push([titleBits.join('  ·  '), '', '', '', '', '', '']);
        aoa.push(['No.', 'Name', 'Age', 'Gender', 'Remarks', dateLabel, 'Payment / Notes']);
        s.students.forEach((stu, i) => aoa.push([i + 1, stu.name || '', stu.age === null || stu.age === undefined || stu.age === '' ? '' : stu.age, '', stu.remark || '', '', '']));
        const fillTo = Math.max(cap, s.students.length) + 2;
        for (let i = s.students.length; i < fillTo; i++) aoa.push([i + 1, '', '', '', '', '', '']);
        aoa.push(['', '', '', '', '', 'T : ____________________', '']);
        aoa.push(['', '', '', '', '', '', '']);
      });
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{
        wch: 5
      }, {
        wch: 30
      }, {
        wch: 8
      }, {
        wch: 11
      }, {
        wch: 22
      }, {
        wch: 13
      }, {
        wch: 28
      }];
      ws['!merges'] = merges;
      sheets.push({
        name: `${DSHORT[day]} ${dObj.getDate()} ${dObj.toLocaleDateString(undefined, {
          month: 'short'
        })}`.slice(0, 31),
        ws
      });
    }
    if (!sheets.length) {
      alert('No classes are scheduled in this week, so there is nothing to export.');
      return;
    }
    const wb = XLSX.utils.book_new();
    sheets.forEach(s => XLSX.utils.book_append_sheet(wb, s.ws, s.name));
    const start = fromDateStr(selectedWeekStart);
    const end = fromDateStr(addDays(selectedWeekStart, 6));
    const fmt = d => `${d.getDate()} ${d.toLocaleDateString(undefined, {
      month: 'short'
    })}`;
    const fname = `${start.toLocaleDateString(undefined, {
      month: 'long'
    })} ${start.getFullYear()} (${fmt(start)} - ${fmt(end)}).xlsx`;
    XLSX.writeFile(wb, fname);
    setStatus(`Exported ${sheets.length} day${sheets.length === 1 ? '' : 's'} to ${fname}`);
  }
  const monthDates = monthCells(monthCursor);
  const selectedItems = sessionsForDate(selectedDate);
  // selectedWeekLabel removed — the header now shows today's date instead.
  const lessonTypeCounts = useMemo(() => {
    const m = {};
    sessions.forEach(s => {
      if (s.lessonTypeId) m[s.lessonTypeId] = (m[s.lessonTypeId] || 0) + 1;
    });
    return m;
  }, [sessions]);

  // Set of swimmer IDs currently on a "trial" package (one-off bookings). Drives
  // the trial annotation in the modal/cards and the duplicate-week skip rule.
  const trialStudentIds = useMemo(() => {
    const trialPkgIds = new Set((options.packages || []).filter(p => (p.name || '').toLowerCase().includes('trial')).map(p => p.id));
    const ids = new Set();
    students.forEach(s => {
      if (s.packageId && trialPkgIds.has(s.packageId)) ids.add(s.id);
    });
    return ids;
  }, [students, options.packages]);
  // Lesson-type-scoped trial lookup: trialByLessonType[ltId] is the Set of
  // trial student IDs enrolled in that lesson type. A student in the global
  // trial set who's only enrolled in LTS won't appear under PERSONAL —
  // matching the policy that "trial" is per-lesson-type, not global.
  const trialByLessonType = useMemo(() => {
    const m = {};
    students.forEach(s => {
      if (!trialStudentIds.has(s.id)) return;
      (s.lessonTypeIds || []).forEach(ltId => {
        if (!m[ltId]) m[ltId] = new Set();
        m[ltId].add(s.id);
      });
    });
    return m;
  }, [students, trialStudentIds]);
  const groupById = useMemo(() => {
    const m = {};
    familyGroups.forEach(g => m[g.id] = g);
    return m;
  }, [familyGroups]);
  // Multi-group membership derived from the junction table when available,
  // falling back to the legacy single-FK column. Two related maps:
  //   • groupIdsByStudent: studentId → Set<groupId>
  //   • membersByGroup:    groupId → student rows
  const {
    groupIdsByStudent,
    membersByGroup,
    studentsWithGroups
  } = useMemo(() => {
    const idsByStu = {};
    const byGroup = {};
    if (groupMemberships === null) {
      // Legacy fallback path (junction table not migrated yet)
      students.forEach(s => {
        if (s.familyGroupId) {
          idsByStu[s.id] = new Set([s.familyGroupId]);
          (byGroup[s.familyGroupId] = byGroup[s.familyGroupId] || []).push(s);
        }
      });
    } else {
      const stuById = {};
      students.forEach(s => {
        stuById[s.id] = s;
      });
      (groupMemberships || []).forEach(m => {
        if (!idsByStu[m.studentId]) idsByStu[m.studentId] = new Set();
        idsByStu[m.studentId].add(m.familyGroupId);
        const s = stuById[m.studentId];
        if (s) {
          (byGroup[m.familyGroupId] = byGroup[m.familyGroupId] || []).push(s);
        }
      });
    }
    // Enriched student rows carrying their full group-set for downstream consumers.
    const withGroups = students.map(s => ({
      ...s,
      familyGroupIds: idsByStu[s.id] ? Array.from(idsByStu[s.id]) : [],
      // Keep legacy singular `familyGroupId` populated with the first group
      // for back-compat with code paths that haven't been refactored yet.
      familyGroupId: idsByStu[s.id] ? Array.from(idsByStu[s.id])[0] : null
    }));
    return {
      groupIdsByStudent: idsByStu,
      membersByGroup: byGroup,
      studentsWithGroups: withGroups
    };
  }, [students, groupMemberships]);

  // Indexed by id but using the ENRICHED row set so callers can read
  // `.familyGroupIds` (the multi-group array) — needed by the SessionModal's
  // bound-cascade logic, the Billing Preview, and any other consumer that
  // wants to know all groups a swimmer is in. MUST be declared AFTER the
  // destructuring above so `studentsWithGroups` is in scope.
  const studentById = useMemo(() => {
    const m = {};
    (studentsWithGroups || []).forEach(s => m[s.id] = s);
    return m;
  }, [studentsWithGroups]);

  // parentGroups: nest swimmers under their guardian (parent) account.
  // When account_id is populated (post-migration) each account is truly
  // isolated — two guardians sharing an email are separate accounts.
  // Pre-migration fallback: cluster on email → phone → name as before.
  const parentGroups = useMemo(() => {
    const m = {};
    // Pre-filter by current branch (header selector) — shows only this branch's accounts.
    // Accounts with no branchId on their swimmers are shown in every branch.
    const branchFiltered = currentBranchId && currentBranchId !== 'all' ? (studentsWithGroups || []).filter(s => !s.branchId || s.branchId === currentBranchId) : studentsWithGroups || [];
    branchFiltered.forEach(s => {
      // Prefer the stable account_id once the migration has run
      let key;
      if (s.accountId) {
        key = `id:${s.accountId}`;
      } else {
        const emailKey = (s.guardianEmail || '').toLowerCase().trim();
        const phoneKey = (s.guardianPhone || '').replace(/\s+/g, '').trim();
        const nameKey = (s.guardianName || '').toLowerCase().trim();
        key = emailKey ? `e:${emailKey}` : phoneKey ? `p:${phoneKey}` : nameKey ? `n:${nameKey}` : '__unassigned__';
      }
      if (!m[key]) {
        const rawId = s.accountId || '';
        const displayCode = rawId ? 'AC·' + rawId.replace(/-/g, '').slice(0, 6).toUpperCase() : '';
        m[key] = {
          key,
          displayCode,
          accountId: s.accountId || null,
          branchId: s.branchId || null,
          // dominant branch from first swimmer
          name: s.guardianName || (key === '__unassigned__' ? '— Unassigned —' : '— No name —'),
          email: s.guardianEmail || '',
          phone: s.guardianPhone || '',
          ic: s.guardianIc || '',
          tin: s.guardianTin || '',
          emergencyPhone: s.emergencyPhone || '',
          emergencyName: s.emergencyName || '',
          emergencyRelationship: s.emergencyRelationship || '',
          emergencySameAsGuardian: !!s.emergencySameAsGuardian,
          swimmers: []
        };
      }
      m[key].swimmers.push(s);
    });
    Object.values(m).forEach(pg => {
      pg.isActive = pg.swimmers.some(s => s.isActive !== false);
    });
    return Object.values(m).sort((a, b) => {
      if (a.key === '__unassigned__') return 1;
      if (b.key === '__unassigned__') return -1;
      return a.name.localeCompare(b.name);
    });
  }, [studentsWithGroups, currentBranchId]);

  // Which sessions (in the selected week) each swimmer is already in — drives the
  // double-booking warning in the enrollment modal.
  const weekEnrollments = useMemo(() => {
    const m = {};
    weekSessions.forEach(s => {
      // Cancelled ghosts retain their student rows for restore purposes
      // but those swimmers aren't actually booked into this slot anymore —
      // skip the ghost so the double-booking warning doesn't false-fire.
      if (s.cancelledAt) return;
      s.students.forEach(st => {
        if (!st.studentId) return;
        (m[st.studentId] = m[st.studentId] || []).push({
          day: s.day,
          startMinute: s.startMinute,
          type: s.type,
          sessionId: s.id
        });
      });
    });
    return m;
  }, [weekSessions]);

  // Each swimmer's recurring class slots across all weeks, de-duplicated by
  // (lesson type, weekday, start), for the Swimmers tab schedule column.
  const scheduleByStudent = useMemo(() => {
    const m = {};
    sessions.forEach(s => s.students.forEach(st => {
      const id = st.studentId;
      if (!id) return;
      const key = `${s.type}|${s.day}|${s.startMinute}`;
      if (!m[id]) m[id] = {};
      if (!m[id][key]) m[id][key] = {
        type: s.type,
        lessonTypeId: s.lessonTypeId,
        day: s.day,
        startMinute: s.startMinute,
        durationMinutes: s.durationMinutes
      };
    }));
    const out = {};
    Object.keys(m).forEach(id => {
      out[id] = Object.values(m[id]).sort((a, b) => a.day - b.day || a.startMinute - b.startMinute);
    });
    return out;
  }, [sessions]);
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "header"
  }, /*#__PURE__*/React.createElement("div", {
    className: "header-inner"
  }, /*#__PURE__*/React.createElement("div", {
    className: "brand"
  }, /*#__PURE__*/React.createElement("img", {
    src: "./logo.png",
    alt: "SSB",
    className: "logo"
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      fontWeight: 800,
      letterSpacing: '-.3px',
      lineHeight: 1
    }
  }, "SSB Scheduler"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 9,
      color: '#64748B',
      marginTop: 2
    }
  }, "Pool-aware lesson calendar"))), /*#__PURE__*/React.createElement("div", {
    className: "header-meta"
  }, /*#__PURE__*/React.createElement("div", {
    className: "branch-selector"
  }, /*#__PURE__*/React.createElement("label", {
    className: "branch-label"
  }, "Branch"), /*#__PURE__*/React.createElement("select", {
    className: "branch-select",
    value: currentBranchId || '',
    onChange: e => setCurrentBranchId(e.target.value || null),
    title: "Switch the active branch. Filters Accounts, Pools, Invoices, Intake."
  }, (options.branches || []).filter(b => b.is_active !== false).map(b => /*#__PURE__*/React.createElement("option", {
    key: b.id,
    value: b.id
  }, b.name, b.code ? ` (${b.code})` : '')), /*#__PURE__*/React.createElement("option", {
    value: "all"
  }, "All branches")), currentBranchId && currentBranchId !== 'all' && (() => {
    const b = branchById(currentBranchId);
    return b ? /*#__PURE__*/React.createElement("span", {
      className: "branch-pill",
      style: b.color ? {
        background: b.color + '22',
        borderColor: b.color,
        color: b.color
      } : {}
    }, "\u25CF ", b.code || b.name) : null;
  })()), /*#__PURE__*/React.createElement("div", {
    className: "header-summary"
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--primary)',
      fontWeight: 800
    }
  }, summary.totalStudents), " students \xB7 ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--primary)',
      fontWeight: 800
    }
  }, summary.totalSessions), " sessions"), /*#__PURE__*/React.createElement("div", {
    className: "header-status"
  }, /*#__PURE__*/React.createElement("span", {
    className: `status-dot ${loading ? 'is-loading' : error ? 'is-error' : 'is-ok'}`,
    "aria-hidden": "true"
  }), loading ? 'Connecting…' : error ? 'Error' : status || 'Ready')), /*#__PURE__*/React.createElement("nav", {
    className: "main-nav"
  }, /*#__PURE__*/React.createElement("button", {
    className: `nav-btn ${view === 'schedule' ? 'active' : ''}`,
    onClick: () => setView('schedule')
  }, "\uD83D\uDCC5 Schedule"), /*#__PURE__*/React.createElement("button", {
    className: `nav-btn ${view === 'accounts' ? 'active' : ''}`,
    onClick: () => {
      setView('accounts');
      setAccountSection('accounts');
    }
  }, "\uD83D\uDC64 Accounts"), /*#__PURE__*/React.createElement("button", {
    className: `nav-btn ${view === 'enroll' ? 'active' : ''}`,
    onClick: () => setView('enroll')
  }, "\uD83D\uDD0D Explore"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "nav-btn nav-btn-link",
    onClick: () => window.open('./intake.html', '_blank', 'noopener,noreferrer')
  }, "\uD83D\uDCDD Intake \u2197"), /*#__PURE__*/React.createElement("button", {
    className: `nav-btn ${view === 'settings' ? 'active' : ''}`,
    onClick: () => {
      setView('settings');
      setAdminSection('pools');
    }
  }, "\u2699\uFE0F Settings")))), !loading && view === 'schedule' && /*#__PURE__*/React.createElement("div", {
    className: "sub-bar"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sub-bar-inner"
  }, /*#__PURE__*/React.createElement("button", {
    className: `sub-tab ${scheduleSection === 'week' ? 'active' : ''}`,
    onClick: () => setScheduleSection('week')
  }, "Weekly"), /*#__PURE__*/React.createElement("button", {
    className: `sub-tab ${scheduleSection === 'day' ? 'active' : ''}`,
    onClick: () => setScheduleSection('day')
  }, "Daily"), /*#__PURE__*/React.createElement("button", {
    className: `sub-tab ${scheduleSection === 'month' ? 'active' : ''}`,
    onClick: () => setScheduleSection('month')
  }, "Monthly"), (scheduleSection === 'week' || scheduleSection === 'day') && /*#__PURE__*/React.createElement("div", {
    className: "sub-bar-spacer"
  }, /*#__PURE__*/React.createElement("div", {
    className: "period-stepper",
    style: {
      margin: 0
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "step-btn",
    onClick: () => setSelectedDate(addDays(selectedDate, -7)),
    title: "Previous week",
    "aria-label": "Previous week"
  }, "\u2039"), /*#__PURE__*/React.createElement("div", {
    className: "period-label",
    style: {
      fontSize: 12
    }
  }, weekRangeLabel(selectedWeekStart)), /*#__PURE__*/React.createElement("button", {
    className: "step-btn",
    onClick: () => setSelectedDate(addDays(selectedDate, 7)),
    title: "Next week",
    "aria-label": "Next week"
  }, "\u203A")), /*#__PURE__*/React.createElement("button", {
    className: `today-btn ${selectedWeekStart === currentWeekStart ? 'is-current' : ''}`,
    disabled: selectedWeekStart === currentWeekStart,
    onClick: () => setSelectedDate(todayStr()),
    style: {
      marginLeft: 6
    }
  }, "This Week")))), !loading && view === 'accounts' && /*#__PURE__*/React.createElement("div", {
    className: "sub-bar"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sub-bar-inner"
  }, /*#__PURE__*/React.createElement("button", {
    className: `sub-tab ${accountSection === 'accounts' ? 'active' : ''}`,
    onClick: () => setAccountSection('accounts')
  }, "Accounts"), /*#__PURE__*/React.createElement("button", {
    className: `sub-tab ${accountSection === 'familyGroups' ? 'active' : ''}`,
    onClick: () => setAccountSection('familyGroups')
  }, "Groups"), /*#__PURE__*/React.createElement("button", {
    className: `sub-tab ${accountSection === 'swimmers' ? 'active' : ''}`,
    onClick: () => setAccountSection('swimmers')
  }, "Swimmers"), /*#__PURE__*/React.createElement("button", {
    className: `sub-tab ${accountSection === 'invoices' ? 'active' : ''}`,
    onClick: () => setAccountSection('invoices')
  }, "Invoices"), /*#__PURE__*/React.createElement("button", {
    className: `sub-tab ${accountSection === 'receipts' ? 'active' : ''}`,
    onClick: () => setAccountSection('receipts')
  }, "Receipts"), /*#__PURE__*/React.createElement("button", {
    className: `sub-tab ${accountSection === 'pendingCredits' ? 'active' : ''}`,
    onClick: () => setAccountSection('pendingCredits')
  }, "Pending Credits"), /*#__PURE__*/React.createElement("button", {
    className: `sub-tab ${accountSection === 'aging' ? 'active' : ''}`,
    onClick: () => setAccountSection('aging')
  }, "Aging"), /*#__PURE__*/React.createElement("button", {
    className: `sub-tab ${accountSection === 'codes' ? 'active' : ''}`,
    onClick: () => setAccountSection('codes')
  }, "Discounts"), /*#__PURE__*/React.createElement("button", {
    className: `sub-tab ${accountSection === 'reports' ? 'active' : ''}`,
    onClick: () => setAccountSection('reports')
  }, "Reports"), ['accounts', 'familyGroups', 'swimmers', 'invoices', 'receipts'].includes(accountSection) && /*#__PURE__*/React.createElement("div", {
    className: "sub-bar-spacer"
  }, /*#__PURE__*/React.createElement("input", {
    className: "input sub-bar-search",
    placeholder: accountSection === 'swimmers' ? 'Search swimmer, parent, phone…' : accountSection === 'invoices' ? 'Search invoice # or account…' : accountSection === 'receipts' ? 'Search receipt #, invoice, account…' : accountSection === 'familyGroups' ? 'Search group or member…' : 'Search account, email, phone, swimmer…',
    value: accountSearchQ,
    onChange: e => setAccountSearchQ(e.target.value)
  })))), !loading && view === 'settings' && /*#__PURE__*/React.createElement("div", {
    className: "sub-bar"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sub-bar-inner"
  }, /*#__PURE__*/React.createElement("button", {
    className: `sub-tab ${adminSection === 'summary' ? 'active' : ''}`,
    onClick: () => setAdminSection('summary')
  }, "Summary"), /*#__PURE__*/React.createElement("button", {
    className: `sub-tab ${adminSection === 'branches' ? 'active' : ''}`,
    onClick: () => setAdminSection('branches')
  }, "Branches"), /*#__PURE__*/React.createElement("button", {
    className: `sub-tab ${adminSection === 'pools' ? 'active' : ''}`,
    onClick: () => setAdminSection('pools')
  }, "Pools & Hours"), /*#__PURE__*/React.createElement("button", {
    className: `sub-tab ${adminSection === 'instructors' ? 'active' : ''}`,
    onClick: () => setAdminSection('instructors')
  }, "Instructors"), /*#__PURE__*/React.createElement("button", {
    className: `sub-tab ${adminSection === 'lessonTypes' ? 'active' : ''}`,
    onClick: () => setAdminSection('lessonTypes')
  }, "Lesson Types"), /*#__PURE__*/React.createElement("button", {
    className: `sub-tab ${adminSection === 'invoiceSettings' ? 'active' : ''}`,
    onClick: () => setAdminSection('invoiceSettings')
  }, "Invoice Numbering"))), /*#__PURE__*/React.createElement("div", {
    className: "wrap"
  }, loading ? /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      textAlign: 'center',
      padding: '42px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 34,
      marginBottom: 10
    }
  }, "\u23F3"), /*#__PURE__*/React.createElement("div", null, "Loading scheduler\u2026"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      marginTop: 6
    }
  }, status || 'Connecting')) : null, !loading && error ? /*#__PURE__*/React.createElement("div", {
    className: "card error-card"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 800,
      marginBottom: 4
    }
  }, "Error"), /*#__PURE__*/React.createElement("div", {
    className: "small"
  }, error)) : null, !loading && view === 'schedule' && scheduleSection === 'week' && /*#__PURE__*/React.createElement(WeekView, {
    weekBlocks: weekBlocks,
    weekBlocksAllPools: weekBlocksAllPools,
    pools: activePools(),
    selectedPoolId: selectedPoolId,
    setSelectedPoolId: setSelectedPoolId,
    branchLabel: currentBranchId && currentBranchId !== 'all' ? branchById(currentBranchId)?.name || '' : 'All Branches',
    gridBounds: gridBounds,
    gridSlots: gridSlots,
    slotToMinute: slotToMinute,
    minuteToSlot: minuteToSlot,
    colorsFor: colorsFor,
    lessonTypeByName: lessonTypeByName,
    poolById: poolById,
    onAdd: openAdd,
    onEdit: openEdit,
    activeLessonTypes: activeLessonTypes(),
    selectedDate: selectedDate,
    sessionsForDate: sessionsForDate,
    selectedWeekStart: selectedWeekStart,
    currentWeekStart: currentWeekStart,
    isFutureSelectedWeek: isFutureSelectedWeek,
    onPrevWeek: () => setSelectedDate(addDays(selectedDate, -7)),
    onNextWeek: () => setSelectedDate(addDays(selectedDate, 7)),
    onThisWeek: () => setSelectedDate(todayStr()),
    onDuplicateWeek: duplicatePreviousWeek,
    onClearDay: clearDayClasses,
    onJumpToDay: dayIndex => {
      const d = fromDateStr(selectedWeekStart);
      d.setDate(d.getDate() + dayIndex);
      setSelectedDate(toDateStr(d));
      setScheduleSection('day');
    },
    isTypeEnabled: isTypeEnabled,
    onToggleType: toggleType,
    onToggleAllTypes: toggleAllTypes,
    allTypesShown: allTypesShown,
    activeInstructors: activeInstructors(),
    isInstructorActive: isInstructorActive,
    onToggleInstructor: toggleInstructor,
    onClearInstructors: clearInstructors,
    instructorFilterActive: selectedInstructors.size > 0,
    weekPendingReplacements: replacementPending.filter(p => {
      // Show on the selected week AND any past-week limbo records that
      // were never placed (they remain pending until manually resolved).
      // Only future-week (>selectedWeekStart) records are hidden until
      // their own week becomes the selected week.
      if (p.week_start_date > selectedWeekStart) return false;
      // Branch filter: only show replacements whose student belongs to the current branch
      if (currentBranchId && currentBranchId !== 'all') {
        const stu = studentById[p.student_id];
        if (stu && stu.branchId && stu.branchId !== currentBranchId) return false;
      }
      return true;
    }),
    lessonTypeById: lessonTypeById,
    studentById: studentById,
    onCancelPendingReplacement: cancelPendingReplacement,
    pendingMove: pendingMove,
    onPlacePendingMove: placePendingMove,
    onCancelPendingMove: cancelPendingMove,
    onExportExcel: exportWeekExcel,
    trialStudentIds: trialStudentIds,
    trialByLessonType: trialByLessonType,
    creditByKey: creditByKey,
    highlightedSessionId: highlightedSessionId,
    onReorderSlot: saveDragOrder
  }), !loading && view === 'schedule' && scheduleSection === 'day' && /*#__PURE__*/React.createElement(DailyView, {
    selectedDate: selectedDate,
    setSelectedDate: setSelectedDate,
    sessionsForDate: filteredSessionsForDate,
    colorsFor: colorsFor,
    lessonTypeByName: lessonTypeByName,
    poolById: poolById,
    branchLabel: currentBranchId && currentBranchId !== 'all' ? branchById(currentBranchId)?.name || '' : 'All Branches',
    onAddAtTime: openAddAtTime,
    onEdit: openEdit,
    onReorderSlot: saveDragOrder,
    selectedWeekStart: selectedWeekStart,
    currentWeekStart: currentWeekStart,
    onPrevWeek: () => setSelectedDate(addDays(selectedDate, -7)),
    onNextWeek: () => setSelectedDate(addDays(selectedDate, 7)),
    onThisWeek: () => setSelectedDate(todayStr()),
    onExportExcel: exportWeekExcel,
    activeLessonTypes: activeLessonTypes(),
    isTypeEnabled: isTypeEnabled,
    onToggleType: toggleType,
    onToggleAllTypes: toggleAllTypes,
    allTypesShown: allTypesShown,
    activeInstructors: activeInstructors(),
    isInstructorActive: isInstructorActive,
    onToggleInstructor: toggleInstructor,
    onClearInstructors: clearInstructors,
    instructorFilterActive: selectedInstructors.size > 0,
    trialStudentIds: trialStudentIds,
    trialByLessonType: trialByLessonType,
    creditByKey: creditByKey
  }), !loading && view === 'schedule' && scheduleSection === 'month' && /*#__PURE__*/React.createElement(MonthView, {
    monthCursor: monthCursor,
    setMonthCursor: setMonthCursor,
    selectedDate: selectedDate,
    setSelectedDate: setSelectedDate,
    monthDates: monthDates,
    sessionsForDate: sessionsForDate,
    colorsFor: colorsFor,
    remarks: remarks,
    remarkDraft: remarkDraft,
    setRemarkDraft: setRemarkDraft,
    saveRemark: saveRemark,
    selectedItems: selectedItems
  }), !loading && view === 'accounts' && (accountSection === 'accounts' || accountSection === 'familyGroups') && /*#__PURE__*/React.createElement(ParentsView, {
    externalSearchQ: accountSearchQ,
    branches: options.branches || [],
    accountSection: accountSection,
    setAccountSection: setAccountSection,
    parentGroups: parentGroups,
    lessonTypes: activeLessonTypes(),
    lessonTypeById: lessonTypeById,
    packages: activePackages(),
    packageById: packageById,
    familyGroups: currentBranchId && currentBranchId !== 'all' ? (familyGroups || []).filter(g => {
      const gid = g.id;
      return (studentsWithGroups || []).some(s => (s.familyGroupIds || []).includes(gid) && (!s.branchId || s.branchId === currentBranchId));
    }) : familyGroups,
    groupById: groupById,
    membersByGroup: membersByGroup,
    creditByKey: creditByKey,
    subscriptions: subscriptions,
    addStudent: addStudent,
    updateStudent: updateStudent,
    deleteStudent: deleteStudent,
    deleteAccount: deleteAccount,
    addGroup: addGroup,
    updateGroup: updateGroup,
    deleteGroup: deleteGroup,
    setStudentGroup: setStudentGroup,
    addStudentToGroup: addStudentToGroup,
    removeStudentFromGroup: removeStudentFromGroup,
    groupIdsByStudent: groupIdsByStudent,
    addSubscription: addSubscription,
    cancelSubscription: cancelSubscription,
    adjustBalanceTo: adjustBalanceTo,
    scheduleByStudent: scheduleByStudent,
    sessions: sessions,
    poolById: poolById,
    selectedWeekStart: selectedWeekStart,
    createInvoice: createInvoice,
    setAdminSection: setAdminSection,
    onJumpToSession: jumpToSession,
    setView: setView
  }), !loading && view === 'accounts' && accountSection === 'swimmers' && /*#__PURE__*/React.createElement(StudentsView, {
    externalSearchQ: accountSearchQ,
    students: currentBranchId && currentBranchId !== 'all' ? students.filter(s => !s.branchId || s.branchId === currentBranchId) : students,
    lessonTypes: activeLessonTypes(),
    lessonTypeById: lessonTypeById,
    packages: activePackages(),
    packageById: packageById,
    groupById: groupById,
    familyGroups: familyGroups,
    membersByGroup: membersByGroup,
    scheduleByStudent: scheduleByStudent,
    sessions: sessions,
    jumpToWeek: (weekStartDate, dayIndex) => {
      const d = fromDateStr(weekStartDate);
      d.setDate(d.getDate() + (dayIndex || 0));
      setSelectedDate(toDateStr(d));
      setView('schedule');
      setScheduleSection('week');
    },
    creditByKey: creditByKey,
    purchasesByStudent: purchasesByStudent,
    subscriptions: subscriptions,
    addCreditPurchase: addCreditPurchase,
    deleteCreditPurchase: deleteCreditPurchase,
    addSubscription: addSubscription,
    cancelSubscription: cancelSubscription,
    adjustBalanceTo: adjustBalanceTo,
    addStudent: addStudent,
    updateStudent: updateStudent,
    deleteStudent: deleteStudent,
    deleteAccount: deleteAccount
  }), !loading && view === 'accounts' && accountSection === 'invoices' && /*#__PURE__*/React.createElement(InvoicesView, {
    externalSearchQ: accountSearchQ,
    branches: options.branches || [],
    invoices: invoices,
    invoiceLines: invoiceLines,
    pmts: pmts,
    pendingCredits: pendingCredits,
    lessonTypeById: lessonTypeById,
    packageById: packageById,
    studentById: studentById,
    membersByGroup: membersByGroup,
    invoiceSettings: invoiceSettings,
    onSaveSettings: saveInvoiceSettings,
    formatInvoiceNumber: formatInvoiceNumber,
    formatReceiptNumber: formatReceiptNumber,
    onVoid: voidInvoice,
    onDelete: invoiceSettings.allow_delete_invoice ? deleteInvoice : null,
    onUpdateStatus: updateInvoiceStatus,
    onRecordPayment: recordPayment,
    onConfirmCredit: confirmCredit,
    onReverseCredit: reverseCredit,
    onAddLine: addInvoiceLine,
    onUpdateLine: updateInvoiceLine,
    onDeleteLine: deleteInvoiceLine
  }), !loading && view === 'accounts' && accountSection === 'receipts' && /*#__PURE__*/React.createElement(ReceiptsView, {
    externalSearchQ: accountSearchQ,
    pmts: pmts,
    invoices: invoices,
    branches: options.branches || []
  }), !loading && view === 'accounts' && accountSection === 'pendingCredits' && /*#__PURE__*/React.createElement(PendingCreditsView, {
    branches: options.branches || [],
    pendingCredits: currentBranchId && currentBranchId !== 'all' ? pendingCredits.filter(pc => {
      // Priority 1: use the invoice's branch_id — most reliable for both
      // individual and group/family credits since invoices are stamped at creation.
      if (pc.invoice_id) {
        const inv = invoices.find(i => i.id === pc.invoice_id);
        if (inv) {
          if (!inv.branch_id) return true; // unassigned invoice → show everywhere
          return inv.branch_id === currentBranchId;
        }
      }
      // Priority 2: fall back to the individual student's branchId
      if (pc.student_id) {
        const stu = studentById[pc.student_id];
        if (stu) {
          if (!stu.branchId) return true; // unassigned student → show everywhere
          return stu.branchId === currentBranchId;
        }
      }
      // No anchor found (old data with no branch info) → show in all branches
      return true;
    }) : pendingCredits,
    invoices: invoices,
    studentById: studentById,
    familyGroups: familyGroups,
    groupById: id => groupById[id],
    lessonTypeById: lessonTypeById,
    packageById: packageById,
    onConfirm: confirmCredit,
    onReverse: reverseCredit
  }), !loading && view === 'accounts' && accountSection === 'aging' && /*#__PURE__*/React.createElement(AgingReportView, {
    invoices: invoices,
    pmts: pmts,
    branches: options.branches || []
  }), !loading && view === 'accounts' && accountSection === 'reports' && /*#__PURE__*/React.createElement(ReportsView, {
    invoices: invoices,
    pmts: pmts,
    pendingCredits: pendingCredits,
    students: students,
    sessions: sessions,
    creditBalances: creditBalances,
    currentBranchId: currentBranchId,
    branches: options.branches || [],
    lessonTypes: activeLessonTypes(),
    lessonTypeById: lessonTypeById
  }), !loading && view === 'accounts' && accountSection === 'codes' && /*#__PURE__*/React.createElement(SettingsView, {
    section: "codes",
    options: options,
    addOption: addOption,
    toggleOption: toggleOption,
    deleteOption: deleteOption,
    codes: codes,
    students: students,
    packages: options.packages,
    addCode: addCode,
    updateCode: updateCode,
    deleteCode: deleteCode,
    pools: activePools(),
    onUpdatePool: updatePool
  }), !loading && view === 'enroll' && /*#__PURE__*/React.createElement(EnrollView, {
    sessions: sessions.filter(s => {
      if (!currentBranchId || currentBranchId === 'all') return true;
      // A session belongs to a branch via its pool's branch_id
      const pool = poolById(s.poolId);
      if (!pool) return true; // no pool assigned — show in all branches
      return !pool.branch_id || pool.branch_id === currentBranchId;
    }),
    students: students,
    studentById: studentById,
    lessonTypes: activeLessonTypes(),
    lessonTypeById: lessonTypeById,
    lessonTypeByName: lessonTypeByName,
    poolById: poolById,
    colorsFor: colorsFor,
    gridBounds: gridBounds,
    packages: options.packages,
    instructors: activeInstructors(),
    initialWeekStart: selectedWeekStart,
    onEnroll: openEnroll,
    onCreate: openCreateFor,
    onEdit: openEdit,
    onAdd: (day, startMinute, poolId, weekStart) => openAddForWeek(weekStart, day, startMinute, poolId)
  }), !loading && view === 'students' && /*#__PURE__*/React.createElement(StudentsView, {
    students: students,
    lessonTypes: activeLessonTypes(),
    lessonTypeById: lessonTypeById,
    packages: activePackages(),
    packageById: packageById,
    groupById: groupById,
    familyGroups: familyGroups,
    membersByGroup: membersByGroup,
    scheduleByStudent: scheduleByStudent,
    sessions: sessions,
    jumpToWeek: (weekStartDate, dayIndex) => {
      const d = fromDateStr(weekStartDate);
      d.setDate(d.getDate() + (dayIndex || 0));
      setSelectedDate(toDateStr(d));
      setView('schedule');
      setScheduleSection('week');
    },
    creditByKey: creditByKey,
    purchasesByStudent: purchasesByStudent,
    subscriptions: subscriptions,
    addCreditPurchase: addCreditPurchase,
    deleteCreditPurchase: deleteCreditPurchase,
    addSubscription: addSubscription,
    cancelSubscription: cancelSubscription,
    adjustBalanceTo: adjustBalanceTo,
    addStudent: addStudent,
    updateStudent: updateStudent,
    deleteStudent: deleteStudent,
    deleteAccount: deleteAccount
  }), !loading && view === 'settings' && adminSection === 'summary' && /*#__PURE__*/React.createElement(SummaryView, {
    summary: summary,
    pools: activePools()
  }), !loading && view === 'settings' && adminSection === 'branches' && /*#__PURE__*/React.createElement(BranchesAdminView, {
    branches: options.branches || [],
    addBranch: addBranch,
    updateBranch: updateBranch,
    deleteBranch: deleteBranch
  }), !loading && view === 'settings' && adminSection === 'invoiceSettings' && /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 800,
      fontSize: 18,
      marginBottom: 4
    }
  }, "Invoice Numbering & Permissions"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      marginBottom: 16
    }
  }, "These are sensitive settings. Invoice deletion is irreversible \u2014 enable the delete permission only for authorised users."), /*#__PURE__*/React.createElement(InvoiceSettingsPanel, {
    settings: invoiceSettings,
    onSave: saveInvoiceSettings,
    formatInvoiceNumber: formatInvoiceNumber,
    formatReceiptNumber: formatReceiptNumber
  })), !loading && view === 'settings' && (adminSection === 'pools' || adminSection === 'instructors' || adminSection === 'lessonTypes') && /*#__PURE__*/React.createElement(SettingsView, {
    section: adminSection,
    options: options,
    addOption: addOption,
    toggleOption: toggleOption,
    deleteOption: deleteOption,
    deleteInstructor: deleteInstructor,
    patchOption: patchOption,
    reorderOption: reorderOption,
    moveOption: moveOption,
    saveLessonType: saveLessonType,
    deleteLessonType: deleteLessonType,
    lessonTypeCounts: lessonTypeCounts,
    codes: codes,
    students: students,
    packages: options.packages,
    addCode: addCode,
    updateCode: updateCode,
    deleteCode: deleteCode,
    pools: activePools(),
    onUpdatePool: updatePool
  })), modal ? /*#__PURE__*/React.createElement(SessionModal, {
    modal: modal,
    setModal: setModal,
    saveBusy: saveBusy,
    saveSession: saveSession,
    deleteSession: deleteSession,
    openAddAtTime: openAddAtTime,
    instructors: activeInstructors(),
    lessonTypes: activeLessonTypes(),
    pools: activePools(),
    lessonTypeByName: lessonTypeByName,
    poolById: poolById,
    packageById: packageById,
    students: students,
    studentById: studentById,
    weekEnrollments: weekEnrollments,
    familyGroups: familyGroups,
    membersByGroup: membersByGroup,
    groupById: groupById,
    trialStudentIds: trialStudentIds,
    trialByLessonType: trialByLessonType,
    creditByKey: creditByKey,
    purchasesByKey: purchasesByKey,
    addCreditPurchase: addCreditPurchase,
    adjustCredit: adjustCredit,
    initCredit: initCredit,
    pendingByKey: pendingByKey,
    replacementPending: replacementPending,
    markForReplacement: markForReplacement,
    forwardClassToNextWeek: forwardClassToNextWeek,
    startFullClassMove: startFullClassMove,
    duplicateSessionForward: duplicateSessionForward
  }) : null);
}

// ============================================================================
// WeekView (M2: pool toggle, sub-cols, capacity chips)
// ============================================================================

function WeekView(props) {
  const {
    weekBlocks,
    weekBlocksAllPools,
    pools,
    selectedPoolId,
    setSelectedPoolId,
    gridBounds,
    gridSlots,
    slotToMinute,
    minuteToSlot,
    colorsFor,
    lessonTypeByName,
    poolById,
    onAdd,
    onEdit,
    activeLessonTypes,
    selectedDate,
    sessionsForDate,
    selectedWeekStart,
    currentWeekStart,
    isFutureSelectedWeek,
    onPrevWeek,
    onNextWeek,
    onThisWeek,
    onDuplicateWeek,
    onClearDay,
    onJumpToDay,
    isTypeEnabled,
    onToggleType,
    onToggleAllTypes,
    allTypesShown,
    onExportExcel,
    activeInstructors,
    isInstructorActive,
    onToggleInstructor,
    onClearInstructors,
    instructorFilterActive,
    weekPendingReplacements,
    lessonTypeById,
    studentById,
    onCancelPendingReplacement,
    pendingMove,
    onPlacePendingMove,
    onCancelPendingMove,
    trialStudentIds,
    trialByLessonType,
    creditByKey,
    highlightedSessionId,
    onReorderSlot
  } = props;
  const [printMenu, setPrintMenu] = useState(false);
  // ── Slot drag-to-reorder ──────────────────────────────────────────
  // Tracks a custom display order per cell (keyed weekStart:day:hourBucket).
  // Order is in-memory only; survives navigation within the session but
  // resets on page reload. The DB sort is unchanged.
  const [dragId, setDragId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [slotOrders, setSlotOrders] = useState({});
  function cellKey(di, h) {
    return `${selectedWeekStart}:${di}:${h}`;
  }
  function applySlotOrder(rawCell, di, h) {
    if (rawCell.length <= 1) return rawCell;
    const custom = slotOrders[cellKey(di, h)];
    if (!custom || !custom.length) return rawCell;
    const rank = new Map(custom.map((id, i) => [String(id), i]));
    return [...rawCell].sort((a, b) => (rank.has(String(a.id)) ? rank.get(String(a.id)) : 9999) - (rank.has(String(b.id)) ? rank.get(String(b.id)) : 9999));
  }
  function onCardDragStart(e, block, rawCell, di, h) {
    e.stopPropagation();
    setDragId(block.id);
    // Snapshot current visual order on first drag in this slot
    const k = cellKey(di, h);
    if (!slotOrders[k]) setSlotOrders(prev => ({
      ...prev,
      [k]: rawCell.map(b => String(b.id))
    }));
    e.dataTransfer.effectAllowed = 'move';
  }
  function onCardDragOver(e, block) {
    e.preventDefault();
    e.stopPropagation();
    if (String(dragOverId) !== String(block.id)) setDragOverId(block.id);
  }
  function onCardDrop(e, targetBlock, rawCell, di, h) {
    e.preventDefault();
    e.stopPropagation();
    if (!dragId || String(dragId) === String(targetBlock.id)) {
      setDragId(null);
      setDragOverId(null);
      return;
    }
    const k = cellKey(di, h);
    const base = slotOrders[k] || rawCell.map(b => String(b.id));
    const without = base.filter(id => id !== String(dragId));
    const ti = without.indexOf(String(targetBlock.id));
    if (ti === -1) {
      setDragId(null);
      setDragOverId(null);
      return;
    }
    const next = [...without];
    next.splice(ti, 0, String(dragId));
    setSlotOrders(prev => ({
      ...prev,
      [k]: next
    }));
    setDragId(null);
    setDragOverId(null);
    if (onReorderSlot) onReorderSlot(next);
  }
  function onCardDragEnd() {
    setDragId(null);
    setDragOverId(null);
  }
  const wb = weekBounds(selectedDate);
  const printDays = Array.from({
    length: 7
  }, (_, i) => {
    const d = new Date(wb.start);
    d.setDate(wb.start.getDate() + i);
    const ds = toDateStr(d);
    return {
      date: d,
      ds,
      items: sessionsForDate(ds)
    };
  });

  // Full-width agenda: 7 equal day columns fill the screen, one row per hour.
  // Sessions stack vertically inside each day-hour cell, so a busy slot grows
  // downward instead of forcing a horizontal scrollbar. Each card lays its
  // details out on separate lines.
  const showPoolBadge = !selectedPoolId && pools.length > 1;
  const startHour = Math.floor(gridBounds.startMin / 60) * 60;
  const hours = [];
  for (let h = startHour; h < gridBounds.endMin; h += 60) hours.push(h);
  const weekGrid = /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "pool-tabs"
  }, /*#__PURE__*/React.createElement("button", {
    className: `pool-tab ${selectedPoolId === null ? 'active' : ''}`,
    onClick: () => setSelectedPoolId(null)
  }, "All"), pools.map(p => /*#__PURE__*/React.createElement("button", {
    key: p.id,
    className: `pool-tab ${selectedPoolId === p.id ? 'active' : ''}`,
    onClick: () => setSelectedPoolId(p.id)
  }, p.name, " ", /*#__PURE__*/React.createElement("span", {
    className: "pool-tab-cap"
  }, "cap ", p.capacity_total)))), /*#__PURE__*/React.createElement("div", {
    className: "wagenda"
  }, /*#__PURE__*/React.createElement("div", {
    className: "wa-corner"
  }), DAYS_S.map((d, di) => {
    const dateObj = new Date(wb.start);
    dateObj.setDate(wb.start.getDate() + di);
    const dateStr = dateObj.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric'
    });
    return /*#__PURE__*/React.createElement("div", {
      key: 'head' + di,
      className: "wa-dayhead"
    }, /*#__PURE__*/React.createElement("button", {
      className: "week-day-link",
      onClick: () => onJumpToDay(di),
      title: `Open ${DAYS_F[di]} daily view`
    }, /*#__PURE__*/React.createElement("div", null, d), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '10px',
        fontWeight: 600,
        color: '#94A3B8'
      }
    }, dateStr)), isFutureSelectedWeek ? /*#__PURE__*/React.createElement("button", {
      className: "week-clear-btn",
      onClick: e => {
        e.stopPropagation();
        onClearDay(di);
      }
    }, "Remove all") : /*#__PURE__*/React.createElement("div", {
      className: "week-clear-placeholder"
    }, "Protected"));
  }), hours.map(h => /*#__PURE__*/React.createElement(React.Fragment, {
    key: h
  }, /*#__PURE__*/React.createElement("div", {
    className: "wa-time"
  }, hourLabel(h)), DAYS_S.map((_, di) => {
    const rawCell = weekBlocks[di].packed.filter(b => b.startMinute >= h && b.startMinute < h + 60);
    const orderedCell = applySlotOrder(rawCell, di, h);
    return /*#__PURE__*/React.createElement("div", {
      key: di + '-' + h,
      className: `wa-cell ${pendingMove ? 'wa-cell-targetable' : ''}`,
      onClick: () => {
        if (pendingMove) {
          onPlacePendingMove && onPlacePendingMove(di, slotToMinute(minuteToSlot(h)));
        } else {
          onAdd(di, minuteToSlot(h), selectedPoolId || undefined);
        }
      }
    }, orderedCell.map(block => /*#__PURE__*/React.createElement(AgendaCard, {
      key: block.id,
      block: block,
      colorsFor: colorsFor,
      lessonTypeByName: lessonTypeByName,
      poolById: poolById,
      showPoolBadge: showPoolBadge,
      onEdit: onEdit,
      trialStudentIds: trialStudentIds,
      trialByLessonType: trialByLessonType,
      creditByKey: creditByKey,
      isDraggable: rawCell.length > 1,
      isDragging: String(dragId) === String(block.id),
      isDragOver: String(dragOverId) === String(block.id),
      isHighlighted: highlightedSessionId && String(highlightedSessionId) === String(block.id),
      onDragStartCard: e => onCardDragStart(e, block, rawCell, di, h),
      onDragOverCard: e => onCardDragOver(e, block),
      onDropCard: e => onCardDrop(e, block, rawCell, di, h),
      onDragEndCard: onCardDragEnd
    })));
  })))));
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "card print-target",
    style: {
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "view-head"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "view-title"
  }, "Weekly View"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, "Pool shown as a badge \u2014 use the pool tabs to focus one pool. Busy days widen and scroll sideways; the time axis stays pinned."))), /*#__PURE__*/React.createElement(PeriodNav, {
    rangeLabel: weekRangeLabel(selectedWeekStart),
    onPrev: onPrevWeek,
    onNext: onNextWeek,
    onToday: onThisWeek,
    isCurrent: selectedWeekStart === currentWeekStart
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary small-btn",
    onClick: onDuplicateWeek,
    disabled: !isFutureSelectedWeek
  }, "Duplicate Previous Week"), /*#__PURE__*/React.createElement("div", {
    className: "print-wrap"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-print small-btn",
    onClick: () => setPrintMenu(v => !v)
  }, "Print ", /*#__PURE__*/React.createElement("span", {
    className: "caret"
  }, "\u25BE")), printMenu ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "menu-backdrop",
    onClick: () => setPrintMenu(false)
  }), /*#__PURE__*/React.createElement("div", {
    className: "drop-menu"
  }, /*#__PURE__*/React.createElement("button", {
    className: "drop-item",
    onClick: () => {
      setPrintMenu(false);
      printWeeklyView();
    }
  }, "Weekly rundown ", /*#__PURE__*/React.createElement("span", {
    className: "drop-hint"
  }, "A4 \xB7 per-day list")), /*#__PURE__*/React.createElement("button", {
    className: "drop-item",
    onClick: () => {
      setPrintMenu(false);
      printWeeklyTable();
    }
  }, "Weekly grid ", /*#__PURE__*/React.createElement("span", {
    className: "drop-hint"
  }, "A3 \xB7 time table")))) : null), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-print small-btn",
    onClick: onExportExcel,
    title: "Download this week as a multi-tab attendance roster"
  }, "Export Excel")), /*#__PURE__*/React.createElement("div", {
    className: "nav-note"
  }, isFutureSelectedWeek ? 'Future week — "Remove all classes" and "Duplicate Previous Week" are enabled.' : 'Current and past weeks are protected from bulk removal.'), /*#__PURE__*/React.createElement("div", {
    className: "legend-bar legend-bar-v",
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "legend-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "legend-label"
  }, "Types"), /*#__PURE__*/React.createElement("div", {
    className: "legend"
  }, activeLessonTypes.map(t => {
    const c = colorsFor(t.name);
    const on = isTypeEnabled(t.name);
    return /*#__PURE__*/React.createElement("button", {
      key: t.id || t.name,
      className: `chip chip-toggle ${on ? '' : 'chip-off'}`,
      style: on ? {
        background: c.bg,
        borderColor: c.bd,
        color: c.tx
      } : undefined,
      onClick: () => onToggleType(t.name),
      title: on ? 'Showing — click to hide' : 'Hidden — click to show'
    }, t.name);
  })), /*#__PURE__*/React.createElement("button", {
    className: `legend-allbtn ${allTypesShown ? '' : 'is-off'}`,
    onClick: onToggleAllTypes
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot"
  }), allTypesShown ? 'Hide all' : 'Show all')), /*#__PURE__*/React.createElement("div", {
    className: "legend-row legend-row-instructors"
  }, /*#__PURE__*/React.createElement("span", {
    className: "legend-label"
  }, "Instructors"), /*#__PURE__*/React.createElement("div", {
    className: "legend"
  }, (activeInstructors || []).length === 0 ? /*#__PURE__*/React.createElement("span", {
    className: "small subtle"
  }, "No instructors") : (activeInstructors || []).map(inst => {
    const on = isInstructorActive(inst.id);
    const gIcon = inst.gender === 'female' ? '♀' : inst.gender === 'male' ? '♂' : '';
    return /*#__PURE__*/React.createElement("button", {
      key: inst.id,
      className: `chip chip-instructor ${on ? 'is-on' : ''}`,
      onClick: () => onToggleInstructor(inst.id),
      title: on ? `Filtering — click to remove ${inst.name}` : `Click to filter to ${inst.name}'s classes`
    }, gIcon ? /*#__PURE__*/React.createElement("span", {
      className: "inst-chip-g",
      "aria-hidden": "true"
    }, gIcon) : null, inst.name);
  })), /*#__PURE__*/React.createElement("button", {
    className: `legend-allbtn ${instructorFilterActive ? '' : 'is-off'}`,
    onClick: onClearInstructors,
    disabled: !instructorFilterActive,
    title: instructorFilterActive ? 'Remove instructor filter' : 'No instructor filter active'
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot"
  }), instructorFilterActive ? 'Clear' : 'No filter'))), pendingMove && /*#__PURE__*/React.createElement("div", {
    className: "pending-move-banner"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pending-move-icon",
    "aria-hidden": "true"
  }, "\uD83D\uDCC5"), /*#__PURE__*/React.createElement("div", {
    className: "pending-move-text"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pending-move-title"
  }, "Pick a slot to place ", pendingMove.lessonTypeName), /*#__PURE__*/React.createElement("div", {
    className: "pending-move-sub"
  }, "Moving from ", /*#__PURE__*/React.createElement("strong", null, pendingMove.sourceLabel), " \xB7 ", pendingMove.swimmerCount, " swimmer", pendingMove.swimmerCount === 1 ? '' : 's', " \u2014 click any time-cell in the grid below.")), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "btn btn-ghost small",
    onClick: onCancelPendingMove
  }, "Cancel move")), (weekPendingReplacements || []).length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "pending-repl-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pending-repl-head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "pending-repl-badge",
    "aria-hidden": "true"
  }, "R"), /*#__PURE__*/React.createElement("div", {
    className: "pending-repl-title"
  }, "Pending Replacements \xB7 ", weekPendingReplacements.length)), /*#__PURE__*/React.createElement("div", {
    className: "pending-repl-grid"
  }, weekPendingReplacements.map(p => {
    const stu = studentById ? studentById[p.student_id] : null;
    const lt = lessonTypeById ? lessonTypeById(p.lesson_type_id) : null;
    const stillExists = (props.weekBlocks || []).some(day => (day.packed || []).some(b => b.id === p.original_session_id));
    const datePassed = p.week_start_date && p.week_start_date < new Date().toISOString().slice(0, 10);
    return /*#__PURE__*/React.createElement("div", {
      key: p.id,
      className: `pending-repl-chip${datePassed ? ' repl-chip-passed' : ''}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "repl-chip-name"
    }, stu ? stu.name : '?', stu?.age != null ? /*#__PURE__*/React.createElement("span", {
      className: "repl-chip-age"
    }, " ", stu.age, "y") : null), /*#__PURE__*/React.createElement("div", {
      className: "repl-chip-meta"
    }, lt ? lt.name : '—', " \xB7 ", p.original_session_label || '?'), datePassed && /*#__PURE__*/React.createElement("div", {
      className: "repl-chip-warn"
    }, "\u26A0 past date"), !stillExists && /*#__PURE__*/React.createElement("div", {
      className: "repl-chip-warn"
    }, "\u26A0 slot deleted"), /*#__PURE__*/React.createElement("button", {
      type: "button",
      className: "repl-chip-btn",
      onClick: () => onCancelPendingReplacement && onCancelPendingReplacement(p, {
        restore: true
      }),
      title: stillExists ? `Cancel — restore to ${p.original_session_label}` : 'Original class deleted — clear limbo only'
    }, stillExists ? 'Restore' : 'Clear'));
  }))), weekGrid), /*#__PURE__*/React.createElement("div", {
    className: "print-rundown"
  }, /*#__PURE__*/React.createElement("div", {
    className: "print-title"
  }, "Weekly Daily Rundown", props.branchLabel ? ` — ${props.branchLabel}` : ''), /*#__PURE__*/React.createElement("div", {
    className: "print-meta"
  }, wb.start.toLocaleDateString(), " to ", wb.end.toLocaleDateString()), printDays.map(({
    date,
    ds,
    items
  }) => /*#__PURE__*/React.createElement("div", {
    className: "print-day",
    key: ds
  }, /*#__PURE__*/React.createElement("h3", null, date.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })), /*#__PURE__*/React.createElement("table", null, /*#__PURE__*/React.createElement("tbody", null, items.length ? items.map(it => {
    const instLabel = it.instructors.map(i => i.name).join(', ') || it.legacyInstructor || '-';
    return /*#__PURE__*/React.createElement("tr", {
      key: it.id
    }, /*#__PURE__*/React.createElement("td", {
      className: "print-time-col"
    }, formatRange(it.startMinute, it.durationMinutes)), /*#__PURE__*/React.createElement("td", {
      className: "print-type-col"
    }, it.type), /*#__PURE__*/React.createElement("td", {
      className: "print-inst-col"
    }, instLabel), /*#__PURE__*/React.createElement("td", {
      className: "print-stu-col"
    }, it.students.length ? it.students.map(s => /*#__PURE__*/React.createElement("div", {
      key: s.id || s.name,
      className: "print-stu-name"
    }, studentLabel(s))) : /*#__PURE__*/React.createElement("span", {
      style: {
        color: '#aaa'
      }
    }, "-")));
  }) : /*#__PURE__*/React.createElement("tr", {
    className: "empty-row"
  }, /*#__PURE__*/React.createElement("td", {
    colSpan: "4"
  }, "No sessions"))))))), /*#__PURE__*/React.createElement(PrintWeeklyTableSection, {
    weekBlocksAllPools: weekBlocksAllPools,
    wb: wb,
    selectedWeekStart: selectedWeekStart,
    gridSlots: gridSlots,
    gridBounds: gridBounds,
    slotToMinute: slotToMinute,
    poolById: poolById,
    branchLabel: props.branchLabel
  }));
}

// M2.2: agenda card — a static, full-width card inside a day-hour cell. Details
// stack on separate lines; the student list wraps to use vertical space.
function AgendaCard({
  block,
  colorsFor,
  lessonTypeByName,
  poolById,
  showPoolBadge,
  onEdit,
  trialStudentIds,
  trialByLessonType,
  creditByKey,
  isDraggable,
  isDragging,
  isDragOver,
  isHighlighted,
  onDragStartCard,
  onDragOverCard,
  onDropCard,
  onDragEndCard
}) {
  const c = colorsFor(block.type);
  const lt = lessonTypeByName(block.type);
  const cap = sessionCapacity(block, lt);
  const chip = capacityChipColors(cap.status);
  const pool = poolById(block.poolId);
  const isOver = cap.status === 'over';
  const missingInst = block.instructors.length === 0;
  const instName = block.instructors[0]?.name || block.legacyInstructor || '';
  const isPersonal = lessonTypeByName(block.type)?.class_type === 'personal';
  const isRescheduled = block.rescheduledFromDay != null;
  const isCancelled = !!block.cancelledAt;
  // Trial flag is per-lesson-type: only fires if the swimmer's enrollment
  // matches this card's lesson type. Falls back to the global set if no map
  // is passed (defensive — shouldn't happen in normal mount path).
  const trialSet = trialByLessonType && block.lessonTypeId ? trialByLessonType[block.lessonTypeId] : trialStudentIds;
  // Cancelled session — greyed-out shell. Clicking calls onEdit which
  // detects the cancelled state and routes to restore. Don't render
  // capacity, students, or instructor details — they're misleading
  // on a class that didn't happen.
  if (isCancelled) {
    const reasonLabel = block.cancelledReason === 'forwarded' ? 'Forwarded → next week' : block.cancelledReason === 'rescheduled' ? 'Rescheduled — moved' : 'Cancelled';
    return /*#__PURE__*/React.createElement("div", {
      className: "wa-card wa-card-cancelled",
      onClick: e => {
        e.stopPropagation();
        onEdit(block);
      },
      title: "Click to restore this session to its original slot"
    }, /*#__PURE__*/React.createElement("div", {
      className: "wa-card-head"
    }, /*#__PURE__*/React.createElement("span", {
      className: "wa-card-title wa-card-title-strike"
    }, block.type), /*#__PURE__*/React.createElement("span", {
      className: "wa-cancelled-tag"
    }, reasonLabel)), /*#__PURE__*/React.createElement("div", {
      className: "wa-card-line wa-card-strike"
    }, compactRange(block.startMinute, block.durationMinutes), instName ? ` · ${instName}` : ''), /*#__PURE__*/React.createElement("div", {
      className: "wa-card-restore-hint"
    }, "Click to restore"));
  }
  return /*#__PURE__*/React.createElement("div", {
    className: `wa-card ${isOver ? 'event-over' : ''} ${missingInst ? 'wa-card-warn' : ''} ${isDragging ? 'wa-card-dragging' : ''} ${isDragOver ? 'wa-card-dragover' : ''} ${isHighlighted ? 'wa-card-highlight' : ''}`,
    draggable: isDraggable || false,
    onDragStart: onDragStartCard,
    onDragOver: onDragOverCard,
    onDrop: onDropCard,
    onDragEnd: onDragEndCard,
    onClick: e => {
      e.stopPropagation();
      onEdit(block);
    },
    style: {
      background: c.bg,
      borderLeft: `3px solid ${c.bd}`,
      color: c.tx
    }
  }, missingInst ? /*#__PURE__*/React.createElement("span", {
    className: "card-warn-corner",
    title: "No instructor assigned \u2014 needs reassignment"
  }, "\u26A0") : null, /*#__PURE__*/React.createElement("div", {
    className: "wa-card-head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "wa-card-title"
  }, block.type), cap.max > 0 ? /*#__PURE__*/React.createElement("span", {
    className: "cap-chip",
    style: {
      background: chip.bg,
      color: chip.tx,
      borderColor: chip.bd
    }
  }, cap.current, "/", cap.max) : /*#__PURE__*/React.createElement("span", {
    className: "cap-chip cap-chip-unknown"
  }, cap.current)), /*#__PURE__*/React.createElement("div", {
    className: "wa-card-line"
  }, showPoolBadge && pool ? /*#__PURE__*/React.createElement("span", {
    className: "event-pool-pill"
  }, pool.name) : null, compactRange(block.startMinute, block.durationMinutes), isRescheduled ? /*#__PURE__*/React.createElement("span", {
    className: "reschedule-tag",
    title: `Rescheduled — was ${DAYS_S[block.rescheduledFromDay]} ${minuteToTime(block.rescheduledFromStartMinute)}`
  }, "\u21C4") : null), /*#__PURE__*/React.createElement("div", {
    className: `wa-card-line wa-card-inst ${missingInst ? 'inst-missing' : ''}`
  }, missingInst ? /*#__PURE__*/React.createElement("span", {
    className: "warn-tri",
    title: "Instructor was removed \u2014 pick a new one in the modal"
  }, "\u26A0") : null, /*#__PURE__*/React.createElement("span", {
    className: missingInst ? 'inst-orphan' : ''
  }, instName || 'Unassigned'), missingInst ? /*#__PURE__*/React.createElement("span", {
    className: "inst-warn-chip"
  }, "Needs instructor") : null), block.students.length ? /*#__PURE__*/React.createElement("div", {
    className: "wa-card-students"
  }, block.students.map((s, i) => {
    const isTrial = !!(s.studentId && trialSet && trialSet.has(s.studentId));
    const isRepl = s.isReplacement;
    const bal = s.studentId && creditByKey ? creditByKey[`${s.studentId}:${block.lessonTypeId}`] : null;
    return /*#__PURE__*/React.createElement("span", {
      key: s.id || i,
      className: `wa-stu ${isRepl ? 'wa-stu-repl' : ''}`,
      title: studentLabel(s) + (isTrial ? ' (trial)' : '') + (isRepl ? ` replacing from ${replFromLabel(s.replacementFrom) || '?'}` : '')
    }, isRepl ? /*#__PURE__*/React.createElement("span", {
      className: "repl-mark"
    }, "R") : null, clip22(s.name) + ageSuffix(s), isTrial ? /*#__PURE__*/React.createElement("span", {
      className: "trial-mark"
    }, " (trial)") : null, bal ? /*#__PURE__*/React.createElement("span", {
      className: `credit-mark ${bal.remaining_balance <= 2 ? 'credit-low' : ''}`
    }, " \xB7 ", bal.remaining_balance, "cr") : null, s.remark ? ` — ${s.remark}` : '');
  })) : /*#__PURE__*/React.createElement("div", {
    className: "wa-card-line wa-card-students-empty"
  }, "\u2014"));
}

// ============================================================================
// DailyView (M2: pool labels on each session)
// ============================================================================

function DailyView({
  selectedDate,
  setSelectedDate,
  sessionsForDate,
  colorsFor,
  lessonTypeByName,
  poolById,
  branchLabel,
  onAddAtTime,
  onEdit,
  selectedWeekStart,
  currentWeekStart,
  onPrevWeek,
  onNextWeek,
  onThisWeek,
  onExportExcel,
  activeLessonTypes,
  isTypeEnabled,
  onToggleType,
  onToggleAllTypes,
  allTypesShown,
  activeInstructors,
  isInstructorActive,
  onToggleInstructor,
  onClearInstructors,
  instructorFilterActive,
  trialStudentIds,
  trialByLessonType,
  creditByKey,
  onReorderSlot
}) {
  const wb = weekBounds(selectedDate);
  const weekDays = Array.from({
    length: 7
  }, (_, i) => {
    const d = new Date(wb.start);
    d.setDate(wb.start.getDate() + i);
    return {
      date: d,
      ds: toDateStr(d),
      idx: i
    };
  });
  const items = sessionsForDate(selectedDate);
  const hourStarts = Array.from({
    length: 13
  }, (_, i) => 480 + i * 60);

  // ── Slot drag-to-reorder (same pattern as WeekView) ────────────────
  const [dailyDragId, setDailyDragId] = useState(null);
  const [dailyDragOverId, setDailyDragOverId] = useState(null);
  const [dailySlotOrders, setDailySlotOrders] = useState({});
  function dailySlotKey(start) {
    return `${selectedDate}:${start}`;
  }
  function applyDailyOrder(rawItems, start) {
    if (rawItems.length <= 1) return rawItems;
    const custom = dailySlotOrders[dailySlotKey(start)];
    if (!custom || !custom.length) return rawItems;
    const rank = new Map(custom.map((id, i) => [String(id), i]));
    return [...rawItems].sort((a, b) => (rank.has(String(a.id)) ? rank.get(String(a.id)) : 9999) - (rank.has(String(b.id)) ? rank.get(String(b.id)) : 9999));
  }
  function onDailyDragStart(e, it, rawItems, start) {
    e.stopPropagation();
    setDailyDragId(it.id);
    const k = dailySlotKey(start);
    if (!dailySlotOrders[k]) setDailySlotOrders(prev => ({
      ...prev,
      [k]: rawItems.map(s => String(s.id))
    }));
    e.dataTransfer.effectAllowed = 'move';
  }
  function onDailyDragOver(e, it) {
    e.preventDefault();
    e.stopPropagation();
    if (String(dailyDragOverId) !== String(it.id)) setDailyDragOverId(it.id);
  }
  function onDailyDrop(e, targetIt, rawItems, start) {
    e.preventDefault();
    e.stopPropagation();
    if (!dailyDragId || String(dailyDragId) === String(targetIt.id)) {
      setDailyDragId(null);
      setDailyDragOverId(null);
      return;
    }
    const k = dailySlotKey(start);
    const base = dailySlotOrders[k] || rawItems.map(s => String(s.id));
    const without = base.filter(id => id !== String(dailyDragId));
    const ti = without.indexOf(String(targetIt.id));
    if (ti === -1) {
      setDailyDragId(null);
      setDailyDragOverId(null);
      return;
    }
    const next = [...without];
    next.splice(ti, 0, String(dailyDragId));
    setDailySlotOrders(prev => ({
      ...prev,
      [k]: next
    }));
    setDailyDragId(null);
    setDailyDragOverId(null);
    if (onReorderSlot) onReorderSlot(next);
  }
  function onDailyDragEnd() {
    setDailyDragId(null);
    setDailyDragOverId(null);
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "grid"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card no-print"
  }, /*#__PURE__*/React.createElement("div", {
    className: "view-head"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "view-title"
  }, "Daily View"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, "Hour-by-hour for the selected day. Every hour is shown even when empty."))), /*#__PURE__*/React.createElement(PeriodNav, {
    rangeLabel: weekRangeLabel(selectedWeekStart),
    onPrev: onPrevWeek,
    onNext: onNextWeek,
    onToday: onThisWeek,
    isCurrent: selectedWeekStart === currentWeekStart
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-print",
    onClick: () => printDailyView(selectedDate)
  }, "Print"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-print",
    onClick: onExportExcel,
    title: "Download this week as a multi-tab attendance roster"
  }, "Export Excel")), /*#__PURE__*/React.createElement("div", {
    className: "nav-note"
  }, "Showing ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: 'var(--text)'
    }
  }, longDate(selectedDate))), /*#__PURE__*/React.createElement("div", {
    className: "daily-day-tabs"
  }, weekDays.map(({
    date,
    ds,
    idx
  }) => /*#__PURE__*/React.createElement("button", {
    key: ds,
    className: `daily-day-tab ${selectedDate === ds ? 'active' : ''}`,
    onClick: () => setSelectedDate(ds)
  }, DAYS_S[idx], " \xB7 ", date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  })))), /*#__PURE__*/React.createElement("div", {
    className: "legend-bar legend-bar-v",
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "legend-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "legend-label"
  }, "Types"), /*#__PURE__*/React.createElement("div", {
    className: "legend"
  }, (activeLessonTypes || []).map(t => {
    const c = colorsFor(t.name);
    const on = isTypeEnabled(t.name);
    return /*#__PURE__*/React.createElement("button", {
      key: t.id || t.name,
      className: `chip chip-toggle ${on ? '' : 'chip-off'}`,
      style: on ? {
        background: c.bg,
        borderColor: c.bd,
        color: c.tx
      } : undefined,
      onClick: () => onToggleType(t.name),
      title: on ? 'Showing — click to hide' : 'Hidden — click to show'
    }, t.name);
  })), /*#__PURE__*/React.createElement("button", {
    className: `legend-allbtn ${allTypesShown ? '' : 'is-off'}`,
    onClick: onToggleAllTypes
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot"
  }), allTypesShown ? 'Hide all' : 'Show all')), /*#__PURE__*/React.createElement("div", {
    className: "legend-row legend-row-instructors"
  }, /*#__PURE__*/React.createElement("span", {
    className: "legend-label"
  }, "Instructors"), /*#__PURE__*/React.createElement("div", {
    className: "legend"
  }, (activeInstructors || []).length === 0 ? /*#__PURE__*/React.createElement("span", {
    className: "small subtle"
  }, "No instructors") : (activeInstructors || []).map(inst => {
    const on = isInstructorActive(inst.id);
    const gIcon = inst.gender === 'female' ? '♀' : inst.gender === 'male' ? '♂' : '';
    return /*#__PURE__*/React.createElement("button", {
      key: inst.id,
      className: `chip chip-instructor ${on ? 'is-on' : ''}`,
      onClick: () => onToggleInstructor(inst.id),
      title: on ? `Filtering — click to remove ${inst.name}` : `Click to filter to ${inst.name}'s classes`
    }, gIcon ? /*#__PURE__*/React.createElement("span", {
      className: "inst-chip-g",
      "aria-hidden": "true"
    }, gIcon) : null, inst.name);
  })), /*#__PURE__*/React.createElement("button", {
    className: `legend-allbtn ${instructorFilterActive ? '' : 'is-off'}`,
    onClick: onClearInstructors,
    disabled: !instructorFilterActive
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot"
  }), instructorFilterActive ? 'Clear' : 'No filter'))), /*#__PURE__*/React.createElement("div", {
    className: "daily-grid"
  }, hourStarts.map(start => {
    const rawItems = items.filter(it => it.startMinute >= start && it.startMinute < start + 60);
    const rowItems = applyDailyOrder(rawItems, start);
    return /*#__PURE__*/React.createElement("div", {
      className: "daily-row",
      key: start
    }, /*#__PURE__*/React.createElement("div", {
      className: "daily-time"
    }, minuteToTime(start)), /*#__PURE__*/React.createElement("div", {
      className: `daily-slot ${rowItems.length ? '' : 'empty'}`
    }, rowItems.length ? /*#__PURE__*/React.createElement("div", {
      className: "daily-sessions"
    }, rowItems.map(it => {
      const c = colorsFor(it.type);
      const lt = lessonTypeByName(it.type);
      const cap = sessionCapacity(it, lt);
      const chip = capacityChipColors(cap.status);
      const pool = poolById(it.poolId);
      const missingInst = it.instructors.length === 0;
      const instName = it.instructors[0]?.name || it.legacyInstructor || '';
      const isPersonalIt = lessonTypeByName(it.type)?.class_type === 'personal';
      const isRescheduledIt = it.rescheduledFromDay != null;
      const isBeingDragged = String(dailyDragId) === String(it.id);
      const isDropTarget = String(dailyDragOverId) === String(it.id);
      return /*#__PURE__*/React.createElement("div", {
        key: it.id,
        className: `daily-event ${missingInst ? 'daily-event-warn' : ''} ${isBeingDragged ? 'daily-event-dragging' : ''} ${isDropTarget ? 'daily-event-dragover' : ''}`,
        onDragOver: e => onDailyDragOver(e, it),
        onDrop: e => onDailyDrop(e, it, rawItems, start),
        onDragEnd: onDailyDragEnd,
        onClick: () => onEdit(it),
        style: {
          background: c.bg,
          borderLeftColor: c.bd,
          color: c.tx
        }
      }, rawItems.length > 1 && /*#__PURE__*/React.createElement("div", {
        className: "daily-drag-handle",
        draggable: true,
        onDragStart: e => onDailyDragStart(e, it, rawItems, start),
        onClick: e => e.stopPropagation(),
        title: "Drag to reorder"
      }, "\u283F"), missingInst ? /*#__PURE__*/React.createElement("span", {
        className: "card-warn-corner",
        title: "No instructor assigned \u2014 needs reassignment"
      }, "\u26A0") : null, /*#__PURE__*/React.createElement("div", {
        className: "daily-event-top"
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          minWidth: 0,
          flex: 1
        }
      }, /*#__PURE__*/React.createElement("div", {
        className: "daily-event-title",
        style: {
          color: c.tx
        }
      }, it.type, " ", pool ? /*#__PURE__*/React.createElement("span", {
        className: "pool-badge"
      }, pool.name) : null, it.familyGroupId ? /*#__PURE__*/React.createElement("span", {
        title: "Family group booking",
        style: {
          marginLeft: 4
        }
      }, "\uD83D\uDC6A") : null, isRescheduledIt ? /*#__PURE__*/React.createElement("span", {
        className: "reschedule-tag",
        title: `Rescheduled — was ${DAYS_S[it.rescheduledFromDay]} ${minuteToTime(it.rescheduledFromStartMinute)}`
      }, " \u21C4") : null), /*#__PURE__*/React.createElement("div", {
        className: `daily-event-sub ${missingInst ? 'inst-missing' : ''}`
      }, compactRange(it.startMinute, it.durationMinutes), " \xB7 ", missingInst ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
        className: "warn-tri"
      }, "\u26A0"), /*#__PURE__*/React.createElement("span", {
        className: "inst-orphan"
      }, instName || 'Unassigned'), /*#__PURE__*/React.createElement("span", {
        className: "inst-warn-chip"
      }, "Needs instructor")) : instName || '—'), it.students.length ? (() => {
        // Per-session trial set: only swimmers whose
        // enrolment includes THIS lesson type flag as
        // trial. Falls back to global set defensively.
        const trialSet = trialByLessonType && it.lessonTypeId ? trialByLessonType[it.lessonTypeId] : trialStudentIds;
        return /*#__PURE__*/React.createElement("div", {
          className: "daily-event-students"
        }, it.students.map((s, si) => {
          const isTrial = !!(s.studentId && trialSet && trialSet.has(s.studentId));
          const isRepl = s.isReplacement;
          const bal = s.studentId && creditByKey ? creditByKey[`${s.studentId}:${it.lessonTypeId}`] : null;
          return /*#__PURE__*/React.createElement("span", {
            key: s.id || si,
            className: `daily-event-stu ${isRepl ? 'daily-stu-repl' : ''}`,
            title: isRepl ? `Replacement from ${replFromLabel(s.replacementFrom) || '?'}` : undefined
          }, isRepl ? /*#__PURE__*/React.createElement("span", {
            className: "repl-mark-sm"
          }, "R") : null, s.name + ageSuffix(s), isTrial ? /*#__PURE__*/React.createElement("span", {
            className: "trial-mark"
          }, " (trial)") : null, bal ? /*#__PURE__*/React.createElement("span", {
            className: `credit-mark ${bal.remaining_balance <= 2 ? 'credit-low' : ''}`
          }, " \xB7 ", bal.remaining_balance, "cr") : null);
        }));
      })() : /*#__PURE__*/React.createElement("div", {
        className: "daily-event-sub"
      }, "No students listed"), it.students.filter(s => s.remark).map((s, ri) => /*#__PURE__*/React.createElement("div", {
        key: ri,
        className: "daily-event-note"
      }, "\uD83D\uDCDD ", shortName(s.name), ": ", s.remark))), /*#__PURE__*/React.createElement("div", {
        style: {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 6
        }
      }, cap.max > 0 ? /*#__PURE__*/React.createElement("span", {
        className: "cap-chip cap-chip-lg",
        style: {
          background: chip.bg,
          color: chip.tx,
          borderColor: chip.bd
        }
      }, cap.current, "/", cap.max) : /*#__PURE__*/React.createElement("span", {
        className: "cap-chip cap-chip-lg cap-chip-unknown"
      }, cap.current))));
    })) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      className: "small subtle"
    }, "No sessions"), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-secondary small-btn",
      onClick: () => onAddAtTime(dateToWeekdayIndex(selectedDate), start)
    }, "Add Session")), rowItems.length ? /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        justifyContent: 'flex-end',
        marginTop: 8
      }
    }, /*#__PURE__*/React.createElement("button", {
      className: "btn btn-secondary small-btn",
      onClick: () => onAddAtTime(dateToWeekdayIndex(selectedDate), start)
    }, "Add Session")) : null));
  }), /*#__PURE__*/React.createElement("div", {
    className: "daily-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "daily-time"
  }, minuteToTime(1260)), /*#__PURE__*/React.createElement("div", {
    className: "daily-slot empty"
  }, /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, "Day end marker"))))), /*#__PURE__*/React.createElement("div", {
    className: "print-daily"
  }, /*#__PURE__*/React.createElement("div", {
    className: "print-daily-heading"
  }, "Daily Schedule", branchLabel ? ` — ${branchLabel}` : ''), /*#__PURE__*/React.createElement("div", {
    className: "print-daily-date"
  }, longDate(selectedDate)), /*#__PURE__*/React.createElement("table", {
    className: "print-daily-table"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    className: "print-th-time"
  }, "Time"), /*#__PURE__*/React.createElement("th", {
    className: "print-th-detail"
  }, "Session Details"))), /*#__PURE__*/React.createElement("tbody", null, hourStarts.map(start => {
    const rowItems = items.filter(it => it.startMinute >= start && it.startMinute < start + 60);
    return /*#__PURE__*/React.createElement("tr", {
      key: `p-${start}`
    }, /*#__PURE__*/React.createElement("td", {
      className: "print-time-cell"
    }, shortTime(start)), /*#__PURE__*/React.createElement("td", {
      className: "print-detail-cell"
    }, rowItems.length ? /*#__PURE__*/React.createElement("div", {
      className: "print-day-cols"
    }, [0, 1, 2].map(col => {
      const it = rowItems[col];
      if (!it) return /*#__PURE__*/React.createElement("div", {
        key: col,
        className: "print-day-col print-day-col-empty"
      });
      const pool = poolById(it.poolId);
      const inst = it.instructors.map(i => i.name).join(', ') || it.legacyInstructor || '';
      const meta = [pool ? pool.name : '', inst].filter(Boolean).join(' · ');
      return /*#__PURE__*/React.createElement("div", {
        key: it.id,
        className: "print-day-col"
      }, /*#__PURE__*/React.createElement("div", {
        className: "print-session-head"
      }, shortRange(it.startMinute, it.durationMinutes), " \xB7 ", it.type), meta && /*#__PURE__*/React.createElement("div", {
        className: "print-session-meta"
      }, meta), /*#__PURE__*/React.createElement("div", {
        className: "print-session-students"
      }, it.students.length ? it.students.map((s, i) => /*#__PURE__*/React.createElement("div", {
        key: i,
        className: "print-student-name"
      }, studentLabel(s))) : /*#__PURE__*/React.createElement("div", {
        className: "print-student-name print-student-empty"
      }, "No students")));
    })) : /*#__PURE__*/React.createElement("span", {
      className: "print-no-session"
    }, "\u2014")));
  })))));
}

// ============================================================================
// MonthView (unchanged from M1)
// ============================================================================

function MonthView({
  monthCursor,
  setMonthCursor,
  selectedDate,
  setSelectedDate,
  monthDates,
  sessionsForDate,
  colorsFor,
  remarks,
  remarkDraft,
  setRemarkDraft,
  saveRemark,
  selectedItems
}) {
  const options = [];
  for (let y = 2025; y <= 2032; y++) for (let m = 0; m < 12; m++) {
    const d = new Date(y, m, 1);
    options.push(/*#__PURE__*/React.createElement("option", {
      key: `${y}-${m}`,
      value: monthKey(d)
    }, d.toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric'
    })));
  }
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 16,
      width: '100%',
      alignItems: 'flex-start'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      flex: '1 1 0',
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap',
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 18,
      fontWeight: 800
    }
  }, "Monthly Calendar"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, "Monday-first calendar. Click a day to expand the rundown below.")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 12,
      alignItems: 'center',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost",
    onClick: () => setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth() - 1, 1))
  }, "\u2190"), /*#__PURE__*/React.createElement("select", {
    className: "select",
    style: {
      width: 240
    },
    value: monthKey(monthCursor),
    onChange: e => {
      const [y, m] = e.target.value.split('-').map(Number);
      setMonthCursor(new Date(y, m - 1, 1));
    }
  }, options), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost",
    onClick: () => setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1))
  }, "\u2192"))), /*#__PURE__*/React.createElement("div", {
    className: "month-grid"
  }, DAYS_S.map(d => /*#__PURE__*/React.createElement("div", {
    key: d,
    className: "month-dow"
  }, d)), monthDates.map(d => {
    const ds = toDateStr(d),
      inMonth = d.getMonth() === monthCursor.getMonth(),
      items = sessionsForDate(ds),
      hasRemark = !!(remarks[ds] || '').trim();
    return /*#__PURE__*/React.createElement("div", {
      key: ds,
      className: `day-box ${inMonth ? '' : 'outside'} ${selectedDate === ds ? 'selected' : ''}`,
      onClick: () => setSelectedDate(ds)
    }, /*#__PURE__*/React.createElement("div", {
      className: "day-top"
    }, /*#__PURE__*/React.createElement("div", {
      className: "day-num"
    }, d.getDate()), /*#__PURE__*/React.createElement("div", {
      className: `remark-dot ${hasRemark ? 'has-content' : 'empty'}`
    }, "+remark")), /*#__PURE__*/React.createElement("div", null, items.length ? items.slice(0, 3).map(ev => {
      const c = colorsFor(ev.type);
      return /*#__PURE__*/React.createElement("div", {
        key: ev.id,
        className: "mini-item",
        style: {
          background: c.bg,
          borderLeftColor: c.bd,
          color: c.tx
        }
      }, minuteToTime(ev.startMinute), " \xB7 ", ev.type);
    }) : /*#__PURE__*/React.createElement("div", {
      className: "small subtle"
    }, "No sessions")));
  }))), /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      flex: '0 0 320px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 18,
      fontWeight: 800
    }
  }, "One-off Day Remark"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      margin: '4px 0 12px'
    }
  }, "This remark is saved only for ", /*#__PURE__*/React.createElement("b", null, longDate(selectedDate)), ". It does not recur."), /*#__PURE__*/React.createElement("textarea", {
    className: "textarea",
    value: remarkDraft,
    onChange: e => setRemarkDraft(e.target.value),
    placeholder: "Add closure note, special arrangement, replacement note, etc."
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'flex-end',
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary",
    onClick: saveRemark
  }, "Save Remark")))), /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginTop: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap',
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 18,
      fontWeight: 800
    }
  }, "Daily Rundown"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, longDate(selectedDate))), /*#__PURE__*/React.createElement("div", {
    className: "pill"
  }, "Sessions for this date in this week's schedule")), /*#__PURE__*/React.createElement("div", {
    className: "table-wrap"
  }, /*#__PURE__*/React.createElement("table", null, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      width: 130
    }
  }, "Time"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 170
    }
  }, "Lesson Type"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 160
    }
  }, "Instructor"), /*#__PURE__*/React.createElement("th", null, "Students"))), /*#__PURE__*/React.createElement("tbody", null, selectedItems.length ? selectedItems.map(g => /*#__PURE__*/React.createElement("tr", {
    key: g.id
  }, /*#__PURE__*/React.createElement("td", null, formatRange(g.startMinute, g.durationMinutes)), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, g.type)), /*#__PURE__*/React.createElement("td", null, g.instructors.map(i => i.name).join(', ') || g.legacyInstructor), /*#__PURE__*/React.createElement("td", null, g.students.map(s => s.name + ageSuffix(s)).join(', ') || '-'))) : /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    colSpan: "4",
    className: "empty"
  }, "No schedule for this day.")))))));
}

// ============================================================================
// SummaryView (M2: by-pool breakdown added)
// ============================================================================

function BranchesAdminView({
  branches,
  addBranch,
  updateBranch,
  deleteBranch
}) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [color, setColor] = useState('#0EA5E9');
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({
    name: '',
    code: '',
    color: ''
  });
  function startEdit(b) {
    setEditingId(b.id);
    setEditForm({
      name: b.name || '',
      code: b.code || '',
      color: b.color || '#0EA5E9'
    });
  }
  async function saveEdit() {
    if (!editForm.name.trim()) return;
    await updateBranch(editingId, {
      name: editForm.name.trim(),
      code: editForm.code.trim() || null,
      color: editForm.color || null
    });
    setEditingId(null);
  }
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 18,
      fontWeight: 800,
      marginBottom: 4
    }
  }, "\uD83C\uDFE2 Branches"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      marginBottom: 14
    }
  }, "Branches are administrative locations (HQ + rented pool sites). They filter Accounts, Pools, and Invoices throughout the app. Instructors, lesson types, packages, and invoice numbering are shared across all branches."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      flexWrap: 'wrap',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("input", {
    className: "input",
    style: {
      flex: '1 1 200px',
      maxWidth: 240
    },
    placeholder: "Branch name (e.g. Ipoh)",
    value: name,
    onChange: e => setName(e.target.value)
  }), /*#__PURE__*/React.createElement("input", {
    className: "input",
    style: {
      width: 120
    },
    placeholder: "Code (e.g. IPH)",
    value: code,
    onChange: e => setCode(e.target.value),
    maxLength: 8
  }), /*#__PURE__*/React.createElement("input", {
    type: "color",
    className: "input",
    style: {
      width: 64,
      padding: 2
    },
    value: color,
    onChange: e => setColor(e.target.value),
    title: "Branch tint color"
  }), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary small",
    disabled: !name.trim(),
    onClick: async () => {
      if (!name.trim()) return;
      await addBranch({
        name: name.trim(),
        code: code.trim() || null,
        color
      });
      setName('');
      setCode('');
      setColor('#0EA5E9');
    }
  }, "+ Add Branch"))), /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      padding: 0,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "table-wrap",
    style: {
      border: 'none',
      borderRadius: 0
    }
  }, /*#__PURE__*/React.createElement("table", null, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      width: '40%'
    }
  }, "Name"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: '15%'
    }
  }, "Code"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 90
    }
  }, "Color"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 100
    }
  }, "Status"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 200,
      textAlign: 'right'
    }
  }, "Actions"))), /*#__PURE__*/React.createElement("tbody", null, (branches || []).length === 0 && /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    colSpan: 5,
    className: "empty"
  }, "No branches yet. Add one above to get started.")), (branches || []).map(b => editingId === b.id ? /*#__PURE__*/React.createElement("tr", {
    key: b.id
  }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: editForm.name,
    onChange: e => setEditForm({
      ...editForm,
      name: e.target.value
    })
  })), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: editForm.code,
    onChange: e => setEditForm({
      ...editForm,
      code: e.target.value
    }),
    maxLength: 8
  })), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("input", {
    type: "color",
    className: "input",
    style: {
      width: 50,
      padding: 2
    },
    value: editForm.color,
    onChange: e => setEditForm({
      ...editForm,
      color: e.target.value
    })
  })), /*#__PURE__*/React.createElement("td", {
    className: "small subtle"
  }, b.is_active === false ? 'Archived' : 'Active'), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: 'right'
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary small",
    onClick: saveEdit,
    style: {
      marginRight: 6
    }
  }, "Save"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: () => setEditingId(null)
  }, "Cancel"))) : /*#__PURE__*/React.createElement("tr", {
    key: b.id
  }, /*#__PURE__*/React.createElement("td", {
    style: {
      fontWeight: 600
    }
  }, b.name), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'monospace',
      fontSize: 12,
      fontWeight: 600,
      color: 'var(--text-2)'
    }
  }, b.code || '—')), /*#__PURE__*/React.createElement("td", null, b.color ? /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-block',
      width: 24,
      height: 24,
      borderRadius: 6,
      background: b.color,
      border: '1px solid var(--border)'
    }
  }) : /*#__PURE__*/React.createElement("span", {
    className: "subtle"
  }, "\u2014")), /*#__PURE__*/React.createElement("td", null, b.is_active === false ? /*#__PURE__*/React.createElement("span", {
    className: "pill",
    style: {
      background: '#FEF3C7',
      color: '#92400E'
    }
  }, "Archived") : /*#__PURE__*/React.createElement("span", {
    className: "pill",
    style: {
      background: '#D1FAE5',
      color: '#065F46'
    }
  }, "Active")), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: 'right'
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: () => startEdit(b),
    style: {
      marginRight: 6
    }
  }, "\u270E Edit"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: () => updateBranch(b.id, {
      is_active: b.is_active === false
    }),
    style: {
      marginRight: 6
    }
  }, b.is_active === false ? 'Restore' : 'Archive'), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-danger small",
    onClick: () => deleteBranch(b.id)
  }, "\uD83D\uDDD1 Delete")))))))));
}
function SummaryView({
  summary,
  pools
}) {
  const typeRows = Object.entries(summary.byType).sort((a, b) => b[1] - a[1]);
  const instRows = Object.entries(summary.byInst).sort((a, b) => b[1] - a[1]);
  const poolRows = Object.entries(summary.byPool).sort((a, b) => b[1] - a[1]);
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "grid grid-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, "Total students"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 34,
      fontWeight: 800,
      color: 'var(--primary)'
    }
  }, summary.totalStudents), /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      marginTop: 6
    }
  }, "Excludes lesson types containing \"replacement\" or \"trial\".")), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, "Sessions this week"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 34,
      fontWeight: 800,
      color: 'var(--teal)'
    }
  }, summary.totalSessions)), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, "Active pools"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 34,
      fontWeight: 800,
      color: '#F59E0B'
    }
  }, pools.length))), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-3",
    style: {
      marginTop: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 18,
      fontWeight: 800,
      marginBottom: 10
    }
  }, "By Lesson Type"), /*#__PURE__*/React.createElement("div", {
    className: "table-wrap"
  }, /*#__PURE__*/React.createElement("table", null, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Lesson Type"), /*#__PURE__*/React.createElement("th", null, "Students"))), /*#__PURE__*/React.createElement("tbody", null, typeRows.map(([k, v]) => /*#__PURE__*/React.createElement("tr", {
    key: k
  }, /*#__PURE__*/React.createElement("td", null, k), /*#__PURE__*/React.createElement("td", null, v))))))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 18,
      fontWeight: 800,
      marginBottom: 10
    }
  }, "By Pool"), /*#__PURE__*/React.createElement("div", {
    className: "table-wrap"
  }, /*#__PURE__*/React.createElement("table", null, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Pool"), /*#__PURE__*/React.createElement("th", null, "Students"))), /*#__PURE__*/React.createElement("tbody", null, poolRows.map(([k, v]) => /*#__PURE__*/React.createElement("tr", {
    key: k
  }, /*#__PURE__*/React.createElement("td", null, k), /*#__PURE__*/React.createElement("td", null, v))))))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 18,
      fontWeight: 800,
      marginBottom: 10
    }
  }, "By Instructor"), /*#__PURE__*/React.createElement("div", {
    className: "table-wrap"
  }, /*#__PURE__*/React.createElement("table", null, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Instructor"), /*#__PURE__*/React.createElement("th", null, "Students"))), /*#__PURE__*/React.createElement("tbody", null, instRows.map(([k, v]) => /*#__PURE__*/React.createElement("tr", {
    key: k
  }, /*#__PURE__*/React.createElement("td", null, k), /*#__PURE__*/React.createElement("td", null, v)))))))));
}

// ============================================================================
// SettingsView (M2: pools, operating hours, expanded lesson-type editor)
// ============================================================================

function billingText(mode, count) {
  if (count === null || count === undefined || count === '') return '';
  return `${count} ${mode === 'credit' ? 'credits' : 'monthly'}`;
}
function BillingControl({
  mode,
  count,
  onMode,
  onCount
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-end',
      gap: 12,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      margin: 0
    }
  }, /*#__PURE__*/React.createElement("label", null, "Billing"), /*#__PURE__*/React.createElement("div", {
    className: "seg"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `seg-btn ${mode === 'credit' ? '' : 'on'}`,
    onClick: () => onMode('monthly')
  }, "Monthly"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `seg-btn ${mode === 'credit' ? 'on' : ''}`,
    onClick: () => onMode('credit')
  }, "Credit"))), /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      margin: 0
    }
  }, /*#__PURE__*/React.createElement("label", null, mode === 'credit' ? 'Credits' : 'Lessons per month'), /*#__PURE__*/React.createElement("div", {
    className: "suffix-input"
  }, /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "number",
    min: "0",
    value: count,
    onChange: e => onCount(e.target.value),
    placeholder: mode === 'credit' ? '6' : '4'
  }), /*#__PURE__*/React.createElement("span", {
    className: "suffix-tag"
  }, mode === 'credit' ? 'credits' : 'monthly'))));
}
function PackageEditor({
  row,
  onSave,
  onCancel
}) {
  const [name, setName] = useState(row.name || '');
  const [pax, setPax] = useState(row.pax == null ? '' : String(row.pax));
  const [amount, setAmount] = useState(row.amount == null ? '' : String(row.amount));
  const [mode, setMode] = useState(row.billing_mode === 'credit' ? 'credit' : 'monthly');
  const [count, setCount] = useState(row.billing_count == null ? '' : String(row.billing_count));
  const [isGroup, setIsGroup] = useState(!!row.is_group);
  const [fallback, setFallback] = useState(row.fallback_per_pax == null ? '' : String(row.fallback_per_pax));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width: '100%'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'minmax(0,1fr) 90px 130px',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      margin: 0
    }
  }, /*#__PURE__*/React.createElement("label", null, "Package name"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: name,
    onChange: e => setName(e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      margin: 0
    }
  }, /*#__PURE__*/React.createElement("label", null, isGroup ? 'Required pax' : 'Pax'), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "number",
    min: "1",
    value: pax,
    onChange: e => setPax(e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      margin: 0
    }
  }, /*#__PURE__*/React.createElement("label", null, isGroup ? 'Bundle total (RM)' : 'Amount (RM)'), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "number",
    min: "0",
    step: "0.01",
    value: amount,
    onChange: e => setAmount(e.target.value)
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement(BillingControl, {
    mode: mode,
    count: count,
    onMode: setMode,
    onCount: setCount
  })), /*#__PURE__*/React.createElement("label", {
    className: "gb-check",
    style: {
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: isGroup,
    onChange: e => setIsGroup(e.target.checked)
  }), " Family unit (single payer for the required pax)"), isGroup ? /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      marginTop: 8,
      maxWidth: 280
    }
  }, /*#__PURE__*/React.createElement("label", null, "Standard rate per pax if under-enrolled (RM)"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "number",
    min: "0",
    step: "0.01",
    value: fallback,
    onChange: e => setFallback(e.target.value),
    placeholder: "200"
  })) : null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'flex-end',
      gap: 8,
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: onCancel
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary small",
    onClick: () => {
      const v = name.trim();
      if (!v) return;
      onSave({
        name: v,
        pax: pax === '' ? null : Number(pax),
        amount: amount === '' ? null : Number(amount),
        billing_mode: mode,
        billing_count: count === '' ? null : Number(count),
        is_group: isGroup,
        fallback_per_pax: fallback === '' ? null : Number(fallback)
      });
    }
  }, "Save")));
}
function SettingsView({
  section,
  options,
  status,
  addOption,
  toggleOption,
  deleteOption,
  deleteInstructor,
  patchOption,
  reorderOption,
  moveOption,
  saveLessonType,
  deleteLessonType,
  lessonTypeCounts,
  codes,
  students,
  packages,
  addCode,
  updateCode,
  deleteCode
}) {
  const dragRef = React.useRef({
    canDrag: false
  });
  const [drag, setDrag] = useState({
    key: null,
    idx: null
  });
  const [over, setOver] = useState(null);
  function gripEl() {
    return /*#__PURE__*/React.createElement("span", {
      className: "grip",
      title: "Drag to reorder",
      onMouseDown: () => {
        dragRef.current.canDrag = true;
      },
      onTouchStart: () => {
        dragRef.current.canDrag = true;
      }
    }, "\u283F");
  }
  function dragProps(listKey, table, list, idx) {
    return {
      draggable: true,
      onDragStart: e => {
        if (!dragRef.current.canDrag) {
          e.preventDefault();
          return;
        }
        setDrag({
          key: listKey,
          idx
        });
        try {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(idx));
        } catch (_) {}
      },
      onDragOver: e => {
        if (drag.key !== listKey) return;
        e.preventDefault();
        if (over !== idx) setOver(idx);
      },
      onDrop: e => {
        e.preventDefault();
        if (drag.key === listKey && drag.idx != null && drag.idx !== idx) moveOption(table, list, drag.idx, idx);
        setDrag({
          key: null,
          idx: null
        });
        setOver(null);
        dragRef.current.canDrag = false;
      },
      onDragEnd: () => {
        setDrag({
          key: null,
          idx: null
        });
        setOver(null);
        dragRef.current.canDrag = false;
      }
    };
  }
  function dragClass(listKey, idx) {
    return `${drag.key === listKey && drag.idx === idx ? 'lt-dragging' : ''} ${drag.key === listKey && over === idx && drag.idx != null && drag.idx !== idx ? 'lt-drop' : ''}`;
  }
  function reorderCluster(listKey, table, list, idx) {
    return /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4
      }
    }, gripEl(), /*#__PURE__*/React.createElement("span", {
      className: "reorder"
    }, /*#__PURE__*/React.createElement("button", {
      className: "reorder-btn",
      disabled: idx === 0,
      title: "Move up",
      onClick: () => reorderOption(table, list, idx, -1)
    }, "\u2191"), /*#__PURE__*/React.createElement("button", {
      className: "reorder-btn",
      disabled: idx === list.length - 1,
      title: "Move down",
      onClick: () => reorderOption(table, list, idx, 1)
    }, "\u2193")));
  }
  const [newInstructor, setNewInstructor] = useState('');
  const [newInstructorGender, setNewInstructorGender] = useState(null);
  const [editingInstructorId, setEditingInstructorId] = useState(null);
  const [newTypeName, setNewTypeName] = useState('');
  const [bg, setBg] = useState('#DBEAFE');
  const [bd, setBd] = useState('#3B82F6');
  const [tx, setTx] = useState('#1E40AF');
  const [newPoolName, setNewPoolName] = useState('');
  const [newPoolCap, setNewPoolCap] = useState(16);
  const [editingPoolId, setEditingPoolId] = useState(null);
  const [editPoolForm, setEditPoolForm] = useState({
    name: '',
    capacity_total: 16
  });
  const [newPkgName, setNewPkgName] = useState('');
  const [newPkgPax, setNewPkgPax] = useState('');
  const [newPkgAmount, setNewPkgAmount] = useState('');
  const [newPkgMode, setNewPkgMode] = useState('monthly');
  const [newPkgCount, setNewPkgCount] = useState('');
  const [newPkgGroup, setNewPkgGroup] = useState(false);
  const [newPkgFallback, setNewPkgFallback] = useState('');
  const [editPkgId, setEditPkgId] = useState(null);
  const [pkgPanelLtId, setPkgPanelLtId] = useState(null);
  const [editingLessonId, setEditingLessonId] = useState(null);
  const counts = lessonTypeCounts || {};
  return /*#__PURE__*/React.createElement(React.Fragment, null, section === 'pools' && /*#__PURE__*/React.createElement("div", {
    className: "settings-cols",
    style: {
      gridTemplateColumns: '1fr 1fr'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 16,
      fontWeight: 800
    }
  }, "Pools"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      marginTop: 4
    }
  }, "Capacity includes every body in the water, instructors included."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      flexWrap: 'wrap',
      marginTop: 12
    }
  }, /*#__PURE__*/React.createElement("input", {
    className: "input",
    style: {
      flex: '1 1 130px'
    },
    placeholder: "Pool name",
    value: newPoolName,
    onChange: e => setNewPoolName(e.target.value)
  }), /*#__PURE__*/React.createElement("input", {
    className: "input",
    style: {
      width: 96
    },
    type: "number",
    min: "1",
    placeholder: "Cap",
    value: newPoolCap,
    onChange: e => setNewPoolCap(e.target.value)
  }), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary",
    onClick: () => {
      const v = newPoolName.trim();
      const c = Number(newPoolCap);
      if (!v || !c || c < 1) return;
      addOption('pool', {
        name: v,
        capacity: c
      });
      setNewPoolName('');
      setNewPoolCap(16);
    }
  }, "Add")), /*#__PURE__*/React.createElement("div", {
    className: "settings-list"
  }, options.pools.length ? options.pools.map((r, idx) => {
    const isEditing = editingPoolId === r.id;
    return /*#__PURE__*/React.createElement("div", _extends({
      key: r.id,
      className: `row-item ${dragClass('pool', idx)}`,
      style: isEditing ? {
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 10
      } : {}
    }, dragProps('pool', 'pools', options.pools, idx)), isEditing ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 8,
        flexWrap: 'wrap',
        alignItems: 'center'
      }
    }, /*#__PURE__*/React.createElement("input", {
      className: "input",
      style: {
        flex: '1 1 130px'
      },
      value: editPoolForm.name,
      onChange: e => setEditPoolForm({
        ...editPoolForm,
        name: e.target.value
      }),
      placeholder: "Pool name"
    }), /*#__PURE__*/React.createElement("input", {
      className: "input",
      style: {
        width: 90
      },
      type: "number",
      min: "1",
      value: editPoolForm.capacity_total,
      onChange: e => setEditPoolForm({
        ...editPoolForm,
        capacity_total: Number(e.target.value)
      }),
      placeholder: "Cap"
    }), (options.branches || []).length > 0 && /*#__PURE__*/React.createElement("select", {
      className: "select",
      style: {
        width: 140,
        padding: '4px 8px',
        fontSize: 12
      },
      value: editPoolForm.branch_id || '',
      onChange: e => setEditPoolForm({
        ...editPoolForm,
        branch_id: e.target.value || null
      })
    }, /*#__PURE__*/React.createElement("option", {
      value: ""
    }, "No branch"), (options.branches || []).filter(b => b.is_active !== false).map(b => /*#__PURE__*/React.createElement("option", {
      key: b.id,
      value: b.id
    }, b.name, b.code ? ` (${b.code})` : '')))), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 6,
        justifyContent: 'flex-end'
      }
    }, /*#__PURE__*/React.createElement("button", {
      className: "btn btn-ghost small",
      onClick: () => setEditingPoolId(null)
    }, "Cancel"), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-primary small",
      onClick: () => {
        const v = editPoolForm.name.trim();
        const c = Number(editPoolForm.capacity_total);
        if (!v || !c || c < 1) return;
        patchOption('pools', r.id, {
          name: v,
          capacity_total: c,
          branch_id: editPoolForm.branch_id || null
        });
        setEditingPoolId(null);
      }
    }, "Save"))) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap'
      }
    }, reorderCluster('pool', 'pools', options.pools, idx), /*#__PURE__*/React.createElement("span", {
      className: "pill",
      style: {
        background: r.is_active ? 'var(--primary-soft)' : '#F0F0F5',
        color: r.is_active ? 'var(--primary-on-soft)' : '#9C9CAD'
      }
    }, r.is_active ? 'Active' : 'Hidden'), /*#__PURE__*/React.createElement("div", {
      style: {
        fontWeight: 600
      }
    }, r.name), /*#__PURE__*/React.createElement("span", {
      className: "small subtle"
    }, "cap ", r.capacity_total), (() => {
      const b = (options.branches || []).find(x => x.id === r.branch_id);
      return b ? /*#__PURE__*/React.createElement("span", {
        className: "pill",
        style: {
          fontSize: 10,
          background: 'var(--surface-2)',
          color: 'var(--text-3)'
        }
      }, b.code || b.name) : null;
    })()), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 6
      }
    }, /*#__PURE__*/React.createElement("button", {
      className: "btn btn-ghost small",
      style: {
        background: '#EAB308',
        color: '#000',
        border: '1px solid #CA8A04'
      },
      onClick: () => {
        setEditPoolForm({
          name: r.name,
          capacity_total: r.capacity_total,
          branch_id: r.branch_id || ''
        });
        setEditingPoolId(r.id);
      }
    }, "\u270E Edit"), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-ghost small",
      onClick: () => toggleOption('pools', r)
    }, r.is_active ? 'Hide' : 'Show'), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-danger small",
      onClick: () => deleteOption('pools', r, r.name)
    }, "Delete"))));
  }) : /*#__PURE__*/React.createElement("div", {
    className: "empty"
  }, "No pools"))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 16,
      fontWeight: 800
    }
  }, "Operating Hours"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      marginTop: 4
    }
  }, "Per-weekday open and close window. Drives the visible weekly grid bounds."), /*#__PURE__*/React.createElement("div", {
    className: "settings-list"
  }, DAYS_F.map((label, idx) => {
    const row = options.operatingHours.find(h => Number(h.weekday) === idx + 1);
    if (!row) return /*#__PURE__*/React.createElement("div", {
      key: idx,
      className: "row-item"
    }, /*#__PURE__*/React.createElement("div", {
      className: "small subtle"
    }, label, ": not configured"));
    const fmtTime = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    return /*#__PURE__*/React.createElement("div", {
      key: row.weekday,
      className: "row-item"
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        flexWrap: 'wrap'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        minWidth: 74,
        fontWeight: 700
      }
    }, label), /*#__PURE__*/React.createElement("input", {
      className: "input",
      style: {
        width: 128,
        padding: '6px 8px',
        fontSize: 13
      },
      type: "time",
      defaultValue: fmtTime(row.open_minute),
      onBlur: e => {
        const [h, m] = e.target.value.split(':').map(Number);
        const v = h * 60 + m;
        if (Number.isFinite(v) && v !== row.open_minute) patchOption('operating_hours', {
          weekday: row.weekday
        }, {
          open_minute: v
        });
      }
    }), /*#__PURE__*/React.createElement("span", {
      className: "small subtle"
    }, "to"), /*#__PURE__*/React.createElement("input", {
      className: "input",
      style: {
        width: 128,
        padding: '6px 8px',
        fontSize: 13
      },
      type: "time",
      defaultValue: fmtTime(row.close_minute),
      onBlur: e => {
        const [h, m] = e.target.value.split(':').map(Number);
        const v = h * 60 + m;
        if (Number.isFinite(v) && v !== row.close_minute) patchOption('operating_hours', {
          weekday: row.weekday
        }, {
          close_minute: v
        });
      }
    }), /*#__PURE__*/React.createElement("label", {
      className: "small",
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 4
      }
    }, /*#__PURE__*/React.createElement("input", {
      type: "checkbox",
      checked: row.is_open !== false,
      onChange: e => patchOption('operating_hours', {
        weekday: row.weekday
      }, {
        is_open: e.target.checked
      })
    }), "Open")));
  })))), section === 'instructors' && /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 16,
      fontWeight: 800
    }
  }, "Instructors"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      marginTop: 4
    }
  }, "Names available in the session instructor dropdown. Edit to rename or set a gender."), /*#__PURE__*/React.createElement("div", {
    className: "inst-add"
  }, /*#__PURE__*/React.createElement("input", {
    className: "input",
    placeholder: "Add instructor name",
    value: newInstructor,
    onChange: e => setNewInstructor(e.target.value)
  }), /*#__PURE__*/React.createElement("div", {
    className: "gender-toggle gender-toggle-sm",
    role: "radiogroup",
    "aria-label": "Gender"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `gender-opt ${newInstructorGender === 'female' ? 'active' : ''}`,
    onClick: () => setNewInstructorGender(newInstructorGender === 'female' ? null : 'female'),
    title: "Female"
  }, "\u2640 F"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `gender-opt ${newInstructorGender === 'male' ? 'active' : ''}`,
    onClick: () => setNewInstructorGender(newInstructorGender === 'male' ? null : 'male'),
    title: "Male"
  }, "\u2642 M")), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary",
    onClick: () => {
      const v = newInstructor.trim();
      if (!v) return;
      addOption('instructor', {
        name: v,
        gender: newInstructorGender
      });
      setNewInstructor('');
      setNewInstructorGender(null);
    }
  }, "Add")), /*#__PURE__*/React.createElement("div", {
    className: "settings-list"
  }, options.instructors.length ? options.instructors.map((r, idx) => {
    const assigned = lessonTypeCounts && lessonTypeCounts.__bySessionInstructor && lessonTypeCounts.__bySessionInstructor[r.id] || 0; // not provided; computed below in row instead
    return editingInstructorId === r.id ? /*#__PURE__*/React.createElement("div", {
      key: r.id,
      className: "row-item",
      style: {
        display: 'block'
      }
    }, /*#__PURE__*/React.createElement(InstructorEditor, {
      row: r,
      branches: options.branches,
      onCancel: () => setEditingInstructorId(null),
      onSave: patch => {
        patchOption('scheduler_instructors', r.id, patch);
        setEditingInstructorId(null);
      }
    })) : /*#__PURE__*/React.createElement("div", _extends({
      key: r.id,
      className: `row-item ${dragClass('inst', idx)}`
    }, dragProps('inst', 'scheduler_instructors', options.instructors, idx)), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'nowrap',
        minWidth: 0,
        overflow: 'hidden'
      }
    }, reorderCluster('inst', 'scheduler_instructors', options.instructors, idx), /*#__PURE__*/React.createElement("span", {
      className: "pill",
      style: {
        fontSize: 10,
        padding: '2px 7px',
        background: r.is_active ? 'var(--primary-soft)' : '#F0F0F5',
        color: r.is_active ? 'var(--primary-on-soft)' : '#9C9CAD',
        flexShrink: 0
      }
    }, r.is_active ? 'Active' : 'Hidden'), /*#__PURE__*/React.createElement("div", {
      style: {
        fontWeight: 700,
        fontSize: 12,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        minWidth: 0
      }
    }, r.name), r.gender ? /*#__PURE__*/React.createElement("span", {
      className: `gender-chip gender-chip-${r.gender}`,
      style: {
        fontSize: 10,
        padding: '2px 6px',
        flexShrink: 0
      },
      title: r.gender === 'female' ? 'Female' : 'Male'
    }, r.gender === 'female' ? '♀' : '♂') : null, r.primary_branch_id && (() => {
      const b = (options.branches || []).find(x => x.id === r.primary_branch_id);
      return b ? /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 10,
          padding: '2px 6px',
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          color: 'var(--text-3)',
          fontFamily: 'monospace',
          flexShrink: 0
        },
        title: `Primary branch: ${b.name}`
      }, "\uD83C\uDFE2 ", b.code || b.name) : null;
    })()), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 6
      }
    }, /*#__PURE__*/React.createElement("button", {
      className: "btn btn-ghost small",
      onClick: () => setEditingInstructorId(r.id)
    }, "Edit"), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-ghost small",
      onClick: () => toggleOption('scheduler_instructors', r)
    }, r.is_active ? 'Hide' : 'Show'), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-danger small",
      onClick: () => deleteInstructor(r)
    }, "Delete")));
  }) : /*#__PURE__*/React.createElement("div", {
    className: "empty"
  }, "No instructors"))), section === 'lessonTypes' && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 18,
      fontWeight: 800
    }
  }, "Lesson Types"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      marginTop: 4
    }
  }, "Create a type and pick its colors. Click Edit on a row to rename it, set age range, ratio, billing, and default pool. Renaming or recoloring updates every class on the schedule."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'minmax(0,1fr) 78px 78px 78px 132px auto',
      gap: 10,
      alignItems: 'end',
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      margin: 0
    }
  }, /*#__PURE__*/React.createElement("label", null, "Name"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    placeholder: "e.g. LTS Group",
    value: newTypeName,
    onChange: e => setNewTypeName(e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      margin: 0
    }
  }, /*#__PURE__*/React.createElement("label", null, "Background"), /*#__PURE__*/React.createElement("input", {
    className: "swatch",
    type: "color",
    value: bg,
    onChange: e => setBg(e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      margin: 0
    }
  }, /*#__PURE__*/React.createElement("label", null, "Border"), /*#__PURE__*/React.createElement("input", {
    className: "swatch",
    type: "color",
    value: bd,
    onChange: e => setBd(e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      margin: 0
    }
  }, /*#__PURE__*/React.createElement("label", null, "Text"), /*#__PURE__*/React.createElement("input", {
    className: "swatch",
    type: "color",
    value: tx,
    onChange: e => setTx(e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      margin: 0
    }
  }, /*#__PURE__*/React.createElement("label", null, "Preview"), /*#__PURE__*/React.createElement("span", {
    className: "chip",
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: 38,
      background: bg,
      borderColor: bd,
      color: tx,
      fontWeight: 800
    }
  }, newTypeName.trim() || 'Sample')), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary",
    style: {
      height: 38
    },
    onClick: () => {
      const v = newTypeName.trim();
      if (!v) return;
      addOption('lessonType', {
        name: v,
        bg,
        bd,
        tx
      });
      setNewTypeName('');
    }
  }, "Add")), /*#__PURE__*/React.createElement("div", {
    className: "settings-list"
  }, options.lessonTypes.length ? options.lessonTypes.map((r, idx) => {
    const n = counts[r.id] || 0;
    const pkgCount = (options.packages || []).filter(p => p.lesson_type_id === r.id).length;
    const poolName = options.pools.find(p => p.id === r.default_pool_id)?.name;
    const editingThis = editingLessonId === r.id;
    const pkgPanelOpen = pkgPanelLtId === r.id;
    return /*#__PURE__*/React.createElement("div", _extends({
      key: r.id,
      className: `lesson-row ${dragClass('lt', idx)}`
    }, dragProps('lt', 'scheduler_lesson_types', options.lessonTypes, idx)), /*#__PURE__*/React.createElement("div", {
      className: `lt-row-card ${!r.is_active ? 'lt-row-hidden' : ''}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "lt-row-top"
    }, /*#__PURE__*/React.createElement("div", {
      className: "lt-row-lead"
    }, reorderCluster('lt', 'scheduler_lesson_types', options.lessonTypes, idx), /*#__PURE__*/React.createElement("span", {
      className: "lt-name-chip",
      style: {
        background: r.bg_color,
        borderColor: r.border_color,
        color: r.text_color
      }
    }, r.name), /*#__PURE__*/React.createElement("span", {
      className: `lt-type-badge lt-type-${r.class_type || 'group'}`
    }, r.class_type === 'personal' ? '🧑 Personal' : '👥 Group'), /*#__PURE__*/React.createElement("span", {
      className: "lt-classes-pill",
      title: "Classes on the schedule using this type"
    }, n, " ", n === 1 ? 'class' : 'classes')), /*#__PURE__*/React.createElement("div", {
      className: "lt-row-actions"
    }, /*#__PURE__*/React.createElement("button", {
      className: `btn-packages ${pkgPanelOpen ? 'active' : ''}`,
      onClick: () => setPkgPanelLtId(pkgPanelOpen ? null : r.id),
      title: "Manage packages nested under this lesson type"
    }, "Packages ", /*#__PURE__*/React.createElement("span", {
      className: "pkg-count-badge"
    }, pkgCount)), /*#__PURE__*/React.createElement("button", {
      className: `btn btn-ghost small ${editingThis ? 'btn-active' : ''}`,
      onClick: () => setEditingLessonId(editingThis ? null : r.id)
    }, editingThis ? 'Close' : 'Edit'), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-ghost small",
      onClick: () => toggleOption('scheduler_lesson_types', r)
    }, r.is_active ? 'Hide' : 'Show'), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-danger small",
      onClick: () => deleteLessonType(r)
    }, "Delete"))), /*#__PURE__*/React.createElement("div", {
      className: "lt-row-meta"
    }, /*#__PURE__*/React.createElement("div", {
      className: "lt-meta-tile"
    }, /*#__PURE__*/React.createElement("span", {
      className: "lt-meta-label"
    }, "Ratio"), /*#__PURE__*/React.createElement("span", {
      className: `lt-meta-value ${r.students_per_instructor ? '' : 'lt-meta-empty'}`
    }, r.students_per_instructor ? `1:${r.students_per_instructor}` : '—')), /*#__PURE__*/React.createElement("div", {
      className: "lt-meta-tile"
    }, /*#__PURE__*/React.createElement("span", {
      className: "lt-meta-label"
    }, "Duration"), /*#__PURE__*/React.createElement("span", {
      className: `lt-meta-value ${r.default_duration_minutes ? '' : 'lt-meta-empty'}`
    }, r.default_duration_minutes ? `${r.default_duration_minutes} min` : '—')), /*#__PURE__*/React.createElement("div", {
      className: "lt-meta-tile"
    }, /*#__PURE__*/React.createElement("span", {
      className: "lt-meta-label"
    }, "Billing"), /*#__PURE__*/React.createElement("span", {
      className: `lt-meta-value ${r.billing_model ? '' : 'lt-meta-empty'}`
    }, r.billing_model || '—')), /*#__PURE__*/React.createElement("div", {
      className: "lt-meta-tile"
    }, /*#__PURE__*/React.createElement("span", {
      className: "lt-meta-label"
    }, "Default Pool"), /*#__PURE__*/React.createElement("span", {
      className: `lt-meta-value ${poolName ? '' : 'lt-meta-empty'}`
    }, poolName || 'None set')), /*#__PURE__*/React.createElement("div", {
      className: "lt-meta-tile"
    }, /*#__PURE__*/React.createElement("span", {
      className: "lt-meta-label"
    }, "Age"), /*#__PURE__*/React.createElement("span", {
      className: `lt-meta-value ${r.age_min_months != null || r.age_max_months != null ? '' : 'lt-meta-empty'}`
    }, r.age_min_months != null || r.age_max_months != null ? `${r.age_min_months != null ? Math.floor(r.age_min_months / 12) + 'y' : '·'}–${r.age_max_months != null ? Math.floor(r.age_max_months / 12) + 'y' : '·'}` : 'Any age')))), editingLessonId === r.id ? /*#__PURE__*/React.createElement(LessonTypeEditor, {
      row: r,
      pools: options.pools,
      onSave: patch => {
        saveLessonType(r, patch);
        setEditingLessonId(null);
      }
    }) : null, pkgPanelLtId === r.id ? /*#__PURE__*/React.createElement(LessonTypePackages, {
      lessonType: r,
      packages: (options.packages || []).filter(p => p.lesson_type_id === r.id).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)),
      editPkgId: editPkgId,
      setEditPkgId: setEditPkgId,
      addOption: addOption,
      toggleOption: toggleOption,
      deleteOption: deleteOption,
      patchOption: patchOption,
      reorderOption: reorderOption
    }) : null);
  }) : /*#__PURE__*/React.createElement("div", {
    className: "empty"
  }, "No lesson types"))), (() => {
    const orphans = (options.packages || []).filter(p => !p.lesson_type_id);
    if (!orphans.length) return null;
    return /*#__PURE__*/React.createElement("div", {
      className: "card",
      style: {
        marginTop: 16
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 16,
        fontWeight: 800
      }
    }, "Legacy Packages"), /*#__PURE__*/React.createElement("div", {
      className: "small subtle",
      style: {
        marginTop: 4
      }
    }, "These packages exist from before packages were nested under lesson types. Assign each to a lesson type, or delete it. Swimmers and family groups on these still work until you reassign."), /*#__PURE__*/React.createElement("div", {
      className: "settings-list",
      style: {
        marginTop: 10
      }
    }, orphans.map(r => /*#__PURE__*/React.createElement("div", {
      key: r.id,
      className: "row-item"
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap'
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: "pill",
      style: {
        background: '#FEF3C7',
        color: '#92400E',
        borderColor: '#FCD34D'
      }
    }, "Unassigned"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontWeight: 700
      }
    }, r.name), /*#__PURE__*/React.createElement("span", {
      className: "small subtle"
    }, r.pax != null ? `${r.pax} pax` : '—', r.amount != null ? ` · RM${r.amount}` : '', billingText(r.billing_mode, r.billing_count) ? ` · ${billingText(r.billing_mode, r.billing_count)}` : '', r.is_group ? ' · 👪 family' : '')), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 6,
        alignItems: 'center'
      }
    }, /*#__PURE__*/React.createElement("select", {
      className: "select",
      defaultValue: "",
      onChange: e => {
        if (e.target.value) patchOption('packages', r.id, {
          lesson_type_id: e.target.value
        });
      }
    }, /*#__PURE__*/React.createElement("option", {
      value: ""
    }, "Move to\u2026"), options.lessonTypes.map(lt => /*#__PURE__*/React.createElement("option", {
      key: lt.id,
      value: lt.id
    }, lt.name))), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-danger small",
      onClick: () => deleteOption('packages', r, r.name)
    }, "Delete"))))));
  })()), section === 'codes' && addCode && /*#__PURE__*/React.createElement(CodesPanel, {
    codes: codes || [],
    students: students || [],
    packages: packages || [],
    addCode: addCode,
    updateCode: updateCode,
    deleteCode: deleteCode
  }));
}

// ============================================================================
// CodesPanel — Referral & Discount code management. Two filter pills toggle
// between the two kinds, then a single table-style list with inline create/edit.
// The same row schema serves both kinds; the editor adapts its fields to
// the selected code_type. Pure record-keeping for now — redemption logic
// will live in the future invoice module.
// ============================================================================
function CodesPanel({
  codes,
  students,
  packages,
  addCode,
  updateCode,
  deleteCode
}) {
  const [filter, setFilter] = useState('all'); // all | referral | discount | active | expired
  const [editingId, setEditingId] = useState(null);
  const [creating, setCreating] = useState(false);
  const today = todayStr();
  const filtered = (codes || []).filter(c => {
    if (filter === 'all') return true;
    if (filter === 'referral' || filter === 'discount') return c.code_type === filter;
    if (filter === 'active') {
      if (!c.is_active) return false;
      if (c.valid_until && c.valid_until < today) return false;
      if (c.max_uses != null && (c.current_uses || 0) >= c.max_uses) return false;
      return true;
    }
    if (filter === 'expired') {
      if (!c.is_active) return true;
      if (c.valid_until && c.valid_until < today) return true;
      if (c.max_uses != null && (c.current_uses || 0) >= c.max_uses) return true;
      return false;
    }
    return true;
  });
  function codeStatus(c) {
    if (!c.is_active) return {
      label: 'Inactive',
      tone: 'grey'
    };
    if (c.valid_until && c.valid_until < today) return {
      label: 'Expired',
      tone: 'red'
    };
    if (c.valid_from && c.valid_from > today) return {
      label: 'Scheduled',
      tone: 'blue'
    };
    if (c.max_uses != null && (c.current_uses || 0) >= c.max_uses) return {
      label: 'Used up',
      tone: 'red'
    };
    return {
      label: 'Active',
      tone: 'green'
    };
  }
  function summarizeDiscount(c) {
    if (!c.discount_type || c.discount_value == null) return '—';
    if (c.discount_type === 'percentage') return `${c.discount_value}% off`;
    if (c.discount_type === 'fixed') return `RM${c.discount_value} off`;
    if (c.discount_type === 'credit') return `+${c.discount_value} credits`;
    return '—';
  }
  function summarizeReferrerReward(c) {
    if (c.code_type !== 'referral') return '—';
    if (!c.referrer_reward_type || c.referrer_reward_value == null) return '—';
    if (c.referrer_reward_type === 'percentage') return `${c.referrer_reward_value}% off`;
    if (c.referrer_reward_type === 'fixed') return `RM${c.referrer_reward_value} off`;
    if (c.referrer_reward_type === 'credit') return `+${c.referrer_reward_value} credits`;
    return '—';
  }
  function ownerName(id) {
    const s = (students || []).find(x => x.id === id);
    return s ? s.name : '—';
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginTop: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "settings-section-title",
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("span", null, "\uD83C\uDF9F Referral & Discount Codes"), /*#__PURE__*/React.createElement("span", {
    className: "small subtle",
    style: {
      fontWeight: 400,
      letterSpacing: 0,
      textTransform: 'none'
    }
  }, "Manage promotional and referral codes. These are captured at intake and will be validated when invoices are generated.")), /*#__PURE__*/React.createElement("div", {
    className: "codes-toolbar",
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      flexWrap: 'wrap',
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "codes-filter",
    style: {
      display: 'flex',
      gap: 4,
      border: '1px solid var(--border-2)',
      borderRadius: 6,
      padding: 2,
      background: 'var(--surface)'
    }
  }, ['all', 'referral', 'discount', 'active', 'expired'].map(f => /*#__PURE__*/React.createElement("button", {
    key: f,
    className: `codes-filter-pill ${filter === f ? 'active' : ''}`,
    onClick: () => setFilter(f)
  }, f.charAt(0).toUpperCase() + f.slice(1)))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: 'auto'
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary small",
    onClick: () => {
      setCreating(true);
      setEditingId(null);
    }
  }, "+ New Code"))), creating && /*#__PURE__*/React.createElement(CodeEditor, {
    initial: {},
    students: students,
    packages: packages,
    onCancel: () => setCreating(false),
    onSave: async input => {
      try {
        await addCode(input);
        setCreating(false);
      } catch (_) {}
    }
  }), filtered.length === 0 && !creating && /*#__PURE__*/React.createElement("div", {
    className: "empty",
    style: {
      padding: 24,
      textAlign: 'center',
      color: 'var(--text-3)'
    }
  }, "No codes match this filter."), filtered.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "codes-table-wrap",
    style: {
      border: '1px solid var(--border-2)',
      borderRadius: 8,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("table", {
    className: "codes-table",
    style: {
      width: '100%',
      borderCollapse: 'collapse',
      fontSize: 12
    }
  }, /*#__PURE__*/React.createElement("thead", {
    style: {
      background: 'var(--surface-2)'
    }
  }, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: 'left',
      padding: '9px 10px',
      fontSize: 10,
      textTransform: 'uppercase',
      letterSpacing: .6,
      color: 'var(--text-3)',
      fontWeight: 800
    }
  }, "Code"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: 'left',
      padding: '9px 10px',
      fontSize: 10,
      textTransform: 'uppercase',
      letterSpacing: .6,
      color: 'var(--text-3)',
      fontWeight: 800
    }
  }, "Type"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: 'left',
      padding: '9px 10px',
      fontSize: 10,
      textTransform: 'uppercase',
      letterSpacing: .6,
      color: 'var(--text-3)',
      fontWeight: 800
    }
  }, "Redeemer Benefit"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: 'left',
      padding: '9px 10px',
      fontSize: 10,
      textTransform: 'uppercase',
      letterSpacing: .6,
      color: 'var(--text-3)',
      fontWeight: 800
    }
  }, "Referrer Reward"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: 'left',
      padding: '9px 10px',
      fontSize: 10,
      textTransform: 'uppercase',
      letterSpacing: .6,
      color: 'var(--text-3)',
      fontWeight: 800
    }
  }, "Validity"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: 'left',
      padding: '9px 10px',
      fontSize: 10,
      textTransform: 'uppercase',
      letterSpacing: .6,
      color: 'var(--text-3)',
      fontWeight: 800
    }
  }, "Uses"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: 'left',
      padding: '9px 10px',
      fontSize: 10,
      textTransform: 'uppercase',
      letterSpacing: .6,
      color: 'var(--text-3)',
      fontWeight: 800
    }
  }, "Status"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: 'right',
      padding: '9px 10px',
      fontSize: 10,
      textTransform: 'uppercase',
      letterSpacing: .6,
      color: 'var(--text-3)',
      fontWeight: 800
    }
  }))), /*#__PURE__*/React.createElement("tbody", null, filtered.map(c => {
    const st = codeStatus(c);
    const isEditing = editingId === c.id;
    return /*#__PURE__*/React.createElement(React.Fragment, {
      key: c.id
    }, /*#__PURE__*/React.createElement("tr", {
      style: {
        borderTop: '1px solid var(--border-2)'
      }
    }, /*#__PURE__*/React.createElement("td", {
      style: {
        padding: '9px 10px',
        fontWeight: 800,
        fontFamily: 'ui-monospace,monospace',
        letterSpacing: .5
      }
    }, c.code), /*#__PURE__*/React.createElement("td", {
      style: {
        padding: '9px 10px'
      }
    }, c.code_type === 'referral' ? /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'inline-flex',
        gap: 5,
        alignItems: 'center',
        fontSize: 11,
        fontWeight: 700,
        color: 'var(--green-tx)',
        background: 'var(--green-bg)',
        padding: '2px 8px',
        borderRadius: 5,
        border: '1px solid var(--green-bd)'
      }
    }, "\uD83D\uDC65 Referral") : /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'inline-flex',
        gap: 5,
        alignItems: 'center',
        fontSize: 11,
        fontWeight: 700,
        color: 'var(--amber-tx)',
        background: 'var(--amber-bg)',
        padding: '2px 8px',
        borderRadius: 5,
        border: '1px solid var(--amber-bd)'
      }
    }, "\uD83C\uDFF7 Discount"), c.code_type === 'referral' && c.owner_student_id ? /*#__PURE__*/React.createElement("div", {
      className: "small subtle",
      style: {
        marginTop: 3
      }
    }, "Owner: ", ownerName(c.owner_student_id)) : null), /*#__PURE__*/React.createElement("td", {
      style: {
        padding: '9px 10px'
      }
    }, summarizeDiscount(c)), /*#__PURE__*/React.createElement("td", {
      style: {
        padding: '9px 10px'
      }
    }, summarizeReferrerReward(c)), /*#__PURE__*/React.createElement("td", {
      style: {
        padding: '9px 10px',
        fontSize: 11
      }
    }, c.valid_from || c.valid_until ? /*#__PURE__*/React.createElement("span", null, c.valid_from || '—', " \u2192 ", c.valid_until || 'open') : /*#__PURE__*/React.createElement("span", {
      className: "subtle"
    }, "Always")), /*#__PURE__*/React.createElement("td", {
      style: {
        padding: '9px 10px',
        fontSize: 11
      }
    }, c.current_uses || 0, c.max_uses != null ? ` / ${c.max_uses}` : ' (∞)'), /*#__PURE__*/React.createElement("td", {
      style: {
        padding: '9px 10px'
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: `code-status-pill code-status-${st.tone}`
    }, st.label)), /*#__PURE__*/React.createElement("td", {
      style: {
        padding: '9px 10px',
        textAlign: 'right',
        whiteSpace: 'nowrap'
      }
    }, /*#__PURE__*/React.createElement("button", {
      className: "btn btn-ghost small",
      onClick: () => setEditingId(isEditing ? null : c.id)
    }, isEditing ? 'Close' : 'Edit'), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-ghost small",
      onClick: () => updateCode(c.id, {
        isActive: !c.is_active
      }),
      title: c.is_active ? 'Deactivate' : 'Reactivate'
    }, c.is_active ? '⏸' : '▶'), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-danger small",
      onClick: () => {
        if (confirm(`Delete code "${c.code}"? This cannot be undone.`)) deleteCode(c.id);
      }
    }, "\xD7"))), isEditing && /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
      colSpan: 8,
      style: {
        padding: 0,
        background: 'var(--surface-2)'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        padding: '12px 14px'
      }
    }, /*#__PURE__*/React.createElement(CodeEditor, {
      initial: c,
      students: students,
      packages: packages,
      onCancel: () => setEditingId(null),
      onSave: async input => {
        try {
          await updateCode(c.id, input);
          setEditingId(null);
        } catch (_) {}
      }
    })))));
  })))));
}

// Inline form for creating / editing a single code. Adapts to the selected
// code_type — referral codes get an owner picker and referrer-reward fields,
// discount codes hide those.
function CodeEditor({
  initial,
  students,
  packages,
  onCancel,
  onSave
}) {
  const [codeStr, setCodeStr] = useState(initial.code || '');
  const [codeType, setCodeType] = useState(initial.code_type || 'discount');
  const [ownerStudentId, setOwnerStudentId] = useState(initial.owner_student_id || '');
  const [discountType, setDiscountType] = useState(initial.discount_type || 'percentage');
  const [discountValue, setDiscountValue] = useState(initial.discount_value ?? '');
  const [referrerRewardType, setReferrerRewardType] = useState(initial.referrer_reward_type || 'credit');
  const [referrerRewardValue, setReferrerRewardValue] = useState(initial.referrer_reward_value ?? '');
  const [validFrom, setValidFrom] = useState(initial.valid_from || '');
  const [validUntil, setValidUntil] = useState(initial.valid_until || '');
  const [maxUses, setMaxUses] = useState(initial.max_uses ?? '');
  const [maxUsesPerCustomer, setMaxUsesPerCustomer] = useState(initial.max_uses_per_customer ?? 1);
  const [appliesTo, setAppliesTo] = useState(initial.applies_to || 'all');
  const [minimumAmount, setMinimumAmount] = useState(initial.minimum_amount ?? '');
  const [isActive, setIsActive] = useState(initial.is_active !== false);
  const [notes, setNotes] = useState(initial.notes || '');
  const isReferral = codeType === 'referral';
  return /*#__PURE__*/React.createElement("div", {
    className: "code-editor",
    style: {
      padding: 14,
      background: 'var(--surface)',
      border: '1px solid var(--border-2)',
      borderRadius: 8,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: .6,
      fontWeight: 800,
      color: 'var(--text-3)',
      marginBottom: 10
    }
  }, initial.id ? `Edit code "${initial.code}"` : 'New code'), /*#__PURE__*/React.createElement("div", {
    className: "form-grid",
    style: {
      gridTemplateColumns: 'auto 1fr auto'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Type"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 4,
      border: '1px solid var(--border-2)',
      borderRadius: 6,
      padding: 2,
      background: 'var(--surface-2)'
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `codes-type-toggle ${codeType === 'discount' ? 'active' : ''}`,
    onClick: () => setCodeType('discount')
  }, "\uD83C\uDFF7 Discount"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `codes-type-toggle ${codeType === 'referral' ? 'active' : ''}`,
    onClick: () => setCodeType('referral')
  }, "\uD83D\uDC65 Referral"))), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Code ", /*#__PURE__*/React.createElement("span", {
    className: "req"
  }, "*")), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: codeStr,
    onChange: e => setCodeStr(e.target.value.toUpperCase()),
    placeholder: "e.g. SARAH2025 or NEW50",
    style: {
      fontFamily: 'ui-monospace,monospace',
      letterSpacing: .5,
      fontWeight: 700
    }
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Status"), /*#__PURE__*/React.createElement("label", {
    className: "gb-check",
    style: {
      height: 38,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: isActive,
    onChange: e => setIsActive(e.target.checked)
  }), " Active"))), isReferral && /*#__PURE__*/React.createElement("div", {
    className: "form-grid",
    style: {
      gridTemplateColumns: '1fr',
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Owner (existing customer who shares this code)"), /*#__PURE__*/React.createElement("select", {
    className: "select",
    value: ownerStudentId,
    onChange: e => setOwnerStudentId(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "\u2014 Select swimmer \u2014"), (students || []).filter(s => s.isActive !== false).map(s => /*#__PURE__*/React.createElement("option", {
    key: s.id,
    value: s.id
  }, s.name, s.guardianName ? ` (${s.guardianName})` : ''))))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12,
      padding: '10px 12px',
      background: '#F0F9FF',
      border: '1px solid #BFDBFE',
      borderRadius: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      textTransform: 'uppercase',
      letterSpacing: .6,
      fontWeight: 800,
      color: '#1E40AF',
      marginBottom: 7
    }
  }, "Redeemer Benefit \u2014 what the new customer gets"), /*#__PURE__*/React.createElement("div", {
    className: "form-grid",
    style: {
      gridTemplateColumns: '1fr 1fr'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Benefit Type"), /*#__PURE__*/React.createElement("select", {
    className: "select",
    value: discountType,
    onChange: e => setDiscountType(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: "percentage"
  }, "Percentage off"), /*#__PURE__*/React.createElement("option", {
    value: "fixed"
  }, "Fixed amount off (RM)"), /*#__PURE__*/React.createElement("option", {
    value: "credit"
  }, "Bonus credits"))), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Value ", /*#__PURE__*/React.createElement("span", {
    className: "subtle small"
  }, "(", discountType === 'percentage' ? '%' : discountType === 'fixed' ? 'RM' : 'credits', ")")), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "number",
    min: "0",
    step: "0.01",
    value: discountValue,
    onChange: e => setDiscountValue(e.target.value),
    placeholder: discountType === 'percentage' ? '10' : discountType === 'fixed' ? '50' : '4'
  })))), isReferral && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10,
      padding: '10px 12px',
      background: '#F0FDF4',
      border: '1px solid #BBF7D0',
      borderRadius: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      textTransform: 'uppercase',
      letterSpacing: .6,
      fontWeight: 800,
      color: '#065F46',
      marginBottom: 7
    }
  }, "Referrer Reward \u2014 what the existing customer earns"), /*#__PURE__*/React.createElement("div", {
    className: "form-grid",
    style: {
      gridTemplateColumns: '1fr 1fr'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Reward Type"), /*#__PURE__*/React.createElement("select", {
    className: "select",
    value: referrerRewardType,
    onChange: e => setReferrerRewardType(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: "credit"
  }, "Bonus credits"), /*#__PURE__*/React.createElement("option", {
    value: "fixed"
  }, "Fixed amount off (RM)"), /*#__PURE__*/React.createElement("option", {
    value: "percentage"
  }, "Percentage off"))), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Value ", /*#__PURE__*/React.createElement("span", {
    className: "subtle small"
  }, "(", referrerRewardType === 'percentage' ? '%' : referrerRewardType === 'fixed' ? 'RM' : 'credits', ")")), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "number",
    min: "0",
    step: "0.01",
    value: referrerRewardValue,
    onChange: e => setReferrerRewardValue(e.target.value),
    placeholder: referrerRewardType === 'percentage' ? '10' : referrerRewardType === 'fixed' ? '50' : '2'
  })))), /*#__PURE__*/React.createElement("div", {
    className: "form-grid",
    style: {
      gridTemplateColumns: '1fr 1fr',
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Valid From ", /*#__PURE__*/React.createElement("span", {
    className: "subtle small"
  }, "(blank = anytime)")), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "date",
    value: validFrom,
    onChange: e => setValidFrom(e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Valid Until ", /*#__PURE__*/React.createElement("span", {
    className: "subtle small"
  }, "(blank = no expiry)")), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "date",
    value: validUntil,
    onChange: e => setValidUntil(e.target.value)
  }))), /*#__PURE__*/React.createElement("div", {
    className: "form-grid",
    style: {
      gridTemplateColumns: '1fr 1fr 1fr',
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Max Total Uses ", /*#__PURE__*/React.createElement("span", {
    className: "subtle small"
  }, "(blank = \u221E)")), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "number",
    min: "0",
    value: maxUses,
    onChange: e => setMaxUses(e.target.value),
    placeholder: "unlimited"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Max Uses per Customer"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "number",
    min: "1",
    value: maxUsesPerCustomer,
    onChange: e => setMaxUsesPerCustomer(e.target.value),
    placeholder: "1"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Minimum Invoice (RM)"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "number",
    min: "0",
    step: "0.01",
    value: minimumAmount,
    onChange: e => setMinimumAmount(e.target.value),
    placeholder: "none"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "form-grid",
    style: {
      gridTemplateColumns: '1fr 2fr',
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Applies To"), /*#__PURE__*/React.createElement("select", {
    className: "select",
    value: appliesTo,
    onChange: e => setAppliesTo(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: "all"
  }, "All purchases"), /*#__PURE__*/React.createElement("option", {
    value: "first_purchase"
  }, "First purchase only"))), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Internal Notes"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: notes,
    onChange: e => setNotes(e.target.value),
    placeholder: "e.g. Q1 launch promo, only for new families"
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      justifyContent: 'flex-end',
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: onCancel
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary small",
    onClick: () => {
      if (!codeStr.trim()) {
        alert('Code string is required.');
        return;
      }
      onSave({
        code: codeStr,
        codeType,
        ownerStudentId: isReferral ? ownerStudentId || null : null,
        discountType,
        discountValue,
        referrerRewardType: isReferral ? referrerRewardType : null,
        referrerRewardValue: isReferral ? referrerRewardValue : null,
        validFrom,
        validUntil,
        maxUses,
        maxUsesPerCustomer,
        appliesTo,
        minimumAmount,
        isActive,
        notes
      });
    }
  }, initial.id ? 'Save Changes' : 'Create Code')));
}

// Manage packages nested under one lesson type: add, edit (PackageEditor),
// reorder with ↑/↓, hide, delete. Same controls as the old top-level card but
// scoped to its lesson type — so each type owns its Normal, Trial, Family 3…
// Inline editor for an instructor: rename + Female/Male toggle.
function InstructorEditor({
  row,
  onSave,
  onCancel,
  branches
}) {
  const [name, setName] = useState(row.name || '');
  const [gender, setGender] = useState(row.gender || null);
  const [primaryBranchId, setPrimaryBranchId] = useState(row.primary_branch_id || '');
  function apply() {
    const v = (name || '').trim();
    if (!v) return;
    onSave({
      name: v,
      gender: gender || null,
      primary_branch_id: primaryBranchId || null
    });
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "inst-editor"
  }, /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      margin: 0,
      flex: 1,
      minWidth: 160
    }
  }, /*#__PURE__*/React.createElement("label", null, "Name"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: name,
    onChange: e => setName(e.target.value),
    placeholder: "Instructor name"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      margin: 0
    }
  }, /*#__PURE__*/React.createElement("label", null, "Gender"), /*#__PURE__*/React.createElement("div", {
    className: "gender-toggle"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `gender-opt ${gender === 'female' ? 'active' : ''}`,
    onClick: () => setGender(gender === 'female' ? null : 'female')
  }, "\u2640 Female"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `gender-opt ${gender === 'male' ? 'active' : ''}`,
    onClick: () => setGender(gender === 'male' ? null : 'male')
  }, "\u2642 Male"))), (branches || []).length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      margin: 0,
      minWidth: 140
    }
  }, /*#__PURE__*/React.createElement("label", null, "Primary Branch ", /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 400,
      color: 'var(--text-3)',
      fontSize: 10
    }
  }, "(hint only)")), /*#__PURE__*/React.createElement("select", {
    className: "select",
    value: primaryBranchId,
    onChange: e => setPrimaryBranchId(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "\u2014 None \u2014"), (branches || []).filter(b => b.is_active !== false).map(b => /*#__PURE__*/React.createElement("option", {
    key: b.id,
    value: b.id
  }, b.name, b.code ? ` (${b.code})` : '')))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      alignSelf: 'flex-end'
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: onCancel
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary small",
    onClick: apply
  }, "Save")));
}
function LessonTypePackages({
  lessonType,
  packages,
  editPkgId,
  setEditPkgId,
  addOption,
  toggleOption,
  deleteOption,
  patchOption,
  reorderOption
}) {
  const [name, setName] = useState('');
  const [pax, setPax] = useState('');
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState('monthly');
  const [count, setCount] = useState('');
  const [isGroup, setIsGroup] = useState(false);
  const [fallback, setFallback] = useState('');
  function reset() {
    setName('');
    setPax('');
    setAmount('');
    setMode('monthly');
    setCount('');
    setIsGroup(false);
    setFallback('');
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "lt-packages"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lt-packages-head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "chip",
    style: {
      background: lessonType.bg_color,
      borderColor: lessonType.border_color,
      color: lessonType.text_color,
      fontWeight: 800
    }
  }, lessonType.name), /*#__PURE__*/React.createElement("span", {
    className: "small subtle"
  }, "Packages nested under this lesson type")), /*#__PURE__*/React.createElement("div", {
    className: "lt-packages-list"
  }, packages.length ? packages.map((r, i) => editPkgId === r.id ? /*#__PURE__*/React.createElement("div", {
    key: r.id,
    className: "row-item",
    style: {
      display: 'block'
    }
  }, /*#__PURE__*/React.createElement(PackageEditor, {
    row: r,
    onCancel: () => setEditPkgId(null),
    onSave: patch => {
      patchOption('packages', r.id, patch);
      setEditPkgId(null);
    }
  })) : /*#__PURE__*/React.createElement("div", {
    key: r.id,
    className: "row-item"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "reorder"
  }, /*#__PURE__*/React.createElement("button", {
    className: "reorder-btn",
    disabled: i === 0,
    title: "Move up",
    onClick: () => reorderOption('packages', packages, i, -1)
  }, "\u2191"), /*#__PURE__*/React.createElement("button", {
    className: "reorder-btn",
    disabled: i === packages.length - 1,
    title: "Move down",
    onClick: () => reorderOption('packages', packages, i, 1)
  }, "\u2193")), /*#__PURE__*/React.createElement("span", {
    className: "pill",
    style: {
      background: r.is_active ? 'var(--primary-soft)' : '#F0F0F5',
      color: r.is_active ? 'var(--primary-on-soft)' : '#9C9CAD'
    }
  }, r.is_active ? 'Active' : 'Hidden'), /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700
    }
  }, r.name), /*#__PURE__*/React.createElement("span", {
    className: "small subtle"
  }, r.pax != null ? `${r.pax}${r.is_group ? ' pax req.' : ' pax'}` : '—', " \xB7 ", r.amount != null ? `RM${r.amount}${r.is_group ? ' bundle' : ''}` : 'no amount', billingText(r.billing_mode, r.billing_count) ? ` · ${billingText(r.billing_mode, r.billing_count)}` : '', r.is_group ? ` · 👪 family${r.fallback_per_pax != null ? `, RM${r.fallback_per_pax}/pax fallback` : ''}` : '')), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: () => setEditPkgId(r.id)
  }, "Edit"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: () => toggleOption('packages', r)
  }, r.is_active ? 'Hide' : 'Show'), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-danger small",
    onClick: () => deleteOption('packages', r, r.name)
  }, "Delete")))) : /*#__PURE__*/React.createElement("div", {
    className: "empty"
  }, "No packages yet for this lesson type.")), /*#__PURE__*/React.createElement("div", {
    className: "lt-packages-add"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 700,
      marginBottom: 6
    }
  }, "+ Add a package under ", lessonType.name), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'minmax(0,1fr) 90px 130px',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      margin: 0
    }
  }, /*#__PURE__*/React.createElement("label", null, "Name"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    placeholder: "e.g. Family of 4",
    value: name,
    onChange: e => setName(e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      margin: 0
    }
  }, /*#__PURE__*/React.createElement("label", null, "Pax"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "number",
    min: "1",
    value: pax,
    onChange: e => setPax(e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      margin: 0
    }
  }, /*#__PURE__*/React.createElement("label", null, "Amount (RM)"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "number",
    min: "0",
    step: "0.01",
    value: amount,
    onChange: e => setAmount(e.target.value)
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-end',
      gap: 12,
      marginTop: 10,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement(BillingControl, {
    mode: mode,
    count: count,
    onMode: setMode,
    onCount: setCount
  }), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary small",
    onClick: () => {
      const v = name.trim();
      if (!v) return;
      addOption('package', {
        lessonTypeId: lessonType.id,
        name: v,
        pax,
        amount,
        billingMode: mode,
        billingCount: count,
        isGroup,
        fallbackPerPax: fallback
      });
      reset();
    }
  }, "Add Package")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-end',
      gap: 14,
      marginTop: 8,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("label", {
    className: "gb-check"
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: isGroup,
    onChange: e => setIsGroup(e.target.checked)
  }), " Family unit (single payer)"), isGroup ? /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      margin: 0,
      maxWidth: 260
    }
  }, /*#__PURE__*/React.createElement("label", null, "Standard rate per pax if under-enrolled (RM)"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "number",
    min: "0",
    step: "0.01",
    placeholder: "200",
    value: fallback,
    onChange: e => setFallback(e.target.value)
  })) : null)));
}

// M2: inline editor for the new lesson-type fields. Saves on Apply.
function LessonTypeEditor({
  row,
  pools,
  onSave
}) {
  const [draft, setDraft] = useState({
    name: row.name || '',
    age_min_months: row.age_min_months ?? '',
    age_max_months: row.age_max_months ?? '',
    students_per_instructor: row.students_per_instructor ?? '',
    default_duration_minutes: row.default_duration_minutes ?? '',
    billing_model: row.billing_model || 'monthly',
    class_type: row.class_type || 'group',
    monthly_fee: row.monthly_fee ?? '',
    lessons_per_month: row.lessons_per_month ?? '',
    credit_count: row.credit_count ?? '',
    credit_fee: row.credit_fee ?? '',
    default_pool_id: row.default_pool_id || '',
    coach_in_pool: row.coach_in_pool !== false,
    bg_color: row.bg_color || '#DBEAFE',
    border_color: row.border_color || '#3B82F6',
    text_color: row.text_color || '#1E40AF'
  });
  function setF(k, v) {
    setDraft(d => ({
      ...d,
      [k]: v
    }));
  }
  function clean(v) {
    if (v === '' || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "lesson-edit"
  }, /*#__PURE__*/React.createElement("div", {
    className: "form-grid",
    style: {
      gridTemplateColumns: 'repeat(4, minmax(0,1fr))'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      gridColumn: '1 / 3'
    }
  }, /*#__PURE__*/React.createElement("label", null, "Name"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: draft.name,
    onChange: e => setF('name', e.target.value),
    placeholder: "Lesson type name"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Age min (months)"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "number",
    value: draft.age_min_months,
    onChange: e => setF('age_min_months', e.target.value),
    placeholder: "60 for 5 years"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Age max (months)"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "number",
    value: draft.age_max_months,
    onChange: e => setF('age_max_months', e.target.value),
    placeholder: "216 for 18 years"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Students per instructor"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "number",
    value: draft.students_per_instructor,
    onChange: e => setF('students_per_instructor', e.target.value),
    placeholder: "6 for 1:6"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Default duration (min)"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "number",
    value: draft.default_duration_minutes,
    onChange: e => setF('default_duration_minutes', e.target.value),
    placeholder: "50"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Default pool"), /*#__PURE__*/React.createElement("select", {
    className: "select",
    value: draft.default_pool_id,
    onChange: e => setF('default_pool_id', e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "(none)"), pools.map(p => /*#__PURE__*/React.createElement("option", {
    key: p.id,
    value: p.id
  }, p.name)))), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Billing model"), /*#__PURE__*/React.createElement("select", {
    className: "select",
    value: draft.billing_model,
    onChange: e => setF('billing_model', e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: "monthly"
  }, "Monthly"), /*#__PURE__*/React.createElement("option", {
    value: "credit"
  }, "Credit"))), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Class type"), /*#__PURE__*/React.createElement("div", {
    className: "gender-toggle",
    style: {
      marginTop: 2
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `gender-opt ${draft.class_type === 'group' ? 'active' : ''}`,
    onClick: () => setF('class_type', 'group')
  }, "\uD83D\uDC65 Group"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `gender-opt ${draft.class_type === 'personal' ? 'active' : ''}`,
    onClick: () => setF('class_type', 'personal')
  }, "\uD83E\uDDD1 Personal")), /*#__PURE__*/React.createElement("div", {
    className: "hint",
    style: {
      marginTop: 4
    }
  }, draft.class_type === 'personal' ? 'Private lesson — enables credit tracking and per-week reschedule' : 'Group lesson — enables drop-in replacement for absent swimmers')), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Coach in pool"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '10px 0'
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: draft.coach_in_pool,
    onChange: e => setF('coach_in_pool', e.target.checked)
  }), /*#__PURE__*/React.createElement("span", {
    className: "small subtle"
  }, "Uncheck for on-deck coaching (Strokelab Elite)"))), draft.billing_model === 'monthly' ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Monthly fee"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "number",
    step: "0.01",
    value: draft.monthly_fee,
    onChange: e => setF('monthly_fee', e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Lessons per month"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "number",
    value: draft.lessons_per_month,
    onChange: e => setF('lessons_per_month', e.target.value),
    placeholder: "4"
  }))) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Credit count"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "number",
    value: draft.credit_count,
    onChange: e => setF('credit_count', e.target.value),
    placeholder: "4 or 6"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Credit fee (full pack)"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "number",
    step: "0.01",
    value: draft.credit_fee,
    onChange: e => setF('credit_fee', e.target.value)
  }))), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Background"), /*#__PURE__*/React.createElement("input", {
    className: "swatch",
    type: "color",
    value: draft.bg_color,
    onChange: e => setF('bg_color', e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Border"), /*#__PURE__*/React.createElement("input", {
    className: "swatch",
    type: "color",
    value: draft.border_color,
    onChange: e => setF('border_color', e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Text"), /*#__PURE__*/React.createElement("input", {
    className: "swatch",
    type: "color",
    value: draft.text_color,
    onChange: e => setF('text_color', e.target.value)
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'flex-end',
      gap: 8,
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary",
    onClick: () => {
      onSave({
        name: draft.name.trim() || row.name,
        age_min_months: clean(draft.age_min_months),
        age_max_months: clean(draft.age_max_months),
        students_per_instructor: clean(draft.students_per_instructor),
        default_duration_minutes: clean(draft.default_duration_minutes),
        billing_model: draft.billing_model,
        class_type: draft.class_type || 'group',
        monthly_fee: clean(draft.monthly_fee),
        lessons_per_month: clean(draft.lessons_per_month),
        credit_count: clean(draft.credit_count),
        credit_fee: clean(draft.credit_fee),
        default_pool_id: draft.default_pool_id || null,
        coach_in_pool: !!draft.coach_in_pool,
        bg_color: draft.bg_color,
        border_color: draft.border_color,
        text_color: draft.text_color
      });
    }
  }, "Apply Changes")));
}

// ============================================================================
// SessionModal (M2: pool selector, lesson-type auto-default, capacity preview)
// ============================================================================

// M4: deterministic enrollment matcher. Given an age (or a registered swimmer)
// plus availability, it filters the selected week's sessions to age-eligible
// lesson types, ranks them by open capacity, and offers one-tap enroll/create.
function EnrollView({
  sessions,
  students,
  studentById,
  lessonTypes,
  lessonTypeById,
  lessonTypeByName,
  poolById,
  colorsFor,
  gridBounds,
  packages,
  instructors,
  initialWeekStart,
  onEnroll,
  onCreate,
  onEdit,
  onAdd
}) {
  const [weekStart, setWeekStart] = useState(initialWeekStart);

  // ── Filter state ──────────────────────────────────────────────────
  // Lesson Types: empty Set = no filter (show all). Non-empty = show only matching.
  const [activeLts, setActiveLts] = useState(new Set());
  // Not Full: OFF = show all (including full). ON = hide full sessions.
  const [notFull, setNotFull] = useState(false);
  // Instructors: all ON by default. Toggle off to hide that instructor's sessions.
  const allInstNames = useMemo(() => (instructors || []).map(i => i.name), [instructors]);
  const [activeInsts, setActiveInsts] = useState(() => new Set(allInstNames));
  // Gender quick-toggle: applies to instructor pills in bulk.
  const [genderMode, setGenderMode] = useState('all'); // 'all' | 'male' | 'female'
  React.useEffect(() => {
    setActiveInsts(new Set(allInstNames));
  }, [allInstNames]);
  function toggleLt(id) {
    setActiveLts(s => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);else n.add(id);
      return n;
    });
  }
  function toggleInst(name) {
    setActiveInsts(s => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);else n.add(name);
      return n;
    });
    setGenderMode('custom');
  }
  function setGender(mode) {
    setGenderMode(mode);
    if (mode === 'all') {
      setActiveInsts(new Set(allInstNames));
      return;
    }
    const filtered = (instructors || []).filter(i => (i.gender || '').toLowerCase() === mode).map(i => i.name);
    setActiveInsts(new Set(filtered));
  }

  // ── Session analysis + filtering ──────────────────────────────────
  const weekSessions = useMemo(() => sessions.filter(s => s.weekStartDate === weekStart), [sessions, weekStart]);
  const analyzed = useMemo(() => {
    return weekSessions.map(s => {
      const lt = s.lessonTypeId && lessonTypeById(s.lessonTypeId) || lessonTypeByName(s.type);
      const cap = sessionCapacity(s, lt);
      const isFull = cap.max > 0 && cap.current >= cap.max;
      const instName = s.instructors?.[0]?.name || s.legacyInstructor || '';
      return {
        s,
        lt,
        ltId: lt?.id,
        cap,
        isFull,
        instName
      };
    });
  }, [weekSessions, lessonTypeById, lessonTypeByName]);
  const visible = useMemo(() => {
    return analyzed.filter(a => {
      // 1. Lesson type: if any selected, must match
      if (activeLts.size > 0 && !activeLts.has(a.ltId)) return false;
      // 2. Not Full filter
      if (notFull && a.isFull) return false;
      // 3. Instructor filter
      if (a.instName && !activeInsts.has(a.instName)) return false;
      return true;
    });
  }, [analyzed, activeLts, notFull, activeInsts]);
  const byDay = useMemo(() => Array.from({
    length: 7
  }, (_, di) => visible.filter(v => v.s.day === di).sort((a, b) => a.s.startMinute - b.s.startMinute)), [visible]);
  const startHour = Math.floor(gridBounds.startMin / 60) * 60;
  const hours = [];
  for (let h = startHour; h < gridBounds.endMin; h += 60) hours.push(h);
  const wb = weekBounds(weekStart);

  // Stats
  const totalShown = visible.length;
  const totalAll = analyzed.length;
  const fullCount = visible.filter(v => v.isFull).length;
  const openCount = totalShown - fullCount;
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "view-head"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "view-title"
  }, "Schedule Explorer"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, "Filter the weekly schedule by lesson type, availability, and instructor. Click any session to view or edit.")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      alignItems: 'center',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "enroll-stat fits"
  }, openCount, " open"), /*#__PURE__*/React.createElement("span", {
    className: "enroll-stat full"
  }, fullCount, " full"), /*#__PURE__*/React.createElement("span", {
    className: "small subtle"
  }, totalShown, "/", totalAll, " shown"))), /*#__PURE__*/React.createElement(PeriodNav, {
    rangeLabel: weekRangeLabel(weekStart),
    onPrev: () => setWeekStart(addDays(weekStart, -7)),
    onNext: () => setWeekStart(addDays(weekStart, 7)),
    onToday: () => setWeekStart(initialWeekStart),
    isCurrent: weekStart === initialWeekStart
  }), /*#__PURE__*/React.createElement("div", {
    className: "enroll-filter-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "enroll-filter-label"
  }, "Lesson Type"), /*#__PURE__*/React.createElement("div", {
    className: "enroll-filter-pills"
  }, lessonTypes.map(lt => {
    const isOn = activeLts.has(lt.id);
    const c = colorsFor(lt.name);
    return /*#__PURE__*/React.createElement("button", {
      key: lt.id,
      type: "button",
      className: `enroll-pill ${isOn ? 'is-on' : ''}`,
      style: isOn ? {
        background: c.bg,
        borderColor: c.bd,
        color: c.tx
      } : {},
      onClick: () => toggleLt(lt.id)
    }, lt.name);
  }), activeLts.size > 0 ? /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "enroll-pill-clear",
    onClick: () => setActiveLts(new Set())
  }, "\u2715 Clear") : null)), /*#__PURE__*/React.createElement("div", {
    className: "enroll-filter-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "enroll-filter-label"
  }, "Availability"), /*#__PURE__*/React.createElement("div", {
    className: "enroll-filter-pills"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `enroll-pill ${notFull ? 'is-on' : ''}`,
    style: notFull ? {
      background: '#D1FAE5',
      borderColor: '#10B981',
      color: '#065F46'
    } : {},
    onClick: () => setNotFull(v => !v)
  }, "Not Full Only"))), /*#__PURE__*/React.createElement("div", {
    className: "enroll-filter-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "enroll-filter-label"
  }, "Instructor"), /*#__PURE__*/React.createElement("div", {
    className: "enroll-filter-pills",
    style: {
      marginBottom: 4
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `enroll-pill ${genderMode === 'all' ? 'is-on' : ''}`,
    style: genderMode === 'all' ? {
      background: '#DBEAFE',
      borderColor: '#3B82F6',
      color: '#1E3A8A'
    } : {},
    onClick: () => setGender('all')
  }, "All"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `enroll-pill ${genderMode === 'male' ? 'is-on' : ''}`,
    style: genderMode === 'male' ? {
      background: '#DBEAFE',
      borderColor: '#3B82F6',
      color: '#1E3A8A'
    } : {},
    onClick: () => setGender('male')
  }, "\u2642 Male"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `enroll-pill ${genderMode === 'female' ? 'is-on' : ''}`,
    style: genderMode === 'female' ? {
      background: '#FCE7F3',
      borderColor: '#EC4899',
      color: '#831843'
    } : {},
    onClick: () => setGender('female')
  }, "\u2640 Female")), /*#__PURE__*/React.createElement("div", {
    className: "enroll-filter-pills"
  }, (instructors || []).map(inst => {
    const isOn = activeInsts.has(inst.name);
    return /*#__PURE__*/React.createElement("button", {
      key: inst.id || inst.name,
      type: "button",
      className: `enroll-pill ${isOn ? 'is-on' : ''}`,
      onClick: () => toggleInst(inst.name)
    }, inst.name);
  })))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "enroll-grid"
  }, /*#__PURE__*/React.createElement("div", {
    className: "enroll-grid-corner"
  }), DAYS_S.map((d, di) => {
    const dt = new Date(wb.start);
    dt.setDate(wb.start.getDate() + di);
    return /*#__PURE__*/React.createElement("div", {
      key: 'h' + di,
      className: "enroll-grid-dayhead"
    }, /*#__PURE__*/React.createElement("div", {
      className: "enroll-grid-dayname"
    }, d), /*#__PURE__*/React.createElement("div", {
      className: "enroll-grid-daydate"
    }, dt.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric'
    })));
  }), hours.map(h => /*#__PURE__*/React.createElement(React.Fragment, {
    key: h
  }, /*#__PURE__*/React.createElement("div", {
    className: "enroll-grid-time"
  }, hourLabel(h)), DAYS_S.map((_, di) => {
    const cellInfos = byDay[di].filter(v => v.s.startMinute >= h && v.s.startMinute < h + 60);
    return /*#__PURE__*/React.createElement("div", {
      key: 'c' + di + '-' + h,
      className: "enroll-grid-cell"
    }, cellInfos.map(info => {
      const c = colorsFor(info.s.type);
      const capLabel = info.cap.max > 0 ? `${info.cap.current}/${info.cap.max}` : `${info.cap.current}`;
      return /*#__PURE__*/React.createElement("div", {
        key: info.s.id,
        className: `enroll-mini ${info.isFull ? 'mini-full' : 'mini-fits'}`,
        style: {
          borderLeftColor: c.bd,
          background: c.bg
        },
        onClick: e => {
          e.stopPropagation();
          onEnroll(info.s, []);
        }
      }, /*#__PURE__*/React.createElement("div", {
        className: "enroll-mini-top"
      }, /*#__PURE__*/React.createElement("span", {
        className: "enroll-mini-type",
        style: {
          color: c.tx
        }
      }, info.s.type), /*#__PURE__*/React.createElement("div", {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 4
        }
      }, /*#__PURE__*/React.createElement("span", {
        className: "enroll-mini-cap"
      }, capLabel), onEdit && /*#__PURE__*/React.createElement("span", {
        className: "enroll-mini-edit",
        title: "Edit session",
        onClick: e => {
          e.stopPropagation();
          onEdit(info.s);
        }
      }, "\u270E"))), /*#__PURE__*/React.createElement("div", {
        className: "enroll-mini-meta"
      }, minuteToTime(info.s.startMinute), info.instName ? ` · ${info.instName}` : ''));
    }), onAdd && /*#__PURE__*/React.createElement("div", {
      className: "enroll-add-btn",
      title: "Add session",
      onClick: () => {
        try {
          onAdd(di, h, null, weekStart);
        } catch (err) {
          console.error('EnrollView + error:', err);
          alert('Could not open add session: ' + err.message);
        }
      }
    }, "+"));
  }))))));
}

// Searchable swimmer combobox used in each enrollment slot.
// The dropdown is portalled into document.body and positioned with
// position:fixed so it floats above the modal — never clipped by the
// scrollable modal-body. Auto-flips upward when there isn't enough room
// below; tracks the input on window scroll/resize.
function StudentSelect({
  valueId,
  fallbackLabel,
  studentById,
  candidates,
  onPick,
  conflict,
  trialStudentIds,
  pendingByKey,
  weekStartDate,
  lessonTypeId
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [popPos, setPopPos] = useState(null); // { left, top, width, flipUp, maxH }
  const triggerRef = React.useRef(null);
  const sel = valueId ? studentById[valueId] : null;
  const label = sel ? `${sel.name}${sel.age != null ? ` (${sel.age})` : ''}` : fallbackLabel || '';
  const filtered = (candidates || []).filter(s => !q || (s.name || '').toLowerCase().includes(q.toLowerCase()));
  // Trial flag is context-sensitive: a swimmer's global "trial" status only
  // surfaces here if the current session's lesson type matches one of their
  // enrolled lesson types. A trial LTS swimmer dropped into a Personal-class
  // dropdown reads as a regular candidate, not as "trial".
  function isTrialFor(s) {
    if (!(trialStudentIds && trialStudentIds.has(s.id))) return false;
    if (!lessonTypeId) return false;
    return (s.lessonTypeIds || []).includes(lessonTypeId);
  }
  // Sort: pending-replacement first, then context-matching trial, then the
  // rest alphabetical — so flagged candidates surface at the top of the
  // dropdown when scheduler is looking for one.
  const sortedFiltered = filtered.slice().sort((a, b) => {
    const aP = !!(pendingByKey && lessonTypeId && weekStartDate && pendingByKey[`${a.id}:${lessonTypeId}:${weekStartDate}`]);
    const bP = !!(pendingByKey && lessonTypeId && weekStartDate && pendingByKey[`${b.id}:${lessonTypeId}:${weekStartDate}`]);
    if (aP !== bP) return aP ? -1 : 1;
    const aT = isTrialFor(a);
    const bT = isTrialFor(b);
    if (aT !== bT) return aT ? -1 : 1;
    return (a.name || '').localeCompare(b.name || '');
  });
  function choose(s) {
    onPick(s);
    setOpen(false);
    setQ('');
  }

  // Recompute popup position from the trigger's bounding rect. Used on
  // open + on resize + on capture-phase scroll so scrolling the modal
  // body keeps the dropdown stuck to the input.
  function recalcPos() {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const desired = 280; // ideal dropdown height
    const spaceBelow = vh - r.bottom - 12;
    const spaceAbove = r.top - 12;
    const flipUp = spaceBelow < 180 && spaceAbove > spaceBelow;
    const maxH = Math.min(desired, Math.max(140, flipUp ? spaceAbove : spaceBelow));
    setPopPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 260) - 8)),
      top: flipUp ? null : r.bottom + 5,
      bottom: flipUp ? vh - r.top + 5 : null,
      width: Math.max(r.width, 260),
      maxH
    });
  }
  React.useEffect(() => {
    if (!open) return;
    recalcPos();
    const onResize = () => recalcPos();
    const onScroll = () => recalcPos();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true); // capture so modal-body scroll also fires
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  // The dropdown body — extracted so we can portal it cleanly.
  const dropdown = open && popPos ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "ssel-backdrop",
    onClick: () => {
      setOpen(false);
      setQ('');
    }
  }), /*#__PURE__*/React.createElement("div", {
    className: "ssel-pop ssel-pop-portal",
    style: {
      position: 'fixed',
      left: popPos.left,
      ...(popPos.top != null ? {
        top: popPos.top
      } : {}),
      ...(popPos.bottom != null ? {
        bottom: popPos.bottom
      } : {}),
      width: popPos.width
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "ssel-list",
    style: {
      maxHeight: popPos.maxH
    }
  }, sortedFiltered.length ? sortedFiltered.map(s => {
    const isPending = !!(pendingByKey && lessonTypeId && weekStartDate && pendingByKey[`${s.id}:${lessonTypeId}:${weekStartDate}`]);
    const isTrial = isTrialFor(s);
    const pendingInfo = isPending ? pendingByKey[`${s.id}:${lessonTypeId}:${weekStartDate}`] : null;
    return /*#__PURE__*/React.createElement("button", {
      key: s.id,
      type: "button",
      className: `ssel-item ${isPending ? 'ssel-item-pending' : ''} ${isTrial ? 'ssel-item-trial' : ''}`,
      onClick: () => choose(s)
    }, /*#__PURE__*/React.createElement("span", {
      className: "ssel-item-main"
    }, isPending ? /*#__PURE__*/React.createElement("span", {
      className: "ssel-flag ssel-flag-r",
      title: `Pending replacement from ${pendingInfo.original_session_label}`
    }, "R-pending") : null, isTrial ? /*#__PURE__*/React.createElement("span", {
      className: "ssel-flag ssel-flag-trial",
      title: "Trial swimmer \u2014 one-off booking for this lesson type"
    }, "trial") : null, /*#__PURE__*/React.createElement("span", {
      className: "ssel-item-name"
    }, s.name)), /*#__PURE__*/React.createElement("span", {
      className: "ssel-item-meta"
    }, s.age != null ? `${s.age}y` : '', isPending ? ` · from ${pendingInfo.original_session_label}` : s.package ? ` · ${s.package}` : ''));
  }) : /*#__PURE__*/React.createElement("div", {
    className: "ssel-empty"
  }, "No swimmers found")))) : null;
  return /*#__PURE__*/React.createElement("div", {
    className: "ssel",
    ref: triggerRef
  }, /*#__PURE__*/React.createElement("div", {
    className: `ssel-control ${label ? 'has' : ''}`
  }, /*#__PURE__*/React.createElement("input", {
    className: "ssel-input",
    type: "text",
    value: open ? q : label,
    placeholder: label ? '' : 'Type to search swimmer…',
    onFocus: () => {
      setOpen(true);
      setQ('');
    },
    onChange: e => {
      setQ(e.target.value);
      if (!open) setOpen(true);
    }
  }), label ? /*#__PURE__*/React.createElement("span", {
    className: "ssel-x",
    title: "Clear slot",
    onMouseDown: e => {
      e.preventDefault();
      onPick(null);
      setQ('');
      setOpen(false);
    }
  }, "\xD7") : /*#__PURE__*/React.createElement("span", {
    className: "ssel-caret",
    title: "Browse",
    onMouseDown: e => {
      e.preventDefault();
      setOpen(o => !o);
      setQ('');
    }
  }, "\u25BE")), conflict ? /*#__PURE__*/React.createElement("div", {
    className: "ssel-warn"
  }, "\u26A0 Also booked ", conflict, " this week") : null, dropdown ? ReactDOM.createPortal(dropdown, document.body) : null);
}

// Shared component used by both the register form and the editor — renders
// a list of (Lesson Type, Package) rows with a "+ Add Lessons" button.
// Already-selected lesson types are filtered out of the dropdown for the
// other rows so the unique(student_id, lesson_type_id) constraint is never
// violated by the UI.
function LessonsEditor({
  enrollments,
  setEnrollments,
  lessonTypes,
  packages
}) {
  function update(idx, field, value) {
    const next = enrollments.map((e, i) => i === idx ? {
      ...e,
      [field]: value,
      ...(field === 'lessonTypeId' ? {
        packageId: ''
      } : {})
    } : e);
    setEnrollments(next);
  }
  function add() {
    setEnrollments([...enrollments, {
      lessonTypeId: '',
      packageId: ''
    }]);
  }
  function remove(idx) {
    setEnrollments(enrollments.filter((_, i) => i !== idx));
  }
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "lessons-rows"
  }, enrollments.map((e, i) => {
    const ltPkgs = e.lessonTypeId ? (packages || []).filter(p => p.lesson_type_id === e.lessonTypeId && p.is_active !== false) : [];
    const usedLtIds = enrollments.map((en, j) => j !== i ? en.lessonTypeId : null).filter(Boolean);
    const availableLts = (lessonTypes || []).filter(lt => !usedLtIds.includes(lt.id));
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      className: "lesson-row"
    }, /*#__PURE__*/React.createElement("select", {
      className: "select",
      value: e.lessonTypeId,
      onChange: ev => update(i, 'lessonTypeId', ev.target.value)
    }, /*#__PURE__*/React.createElement("option", {
      value: ""
    }, "\u2014 Lesson Type \u2014"), availableLts.map(lt => /*#__PURE__*/React.createElement("option", {
      key: lt.id,
      value: lt.id
    }, lt.name))), /*#__PURE__*/React.createElement("select", {
      className: "select",
      value: e.packageId || '',
      onChange: ev => update(i, 'packageId', ev.target.value),
      disabled: !e.lessonTypeId
    }, /*#__PURE__*/React.createElement("option", {
      value: ""
    }, e.lessonTypeId ? '— Package —' : '← pick type first'), ltPkgs.map(p => /*#__PURE__*/React.createElement("option", {
      key: p.id,
      value: p.id
    }, p.name, p.amount != null ? ` · RM${p.amount}` : '', billingText(p.billing_mode, p.billing_count) ? ` · ${billingText(p.billing_mode, p.billing_count)}` : ''))), enrollments.length > 1 ? /*#__PURE__*/React.createElement("button", {
      type: "button",
      className: "lesson-row-x",
      onClick: () => remove(i),
      title: "Remove this lesson"
    }, "\xD7") : /*#__PURE__*/React.createElement("span", {
      className: "lesson-row-x-spacer"
    }));
  })), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "btn btn-ghost lesson-add-btn",
    onClick: add
  }, "+ Add Lessons"));
}
function StudentEditor({
  row,
  lessonTypes,
  packages,
  onSave,
  hideAccountSections
}) {
  const [name, setName] = useState(row.name || '');
  const [dob, setDob] = useState(row.dob || '');
  const [gender, setGender] = useState(row.gender || null);
  const [enrollments, setEnrollments] = useState(row.enrollments && row.enrollments.length ? row.enrollments.map(e => ({
    lessonTypeId: e.lessonTypeId || '',
    packageId: e.packageId || ''
  })) : row.lessonTypeIds && row.lessonTypeIds.length ? row.lessonTypeIds.map((ltId, i) => ({
    lessonTypeId: ltId,
    packageId: i === 0 ? row.packageId || '' : ''
  })) : [{
    lessonTypeId: '',
    packageId: ''
  }]);
  const [guardianName, setGuardianName] = useState(row.guardianName || '');
  const [guardianEmail, setGuardianEmail] = useState(row.guardianEmail || '');
  const [guardianPhone, setGuardianPhone] = useState(row.guardianPhone || '');
  const [sameAsGuardian, setSameAsGuardian] = useState(!!row.emergencySameAsGuardian);
  const [emergencyPhone, setEmergencyPhone] = useState(row.emergencyPhone || '');
  const [emergencyRel, setEmergencyRel] = useState(row.emergencyRelationship || '');
  // Adult-self defaults to true on edits where the swimmer's name matches
  // the guardian name (legacy data import heuristic), but mostly it's
  const [emergencyName, setEmergencyName] = useState(row.emergencyName || '');
  // user-toggled on the +New Account flow.
  const [adultSelf, setAdultSelf] = useState(!!(row.name && row.guardianName && row.name === row.guardianName));
  function handleSameAsGuardian(v) {
    setSameAsGuardian(v);
    if (v) {
      setEmergencyName(guardianName);
      setEmergencyPhone(guardianPhone);
      setEmergencyRel('Account Holder');
    }
  }
  // Adult-self: account holder name == swimmer name. Pre-fills swimmer
  // name from the (already typed) account holder name when toggled on,
  // and keeps them in sync while the toggle is active.
  function handleAdultSelf(v) {
    setAdultSelf(v);
    if (v) {
      if (guardianName) setName(guardianName);else if (name) setGuardianName(name);
    }
  }
  const computedAge = dob ? ageFromDob(dob) : null;
  return /*#__PURE__*/React.createElement("div", {
    className: "lesson-edit"
  }, !hideAccountSections && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "account-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "account-section-title"
  }, "Parent / Guardian (Account Holder)"), /*#__PURE__*/React.createElement("div", {
    className: "form-grid",
    style: {
      gridTemplateColumns: '1fr 1fr 1fr'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Parent Name"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: guardianName,
    onChange: e => {
      setGuardianName(e.target.value);
      if (adultSelf) setName(e.target.value);
      if (sameAsGuardian) setEmergencyName(e.target.value);
    },
    onBlur: e => {
      const v = toTitleCase(e.target.value);
      setGuardianName(v);
      if (adultSelf) setName(v);
      if (sameAsGuardian) setEmergencyName(v);
    },
    placeholder: "Full name"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Email"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "email",
    value: guardianEmail,
    onChange: e => setGuardianEmail(e.target.value),
    placeholder: "email@example.com"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Phone"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "tel",
    value: guardianPhone,
    onChange: e => {
      setGuardianPhone(e.target.value);
      if (sameAsGuardian) setEmergencyPhone(e.target.value);
    },
    placeholder: "+60 1X-XXXXXXX"
  })))), /*#__PURE__*/React.createElement("div", {
    className: "account-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "account-section-title"
  }, "Emergency Contact"), /*#__PURE__*/React.createElement("label", {
    className: "gb-check",
    style: {
      marginBottom: 7,
      display: 'inline-flex',
      gap: 6,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: sameAsGuardian,
    onChange: e => handleSameAsGuardian(e.target.checked)
  }), " Same as account holder above"), /*#__PURE__*/React.createElement("div", {
    className: "form-grid",
    style: {
      gridTemplateColumns: '1fr 1fr 1fr'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Emergency Contact Name"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: sameAsGuardian ? guardianName : emergencyName,
    onChange: e => setEmergencyName(e.target.value),
    onBlur: e => setEmergencyName(toTitleCase(e.target.value)),
    disabled: sameAsGuardian,
    placeholder: "Full name"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Phone"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "tel",
    value: sameAsGuardian ? guardianPhone : emergencyPhone,
    onChange: e => setEmergencyPhone(e.target.value),
    disabled: sameAsGuardian,
    placeholder: "+60 1X-XXXXXXX"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Relationship"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: sameAsGuardian ? 'Account Holder' : emergencyRel,
    onChange: e => setEmergencyRel(e.target.value),
    disabled: sameAsGuardian,
    placeholder: "e.g. Mother, Father, Spouse, Sibling"
  }))))), /*#__PURE__*/React.createElement("div", {
    className: "student-form-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "student-form-section-title"
  }, "Swimmer Details"), /*#__PURE__*/React.createElement("div", {
    className: "form-grid",
    style: {
      gridTemplateColumns: '1.3fr 130px 60px auto'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Name"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: name,
    onChange: e => {
      setName(e.target.value);
      if (adultSelf) setGuardianName(e.target.value);
    },
    onBlur: e => {
      const v = toTitleCase(e.target.value);
      setName(v);
      if (adultSelf) setGuardianName(v);
    },
    disabled: adultSelf && !!guardianName
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Date of Birth"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "date",
    value: dob,
    max: todayStr(),
    onChange: e => setDob(e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Age"), /*#__PURE__*/React.createElement("div", {
    className: `age-display ${computedAge == null ? 'is-empty' : ''}`,
    "aria-label": "Auto-calculated age"
  }, ageDisplay(computedAge))), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Gender"), /*#__PURE__*/React.createElement("div", {
    className: "gender-toggle"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `gender-opt ${gender === 'female' ? 'active' : ''}`,
    onClick: () => setGender(gender === 'female' ? null : 'female')
  }, "\u2640 F"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `gender-opt ${gender === 'male' ? 'active' : ''}`,
    onClick: () => setGender(gender === 'male' ? null : 'male')
  }, "\u2642 M"))))), /*#__PURE__*/React.createElement("div", {
    className: "student-form-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "student-form-section-title"
  }, "Lessons"), /*#__PURE__*/React.createElement(LessonsEditor, {
    enrollments: enrollments,
    setEnrollments: setEnrollments,
    lessonTypes: lessonTypes,
    packages: packages
  })), !hideAccountSections && /*#__PURE__*/React.createElement("label", {
    className: "adult-self-toggle gb-check"
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: adultSelf,
    onChange: e => handleAdultSelf(e.target.checked)
  }), /*#__PURE__*/React.createElement("span", null, "Adult swimmer \u2014 I am my own guardian ", /*#__PURE__*/React.createElement("span", {
    className: "subtle small"
  }, "(pre-fill swimmer name with account holder name)"))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'flex-end',
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary",
    onClick: () => {
      const v = name.trim();
      if (!v) return;
      // In nested mode (editing a swimmer under an existing account),
      // the patch omits guardian/emergency — those are owned at the
      // account level and propagated separately by ParentContactEditor.
      const patch = {
        name: v,
        dateOfBirth: dob || null,
        gender,
        enrollments
      };
      if (!hideAccountSections) {
        patch.guardianName = guardianName;
        patch.guardianEmail = guardianEmail;
        patch.guardianPhone = guardianPhone;
        patch.emergencySameAsGuardian = sameAsGuardian;
        patch.emergencyName = sameAsGuardian ? guardianName : emergencyName;
        patch.emergencyPhone = sameAsGuardian ? guardianPhone : emergencyPhone;
        patch.emergencyRelationship = sameAsGuardian ? 'Account Holder' : emergencyRel;
      }
      onSave(patch);
    }
  }, "Save Swimmer")));
}

// ============================================================================
// CreditHistoryPanel — per-swimmer credit ledger. Shows running balance per
// lesson-type, the chronological purchase history beneath, and an inline
// "Add purchase" form. Each purchase row is the authoritative record of
// when credits arrived; the running balance in student_credit_balances is
// the denormalised cache that the schedule reads. Adding a purchase
// bumps the balance; deleting one reverses it.
// ============================================================================
// ============================================================================
// BalanceAdjuster — small inline "Set balance to N" widget. Writes a
// manual credit_purchase for the delta between current and target so the
// running balance moves there cleanly and the adjustment is logged.
// Solves the legacy-balance problem where a directly-seeded
// student_credit_balances row has no purchase or subscription to undo.
// ============================================================================
function BalanceAdjuster({
  currentBalance,
  onApply
}) {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState(String(currentBalance));
  function submit() {
    const target = Math.max(0, parseInt(val, 10) || 0);
    if (target === currentBalance) {
      setOpen(false);
      return;
    }
    if (!confirm(`Set balance to ${target}? (Currently ${currentBalance}.)\n\nThis will record a manual adjustment of ${target - currentBalance > 0 ? '+' : ''}${target - currentBalance} credits.`)) return;
    onApply(target, null);
    setOpen(false);
  }
  if (!open) {
    return /*#__PURE__*/React.createElement("button", {
      className: "btn btn-ghost small",
      title: "Manually set balance to a specific value",
      onClick: () => {
        setVal(String(currentBalance));
        setOpen(true);
      }
    }, "\u2696 Adjust");
  }
  return /*#__PURE__*/React.createElement("span", {
    className: "balance-adjust-form"
  }, /*#__PURE__*/React.createElement("span", {
    className: "balance-adjust-label"
  }, "Set to:"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "number",
    min: "0",
    value: val,
    onChange: e => setVal(e.target.value),
    onKeyDown: e => {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') setOpen(false);
    },
    style: {
      width: 60,
      padding: '3px 6px',
      fontSize: 11
    },
    autoFocus: true
  }), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary small",
    onClick: submit
  }, "Apply"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: () => setOpen(false)
  }, "Cancel"));
}
function CreditHistoryPanel({
  swimmer,
  lessonTypes,
  lessonTypeById,
  purchases,
  subscriptions,
  creditByKey,
  groupById,
  membersByGroup,
  addCreditPurchase,
  deleteCreditPurchase,
  addSubscription,
  cancelSubscription,
  adjustBalanceTo,
  onClose
}) {
  // Group context: who is this swimmer's family group, and is it bound?
  // Bound-group members have credit operations locked to the group level
  // (the Family Groups panel handles add/cancel for all members at once).
  const group = swimmer.familyGroupId && groupById ? groupById[swimmer.familyGroupId] : null;
  const isBoundMember = !!(group && group.groupType === 'bound');
  const isUnboundGroupMember = !!(group && group.groupType !== 'bound');
  const swimmerLts = (swimmer.lessonTypeIds || []).map(id => lessonTypeById(id)).filter(Boolean);
  const defaultLtId = swimmerLts[0]?.id || lessonTypes[0]?.id || '';
  const [purchaseDate, setPurchaseDate] = useState(toDateStr(new Date()));
  const [ltId, setLtId] = useState(defaultLtId);
  const [credits, setCredits] = useState(4);
  const [source, setSource] = useState('topup');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  // Group purchases by lesson type so each LT shows its own ledger.
  const purchasesByLt = {};
  (purchases || []).forEach(p => {
    (purchasesByLt[p.lesson_type_id] = purchasesByLt[p.lesson_type_id] || []).push(p);
  });
  // Sort within each LT by date desc (newest first).
  Object.values(purchasesByLt).forEach(arr => arr.sort((a, b) => (b.purchase_date || '').localeCompare(a.purchase_date || '') || (b.created_at || '').localeCompare(a.created_at || '')));

  // Lesson types to display — all enrolled types, plus any LT that has
  // purchase history but no current enrollment (so historical records
  // don't vanish when a swimmer un-enrolls).
  const displayLtIds = new Set(swimmerLts.map(lt => lt.id));
  Object.keys(purchasesByLt).forEach(id => displayLtIds.add(id));
  const displayLts = [...displayLtIds].map(id => lessonTypeById(id)).filter(Boolean);
  async function submitPurchase() {
    if (!ltId || !credits) return;
    setBusy(true);
    try {
      await addCreditPurchase({
        studentId: swimmer.id,
        lessonTypeId: ltId,
        purchaseDate,
        creditsAdded: Number(credits),
        source,
        notes: notes.trim() || null
      });
      // Reset for the next entry but keep the LT + source so the user
      // can add multiple top-ups quickly.
      setCredits(4);
      setNotes('');
    } finally {
      setBusy(false);
    }
  }
  function fmtDate(d) {
    if (!d) return '';
    try {
      return new Date(d).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      });
    } catch (_) {
      return d;
    }
  }
  function sourceLabel(s) {
    if (s === 'signup') return '🆕 Sign-up';
    if (s === 'topup') return '💳 Top-up';
    if (s === 'gift') return '🎁 Gift';
    if (s === 'manual') return '✏️ Manual';
    if (s === 'refund') return '↩ Refund';
    return s || '—';
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "credit-panel"
  }, /*#__PURE__*/React.createElement("div", {
    className: "credit-panel-head"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "credit-panel-title"
  }, "\uD83D\uDCB3 Credit ledger \xB7 ", swimmer.name), /*#__PURE__*/React.createElement("div", {
    className: "credit-panel-sub"
  }, "Every purchase recorded with its date. The running balance is purchases minus credits consumed by attendance.")), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: onClose
  }, "Close")), /*#__PURE__*/React.createElement("div", {
    className: "credit-add-form"
  }, /*#__PURE__*/React.createElement("div", {
    className: "credit-add-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Date"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "date",
    value: purchaseDate,
    onChange: e => setPurchaseDate(e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Lesson Type"), /*#__PURE__*/React.createElement("select", {
    className: "select",
    value: ltId,
    onChange: e => setLtId(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "\u2014 select \u2014"), (lessonTypes || []).map(lt => /*#__PURE__*/React.createElement("option", {
    key: lt.id,
    value: lt.id
  }, lt.name)))), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Credits"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "number",
    value: credits,
    onChange: e => setCredits(e.target.value),
    placeholder: "4"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Source"), /*#__PURE__*/React.createElement("select", {
    className: "select",
    value: source,
    onChange: e => setSource(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: "signup"
  }, "Sign-up"), /*#__PURE__*/React.createElement("option", {
    value: "topup"
  }, "Top-up"), /*#__PURE__*/React.createElement("option", {
    value: "gift"
  }, "Gift"), /*#__PURE__*/React.createElement("option", {
    value: "manual"
  }, "Manual adjustment"), /*#__PURE__*/React.createElement("option", {
    value: "refund"
  }, "Refund"))), /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      flex: '2 1 240px'
    }
  }, /*#__PURE__*/React.createElement("label", null, "Notes ", /*#__PURE__*/React.createElement("span", {
    className: "subtle",
    style: {
      textTransform: 'none',
      letterSpacing: 0,
      fontWeight: 600
    }
  }, "\xB7 optional")), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: notes,
    onChange: e => setNotes(e.target.value),
    placeholder: "e.g. cash, receipt #1234"
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'flex-end',
      marginTop: 6,
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "credit-add-hint"
  }, "Use negative credits to record a manual deduction (e.g. expiry)."), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary small",
    onClick: submitPurchase,
    disabled: busy || !ltId || !Number(credits)
  }, busy ? 'Saving…' : '+ Record purchase'))), group ? /*#__PURE__*/React.createElement("div", {
    className: `credit-group-banner ${isBoundMember ? 'credit-group-banner-bound' : ''}`
  }, isBoundMember ? /*#__PURE__*/React.createElement(React.Fragment, null, "\uD83D\uDD17 ", /*#__PURE__*/React.createElement("strong", null, group.name), " \xB7 bound group \u2014 all subscription changes happen at the group level. Individual purchase records are kept for the audit trail but no manual +/\u2212 adjustments are made here.") : /*#__PURE__*/React.createElement(React.Fragment, null, "\uD83D\uDC6A ", /*#__PURE__*/React.createElement("strong", null, group.name), " \xB7 discount group \u2014 subscriptions can be added at the group level (adds to all members) and balances can diverge per-swimmer based on attendance.")) : null, displayLts.length === 0 && /*#__PURE__*/React.createElement("div", {
    className: "credit-panel-empty"
  }, "No lesson-type enrolments yet. Add one in Edit, then record a purchase here."), displayLts.map(lt => {
    const bal = creditByKey[`${swimmer.id}:${lt.id}`];
    const list = purchasesByLt[lt.id] || [];
    const totalPurchased = list.reduce((sum, p) => sum + Number(p.credits_added || 0), 0);
    // Subscriptions affecting this swimmer for this LT — either as
    // direct subject (student type) or as member of their family group
    // (group type).
    const subs = (subscriptions || []).filter(s => s.lesson_type_id === lt.id && (s.subject_type === 'student' && s.subject_id === swimmer.id || s.subject_type === 'family_group' && swimmer.familyGroupId && s.subject_id === swimmer.familyGroupId)).slice().sort((a, b) => (b.subscription_date || '').localeCompare(a.subscription_date || ''));
    // Subscription-quick-add is shown for individuals and unbound group
    // members (the latter triggers a group-wide subscription). Bound
    // group members must use the Family Groups panel.
    const canQuickSub = !isBoundMember && addSubscription;
    return /*#__PURE__*/React.createElement("div", {
      key: lt.id,
      className: "credit-lt-block"
    }, /*#__PURE__*/React.createElement("div", {
      className: "credit-lt-head"
    }, /*#__PURE__*/React.createElement("span", {
      className: "credit-lt-name",
      style: {
        background: lt.bg_color,
        color: lt.text_color,
        borderColor: lt.border_color
      }
    }, lt.name), /*#__PURE__*/React.createElement("span", {
      className: "credit-lt-totals"
    }, bal ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("strong", {
      className: bal.remaining_balance <= 2 ? 'credit-low' : ''
    }, bal.remaining_balance), " credits") : /*#__PURE__*/React.createElement("em", {
      className: "subtle"
    }, "No balance row yet"), list.length > 0 && /*#__PURE__*/React.createElement("span", {
      className: "credit-lt-aggregate"
    }, " \xB7 ", totalPurchased > 0 ? '+' : '', totalPurchased, " credits across ", list.length, " record", list.length === 1 ? '' : 's')), adjustBalanceTo && !isBoundMember && /*#__PURE__*/React.createElement(BalanceAdjuster, {
      currentBalance: bal ? Number(bal.remaining_balance) || 0 : 0,
      onApply: (target, notes) => adjustBalanceTo(swimmer.id, lt.id, target, notes)
    })), canQuickSub && null /* Quick subscription buttons removed — use Adjust or record via Pending Credits */, subs.length > 0 && /*#__PURE__*/React.createElement("div", {
      className: "credit-sub-list"
    }, /*#__PURE__*/React.createElement("div", {
      className: "credit-sub-list-title"
    }, "Subscription log"), subs.map(s => /*#__PURE__*/React.createElement("div", {
      key: s.id,
      className: `credit-sub-row ${s.cancelled_at ? 'is-cancelled' : ''}`
    }, /*#__PURE__*/React.createElement("span", {
      className: "credit-sub-date"
    }, fmtDate(s.subscription_date)), /*#__PURE__*/React.createElement("span", {
      className: "credit-sub-amount"
    }, "+", s.credits_per_swimmer, " \xD7 ", s.swimmer_count), /*#__PURE__*/React.createElement("span", {
      className: "credit-sub-subject"
    }, s.subject_type === 'family_group' ? `👪 ${group?.name || 'group'}` : '👤 individual'), /*#__PURE__*/React.createElement("span", {
      className: "credit-sub-meta subtle"
    }, s.source, s.amount_paid != null ? ` · RM${s.amount_paid}` : '', s.receipt_number ? ` · ${s.receipt_number}` : ''), s.cancelled_at ? /*#__PURE__*/React.createElement("span", {
      className: "credit-sub-cancelled-tag"
    }, "Cancelled") : cancelSubscription ? /*#__PURE__*/React.createElement("button", {
      className: "btn btn-ghost small",
      title: "Cancel this subscription (reverses credits, keeps the record)",
      onClick: () => cancelSubscription(s)
    }, "Cancel") : null))), list.length === 0 ? /*#__PURE__*/React.createElement("div", {
      className: "credit-empty"
    }, "No purchases recorded for this lesson type.") : /*#__PURE__*/React.createElement("table", {
      className: "credit-ledger"
    }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
      style: {
        width: 120
      }
    }, "Date"), /*#__PURE__*/React.createElement("th", {
      style: {
        width: 90
      }
    }, "Credits"), /*#__PURE__*/React.createElement("th", {
      style: {
        width: 130
      }
    }, "Source"), /*#__PURE__*/React.createElement("th", null, "Notes"), /*#__PURE__*/React.createElement("th", {
      style: {
        width: 36
      }
    }))), /*#__PURE__*/React.createElement("tbody", null, list.map(p => /*#__PURE__*/React.createElement("tr", {
      key: p.id,
      className: p.subscription_id ? 'is-from-sub' : ''
    }, /*#__PURE__*/React.createElement("td", {
      style: {
        fontWeight: 600
      }
    }, fmtDate(p.purchase_date)), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
      className: `credit-delta ${Number(p.credits_added) < 0 ? 'credit-delta-neg' : 'credit-delta-pos'}`
    }, Number(p.credits_added) > 0 ? '+' : '', p.credits_added)), /*#__PURE__*/React.createElement("td", null, sourceLabel(p.source)), /*#__PURE__*/React.createElement("td", {
      className: "subtle"
    }, p.notes || '—'), /*#__PURE__*/React.createElement("td", null, !isBoundMember && /*#__PURE__*/React.createElement("button", {
      className: "btn btn-danger small",
      title: "Delete this purchase record",
      onClick: () => deleteCreditPurchase(p)
    }, "\xD7")))))));
  }));
}

// ============================================================================
// ReceiptsView — consolidated subscription / receipt log. Lists every
// subscription in date order with filters by status (active / cancelled /
// all), with a one-click cancel and a printable receipt per row.
// ============================================================================
// ============================================================================
// Swimmer accent palette — six tasteful pastel-derived colours that cycle
// per swimmer-index inside an account. Lets the user visually scan "this
// is Lee Wei's row vs Lee Mei's row" without reading the name. Each
// entry pairs a saturated accent (used for the left-bar + name colour)
// with a darker text tone for the swimmer name. Hand-picked to fit the
// app's existing lesson-type palette DNA.
// ============================================================================
const SWIMMER_ACCENTS = [{
  accent: '#06B6D4',
  text: '#0E7490'
},
// cyan
{
  accent: '#8B5CF6',
  text: '#5B21B6'
},
// violet
{
  accent: '#F43F5E',
  text: '#9F1239'
},
// rose
{
  accent: '#F59E0B',
  text: '#92400E'
},
// amber
{
  accent: '#10B981',
  text: '#065F46'
},
// emerald
{
  accent: '#3B82F6',
  text: '#1E40AF'
} // blue
];
function swimmerAccent(idx) {
  return SWIMMER_ACCENTS[idx % SWIMMER_ACCENTS.length];
}

// ============================================================================
// ParentsView — the de facto administration page. Every operation that
// concerns a parent or their child(ren) happens here:
//   • Create a new parent (which seeds them with their first swimmer)
//   • Edit parent contact (propagates to all children's guardian fields)
//   • Add / edit / delete swimmers under a parent (full StudentEditor)
//   • Create or assign bound/discount family groups for a parent's kids
//   • Credit management: quick subscription buttons, balance adjustment,
//     subscription log, ledger
// The Swimmers page is intentionally read-only — use this page to admin.
// ============================================================================
// ── BranchFilterPills ────────────────────────────────────────────────────────
// Reusable branch filter row used by Accounts, Invoices, Receipts, Pending Credits.
// value=null means "All branches". onChange receives null or a branch.id string.
function BranchFilterPills({
  branches,
  value,
  onChange
}) {
  if (!branches || branches.length < 2) return null;
  const active = branches.filter(b => b.is_active !== false);
  if (!active.length) return null;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 4,
      flexWrap: 'wrap',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "small subtle",
    style: {
      marginRight: 2
    }
  }, "Branch:"), /*#__PURE__*/React.createElement("button", {
    className: `sub-tab${!value ? ' active' : ''}`,
    style: {
      padding: '3px 10px',
      fontSize: 11,
      height: 26
    },
    onClick: () => onChange(null)
  }, "All"), active.map(b => /*#__PURE__*/React.createElement("button", {
    key: b.id,
    className: `sub-tab${value === b.id ? ' active' : ''}`,
    style: {
      padding: '3px 10px',
      fontSize: 11,
      height: 26,
      ...(value === b.id && b.color ? {
        background: b.color,
        borderColor: b.color,
        color: '#fff'
      } : {})
    },
    onClick: () => onChange(value === b.id ? null : b.id)
  }, b.code || b.name)));
}
function ParentsView({
  accountSection,
  setAccountSection,
  branches,
  parentGroups,
  lessonTypes,
  lessonTypeById,
  packages,
  packageById,
  familyGroups,
  groupById,
  membersByGroup,
  creditByKey,
  subscriptions,
  addStudent,
  updateStudent,
  deleteStudent,
  deleteAccount,
  addGroup,
  updateGroup,
  deleteGroup,
  setStudentGroup,
  addStudentToGroup,
  removeStudentFromGroup,
  groupIdsByStudent,
  addSubscription,
  cancelSubscription,
  adjustBalanceTo,
  scheduleByStudent,
  sessions,
  poolById,
  selectedWeekStart,
  createInvoice,
  setAdminSection,
  onJumpToSession,
  setView,
  externalSearchQ
}) {
  // ── Sub-view driven by external accountSection prop (from nav dropdown) ──
  const adminView = accountSection || 'accounts';
  const setAdminView = v => {
    if (setAccountSection) setAccountSection(v);
  };
  // Search comes from the sticky sub-bar when provided; falls back to internal state
  const [localSearchQ, setLocalSearchQ] = useState('');
  const searchQ = externalSearchQ !== undefined ? externalSearchQ : localSearchQ;
  const setSearchQ = setLocalSearchQ;
  const [statusFilter, setStatusFilter] = useState('active');
  const [expandedKey, setExpandedKey] = useState(null);
  const [contactEditKey, setContactEditKey] = useState(null);
  const [addingSwimmerFor, setAddingSwimmerFor] = useState(null);
  const [editingSwimmerId, setEditingSwimmerId] = useState(null);
  const [groupPanelKey, setGroupPanelKey] = useState(null);
  const [billingKey, setBillingKey] = useState(null);
  const [selectedAccountKeys, setSelectedAccountKeys] = useState(new Set());
  const [batchBusy, setBatchBusy] = useState(false);

  // ── Account printout ────────────────────────────────────────────────
  // Opens a popup with a clean, parent-friendly summary: account holder,
  // family groups, each swimmer's lesson types + packages, and their
  // scheduled class sessions for the viewed week.
  function printAccountSummary(pg) {
    const wb = weekBounds(selectedWeekStart || todayStr());
    const weekLabel = `${wb.start.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    })} – ${wb.end.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    })}`;
    const groupsInPlay = [...new Set(pg.swimmers.flatMap(s => s.familyGroupIds || []))].map(gid => groupById?.[gid]).filter(Boolean);
    const groupsHtml = groupsInPlay.length ? groupsInPlay.map(g => {
      const pkg = g.packageId ? packageById?.(g.packageId) : null;
      const lt = pkg?.lesson_type_id ? lessonTypeById?.(pkg.lesson_type_id) : null;
      const members = (membersByGroup?.[g.id] || []).map(m => m.name).join(', ');
      return '<div style="margin-top:4px;font-size:10.5pt">' + (g.groupType === 'bound' ? '🔗' : '👪') + ' <strong>' + g.name + '</strong>' + (lt && pkg ? ' · ' + lt.name + ' · ' + pkg.name : '') + '<div style="font-size:10pt;color:#555;margin-left:18px">Members: ' + (members || 'None') + '</div></div>';
    }).join('') : '<div style="font-size:10pt;color:#999">No family groups</div>';
    const swimmerSections = pg.swimmers.map(sw => {
      const enrolments = sw.enrollments || [];
      // Build per-swimmer schedule from sessions directly (scheduleByStudent
      // doesn't carry weekStartDate or instructor/pool context).
      const weekSessions = (sessions || []).filter(s => s.weekStartDate === (selectedWeekStart || ''));
      const swSessions = weekSessions.filter(s => (s.students || []).some(st => st.studentId === sw.id));
      const slotsByLt = {};
      swSessions.forEach(s => {
        const k = s.lessonTypeId || '_';
        (slotsByLt[k] = slotsByLt[k] || []).push(s);
      });
      const enrolHtml = enrolments.map(e => {
        const lt = lessonTypeById?.(e.lessonTypeId);
        const pkg = packageById?.(e.packageId);
        const ltSlots = (slotsByLt[e.lessonTypeId] || []).slice().sort((a, b) => a.day - b.day || a.startMinute - b.startMinute);
        const slotLines = ltSlots.map(sl => {
          const pool = sl.poolId && poolById ? poolById(sl.poolId) : null;
          const inst = sl.instructors && sl.instructors[0] && sl.instructors[0].name || sl.legacyInstructor || '';
          return '<div style="margin-left:22px;font-size:10pt;color:#333">' + DAYS_F[sl.day] + ' ' + minuteToTime(sl.startMinute) + '–' + minuteToTime(sl.startMinute + sl.durationMinutes) + (pool ? ' · ' + pool.name : '') + (inst ? ' · ' + inst : '') + '</div>';
        }).join('');
        return '<div style="margin-top:6px"><div style="font-size:10.5pt;font-weight:600">' + (lt?.name || 'Lesson') + ' · ' + (pkg?.name || 'Package') + '</div>' + (slotLines || '<div style="margin-left:22px;font-size:10pt;color:#999">No sessions this week</div>') + '</div>';
      }).join('');
      return '<div style="margin-top:14px;padding:10px 12px;border:1px solid #ccc;border-radius:6px">' + '<div style="font-size:12pt;font-weight:700">' + sw.name + (sw.age != null ? ' · ' + sw.age + 'y' : '') + (sw.gender ? ' · ' + (sw.gender === 'male' ? 'M' : sw.gender === 'female' ? 'F' : sw.gender) : '') + '</div>' + (enrolHtml || '<div style="font-size:10pt;color:#999;margin-top:4px">No enrolments</div>') + '</div>';
    }).join('');
    const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Account Summary – ' + pg.name + '</title>' + '<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Inter,system-ui,-apple-system,sans-serif;color:#111;padding:24px 28px;max-width:720px;margin:0 auto}' + '@page{size:A4 portrait;margin:20mm 16mm}@media print{body{padding:0}}' + '.hdr{border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:14px}' + '.hdr h1{font-size:16pt;font-weight:800;letter-spacing:-.3px}' + '.hdr-meta{font-size:10.5pt;color:#444;margin-top:3px}' + '.section{margin-top:16px}.section-title{font-size:11pt;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#666;border-bottom:1px solid #ddd;padding-bottom:3px;margin-bottom:6px}</style>' + '<script>window.onload=function(){setTimeout(function(){window.print()},400)}<\/script>' + '</head><body>' + '<div class="hdr"><h1>' + pg.name + '</h1>' + '<div class="hdr-meta">' + [pg.email, pg.phone].filter(Boolean).join(' · ') + '</div>' + '<div class="hdr-meta" style="margin-top:2px">Week: ' + weekLabel + '</div></div>' + '<div class="section"><div class="section-title">Family Groups</div>' + groupsHtml + '</div>' + '<div class="section"><div class="section-title">Swimmers & Schedule</div>' + swimmerSections + '</div>' + '<div style="margin-top:24px;font-size:9pt;color:#999;border-top:1px solid #ddd;padding-top:8px">Generated ' + new Date().toLocaleDateString(undefined, {
      dateStyle: 'long'
    }) + ' · Star Swim Sdn Bhd</div>' + '</body></html>';
    const w = window.open('', '_blank');
    if (w) {
      w.document.write(html);
      w.document.close();
    }
  }
  const filtered = (parentGroups || []).filter(pg => {
    if (statusFilter === 'active' && !pg.isActive) return false;
    if (statusFilter === 'archived' && pg.isActive) return false;
    return true;
  }).filter(pg => {
    if (!searchQ.trim()) return true;
    const q = searchQ.toLowerCase();
    if ((pg.name || '').toLowerCase().includes(q)) return true;
    if ((pg.email || '').toLowerCase().includes(q)) return true;
    if ((pg.phone || '').toLowerCase().includes(q)) return true;
    return pg.swimmers.some(s => (s.name || '').toLowerCase().includes(q));
  });

  // Cross-filter hits: accounts matching the search query that live in the
  // OTHER status bucket — visible only when a specific filter is active and
  // the search returns no results (or fewer results) from the current view.
  function matchesSearch(pg) {
    if (!searchQ.trim()) return false;
    const q = searchQ.toLowerCase();
    if ((pg.name || '').toLowerCase().includes(q)) return true;
    if ((pg.email || '').toLowerCase().includes(q)) return true;
    if ((pg.phone || '').toLowerCase().includes(q)) return true;
    return pg.swimmers.some(s => (s.name || '').toLowerCase().includes(q));
  }
  const archiveHits = searchQ.trim() && statusFilter === 'active' ? (parentGroups || []).filter(pg => !pg.isActive && matchesSearch(pg)) : [];
  const activeHits = searchQ.trim() && statusFilter === 'archived' ? (parentGroups || []).filter(pg => pg.isActive && matchesSearch(pg)) : [];
  const activeCount = (parentGroups || []).filter(p => p.isActive).length;
  const archivedCount = (parentGroups || []).filter(p => !p.isActive).length;
  const totalSwimmers = (parentGroups || []).reduce((sum, p) => sum + p.swimmers.length, 0);
  const totalActiveCredits = Object.values(creditByKey || {}).reduce((sum, b) => sum + (Number(b.remaining_balance) || 0), 0);

  // Propagate parent-level contact + emergency edits to every child's
  // guardian_*/emergency_* fields so the account is the single source of
  // truth for who to call.
  async function saveParentContact(pg, patch) {
    for (const s of pg.swimmers) {
      await updateStudent(s.id, {
        guardianName: patch.guardianName,
        guardianEmail: patch.guardianEmail,
        guardianPhone: patch.guardianPhone,
        emergencyName: patch.emergencySameAsGuardian ? patch.guardianName : patch.emergencyName,
        emergencyPhone: patch.emergencySameAsGuardian ? patch.guardianPhone : patch.emergencyPhone,
        emergencyRelationship: patch.emergencySameAsGuardian ? 'Account Holder' : patch.emergencyRelationship,
        emergencySameAsGuardian: !!patch.emergencySameAsGuardian
      });
    }
    setContactEditKey(null);
  }

  // Archive/restore parent — flips is_active on every child. Status is
  // derived (any active swimmer ⇒ active parent), so toggling all of
  // them together keeps the derived state coherent.
  async function setParentArchived(pg, archived) {
    const verb = archived ? 'archive' : 'restore';
    if (!confirm(`${archived ? 'Archive' : 'Restore'} parent "${pg.name}" and all ${pg.swimmers.length} of their swimmer${pg.swimmers.length === 1 ? '' : 's'}?`)) return;
    for (const s of pg.swimmers) {
      await updateStudent(s.id, {
        isActive: !archived
      });
    }
  }

  // deleteAccount is passed as a prop from App scope

  return /*#__PURE__*/React.createElement(React.Fragment, null, adminView === 'familyGroups' && /*#__PURE__*/React.createElement(FamilyGroupsAdminView, {
    familyGroups: familyGroups,
    membersByGroup: membersByGroup,
    lessonTypes: lessonTypes,
    lessonTypeById: lessonTypeById,
    packages: packages,
    packageById: packageById,
    deleteGroup: deleteGroup,
    updateGroup: updateGroup,
    externalSearchQ: externalSearchQ
  }), adminView === 'accounts' && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      gap: 12,
      flexWrap: 'wrap',
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 18,
      fontWeight: 800
    }
  }, "\uD83D\uDC64 Accounts \u2014 Administration"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      marginTop: 3
    }
  }, "An account is either a parent registering one or more children, or an adult swimmer registering themselves. Click an account to expand, then edit contact, add or edit swimmers, manage family groups, and adjust credits.")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 14,
      alignItems: 'flex-end',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, "Accounts"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 22,
      fontWeight: 800,
      color: 'var(--primary)'
    }
  }, (parentGroups || []).length)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, "Swimmers"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 22,
      fontWeight: 800,
      color: 'var(--text)'
    }
  }, totalSwimmers)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, "Active credits"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 22,
      fontWeight: 800,
      color: 'var(--teal)'
    }
  }, totalActiveCredits)))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      alignItems: 'center',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("label", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      cursor: 'pointer',
      fontSize: 12,
      color: 'var(--text-2)',
      userSelect: 'none'
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: selectedAccountKeys.size === filtered.length && filtered.length > 0,
    ref: el => {
      if (el) el.indeterminate = selectedAccountKeys.size > 0 && selectedAccountKeys.size < filtered.length;
    },
    onChange: () => {
      if (selectedAccountKeys.size === filtered.length) setSelectedAccountKeys(new Set());else setSelectedAccountKeys(new Set(filtered.map(p => p.key)));
    }
  }), " Select all"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    style: {
      flex: 1,
      minWidth: 200,
      maxWidth: 420,
      display: 'none'
    },
    placeholder: "Search by account name, email, phone, or swimmer name\u2026",
    value: searchQ,
    onChange: e => setSearchQ(e.target.value)
  }), /*#__PURE__*/React.createElement("div", {
    className: "tabs",
    style: {
      gap: 2,
      padding: 2
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: `tab ${statusFilter === 'active' ? 'active' : ''}`,
    style: {
      padding: '4px 10px',
      fontSize: 11
    },
    onClick: () => setStatusFilter('active')
  }, "Active (", activeCount, ")"), /*#__PURE__*/React.createElement("button", {
    className: `tab ${statusFilter === 'archived' ? 'active' : ''}`,
    style: {
      padding: '4px 10px',
      fontSize: 11
    },
    onClick: () => setStatusFilter('archived')
  }, "Archived (", archivedCount, ")"), /*#__PURE__*/React.createElement("button", {
    className: `tab ${statusFilter === 'all' ? 'active' : ''}`,
    style: {
      padding: '4px 10px',
      fontSize: 11
    },
    onClick: () => setStatusFilter('all')
  }, "All"))), selectedAccountKeys.size > 0 && /*#__PURE__*/React.createElement("div", {
    className: "inv-bulk-bar",
    style: {
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 700,
      fontSize: 13
    }
  }, selectedAccountKeys.size, " account", selectedAccountKeys.size > 1 ? 's' : '', " selected"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary small",
    disabled: batchBusy,
    onClick: async () => {
      if (!confirm(`Generate invoices for the ${selectedAccountKeys.size} selected account(s)?\n\nEach invoice will be pre-populated with the same line items shown in Billing Preview. Accounts with no billable items will produce a RM 0.00 draft.`)) return;
      setBatchBusy(true);
      let created = 0;
      for (const key of selectedAccountKeys) {
        const pg = (parentGroups || []).find(p => p.key === key);
        if (!pg) continue;
        // Compute billing lines via the same helper BillingPreviewPanel uses
        const {
          allItems
        } = computeBillingLines(pg, groupById, packageById, lessonTypeById, lessonTypes);
        await createInvoice({
          accountName: pg.name,
          accountEmail: pg.email,
          accountPhone: pg.phone,
          lines: allItems,
          notes: 'Batch generated',
          dueDate: null
        });
        created++;
      }
      setBatchBusy(false);
      setSelectedAccountKeys(new Set());
      setAccountSection('invoices');
      setView('accounts');
    }
  }, batchBusy ? 'Generating…' : `🧾 Generate ${selectedAccountKeys.size} Invoice${selectedAccountKeys.size > 1 ? 's' : ''}`), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: () => setSelectedAccountKeys(new Set())
  }, "Clear"))), archiveHits.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "cross-filter-notice"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDDC4 ", archiveHits.length, " ", archiveHits.length === 1 ? 'result' : 'results', " found in ", /*#__PURE__*/React.createElement("strong", null, "Archives"), archiveHits.length === 1 ? `: ${archiveHits[0].name}` : ': ' + archiveHits.map(p => p.name).join(', ')), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: () => {
      setStatusFilter('archived');
      if (archiveHits.length === 1) setExpandedKey(archiveHits[0].key);
    }
  }, archiveHits.length === 1 ? 'Go to account →' : 'Switch to Archives →')), activeHits.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "cross-filter-notice"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDC64 ", activeHits.length, " ", activeHits.length === 1 ? 'result' : 'results', " found in ", /*#__PURE__*/React.createElement("strong", null, "Active accounts"), activeHits.length === 1 ? `: ${activeHits[0].name}` : ': ' + activeHits.map(p => p.name).join(', ')), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: () => {
      setStatusFilter('active');
      if (activeHits.length === 1) setExpandedKey(activeHits[0].key);
    }
  }, activeHits.length === 1 ? 'Go to account →' : 'Switch to Active →')), filtered.length === 0 && /*#__PURE__*/React.createElement("div", {
    className: "card empty",
    style: {
      padding: 30
    }
  }, "No accounts match."), filtered.map(pg => {
    const isExpanded = expandedKey === pg.key;
    const isEditingContact = contactEditKey === pg.key;
    const isAddingSwimmer = addingSwimmerFor === pg.key;
    const isManagingGroup = groupPanelKey === pg.key;
    const swimmerCount = pg.swimmers.length;
    const parentActiveCredits = pg.swimmers.reduce((sum, s) => {
      return sum + (s.lessonTypeIds || []).reduce((s2, ltId) => {
        const b = creditByKey[`${s.id}:${ltId}`];
        return s2 + (b ? Number(b.remaining_balance) || 0 : 0);
      }, 0);
    }, 0);
    const parentSubs = (subscriptions || []).filter(s => {
      if (s.subject_type === 'student' && pg.swimmers.some(sw => sw.id === s.subject_id)) return true;
      if (s.subject_type === 'family_group' && pg.swimmers.some(sw => (sw.familyGroupIds || []).includes(s.subject_id))) return true;
      return false;
    });
    // Distinct family groups that involve this parent's swimmers.
    const parentGroupsInPlay = [...new Set(pg.swimmers.flatMap(s => s.familyGroupIds || []))].map(gid => groupById?.[gid]).filter(Boolean);

    // Session indicator: true when at least one swimmer from this account
    // appears in any session scheduled for the currently-viewed week.
    const swimmerIdSet = new Set(pg.swimmers.map(s => s.id));
    const hasActiveSessions = (sessions || []).some(s => s.weekStartDate === selectedWeekStart && (s.students || []).some(st => st.studentId && swimmerIdSet.has(st.studentId)));
    return /*#__PURE__*/React.createElement("div", {
      key: pg.key,
      className: `parent-card ${!pg.isActive ? 'is-archived' : ''}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "parent-head",
      onClick: e => {
        if (e.target.closest('button,input,select')) return;
        setExpandedKey(isExpanded ? null : pg.key);
      }
    }, /*#__PURE__*/React.createElement("label", {
      style: {
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center'
      },
      onClick: e => e.stopPropagation()
    }, /*#__PURE__*/React.createElement("input", {
      type: "checkbox",
      checked: selectedAccountKeys.has(pg.key),
      onChange: () => {
        const s = new Set(selectedAccountKeys);
        s.has(pg.key) ? s.delete(pg.key) : s.add(pg.key);
        setSelectedAccountKeys(s);
      }
    })), /*#__PURE__*/React.createElement("div", {
      className: "parent-head-main"
    }, /*#__PURE__*/React.createElement("div", {
      className: "parent-name"
    }, hasActiveSessions && /*#__PURE__*/React.createElement("span", {
      className: "acct-session-dot",
      title: `One or more swimmers in this account have sessions scheduled in the week of ${selectedWeekStart}`
    }), pg.name, pg.displayCode && /*#__PURE__*/React.createElement("span", {
      className: "acct-display-code",
      title: "Unique account ID"
    }, pg.displayCode), !pg.isActive && /*#__PURE__*/React.createElement("span", {
      className: "parent-archived-badge",
      title: "All swimmers under this parent are archived"
    }, "\uD83D\uDCE6 Archived")), /*#__PURE__*/React.createElement("div", {
      className: "parent-contact subtle small"
    }, pg.email ? /*#__PURE__*/React.createElement("span", null, "\uD83D\uDCE7 ", pg.email) : null, pg.email && pg.phone ? /*#__PURE__*/React.createElement("span", null, " \xB7 ") : null, pg.phone ? /*#__PURE__*/React.createElement("span", null, "\uD83D\uDCDE ", pg.phone) : null, !pg.email && !pg.phone ? /*#__PURE__*/React.createElement("span", null, "(no contact recorded)") : null, pg.ic ? /*#__PURE__*/React.createElement("span", {
      className: "parent-ic-tin"
    }, " \xB7 \uD83E\uDEAA ", pg.ic) : null, pg.tin ? /*#__PURE__*/React.createElement("span", {
      className: "parent-ic-tin"
    }, " \xB7 \uD83E\uDDFE TIN ", pg.tin) : null, (pg.emergencyName || pg.emergencyPhone) && !pg.emergencySameAsGuardian ? /*#__PURE__*/React.createElement("span", null, " \xB7 \uD83D\uDEA8 ", pg.emergencyName || pg.emergencyPhone, pg.emergencyName && pg.emergencyPhone ? ` ${pg.emergencyPhone}` : '', pg.emergencyRelationship ? ` (${pg.emergencyRelationship})` : '') : null, parentGroupsInPlay.length > 0 && /*#__PURE__*/React.createElement("span", null, " \xB7 ", parentGroupsInPlay.map(g => {
      const gp = g.packageId && packageById ? packageById(g.packageId) : null;
      return /*#__PURE__*/React.createElement("span", {
        key: g.id,
        className: "parent-group-tag",
        title: gp ? `${gp.name} package` : undefined
      }, g.groupType === 'bound' ? '🔗' : '👪', " ", g.name, gp ? ` · ${gp.name}` : '');
    })))), /*#__PURE__*/React.createElement("div", {
      className: "parent-head-stats"
    }, /*#__PURE__*/React.createElement("span", {
      className: "parent-stat"
    }, /*#__PURE__*/React.createElement("strong", null, swimmerCount), " swimmer", swimmerCount === 1 ? '' : 's'), /*#__PURE__*/React.createElement("span", {
      className: "parent-stat"
    }, /*#__PURE__*/React.createElement("strong", {
      className: parentActiveCredits <= 2 ? 'credit-low' : ''
    }, parentActiveCredits), " credits total"), parentSubs.length > 0 && /*#__PURE__*/React.createElement("span", {
      className: "parent-stat subtle"
    }, parentSubs.length, " sub", parentSubs.length === 1 ? '' : 's'), pg.key !== '__unassigned__' && /*#__PURE__*/React.createElement("button", {
      className: `btn small parent-archive-btn ${pg.isActive ? 'btn-ghost' : 'btn-primary'}`,
      title: pg.isActive ? 'Archive this account and all its swimmers' : 'Restore this account',
      onClick: e => {
        e.stopPropagation();
        setParentArchived(pg, pg.isActive);
      }
    }, pg.isActive ? '📦' : '↩ Restore'), /*#__PURE__*/React.createElement("span", {
      className: "parent-chev"
    }, isExpanded ? '▴' : '▾'))), isExpanded && /*#__PURE__*/React.createElement("div", {
      className: "parent-body"
    }, pg.key !== '__unassigned__' && /*#__PURE__*/React.createElement("div", {
      className: "parent-admin-toolbar"
    }, /*#__PURE__*/React.createElement("button", {
      className: "btn btn-ghost small",
      onClick: () => setContactEditKey(isEditingContact ? null : pg.key),
      style: isEditingContact ? {
        background: '#EAB308',
        color: '#000',
        border: '1px solid #CA8A04'
      } : {}
    }, isEditingContact ? '✕ Close Edit' : '✎ Edit Contact'), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-ghost small",
      onClick: () => setAddingSwimmerFor(isAddingSwimmer ? null : pg.key)
    }, isAddingSwimmer ? 'Close' : '+ Add Swimmer'), swimmerCount >= 2 && /*#__PURE__*/React.createElement("button", {
      className: "btn btn-ghost small",
      onClick: () => setGroupPanelKey(isManagingGroup ? null : pg.key)
    }, isManagingGroup ? 'Close' : '👪 Manage Group'), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-ghost small",
      onClick: () => setBillingKey(billingKey === pg.key ? null : pg.key),
      title: "Preview what this account would be billed based on current enrolments + family groups",
      style: billingKey === pg.key ? {
        background: '#F97316',
        color: '#fff',
        border: '1px solid #EA580C'
      } : {}
    }, billingKey === pg.key ? '✕ Close Preview' : '🧾 Billing Preview'), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-print small",
      onClick: () => printAccountSummary(pg),
      title: "Print account summary with groups, enrolments, and class schedule"
    }, "\uD83D\uDDA8 Print"), /*#__PURE__*/React.createElement("div", {
      style: {
        marginLeft: 'auto',
        display: 'flex',
        gap: 6
      }
    }, /*#__PURE__*/React.createElement("button", {
      className: `btn small ${pg.isActive ? 'btn-ghost' : 'btn-primary'}`,
      onClick: () => setParentArchived(pg, pg.isActive),
      title: pg.isActive ? 'Archive this parent and all their swimmers' : 'Restore this parent and all their swimmers'
    }, pg.isActive ? '📦 Archive' : '✓ Restore'), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-danger small",
      onClick: e => {
        e.stopPropagation();
        deleteAccount(pg);
      },
      title: "Permanently delete this account and all its swimmers from the database"
    }, "\uD83D\uDDD1 Delete Account"))), pg.key !== '__unassigned__' && (() => {
      const accepted = pg.swimmers.find(sw => sw.tcAcceptedAt);
      return /*#__PURE__*/React.createElement("div", {
        className: "account-tc-summary"
      }, /*#__PURE__*/React.createElement("span", {
        className: "account-tc-label"
      }, "Terms & Conditions:"), accepted ? /*#__PURE__*/React.createElement("span", {
        className: "account-tc-badge tc-ok",
        title: `Accepted ${new Date(accepted.tcAcceptedAt).toLocaleDateString()} · ID ${accepted.tcAcceptanceId} · covers all swimmers in this account`
      }, "\u2705 Accepted \xB7 ", new Date(accepted.tcAcceptedAt).toLocaleDateString(undefined, {
        dateStyle: 'medium'
      })) : /*#__PURE__*/React.createElement("span", {
        className: "account-tc-badge tc-pending",
        title: "No swimmer in this account has T&C acceptance recorded"
      }, "\u26A0 Pending"));
    })(), billingKey === pg.key && /*#__PURE__*/React.createElement(BillingPreviewPanel, {
      pg: pg,
      lessonTypes: lessonTypes,
      lessonTypeById: lessonTypeById,
      packages: packages,
      packageById: packageById,
      groupById: groupById,
      membersByGroup: membersByGroup,
      subscriptions: subscriptions,
      addSubscription: addSubscription,
      onClose: () => setBillingKey(null),
      onGenerateInvoice: async (lines, meta) => {
        const id = await createInvoice({
          accountName: pg.name,
          accountEmail: pg.email,
          accountPhone: pg.phone,
          lines,
          ...meta
        });
        if (id) {
          setBillingKey(null);
          setAccountSection('invoices');
          setView('accounts');
        }
      }
    }), isEditingContact && /*#__PURE__*/React.createElement(ParentContactEditor, {
      pg: pg,
      onSave: patch => saveParentContact(pg, patch),
      onCancel: () => setContactEditKey(null)
    }), isAddingSwimmer && /*#__PURE__*/React.createElement("div", {
      className: "parent-add-swimmer"
    }, /*#__PURE__*/React.createElement("div", {
      className: "parent-sub-log-title"
    }, "+ New swimmer under ", pg.name), /*#__PURE__*/React.createElement(StudentEditor, {
      row: {
        guardianName: pg.name,
        guardianEmail: pg.email,
        guardianPhone: pg.phone,
        emergencyName: pg.emergencyName,
        emergencyPhone: pg.emergencyPhone,
        emergencyRelationship: pg.emergencyRelationship,
        emergencySameAsGuardian: pg.emergencySameAsGuardian
      },
      lessonTypes: lessonTypes,
      packages: packages,
      hideAccountSections: true,
      onSave: async patch => {
        // New swimmer inherits the account's T&C acceptance: the
        // account holder already agreed to terms when the account
        // was opened (or via legacy backfill), and that consent
        // covers every swimmer under them.
        const accountTcSwimmer = pg.swimmers.find(s => s.tcAcceptedAt);
        await addStudent({
          ...patch,
          guardianName: pg.name,
          guardianEmail: pg.email,
          guardianPhone: pg.phone,
          emergencyName: pg.emergencyName,
          emergencyPhone: pg.emergencyPhone,
          emergencyRelationship: pg.emergencyRelationship,
          emergencySameAsGuardian: pg.emergencySameAsGuardian,
          // Inherit account_id so the new swimmer stays in this account
          accountId: pg.accountId || pg.swimmers[0]?.accountId || null,
          // Inherit T&C from the account so the new swimmer is covered immediately
          tcAcceptedAt: accountTcSwimmer?.tcAcceptedAt || null,
          tcAcceptanceId: accountTcSwimmer?.tcAcceptanceId || null
        });
        setAddingSwimmerFor(null);
      }
    })), isManagingGroup && /*#__PURE__*/React.createElement(ParentGroupManager, {
      pg: pg,
      familyGroups: familyGroups,
      groupById: groupById,
      membersByGroup: membersByGroup,
      groupIdsByStudent: groupIdsByStudent,
      lessonTypes: lessonTypes,
      packages: packages,
      packageById: packageById,
      addGroup: addGroup,
      updateGroup: updateGroup,
      deleteGroup: deleteGroup,
      setStudentGroup: setStudentGroup,
      addStudentToGroup: addStudentToGroup,
      removeStudentFromGroup: removeStudentFromGroup,
      onClose: () => setGroupPanelKey(null)
    }), pg.swimmers.map((sw, swi) => {
      const grp = sw.familyGroupId && groupById ? groupById[sw.familyGroupId] : null;
      const isBound = !!(grp && grp.groupType === 'bound');
      const isEditingSwimmer = editingSwimmerId === sw.id;
      const acc = swimmerAccent(swi);
      return /*#__PURE__*/React.createElement("div", {
        key: sw.id,
        className: "parent-swimmer-section",
        style: {
          borderLeftColor: acc.accent
        }
      }, /*#__PURE__*/React.createElement("div", {
        className: "parent-swimmer-head"
      }, /*#__PURE__*/React.createElement("div", {
        className: "parent-swimmer-name"
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          color: acc.accent,
          fontSize: 14
        }
      }, "\u25CF"), " ", /*#__PURE__*/React.createElement("strong", {
        style: {
          color: acc.text
        }
      }, sw.name), pg.displayCode && /*#__PURE__*/React.createElement("span", {
        className: "swimmer-display-code"
      }, pg.displayCode, "-", pg.swimmers.indexOf(sw) + 1), sw.age != null ? /*#__PURE__*/React.createElement("span", {
        className: "subtle"
      }, " \xB7 ", sw.age, "y") : null, sw.gender ? /*#__PURE__*/React.createElement("span", {
        className: "subtle"
      }, " \xB7 ", sw.gender === 'female' ? '♀' : '♂') : null, grp ? /*#__PURE__*/React.createElement("span", {
        className: "subtle"
      }, " \xB7 ", isBound ? '🔗' : '👪', " ", grp.name) : null), /*#__PURE__*/React.createElement("div", {
        className: "parent-swimmer-actions"
      }, /*#__PURE__*/React.createElement("button", {
        className: "btn btn-ghost small",
        onClick: () => setEditingSwimmerId(isEditingSwimmer ? null : sw.id),
        style: isEditingSwimmer ? {
          background: '#EAB308',
          color: '#000',
          border: '1px solid #CA8A04'
        } : {}
      }, isEditingSwimmer ? '✕ Close' : '✎ Edit'), /*#__PURE__*/React.createElement("button", {
        className: "btn btn-danger small",
        onClick: () => deleteStudent(sw)
      }, "Del"))), isEditingSwimmer && /*#__PURE__*/React.createElement("div", {
        style: {
          margin: '8px 0'
        }
      }, /*#__PURE__*/React.createElement(StudentEditor, {
        row: sw,
        lessonTypes: lessonTypes,
        packages: packages,
        hideAccountSections: true,
        onSave: async patch => {
          await updateStudent(sw.id, patch);
          setEditingSwimmerId(null);
        }
      })), (sw.lessonTypeIds || []).length === 0 ? /*#__PURE__*/React.createElement("div", {
        className: "parent-swimmer-empty subtle small"
      }, "No lesson type enrolments yet \u2014 click \u270E Edit to add one.") : /*#__PURE__*/React.createElement("table", {
        className: "lt-mini-table"
      }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Lesson Type"), /*#__PURE__*/React.createElement("th", null, "Package"), /*#__PURE__*/React.createElement("th", null, "Scheduled Session"), /*#__PURE__*/React.createElement("th", null, "Credits"), /*#__PURE__*/React.createElement("th", null))), /*#__PURE__*/React.createElement("tbody", null, (sw.lessonTypeIds || []).map(ltId => {
        const lt = lessonTypeById ? lessonTypeById(ltId) : null;
        if (!lt) return null;
        const bal = creditByKey[`${sw.id}:${ltId}`];
        const remaining = bal ? Number(bal.remaining_balance) || 0 : 0;
        const initial = bal ? Number(bal.initial_balance) || 0 : 0;
        const enrol = (sw.enrollments || []).find(e => e.lessonTypeId === ltId);
        const pkg = enrol?.packageId ? packageById(enrol.packageId) : null;
        const ltSessions = (sessions || []).filter(s => s.weekStartDate === selectedWeekStart && s.type === lt.name && (s.students || []).some(st => st.studentId === sw.id)).sort((a, b) => a.day - b.day || a.startMinute - b.startMinute);
        const schedLabel = ltSessions.length ? ltSessions.map(s => `${DAYS_F[s.day].slice(0, 3)} ${shortTime(s.startMinute)}`).join(', ') : null;
        const quickAddSub = n => addSubscription({
          subjectType: grp && grp.groupType !== 'bound' ? 'family_group' : 'student',
          subjectId: grp && grp.groupType !== 'bound' ? grp.id : sw.id,
          lessonTypeId: ltId,
          creditsPerSwimmer: n,
          quantity: 1,
          source: 'subscription',
          notes: `Quick +${n} (accounts panel)`
        });
        return /*#__PURE__*/React.createElement("tr", {
          key: ltId
        }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
          className: "lt-chip",
          style: {
            background: lt.bg_color,
            color: lt.text_color,
            borderColor: lt.border_color
          }
        }, lt.name)), /*#__PURE__*/React.createElement("td", {
          className: "col-pkg"
        }, pkg ? pkg.name : /*#__PURE__*/React.createElement("em", {
          className: "subtle"
        }, "\u2014")), /*#__PURE__*/React.createElement("td", {
          className: `col-session${schedLabel ? '' : ' no-sched'}`
        }, ltSessions.length ? ltSessions.map((s, si) => /*#__PURE__*/React.createElement("span", {
          key: s.id,
          className: "session-jump-link",
          title: "Click to open this session in the Weekly View",
          onClick: () => onJumpToSession && onJumpToSession(s)
        }, si > 0 ? ', ' : '', DAYS_F[s.day].slice(0, 3), " ", shortTime(s.startMinute))) : 'Not scheduled'), /*#__PURE__*/React.createElement("td", {
          className: "col-credits"
        }, bal ? /*#__PURE__*/React.createElement("strong", {
          className: remaining <= 2 ? 'credit-low' : ''
        }, remaining, " cr") : /*#__PURE__*/React.createElement("em", {
          className: "subtle"
        }, "\u2014")), /*#__PURE__*/React.createElement("td", {
          className: "col-actions"
        }, !isBound && adjustBalanceTo ? /*#__PURE__*/React.createElement(BalanceAdjuster, {
          currentBalance: remaining,
          onApply: (target, notes) => adjustBalanceTo(sw.id, ltId, target, notes)
        }) : isBound ? /*#__PURE__*/React.createElement("span", {
          className: "subtle small"
        }, "\uD83D\uDD17 group") : null));
      }))));
    }), parentSubs.length > 0 && /*#__PURE__*/React.createElement("div", {
      className: "parent-sub-log"
    }, /*#__PURE__*/React.createElement("div", {
      className: "parent-sub-log-title"
    }, "Subscription log (", parentSubs.length, ")"), /*#__PURE__*/React.createElement("div", {
      className: "parent-sub-log-list"
    }, parentSubs.slice().sort((a, b) => (b.subscription_date || '').localeCompare(a.subscription_date || '')).map(s => {
      const lt = lessonTypeById ? lessonTypeById(s.lesson_type_id) : null;
      return /*#__PURE__*/React.createElement("div", {
        key: s.id,
        className: `credit-sub-row ${s.cancelled_at ? 'is-cancelled' : ''}`
      }, /*#__PURE__*/React.createElement("span", {
        className: "credit-sub-date"
      }, s.subscription_date), /*#__PURE__*/React.createElement("span", {
        className: "credit-sub-amount"
      }, "+", s.credits_per_swimmer, " \xD7 ", s.swimmer_count), /*#__PURE__*/React.createElement("span", {
        className: "credit-sub-subject"
      }, lt?.name || '—'), /*#__PURE__*/React.createElement("span", {
        className: "credit-sub-meta subtle"
      }, s.source, s.amount_paid != null ? ` · RM${s.amount_paid}` : ''), s.cancelled_at ? /*#__PURE__*/React.createElement("span", {
        className: "credit-sub-cancelled-tag"
      }, "Cancelled") : cancelSubscription ? /*#__PURE__*/React.createElement("button", {
        className: "btn btn-ghost small",
        onClick: () => cancelSubscription(s)
      }, "Cancel") : null);
    })))));
  })));
}

// ============================================================================
// FamilyGroupsAdminView — system-wide family-groups admin panel.
// Lists EVERY family_groups row in the system, with member count, package
// context, member names, and the guardian/account each member belongs to.
// Use to audit and clean up legacy/test data without dropping to SQL.
// ============================================================================
function FamilyGroupsAdminView({
  familyGroups,
  membersByGroup,
  lessonTypes,
  lessonTypeById,
  packages,
  packageById,
  deleteGroup,
  updateGroup,
  externalSearchQ
}) {
  const [localSearchQ, setLocalSearchQ] = useState('');
  const searchQ = externalSearchQ !== undefined ? externalSearchQ : localSearchQ;
  const setSearchQ = setLocalSearchQ;
  const [filter, setFilter] = useState('all');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [editingNameId, setEditingNameId] = useState(null);
  const [editingNameVal, setEditingNameVal] = useState('');

  // Enrich each group with derived signals: package info, member rows, account names
  const enriched = (familyGroups || []).map(g => {
    const members = membersByGroup?.[g.id] || [];
    const pkg = g.packageId ? typeof packageById === 'function' ? packageById(g.packageId) : packageById?.[g.packageId] : null;
    const lt = pkg?.lesson_type_id ? typeof lessonTypeById === 'function' ? lessonTypeById(pkg.lesson_type_id) : lessonTypeById?.[pkg.lesson_type_id] : null;
    const accountNames = [...new Set(members.map(m => m.guardianName || m.guardian_name || '— No account —'))];
    return {
      ...g,
      memberRows: members,
      memberCount: members.length,
      pkg,
      pkgName: pkg?.name || null,
      ltName: lt?.name || null,
      accountNames,
      isEmpty: members.length === 0,
      isConfigured: !!pkg,
      isMisconfigured: !pkg // group exists but no package set
    };
  });

  // Counts for the filter tab labels
  const counts = {
    all: enriched.length,
    empty: enriched.filter(g => g.isEmpty).length,
    configured: enriched.filter(g => g.isConfigured && !g.isEmpty).length,
    misconfigured: enriched.filter(g => g.isMisconfigured).length
  };

  // Apply filter + search
  const filtered = enriched.filter(g => {
    if (filter === 'empty' && !g.isEmpty) return false;
    if (filter === 'configured' && (!g.isConfigured || g.isEmpty)) return false;
    if (filter === 'misconfigured' && !g.isMisconfigured) return false;
    if (!searchQ.trim()) return true;
    const q = searchQ.toLowerCase();
    if (g.name?.toLowerCase().includes(q)) return true;
    if (g.pkgName?.toLowerCase().includes(q)) return true;
    if (g.ltName?.toLowerCase().includes(q)) return true;
    if (g.accountNames.some(n => (n || '').toLowerCase().includes(q))) return true;
    if (g.memberRows.some(m => (m.name || '').toLowerCase().includes(q))) return true;
    return false;
  });
  // Sort: empty first (so cleanup is easy), then by name
  filtered.sort((a, b) => {
    if (a.isEmpty !== b.isEmpty) return a.isEmpty ? -1 : 1;
    return (a.name || '').localeCompare(b.name || '');
  });
  async function bulkDeleteEmpty() {
    const empties = enriched.filter(g => g.isEmpty);
    if (empties.length === 0) {
      alert('No empty groups to delete.');
      return;
    }
    if (!confirm(`Delete ALL ${empties.length} empty family group${empties.length === 1 ? '' : 's'}? This cannot be undone.\n\nGroups to delete:\n${empties.map(g => `• ${g.name}`).join('\n')}`)) return;
    setBulkBusy(true);
    try {
      for (const g of empties) {
        // eslint-disable-next-line no-await-in-loop
        await deleteGroup(g, /*silentConfirm*/true);
      }
    } finally {
      setBulkBusy(false);
    }
  }
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      gap: 12,
      flexWrap: 'wrap',
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 18,
      fontWeight: 800
    }
  }, "\uD83D\uDC6A Family Groups \u2014 Administration"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      marginTop: 3
    }
  }, "Every family group in the system, with members and package context. Audit legacy or test data here; bulk-clean empty groups in one click.")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 14,
      alignItems: 'flex-end',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, "Total"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 22,
      fontWeight: 800,
      color: 'var(--primary)'
    }
  }, counts.all)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, "Configured"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 22,
      fontWeight: 800,
      color: '#10B981'
    }
  }, counts.configured)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, "Empty"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 22,
      fontWeight: 800,
      color: '#94A3B8'
    }
  }, counts.empty)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, "Misconfigured"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 22,
      fontWeight: 800,
      color: '#F59E0B'
    }
  }, counts.misconfigured)))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      alignItems: 'center',
      flexWrap: 'wrap'
    }
  }, externalSearchQ === undefined && /*#__PURE__*/React.createElement("input", {
    className: "input",
    style: {
      flex: 1,
      minWidth: 240,
      maxWidth: 420
    },
    placeholder: "Search by group, package, lesson type, account, or member name\u2026",
    value: searchQ,
    onChange: e => setSearchQ(e.target.value)
  }), /*#__PURE__*/React.createElement("div", {
    className: "tabs",
    style: {
      gap: 2,
      padding: 2
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: `tab ${filter === 'all' ? 'active' : ''}`,
    style: {
      padding: '4px 10px',
      fontSize: 11
    },
    onClick: () => setFilter('all')
  }, "All (", counts.all, ")"), /*#__PURE__*/React.createElement("button", {
    className: `tab ${filter === 'configured' ? 'active' : ''}`,
    style: {
      padding: '4px 10px',
      fontSize: 11
    },
    onClick: () => setFilter('configured')
  }, "Configured (", counts.configured, ")"), /*#__PURE__*/React.createElement("button", {
    className: `tab ${filter === 'empty' ? 'active' : ''}`,
    style: {
      padding: '4px 10px',
      fontSize: 11
    },
    onClick: () => setFilter('empty')
  }, "Empty (", counts.empty, ")"), /*#__PURE__*/React.createElement("button", {
    className: `tab ${filter === 'misconfigured' ? 'active' : ''}`,
    style: {
      padding: '4px 10px',
      fontSize: 11
    },
    onClick: () => setFilter('misconfigured')
  }, "Misconfigured (", counts.misconfigured, ")")), counts.empty > 0 ? /*#__PURE__*/React.createElement("button", {
    className: "btn btn-danger small",
    onClick: bulkDeleteEmpty,
    disabled: bulkBusy,
    title: `Delete all ${counts.empty} groups with zero members`
  }, bulkBusy ? 'Cleaning…' : `🧹 Clean ${counts.empty} empty`) : null)), filtered.length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: "card empty",
    style: {
      padding: 30
    }
  }, "No family groups match the current filter.") : null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 4
    }
  }, filtered.map(g => {
    const isBound = g.groupType === 'bound';
    return /*#__PURE__*/React.createElement("div", {
      key: g.id,
      className: "fga-card"
    }, /*#__PURE__*/React.createElement("div", {
      className: "fga-head"
    }, /*#__PURE__*/React.createElement("div", {
      className: "fga-head-main"
    }, /*#__PURE__*/React.createElement("div", {
      className: "fga-name"
    }, editingNameId === g.id ? /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6
      }
    }, /*#__PURE__*/React.createElement("input", {
      className: "input",
      style: {
        width: 180,
        padding: '3px 8px',
        fontSize: 14
      },
      value: editingNameVal,
      onChange: e => setEditingNameVal(e.target.value),
      onKeyDown: async e => {
        if (e.key === 'Enter' && editingNameVal.trim()) {
          await updateGroup(g.id, {
            name: editingNameVal.trim()
          });
          setEditingNameId(null);
        }
        if (e.key === 'Escape') setEditingNameId(null);
      },
      autoFocus: true
    }), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-primary small",
      onClick: async () => {
        if (editingNameVal.trim()) await updateGroup(g.id, {
          name: editingNameVal.trim()
        });
        setEditingNameId(null);
      }
    }, "Save"), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-ghost small",
      onClick: () => setEditingNameId(null)
    }, "\u2715")) : /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8
      }
    }, isBound ? '🔗' : '👪', " ", g.name, updateGroup && /*#__PURE__*/React.createElement("button", {
      className: "btn btn-ghost small",
      title: "Edit group name",
      style: {
        padding: '2px 7px',
        fontSize: 11
      },
      onClick: () => {
        setEditingNameId(g.id);
        setEditingNameVal(g.name || '');
      }
    }, "\u270E"))), /*#__PURE__*/React.createElement("div", {
      className: "fga-meta"
    }, g.isConfigured ? /*#__PURE__*/React.createElement("span", {
      className: "fga-pkg-tag"
    }, g.ltName || '?', " \xB7 ", g.pkgName) : /*#__PURE__*/React.createElement("span", {
      className: "fga-pkg-tag fga-pkg-warn"
    }, "\u26A0 no package set"), /*#__PURE__*/React.createElement("span", {
      className: `fga-count ${g.isEmpty ? 'is-empty' : ''}`
    }, g.memberCount, " member", g.memberCount === 1 ? '' : 's'), g.accountNames.length > 0 ? /*#__PURE__*/React.createElement("span", {
      className: "fga-accounts"
    }, g.accountNames.join(', ')) : null)), /*#__PURE__*/React.createElement("div", {
      className: "fga-actions"
    }, /*#__PURE__*/React.createElement("button", {
      className: "btn btn-danger small",
      onClick: () => deleteGroup(g)
    }, "Delete"))), g.memberCount > 0 ? /*#__PURE__*/React.createElement("div", {
      className: "fga-members"
    }, g.memberRows.map(m => /*#__PURE__*/React.createElement("span", {
      key: m.id,
      className: "fga-member-chip"
    }, m.name, m.age != null ? ` · ${m.age}y` : ''))) : null);
  })));
}

// ============================================================================

// Inline editor for an account's contact info + emergency contact.
// Two visually distinct sections — Account Holder (parent or self) on
// top, Emergency Contact below — both propagate to every child swimmer
// when saved. Emergency contact now carries name + phone + relationship
// (name was previously missing).
function ParentContactEditor({
  pg,
  onSave,
  onCancel
}) {
  const [name, setName] = useState(pg.name === '— Unassigned —' || pg.name === '— No name —' ? '' : pg.name);
  const [email, setEmail] = useState(pg.email || '');
  const [phone, setPhone] = useState(pg.phone || '');
  const [ic, setIc] = useState(pg.ic || '');
  const [tin, setTin] = useState(pg.tin || '');
  const [emergencySame, setEmergencySame] = useState(!!pg.emergencySameAsGuardian);
  const [emergencyName, setEmergencyName] = useState(pg.emergencyName || '');
  const [emergencyPhone, setEmergencyPhone] = useState(pg.emergencyPhone || '');
  const [emergencyRel, setEmergencyRel] = useState(pg.emergencyRelationship || '');
  return /*#__PURE__*/React.createElement("div", {
    className: "parent-contact-edit"
  }, /*#__PURE__*/React.createElement("div", {
    className: "parent-sub-log-title"
  }, "Edit account & emergency contact (applies to all ", pg.swimmers.length, " swimmer", pg.swimmers.length === 1 ? '' : 's', ")"), /*#__PURE__*/React.createElement("div", {
    className: "account-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "account-section-title"
  }, "Parent / Guardian (Account Holder)"), /*#__PURE__*/React.createElement("div", {
    className: "form-grid",
    style: {
      gridTemplateColumns: '1fr 1fr 1fr'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Parent Name"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: name,
    onChange: e => setName(e.target.value),
    onBlur: e => setName(toTitleCase(e.target.value)),
    placeholder: "Full name"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Email"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "email",
    value: email,
    onChange: e => setEmail(e.target.value),
    placeholder: "email@example.com"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Phone"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "tel",
    value: phone,
    onChange: e => setPhone(e.target.value),
    placeholder: "+60 1X-XXXXXXX"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "IC No. ", /*#__PURE__*/React.createElement("span", {
    className: "hint",
    style: {
      fontSize: 9,
      display: 'inline',
      color: 'var(--text-3)'
    }
  }, "optional")), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: ic,
    onChange: e => setIc(e.target.value),
    placeholder: "e.g. 901231-14-5678"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "TIN No. ", /*#__PURE__*/React.createElement("span", {
    className: "hint",
    style: {
      fontSize: 9,
      display: 'inline',
      color: 'var(--text-3)'
    }
  }, "optional")), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: tin,
    onChange: e => setTin(e.target.value),
    placeholder: "e.g. IG12345678090"
  })))), /*#__PURE__*/React.createElement("div", {
    className: "account-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "account-section-title"
  }, "Emergency Contact"), /*#__PURE__*/React.createElement("label", {
    className: "gb-check",
    style: {
      marginBottom: 7,
      display: 'inline-flex',
      gap: 6,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: emergencySame,
    onChange: e => setEmergencySame(e.target.checked)
  }), " Same as account holder above"), /*#__PURE__*/React.createElement("div", {
    className: "form-grid",
    style: {
      gridTemplateColumns: '1fr 1fr 1fr'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Emergency Contact Name"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: emergencySame ? name : emergencyName,
    onChange: e => setEmergencyName(e.target.value),
    disabled: emergencySame,
    placeholder: "Full name"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Phone"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "tel",
    value: emergencySame ? phone : emergencyPhone,
    onChange: e => setEmergencyPhone(e.target.value),
    disabled: emergencySame,
    placeholder: "+60 1X-XXXXXXX"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Relationship"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: emergencySame ? 'Account Holder' : emergencyRel,
    onChange: e => setEmergencyRel(e.target.value),
    disabled: emergencySame,
    placeholder: "e.g. Mother, Father, Spouse, Sibling"
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      justifyContent: 'flex-end',
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: onCancel
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary small",
    onClick: () => onSave({
      guardianName: name,
      guardianEmail: email,
      guardianPhone: phone,
      guardianIc: ic.trim() || null,
      guardianTin: tin.trim() || null,
      emergencySameAsGuardian: emergencySame,
      emergencyName: emergencySame ? name : emergencyName,
      emergencyPhone: emergencySame ? phone : emergencyPhone,
      emergencyRelationship: emergencySame ? 'Account Holder' : emergencyRel
    })
  }, "Save")));
}

// Family group management for a parent — pick existing group or create new
// from this parent's children, toggle membership per child, switch type.
// ============================================================================
// ── Shared billing-line computation ─────────────────────────────────────────
// Used by both BillingPreviewPanel (interactive preview) and the batch invoice
// generator so both produce identical line amounts.
function computeBillingLines(pg, groupById, packageById, lessonTypeById, lessonTypes) {
  function ltName(id) {
    const lt = typeof lessonTypeById === 'function' ? lessonTypeById(id) : null;
    return lt?.name || (lessonTypes || []).find(x => x.id === id)?.name || 'Lesson';
  }
  function pkgById2(id) {
    return typeof packageById === 'function' ? packageById(id) : null;
  }
  const groupItems = [];
  const individualItems = [];
  const unconfiguredGroups = [];
  const accountGroupIds = [...new Set((pg.swimmers || []).flatMap(s => s.familyGroupIds || []))];
  accountGroupIds.forEach(gid => {
    const g = groupById?.[gid];
    if (!g) return;
    const pkg = g.packageId ? pkgById2(g.packageId) : null;
    if (!pkg) {
      const mems = (pg.swimmers || []).filter(s => (s.familyGroupIds || []).includes(gid));
      unconfiguredGroups.push({
        id: gid,
        name: g.name,
        groupType: g.groupType,
        memberCount: mems.length,
        memberNames: mems.map(m => m.name).join(', ')
      });
      return;
    }
    const members = (pg.swimmers || []).filter(s => (s.familyGroupIds || []).includes(gid));
    const memberCount = members.length;
    const required = pkg.pax != null ? Number(pkg.pax) : null;
    const bundle = pkg.amount != null ? Number(pkg.amount) : 0;
    const fb = pkg.fallback_per_pax != null ? Number(pkg.fallback_per_pax) : null;
    let amount = bundle;
    if (required != null && memberCount > required && fb != null) amount = bundle + (memberCount - required) * fb;
    groupItems.push({
      key: `group:${gid}`,
      groupId: gid,
      groupName: g.name,
      groupType: g.groupType,
      lessonTypeId: pkg.lesson_type_id,
      packageId: pkg.id,
      lessonTypeName: ltName(pkg.lesson_type_id),
      packageName: pkg.name,
      familyGroupId: gid,
      familyGroupName: g.name,
      memberCount,
      memberIds: members.map(m => m.id),
      memberNames: members.map(m => m.name).join(', '),
      studentIds: members.map(m => m.id).join(','),
      studentNames: members.map(m => m.name).join(', '),
      bundle,
      amount,
      lineType: 'group_bundle',
      billingMode: pkg.billing_mode || 'monthly',
      billingCount: pkg.billing_count,
      creditsPerSwimmer: pkg.billing_count || 4,
      description: `${g.groupType === 'bound' ? '🔗' : '👪'} ${g.name} — ${ltName(pkg.lesson_type_id)} · ${pkg.name}`
    });
  });
  (pg.swimmers || []).forEach(sw => {
    const coveredPkgIds = new Set();
    (sw.familyGroupIds || []).forEach(gid => {
      const grp = groupById?.[gid];
      if (grp?.packageId) coveredPkgIds.add(grp.packageId);
    });
    (sw.enrollments || []).forEach(e => {
      if (!e.lessonTypeId || !e.packageId || coveredPkgIds.has(e.packageId)) return;
      const pkg = pkgById2(e.packageId);
      if (!pkg) return;
      individualItems.push({
        key: `ind:${sw.id}:${e.lessonTypeId}:${e.packageId}`,
        swimmerId: sw.id,
        swimmerName: sw.name,
        lessonTypeId: e.lessonTypeId,
        packageId: e.packageId,
        lessonTypeName: ltName(e.lessonTypeId),
        packageName: pkg.name,
        studentIds: sw.id,
        studentNames: sw.name,
        amount: pkg.amount != null ? Number(pkg.amount) : 0,
        lineType: 'individual',
        billingMode: pkg.billing_mode || 'monthly',
        billingCount: pkg.billing_count,
        creditsPerSwimmer: pkg.billing_count || 4,
        description: `${sw.name} — ${ltName(e.lessonTypeId)} · ${pkg.name}`
      });
    });
  });
  return {
    groupItems,
    individualItems,
    allItems: [...groupItems, ...individualItems],
    unconfiguredGroups
  };
}

// BillingPreviewPanel — invoice generator for an account.
// Detects billable items (group bundles + individual lessons).
// Per-line checkboxes let staff exclude any item before generating.
// "Generate Invoice" creates the invoice + lines + navigates to Admin > Invoices.
// The old per-line "💳 Record" flow has been superseded by the invoice path.
// ============================================================================
function BillingPreviewPanel({
  pg,
  lessonTypes,
  lessonTypeById,
  packages,
  packageById,
  groupById,
  membersByGroup,
  subscriptions,
  addSubscription,
  onClose,
  onGenerateInvoice
}) {
  const ltById = lessonTypeById || (id => lessonTypes.find(x => x.id === id));
  const pkgById = packageById || (id => packages.find(p => p.id === id));
  function ltName(id) {
    const lt = typeof ltById === 'function' ? ltById(id) : ltById?.[id];
    return lt?.name || 'Lesson';
  }
  const [invoiceNotes, setInvoiceNotes] = useState('');
  const [invoiceDueDate, setInvoiceDueDate] = useState('');
  const [checked, setChecked] = useState(new Set()); // initialised after items computed
  const [generating, setGenerating] = useState(false);

  // ── Compute line items via shared helper ────────────────────────────
  const {
    groupItems,
    individualItems,
    allItems,
    unconfiguredGroups
  } = React.useMemo(() => computeBillingLines(pg, groupById, packageById, lessonTypeById, lessonTypes), [pg.key, pg.swimmers?.length]);
  const allKeys = allItems.map(it => it.key);

  // Initialise checked set when items first load
  React.useEffect(() => {
    setChecked(new Set(allKeys));
  }, [allItems.length]);
  function toggleCheck(key) {
    setChecked(s => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);else n.add(key);
      return n;
    });
  }
  function toggleAll() {
    const c = allKeys.every(k => checked.has(k));
    setChecked(c ? new Set() : new Set(allKeys));
  }
  const checkedItems = allItems.filter(it => checked.has(it.key));
  const checkedTotal = checkedItems.reduce((s, it) => s + it.amount, 0);
  const hasAny = allItems.length > 0;
  const allChecked = allKeys.length > 0 && allKeys.every(k => checked.has(k));
  async function handleGenerate() {
    if (checkedItems.length === 0) {
      alert('Select at least one line to include on the invoice.');
      return;
    }
    setGenerating(true);
    try {
      await onGenerateInvoice(checkedItems.map(it => ({
        ...it
      })), {
        notes: invoiceNotes,
        dueDate: invoiceDueDate
      });
    } catch (e) {
      alert(e?.message || 'Failed to generate invoice');
    } finally {
      setGenerating(false);
    }
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "parent-billing-panel"
  }, /*#__PURE__*/React.createElement("div", {
    className: "parent-sub-log-title",
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", null, "\uD83E\uDDFE Invoice Preview \u2014 ", pg.name), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: onClose
  }, "Close")), /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      marginBottom: 10
    }
  }, "Tick the items to include on this invoice. Untick anything not being billed this cycle. Click ", /*#__PURE__*/React.createElement("strong", null, "Generate Invoice"), " to create a draft invoice in Admin \u2192 Invoices."), !hasAny && unconfiguredGroups.length === 0 && /*#__PURE__*/React.createElement("div", {
    className: "empty",
    style: {
      padding: 20
    }
  }, "No billable items \u2014 no swimmers have package enrolments yet."), unconfiguredGroups.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "billing-warning-box"
  }, /*#__PURE__*/React.createElement("div", {
    className: "billing-warning-title"
  }, "\u26A0 ", unconfiguredGroups.length, " group", unconfiguredGroups.length === 1 ? '' : 's', " missing a package"), /*#__PURE__*/React.createElement("div", {
    className: "billing-warning-body"
  }, "Open ", /*#__PURE__*/React.createElement("strong", null, "Manage Group"), " and set a package on: ", unconfiguredGroups.map(u => /*#__PURE__*/React.createElement("strong", {
    key: u.id
  }, " ", u.name)), ".")), hasAny && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("table", {
    className: "billing-table"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      width: 32
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: allChecked,
    onChange: toggleAll,
    title: "Select all"
  })), /*#__PURE__*/React.createElement("th", null, "Description"), /*#__PURE__*/React.createElement("th", null, "Type"), /*#__PURE__*/React.createElement("th", {
    className: "num"
  }, "Amount"))), /*#__PURE__*/React.createElement("tbody", null, groupItems.map(it => /*#__PURE__*/React.createElement("tr", {
    key: it.key,
    className: checked.has(it.key) ? '' : 'billing-row-muted'
  }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: checked.has(it.key),
    onChange: () => toggleCheck(it.key)
  })), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700
    }
  }, it.groupType === 'bound' ? '🔗' : '👪', " ", it.groupName), /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, it.lessonTypeName, " \xB7 ", it.packageName), /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, it.memberNames)), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: "billing-type-chip group"
  }, "Group Bundle")), /*#__PURE__*/React.createElement("td", {
    className: "num"
  }, /*#__PURE__*/React.createElement("strong", null, "RM", it.amount.toFixed(2))))), individualItems.map(it => /*#__PURE__*/React.createElement("tr", {
    key: it.key,
    className: checked.has(it.key) ? '' : 'billing-row-muted'
  }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: checked.has(it.key),
    onChange: () => toggleCheck(it.key)
  })), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700
    }
  }, it.swimmerName), /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, it.lessonTypeName, " \xB7 ", it.packageName)), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: "billing-type-chip individual"
  }, "Individual")), /*#__PURE__*/React.createElement("td", {
    className: "num"
  }, /*#__PURE__*/React.createElement("strong", null, "RM", it.amount.toFixed(2))))))), /*#__PURE__*/React.createElement("div", {
    className: "billing-total-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "billing-total-label"
  }, checkedItems.length, " item", checkedItems.length === 1 ? '' : 's', " selected"), /*#__PURE__*/React.createElement("span", {
    className: "billing-total-value"
  }, "RM", checkedTotal.toFixed(2))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 180px',
      gap: 10,
      marginTop: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Invoice Notes (optional)"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: invoiceNotes,
    onChange: e => setInvoiceNotes(e.target.value),
    placeholder: "e.g. June 2026 monthly fee"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Due Date (optional)"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "date",
    value: invoiceDueDate,
    onChange: e => setInvoiceDueDate(e.target.value)
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'flex-end',
      marginTop: 12
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary",
    onClick: handleGenerate,
    disabled: generating || checkedItems.length === 0
  }, generating ? 'Generating…' : `🧾 Generate Invoice — RM${checkedTotal.toFixed(2)}`))));
}

// Flow:
//   1. Existing groups touching this family are listed at the top with
//      their package context, member checkboxes, and an inline type/name editor.
//      Only swimmers in this family who have an enrollment matching the
//      group's package are shown as eligible checkboxes.
//   2. Below, "Create new group" picks Lesson Type → Package → Type, and
//      live-previews which family swimmers are eligible (have that exact
//      package enrollment). The user ticks who to include and one click
//      creates the group and assigns members in a single transaction.
function ParentGroupManager({
  pg,
  familyGroups,
  groupById,
  membersByGroup,
  groupIdsByStudent,
  lessonTypes,
  packages,
  packageById,
  addGroup,
  updateGroup,
  deleteGroup,
  setStudentGroup,
  addStudentToGroup,
  removeStudentFromGroup,
  onClose
}) {
  // ── Eligibility helpers ──────────────────────────────────────────────
  // (1) A swimmer is "package-eligible" for a (lessonTypeId, packageId)
  //     iff they have an enrolment row with that exact pair.
  // (2) But uniqueness also applies: a swimmer can only be in ONE group
  //     per unique (lesson_type, package). So if the swimmer is already
  //     in some OTHER group with the same package, they're not eligible
  //     for THIS one — they'd be hopping, which is what we're patching.
  //     We surface the conflicting group's name so the UI can explain why.
  function eligibleFor(lessonTypeId, packageId) {
    if (!lessonTypeId || !packageId) return [];
    return pg.swimmers.filter(s => (s.enrollments || []).some(e => e.lessonTypeId === lessonTypeId && e.packageId === packageId));
  }
  // For a candidate package, return any OTHER group the swimmer is in with
  // the same package_id — null if they're free to join.
  function conflictingGroupFor(swimmerId, packageId, excludeGroupId) {
    const ids = groupIdsByStudent?.[swimmerId];
    if (!ids) return null;
    for (const gid of ids) {
      if (gid === excludeGroupId) continue;
      const g = familyGroups.find(x => x.id === gid);
      if (g && g.packageId === packageId) return g;
    }
    return null;
  }

  // ── State for the create form ────────────────────────────────────────
  const [creatingOpen, setCreatingOpen] = useState(false);
  const [creatingName, setCreatingName] = useState('');
  const [creatingLtId, setCreatingLtId] = useState('');
  const [creatingPkgId, setCreatingPkgId] = useState('');
  const [creatingType, setCreatingType] = useState('discount');
  const [creatingMemberIds, setCreatingMemberIds] = useState(new Set());
  // ── State for editing an existing group's package ──────────────────
  // editPkgFor = group.id of the group whose package editor is open.
  // editPkgLtId / editPkgPkgId hold the in-progress selection.
  const [editPkgFor, setEditPkgFor] = useState(null);
  const [editPkgLtId, setEditPkgLtId] = useState('');
  const [editPkgPkgId, setEditPkgPkgId] = useState('');

  // Packages dropdown is filtered by selected lesson type — each package
  // belongs to exactly one lesson type by schema (packages.lesson_type_id).
  const eligiblePackages = creatingLtId ? packages.filter(p => p.lesson_type_id === creatingLtId) : [];

  // Live preview of who is eligible right now given the current pick.
  const previewEligible = eligibleFor(creatingLtId, creatingPkgId);
  function toggleMember(id) {
    const next = new Set(creatingMemberIds);
    if (next.has(id)) next.delete(id);else next.add(id);
    setCreatingMemberIds(next);
  }
  function selectAllEligible() {
    setCreatingMemberIds(new Set(previewEligible.map(s => s.id)));
  }
  function selectNone() {
    setCreatingMemberIds(new Set());
  }

  // When lessonType/package changes, default member selection to all
  // FREE eligible swimmers (excludes those already in another group with
  // the same package — they're locked out by the uniqueness rule).
  React.useEffect(() => {
    if (!creatingPkgId) {
      setCreatingMemberIds(new Set());
      return;
    }
    const free = previewEligible.filter(sw => !conflictingGroupFor(sw.id, creatingPkgId, null));
    setCreatingMemberIds(new Set(free.map(s => s.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creatingLtId, creatingPkgId]);
  async function handleCreate() {
    const name = creatingName.trim();
    if (!name) {
      alert('Group needs a name.');
      return;
    }
    if (!creatingLtId || !creatingPkgId) {
      alert('Pick a Lesson Type and Package first.');
      return;
    }
    const inserted = await addGroup({
      name,
      packageId: creatingPkgId,
      groupType: creatingType
    });
    if (!inserted) {
      return;
    } // addGroup already alerted on failure
    // The `inserted` row is a raw DB record (snake_case). Map it to the
    // familyGroups state shape (camelCase) so addStudentToGroup can use
    // it directly without needing the lookup — necessary because React
    // hasn't re-rendered yet within this same event handler, so our
    // closure's familyGroups doesn't include the brand-new group.
    const targetOverride = {
      id: inserted.id,
      name: inserted.name || '',
      packageId: inserted.package_id || null,
      groupType: inserted.group_type || 'discount'
    };
    // Bulk-assign each selected swimmer to the new group. addStudentToGroup
    // enforces uniqueness — a swimmer who's already in another group with
    // the same package will be filtered out in the UI before this point,
    // but the write API blocks duplicates as a defensive backstop.
    for (const sid of creatingMemberIds) {
      // eslint-disable-next-line no-await-in-loop
      await addStudentToGroup(sid, inserted.id, targetOverride);
    }
    // Reset create form
    setCreatingName('');
    setCreatingLtId('');
    setCreatingPkgId('');
    setCreatingType('discount');
    setCreatingMemberIds(new Set());
    setCreatingOpen(false);
  }

  // ── Existing groups touching this family ─────────────────────────────
  // Multi-group: a swimmer may be in several groups, so flatMap over the
  // familyGroupIds array. The Set dedupes.
  const involvedGroupIds = [...new Set(pg.swimmers.flatMap(s => s.familyGroupIds || []))];
  const involvedGroups = involvedGroupIds.map(gid => groupById?.[gid]).filter(Boolean);
  function packageLabel(pkgId) {
    if (!pkgId) return null;
    const p = packageById ? packageById(pkgId) : null;
    if (!p) return null;
    const lt = lessonTypes.find(x => x.id === p.lesson_type_id);
    return {
      ltName: lt?.name || 'Unknown lesson type',
      pkgName: p.name || 'Package'
    };
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "parent-group-panel"
  }, /*#__PURE__*/React.createElement("div", {
    className: "parent-sub-log-title"
  }, "Family group management"), involvedGroups.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14
    }
  }, involvedGroups.map(g => {
    const isBound = g.groupType === 'bound';
    const pkgInfo = packageLabel(g.packageId);
    // Eligibility: swimmers with the group's exact package. Without
    // a package_id on the group (legacy data) we fall back to "all
    // swimmers in this family" so legacy groups remain editable.
    const eligibleHere = g.packageId ? eligibleFor(pkgInfo ? packageById?.(g.packageId)?.lesson_type_id : null, g.packageId) : pg.swimmers;
    // Multi-group: membership comes from the junction-derived Set on each swimmer.
    const memberSetForThisParent = pg.swimmers.filter(s => (s.familyGroupIds || []).includes(g.id));
    const isEditingPkg = editPkgFor === g.id;
    const editPkgChoices = editPkgLtId ? packages.filter(p => p.lesson_type_id === editPkgLtId) : [];
    return /*#__PURE__*/React.createElement("div", {
      key: g.id,
      className: "parent-group-block"
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        flexWrap: 'wrap',
        marginBottom: 6
      }
    }, /*#__PURE__*/React.createElement("strong", null, isBound ? '🔗' : '👪', " ", g.name), pkgInfo ? /*#__PURE__*/React.createElement("span", {
      className: "parent-group-tag",
      title: "Group package \u2014 only swimmers with this package are eligible"
    }, pkgInfo.ltName, " \xB7 ", pkgInfo.pkgName) : /*#__PURE__*/React.createElement("span", {
      className: "parent-group-tag",
      style: {
        background: '#fef3c7',
        borderColor: '#fde68a',
        color: '#854d0e'
      }
    }, "\u26A0 no package set"), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-ghost small",
      onClick: () => {
        if (isEditingPkg) {
          setEditPkgFor(null);
          return;
        }
        // Pre-fill the editor with current selection
        const cur = g.packageId ? packageById?.(g.packageId) : null;
        setEditPkgLtId(cur?.lesson_type_id || '');
        setEditPkgPkgId(g.packageId || '');
        setEditPkgFor(g.id);
      }
    }, isEditingPkg ? 'Cancel' : pkgInfo ? '✎ Change package' : '+ Set package'), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-ghost small",
      onClick: () => updateGroup(g.id, {
        groupType: isBound ? 'discount' : 'bound'
      })
    }, isBound ? 'Switch to Discount' : 'Switch to Bound'), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-danger small",
      onClick: () => deleteGroup(g)
    }, "Delete"), /*#__PURE__*/React.createElement("span", {
      className: "subtle small",
      style: {
        marginLeft: 'auto'
      }
    }, memberSetForThisParent.length, " of ", eligibleHere.length, " eligible")), isEditingPkg && /*#__PURE__*/React.createElement("div", {
      style: {
        padding: '9px 11px',
        background: '#F0F9FF',
        border: '1px solid #BFDBFE',
        borderRadius: 6,
        marginBottom: 8
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "parent-sub-log-title",
      style: {
        fontSize: 10,
        marginBottom: 6
      }
    }, pkgInfo ? 'Change package for this group' : 'Set the package this group is billed under'), /*#__PURE__*/React.createElement("div", {
      className: "form-grid",
      style: {
        gridTemplateColumns: '1fr 1fr auto'
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "field"
    }, /*#__PURE__*/React.createElement("label", null, "Lesson Type"), /*#__PURE__*/React.createElement("select", {
      className: "select",
      value: editPkgLtId,
      onChange: e => {
        setEditPkgLtId(e.target.value);
        setEditPkgPkgId('');
      }
    }, /*#__PURE__*/React.createElement("option", {
      value: ""
    }, "\u2014 Select lesson type \u2014"), lessonTypes.map(lt => /*#__PURE__*/React.createElement("option", {
      key: lt.id,
      value: lt.id
    }, lt.name)))), /*#__PURE__*/React.createElement("div", {
      className: "field"
    }, /*#__PURE__*/React.createElement("label", null, "Package"), /*#__PURE__*/React.createElement("select", {
      className: "select",
      value: editPkgPkgId,
      onChange: e => setEditPkgPkgId(e.target.value),
      disabled: !editPkgLtId
    }, /*#__PURE__*/React.createElement("option", {
      value: ""
    }, editPkgLtId ? '— Select package —' : 'Pick lesson type first'), editPkgChoices.map(p => /*#__PURE__*/React.createElement("option", {
      key: p.id,
      value: p.id
    }, p.name, p.amount != null ? ` · RM${p.amount}` : '')))), /*#__PURE__*/React.createElement("div", {
      className: "field",
      style: {
        justifyContent: 'flex-end'
      }
    }, /*#__PURE__*/React.createElement("button", {
      className: "btn btn-primary small",
      disabled: !editPkgPkgId,
      onClick: async () => {
        await updateGroup(g.id, {
          packageId: editPkgPkgId
        });
        setEditPkgFor(null);
      }
    }, "Save"))), /*#__PURE__*/React.createElement("div", {
      className: "hint",
      style: {
        marginTop: 6
      }
    }, "Setting the package activates bundle billing for this group \u2014 all members enrolled in this (lesson type, package) pair are billed once via the group bundle.")), /*#__PURE__*/React.createElement("div", {
      className: "parent-group-members"
    }, eligibleHere.length === 0 ? /*#__PURE__*/React.createElement("span", {
      className: "subtle small"
    }, "No swimmers in this family have the matching package.") : eligibleHere.map(sw => {
      const inThis = (sw.familyGroupIds || []).includes(g.id);
      // If this swimmer is NOT already in this group but IS in
      // another group with the same package, lock them out — they
      // can't be moved without removing them from the other group
      // first (that's the patched "no hopping" rule).
      const other = !inThis && g.packageId ? conflictingGroupFor(sw.id, g.packageId, g.id) : null;
      const locked = !!other;
      return /*#__PURE__*/React.createElement("label", {
        key: sw.id,
        className: "parent-group-member",
        style: locked ? {
          opacity: .45
        } : null,
        title: locked ? `Already in "${other.name}" — remove from there first` : undefined
      }, /*#__PURE__*/React.createElement("input", {
        type: "checkbox",
        checked: inThis,
        disabled: locked,
        onChange: e => {
          if (e.target.checked) {
            addStudentToGroup(sw.id, g.id);
          } else {
            removeStudentFromGroup(sw.id, g.id);
          }
        }
      }), " ", sw.name, locked ? /*#__PURE__*/React.createElement("span", {
        className: "subtle small"
      }, " \xB7 in ", other.name) : null);
    }), g.packageId && pg.swimmers.filter(s => !eligibleHere.includes(s)).map(sw => /*#__PURE__*/React.createElement("label", {
      key: sw.id,
      className: "parent-group-member",
      style: {
        opacity: .45
      },
      title: "Does not have the matching package enrollment"
    }, /*#__PURE__*/React.createElement("input", {
      type: "checkbox",
      disabled: true
    }), " ", sw.name))));
  })), /*#__PURE__*/React.createElement("div", {
    className: "parent-group-create"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: creatingOpen ? 8 : 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "parent-sub-log-title",
    style: {
      margin: 0
    }
  }, "Create a new family group"), /*#__PURE__*/React.createElement("button", {
    className: `btn small ${creatingOpen ? 'btn-ghost' : 'btn-primary'}`,
    onClick: () => setCreatingOpen(o => !o)
  }, creatingOpen ? 'Cancel' : '+ New Group')), creatingOpen && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "form-grid",
    style: {
      gridTemplateColumns: '1fr 1fr'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Lesson Type"), /*#__PURE__*/React.createElement("select", {
    className: "select",
    value: creatingLtId,
    onChange: e => {
      setCreatingLtId(e.target.value);
      setCreatingPkgId('');
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "\u2014 Select lesson type \u2014"), lessonTypes.map(lt => /*#__PURE__*/React.createElement("option", {
    key: lt.id,
    value: lt.id
  }, lt.name)))), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Package"), /*#__PURE__*/React.createElement("select", {
    className: "select",
    value: creatingPkgId,
    onChange: e => setCreatingPkgId(e.target.value),
    disabled: !creatingLtId
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, creatingLtId ? '— Select package —' : 'Pick lesson type first'), eligiblePackages.map(p => /*#__PURE__*/React.createElement("option", {
    key: p.id,
    value: p.id
  }, p.name))))), /*#__PURE__*/React.createElement("div", {
    className: "form-grid",
    style: {
      gridTemplateColumns: '1fr auto'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Group Name"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: creatingName,
    onChange: e => setCreatingName(e.target.value),
    placeholder: `${pg.name} family · ${eligiblePackages.find(p => p.id === creatingPkgId)?.name || 'group'}`
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Type"), /*#__PURE__*/React.createElement("div", {
    className: "tabs",
    style: {
      gap: 2,
      padding: 2
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `tab ${creatingType === 'discount' ? 'active' : ''}`,
    style: {
      padding: '4px 10px',
      fontSize: 11
    },
    onClick: () => setCreatingType('discount')
  }, "\uD83D\uDC6A Discount"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `tab ${creatingType === 'bound' ? 'active' : ''}`,
    style: {
      padding: '4px 10px',
      fontSize: 11
    },
    onClick: () => setCreatingType('bound')
  }, "\uD83D\uDD17 Bound")))), creatingPkgId && (() => {
    const free = previewEligible.filter(sw => !conflictingGroupFor(sw.id, creatingPkgId, null));
    const conflicted = previewEligible.filter(sw => !!conflictingGroupFor(sw.id, creatingPkgId, null));
    const lacking = pg.swimmers.filter(s => !previewEligible.includes(s));
    return /*#__PURE__*/React.createElement("div", {
      className: "parent-group-block",
      style: {
        background: '#F0F9FF',
        borderColor: '#BFDBFE'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        flexWrap: 'wrap',
        marginBottom: 6
      }
    }, /*#__PURE__*/React.createElement("strong", null, "Eligible swimmers"), /*#__PURE__*/React.createElement("span", {
      className: "subtle small"
    }, free.length, " free \xB7 ", conflicted.length, " already in another group \xB7 ", lacking.length, " no matching enrolment"), /*#__PURE__*/React.createElement("div", {
      style: {
        marginLeft: 'auto',
        display: 'flex',
        gap: 4
      }
    }, /*#__PURE__*/React.createElement("button", {
      className: "btn btn-ghost small",
      onClick: () => setCreatingMemberIds(new Set(free.map(s => s.id))),
      disabled: free.length === 0
    }, "All"), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-ghost small",
      onClick: selectNone,
      disabled: creatingMemberIds.size === 0
    }, "None"))), /*#__PURE__*/React.createElement("div", {
      className: "parent-group-members"
    }, free.length === 0 && conflicted.length === 0 && lacking.length === pg.swimmers.length ? /*#__PURE__*/React.createElement("span", {
      className: "subtle small"
    }, "No swimmers in this family have the selected package. Add the enrolment to a swimmer first via \u270E Edit on their row.") : null, free.map(sw => {
      const checked = creatingMemberIds.has(sw.id);
      return /*#__PURE__*/React.createElement("label", {
        key: sw.id,
        className: "parent-group-member"
      }, /*#__PURE__*/React.createElement("input", {
        type: "checkbox",
        checked: checked,
        onChange: () => toggleMember(sw.id)
      }), " ", sw.name);
    }), conflicted.map(sw => {
      const other = conflictingGroupFor(sw.id, creatingPkgId, null);
      return /*#__PURE__*/React.createElement("label", {
        key: sw.id,
        className: "parent-group-member",
        style: {
          opacity: .45
        },
        title: `Already in "${other?.name}" with the same package — one group per (lesson type, package) per swimmer`
      }, /*#__PURE__*/React.createElement("input", {
        type: "checkbox",
        disabled: true
      }), " ", sw.name, " ", /*#__PURE__*/React.createElement("span", {
        className: "subtle small"
      }, "\xB7 already in ", other?.name));
    }), lacking.map(sw => /*#__PURE__*/React.createElement("label", {
      key: sw.id,
      className: "parent-group-member",
      style: {
        opacity: .45
      },
      title: "Does not have the selected package \u2014 add the enrolment to make eligible"
    }, /*#__PURE__*/React.createElement("input", {
      type: "checkbox",
      disabled: true
    }), " ", sw.name))));
  })(), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'flex-end',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary small",
    onClick: handleCreate,
    disabled: !creatingLtId || !creatingPkgId || !creatingName.trim()
  }, "+ Create & Assign ", creatingMemberIds.size > 0 ? `(${creatingMemberIds.size})` : '')))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'flex-end',
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: onClose
  }, "Close")));
}
function PendingCreditsView({
  branches,
  pendingCredits,
  invoices,
  studentById,
  familyGroups,
  groupById,
  lessonTypeById,
  packageById,
  onConfirm,
  onReverse
}) {
  const [statusFilter, setStatusFilter] = useState('pending');
  const [confirmingAll, setConfirmingAll] = useState(false);
  const pendingCount = pendingCredits.filter(p => p.status === 'pending').length;
  const invById = useMemo(() => Object.fromEntries((invoices || []).map(i => [i.id, i])), [invoices]);
  const filtered = pendingCredits.filter(pc => statusFilter === 'all' || pc.status === statusFilter);
  async function confirmAll() {
    const targets = pendingCredits.filter(p => p.status === 'pending');
    if (!targets.length) {
      alert('No pending credits to confirm.');
      return;
    }
    if (!confirm(`Confirm all ${targets.length} pending credit${targets.length > 1 ? 's' : ''}? This will allocate lesson credits to each swimmer immediately. This action cannot be undone.`)) return;
    setConfirmingAll(true);
    for (const pc of targets) {
      try {
        await onConfirm(pc);
      } catch (_) {}
    }
    setConfirmingAll(false);
  }
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      gap: 12,
      flexWrap: 'wrap',
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 18,
      fontWeight: 800
    }
  }, "\u23F3 Pending Credits"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, "Credits held in escrow after payment is recorded. Confirm to allocate lesson credits to the account. Reverse to reject (e.g. bounced payment).")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      alignItems: 'center'
    }
  }, pendingCount > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 18,
      fontWeight: 800,
      color: 'var(--amber-tx)'
    }
  }, pendingCount, " awaiting"), pendingCount > 0 && /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary small",
    disabled: confirmingAll,
    onClick: confirmAll
  }, confirmingAll ? 'Confirming…' : `✓ Confirm All (${pendingCount})`))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      flexWrap: 'wrap',
      alignItems: 'center',
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 3
    }
  }, ['pending', 'confirmed', 'reversed', 'all'].map(s => /*#__PURE__*/React.createElement("button", {
    key: s,
    className: `tab ${statusFilter === s ? 'active' : ''}`,
    style: {
      padding: '5px 10px',
      fontSize: 11,
      borderRadius: 7
    },
    onClick: () => setStatusFilter(s)
  }, s === 'all' ? `All (${pendingCredits.length})` : s.charAt(0).toUpperCase() + s.slice(1) + ` (${pendingCredits.filter(p => p.status === s).length})`))))), filtered.length === 0 && /*#__PURE__*/React.createElement("div", {
    className: "card empty",
    style: {
      padding: 28
    }
  }, "No credits in this status."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6
    }
  }, filtered.map(pc => {
    const inv = invById[pc.invoice_id];
    const lt = pc.lesson_type_id && lessonTypeById ? lessonTypeById(pc.lesson_type_id) : null;
    const pkg = pc.package_id && packageById ? packageById(pc.package_id) : null;
    const grp = pc.family_group_id && groupById ? groupById(pc.family_group_id) : null;
    const stu = pc.student_id && studentById ? studentById[pc.student_id] : null;
    return /*#__PURE__*/React.createElement("div", {
      key: pc.id,
      className: `pc-card status-${pc.status}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "pc-card-body"
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontWeight: 700
      }
    }, pc.description || 'Credit Allocation'), /*#__PURE__*/React.createElement("div", {
      className: "small subtle"
    }, grp ? `\ud83d\udc6a ${grp.name}` : stu ? `\ud83d\udc64 ${stu.name}` : 'Unknown recipient', lt ? ` \u00b7 ${lt.name}` : '', pkg ? ` \u00b7 ${pkg.name}` : ''), /*#__PURE__*/React.createElement("div", {
      className: "small subtle"
    }, pc.credits_per_swimmer, " credit", pc.credits_per_swimmer === 1 ? '' : 's', " per swimmer", inv ? ` \u00b7 ${inv.invoice_number}` : '', inv ? ` \u00b7 ${inv.account_name}` : ''), /*#__PURE__*/React.createElement("div", {
      className: "small subtle"
    }, new Date(pc.created_at).toLocaleDateString(undefined, {
      dateStyle: 'medium'
    }))), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 5
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: `pc-status-chip status-${pc.status}`
    }, pc.status === 'pending' ? '\u23f3 Pending' : pc.status === 'confirmed' ? '\u2713 Confirmed' : '\u2717 Reversed'), pc.status === 'pending' && /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 5
      }
    }, /*#__PURE__*/React.createElement("button", {
      className: "btn btn-primary small",
      onClick: () => onConfirm(pc)
    }, "\\u2713 Confirm Credits"), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-danger small",
      onClick: () => onReverse(pc)
    }, "\\u2717 Reverse")))));
  })));
}

// ── ReportsView — Dashboard + Retention ─────────────────────────────────────
// Focused analytics for the swim school owner. Two tabs:
//  1. Dashboard — today's cash snapshot, deferred revenue, at-risk swimmers,
//     overdue invoices, low-utilization slots. Decision-ready.
//  2. Retention — cohort analysis, LTV, churn signals. The growth-vs-leak chart.
function ReportsView({
  invoices,
  pmts,
  pendingCredits,
  students,
  sessions,
  creditBalances,
  branches,
  lessonTypes,
  lessonTypeById,
  currentBranchId
}) {
  const [tab, setTab] = useState('dashboard');
  const today = todayStr();
  const todayMs = new Date(today).getTime();
  const rm = v => `RM ${Number(v || 0).toFixed(2)}`;
  const monthAgo = n => {
    const d = new Date();
    d.setMonth(d.getMonth() - n);
    return toDateStr(d);
  };

  // Branch filter — match the global selector unless we explicitly want everything
  const branchScope = currentBranchId && currentBranchId !== 'all' ? currentBranchId : null;
  const branchById2 = useMemo(() => Object.fromEntries((branches || []).map(b => [b.id, b])), [branches]);
  const studentById2 = useMemo(() => Object.fromEntries((students || []).map(s => [s.id, s])), [students]);

  // Scope-filtered datasets
  const scopedStudents = students.filter(s => !branchScope || !s.branchId || s.branchId === branchScope);
  const scopedInvoices = invoices.filter(i => !branchScope || !i.branch_id || i.branch_id === branchScope);
  const scopedPmts = pmts.filter(p => {
    const inv = invoices.find(i => i.id === p.invoice_id);
    return !branchScope || !inv?.branch_id || inv.branch_id === branchScope;
  });

  // ── Last attended date per swimmer (used by at-risk + retention) ─────────
  const lastAttendedByStu = useMemo(() => {
    const m = {};
    sessions.forEach(s => {
      const sessionDate = addDays(s.weekStartDate || '', s.day);
      if (!sessionDate || sessionDate > today) return; // future sessions don't count
      (s.students || []).forEach(st => {
        const sid = st.studentId;
        if (!sid) return;
        // Only count if attendance was recorded as 'present' OR not recorded
        // (legacy data has no attendance — assume attended)
        const att = st.attendance || st.attendance_status || 'pending';
        if (att === 'absent' || att === 'no_show') return;
        if (!m[sid] || sessionDate > m[sid]) m[sid] = sessionDate;
      });
    });
    return m;
  }, [sessions, today]);

  // ── Tab routing ─────────────────────────────────────────────────────────
  const tabs = [['dashboard', '📊 Dashboard'], ['retention', '🔁 Retention & Churn']];
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      gap: 12,
      flexWrap: 'wrap',
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 18,
      fontWeight: 800
    }
  }, "Reports & Analytics"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, "Focused, decision-ready views", branchScope ? ` · scoped to ${branchById2[branchScope]?.name || 'branch'}` : ' · all branches', "."))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 4,
      flexWrap: 'wrap'
    }
  }, tabs.map(([k, l]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    className: `sub-tab ${tab === k ? 'active' : ''}`,
    style: {
      padding: '4px 14px',
      fontSize: 12
    },
    onClick: () => setTab(k)
  }, l)))), tab === 'dashboard' && /*#__PURE__*/React.createElement(DashboardReport, {
    invoices: scopedInvoices,
    pmts: scopedPmts,
    students: scopedStudents,
    pendingCredits: pendingCredits,
    creditBalances: creditBalances,
    sessions: sessions,
    lastAttendedByStu: lastAttendedByStu,
    today: today,
    todayMs: todayMs,
    rm: rm,
    studentById2: studentById2,
    branchById2: branchById2,
    branchScope: branchScope
  }), tab === 'retention' && /*#__PURE__*/React.createElement(RetentionReport, {
    students: scopedStudents,
    pmts: scopedPmts,
    lastAttendedByStu: lastAttendedByStu,
    sessions: sessions,
    today: today,
    todayMs: todayMs,
    rm: rm,
    studentById2: studentById2
  }));
}

// ── Dashboard tab ───────────────────────────────────────────────────────────
function DashboardReport({
  invoices,
  pmts,
  students,
  pendingCredits,
  creditBalances,
  sessions,
  lastAttendedByStu,
  today,
  todayMs,
  rm,
  studentById2,
  branchById2,
  branchScope
}) {
  // Current month boundaries
  const monthStart = today.slice(0, 7) + '-01';
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();

  // Cash collected this month
  const thisMonthPmts = pmts.filter(p => (p.payment_date || '') >= monthStart && (p.payment_date || '') <= today);
  const cashThisMonth = thisMonthPmts.reduce((s, p) => s + Number(p.amount || 0), 0);

  // Same month last year — only if data exists going back that far
  const lastYearStart = `${now.getFullYear() - 1}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const lastYearEnd = `${now.getFullYear() - 1}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
  const lastYearSamePmts = pmts.filter(p => (p.payment_date || '') >= lastYearStart && (p.payment_date || '') <= lastYearEnd);
  const cashLastYear = lastYearSamePmts.reduce((s, p) => s + Number(p.amount || 0), 0);
  const yoyDelta = cashLastYear > 0 ? Math.round((cashThisMonth - cashLastYear) / cashLastYear * 100) : null;

  // Pace projection
  const projection = dayOfMonth > 0 ? Math.round(cashThisMonth / dayOfMonth * daysInMonth) : 0;

  // Outstanding receivables
  const outstanding = invoices.filter(i => i.status !== 'paid' && i.status !== 'void').reduce((s, i) => s + Math.max(0, Number(i.total_amount || 0) - Number(i.amount_paid || 0)), 0);

  // Deferred revenue — sum of remaining credit balances multiplied by an estimated
  // per-credit value. We don't have a clean per-credit price, so use:
  //   per-credit value = total credit_purchases value / total credits purchased
  // This is the most defensible business approximation.
  const totalCreditsRemaining = (creditBalances || []).reduce((s, c) => s + Number(c.remaining_balance || 0), 0);
  // Approximate per-credit value from confirmed pending credits: amount / credits
  const confirmedCredits = (pendingCredits || []).filter(p => p.status === 'confirmed');
  let perCreditValue = 0;
  if (confirmedCredits.length > 0) {
    const totalValue = confirmedCredits.reduce((s, p) => s + Number(p.amount || 0), 0);
    const totalCredits = confirmedCredits.reduce((s, p) => s + Number(p.credits_per_swimmer || p.initial_balance || 4), 0);
    if (totalCredits > 0) perCreditValue = totalValue / totalCredits;
  }
  const deferredRevenue = totalCreditsRemaining * perCreditValue;

  // ── At-risk swimmers: last attended >30d ago AND credit ≤ 1 ──
  const balanceByStu = useMemo(() => {
    const m = {};
    (creditBalances || []).forEach(c => {
      const sid = c.student_id;
      if (!sid) return;
      m[sid] = (m[sid] || 0) + Number(c.remaining_balance || 0);
    });
    return m;
  }, [creditBalances]);
  const atRisk = students.filter(s => s.isActive !== false).map(s => {
    const last = lastAttendedByStu[s.id];
    const daysSince = last ? Math.floor((todayMs - new Date(last).getTime()) / 86400000) : 999;
    const bal = balanceByStu[s.id] || 0;
    return {
      swimmer: s,
      daysSince,
      lastAttended: last,
      balance: bal
    };
  }).filter(r => r.daysSince >= 30 && r.balance <= 1).sort((a, b) => b.daysSince - a.daysSince);

  // ── Overdue invoices ──
  const overdueInvs = invoices.filter(i => i.status !== 'paid' && i.status !== 'void' && i.due_date && i.due_date < today).map(i => ({
    inv: i,
    owed: Math.max(0, Number(i.total_amount || 0) - Number(i.amount_paid || 0)),
    daysOverdue: Math.floor((todayMs - new Date(i.due_date).getTime()) / 86400000)
  })).sort((a, b) => b.daysOverdue - a.daysOverdue);

  // ── Cash by payment method (last 30 days) ──
  const last30 = pmts.filter(p => (p.payment_date || '') >= monthAgoStr(30));
  const byMethod = {};
  last30.forEach(p => {
    const m = (p.payment_method || 'unknown').toLowerCase();
    byMethod[m] = (byMethod[m] || 0) + Number(p.amount || 0);
  });
  const methodRows = Object.entries(byMethod).sort((a, b) => b[1] - a[1]);
  const methodTotal = methodRows.reduce((s, [, v]) => s + v, 0);
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(4,1fr)',
      gap: 10,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement(KpiCard, {
    label: `Cash · ${now.toLocaleDateString(undefined, {
      month: 'long'
    })}`,
    value: rm(cashThisMonth),
    color: "var(--green-tx)",
    sub: yoyDelta !== null ? `${yoyDelta >= 0 ? '↑' : '↓'} ${Math.abs(yoyDelta)}% vs last year (${rm(cashLastYear)})` : `Day ${dayOfMonth} of ${daysInMonth}`
  }), /*#__PURE__*/React.createElement(KpiCard, {
    label: "Month-end projection",
    value: rm(projection),
    color: "var(--primary)",
    sub: `Pace: ${rm(cashThisMonth / Math.max(dayOfMonth, 1))} per day`
  }), /*#__PURE__*/React.createElement(KpiCard, {
    label: "Outstanding (AR)",
    value: rm(outstanding),
    color: "var(--amber-tx)",
    sub: `${invoices.filter(i => i.status !== 'paid' && i.status !== 'void').length} open invoice${invoices.filter(i => i.status !== 'paid' && i.status !== 'void').length === 1 ? '' : 's'}`
  }), /*#__PURE__*/React.createElement(KpiCard, {
    label: "Deferred revenue",
    value: rm(deferredRevenue),
    color: "#7C3AED",
    sub: `${totalCreditsRemaining} credits unredeemed · ~${rm(perCreditValue)}/credit`
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 12,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 800
    }
  }, "\u26A0\uFE0F At-risk swimmers (", atRisk.length, ")"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, "No class in 30+ days \xB7 low credit")), atRisk.length === 0 && /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      padding: '12px 0'
    }
  }, "None \u2014 every active swimmer attended recently or has credit remaining."), atRisk.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "table-wrap",
    style: {
      maxHeight: 260,
      overflow: 'auto'
    }
  }, /*#__PURE__*/React.createElement("table", null, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Swimmer"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: 'right'
    }
  }, "Days since"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: 'right'
    }
  }, "Balance"))), /*#__PURE__*/React.createElement("tbody", null, atRisk.slice(0, 30).map(r => /*#__PURE__*/React.createElement("tr", {
    key: r.swimmer.id
  }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 600
    }
  }, r.swimmer.name), /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, r.swimmer.guardianName || '—', " \xB7 ", r.swimmer.guardianPhone || r.swimmer.guardianEmail || '—')), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: 'right',
      color: r.daysSince >= 90 ? 'var(--red-tx)' : r.daysSince >= 60 ? '#F97316' : 'var(--amber-tx)',
      fontWeight: 700
    }
  }, r.daysSince >= 999 ? 'never' : `${r.daysSince}d`), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: 'right'
    }
  }, r.balance, " cr"))))), atRisk.length > 30 && /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      padding: '8px 12px'
    }
  }, "+ ", atRisk.length - 30, " more")), /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      marginTop: 8,
      fontStyle: 'italic'
    }
  }, "\uD83D\uDCDE A friendly call this week recovers most of these. They haven't decided to quit yet \u2014 they just got busy.")), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 800
    }
  }, "\uD83D\uDCCB Overdue invoices (", overdueInvs.length, ")"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, rm(overdueInvs.reduce((s, r) => s + r.owed, 0)), " total")), overdueInvs.length === 0 && /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      padding: '12px 0'
    }
  }, "None \u2014 all invoices either current or paid."), overdueInvs.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "table-wrap",
    style: {
      maxHeight: 260,
      overflow: 'auto'
    }
  }, /*#__PURE__*/React.createElement("table", null, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Account"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: 'right'
    }
  }, "Owed"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: 'right'
    }
  }, "Overdue"))), /*#__PURE__*/React.createElement("tbody", null, overdueInvs.slice(0, 30).map(r => /*#__PURE__*/React.createElement("tr", {
    key: r.inv.id
  }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 600
    }
  }, r.inv.account_name), /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, r.inv.invoice_number, " \xB7 due ", r.inv.due_date)), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: 'right',
      fontWeight: 700,
      color: 'var(--red-tx)'
    }
  }, rm(r.owed)), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: 'right'
    }
  }, r.daysOverdue, "d"))))), overdueInvs.length > 30 && /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      padding: '8px 12px'
    }
  }, "+ ", overdueInvs.length - 30, " more")))), /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 800,
      marginBottom: 10
    }
  }, "\uD83D\uDCB0 Cash collected by method \xB7 last 30 days"), methodRows.length === 0 && /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, "No payments recorded in the last 30 days."), methodRows.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6
    }
  }, methodRows.map(([m, v]) => /*#__PURE__*/React.createElement("div", {
    key: m,
    style: {
      display: 'grid',
      gridTemplateColumns: '150px 1fr 120px 60px',
      gap: 10,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      fontWeight: 600,
      color: 'var(--text-2)',
      textTransform: 'capitalize'
    }
  }, m), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 14,
      borderRadius: 4,
      background: 'var(--border)',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      borderRadius: 4,
      background: 'var(--primary)',
      width: Math.round(v / methodTotal * 100) + '%',
      minWidth: 2
    }
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      textAlign: 'right'
    }
  }, rm(v)), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: 'var(--text-3)',
      textAlign: 'right'
    }
  }, Math.round(v / methodTotal * 100), "%"))))));
}

// ── Retention tab ────────────────────────────────────────────────────────────
function RetentionReport({
  students,
  pmts,
  lastAttendedByStu,
  sessions,
  today,
  todayMs,
  rm,
  studentById2
}) {
  // Build attendance set per swimmer: months they were active in
  // "Active in month M" = attended a session OR was enrolled with positive balance
  const attendedMonthsByStu = useMemo(() => {
    const m = {};
    sessions.forEach(s => {
      const sessionDate = addDays(s.weekStartDate || '', s.day);
      if (!sessionDate || sessionDate > today) return;
      const mk = sessionDate.slice(0, 7);
      (s.students || []).forEach(st => {
        const sid = st.studentId;
        if (!sid) return;
        const att = st.attendance || st.attendance_status || 'pending';
        if (att === 'absent' || att === 'no_show') return;
        if (!m[sid]) m[sid] = new Set();
        m[sid].add(mk);
      });
    });
    return m;
  }, [sessions, today]);

  // Cohort: group students by month of created_at
  const cohorts = useMemo(() => {
    const c = {};
    students.forEach(s => {
      const created = (s.createdAt || s.created_at || '').slice(0, 7);
      if (!created) return;
      if (!c[created]) c[created] = [];
      c[created].push(s);
    });
    return c;
  }, [students]);

  // For each cohort, % active at month N (where N=0..11 after signup)
  const cohortKeys = Object.keys(cohorts).sort();
  const lastCohort = cohortKeys.length ? cohortKeys[cohortKeys.length - 1] : null;
  function monthsAfter(cohortMk, n) {
    const [y, m] = cohortMk.split('-').map(Number);
    const d = new Date(y, m - 1 + n, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  const cohortRows = cohortKeys.slice(-12).reverse().map(ck => {
    const members = cohorts[ck];
    const size = members.length;
    const buckets = Array.from({
      length: 12
    }, (_, n) => {
      const targetMk = monthsAfter(ck, n);
      // Only count cells where target month has already occurred
      if (targetMk > today.slice(0, 7)) return null;
      const activeCount = members.filter(s => {
        const mset = attendedMonthsByStu[s.id];
        return mset && mset.has(targetMk);
      }).length;
      return size > 0 ? Math.round(activeCount / size * 100) : 0;
    });
    return {
      cohort: ck,
      size,
      buckets
    };
  });

  // LTV calculation — per-account total payments × months active
  // Build account → { totalPaid, firstAct, lastAct, swimmerCount }
  const accountAgg = {};
  const swimmerToAccount = {};
  students.forEach(s => {
    const key = s.accountId || `__legacy__${s.guardianEmail || s.guardianName || s.id}`;
    swimmerToAccount[s.id] = key;
    if (!accountAgg[key]) accountAgg[key] = {
      swimmers: new Set(),
      name: s.guardianName || '?',
      firstAct: null,
      lastAct: null,
      totalPaid: 0
    };
    accountAgg[key].swimmers.add(s.id);
    const last = lastAttendedByStu[s.id];
    if (last) {
      if (!accountAgg[key].firstAct || last < accountAgg[key].firstAct) accountAgg[key].firstAct = last;
      if (!accountAgg[key].lastAct || last > accountAgg[key].lastAct) accountAgg[key].lastAct = last;
    }
  });

  // LTV summary
  const allAccounts = Object.values(accountAgg);
  const activeAccounts = allAccounts.filter(a => a.lastAct);
  const totalSwimmers = students.length;
  const totalActiveSwimmers = students.filter(s => {
    const last = lastAttendedByStu[s.id];
    if (!last) return false;
    return (todayMs - new Date(last).getTime()) / 86400000 <= 30;
  }).length;

  // Average months active across all accounts with both first and last
  const monthsActiveList = allAccounts.filter(a => a.firstAct && a.lastAct).map(a => {
    const months = (new Date(a.lastAct).getFullYear() - new Date(a.firstAct).getFullYear()) * 12 + (new Date(a.lastAct).getMonth() - new Date(a.firstAct).getMonth()) + 1;
    return Math.max(1, months);
  });
  const avgMonthsActive = monthsActiveList.length ? Math.round(monthsActiveList.reduce((s, x) => s + x, 0) / monthsActiveList.length) : 0;

  // Total revenue ÷ total swimmers = avg revenue per swimmer
  const totalRevenue = pmts.reduce((s, p) => s + Number(p.amount || 0), 0);
  const avgRevenuePerSwimmer = totalSwimmers > 0 ? totalRevenue / totalSwimmers : 0;
  const avgLTV = avgMonthsActive > 0 ? avgRevenuePerSwimmer : 0; // already cumulative
  const avgMonthlyValue = avgMonthsActive > 0 ? avgLTV / avgMonthsActive : 0;

  // Churn: never attended OR last attended >60 days ago
  const churnedSwimmers = students.filter(s => {
    const last = lastAttendedByStu[s.id];
    if (!last) return false; // never attended ≠ churned, they may be brand new
    return (todayMs - new Date(last).getTime()) / 86400000 > 60;
  });
  const churnRate = totalSwimmers > 0 ? Math.round(churnedSwimmers.length / totalSwimmers * 100) : 0;

  // Color cell by retention bucket
  function cellColor(pct) {
    if (pct === null) return 'transparent';
    if (pct >= 75) return '#86EFAC';
    if (pct >= 50) return '#FDE68A';
    if (pct >= 25) return '#FCA5A5';
    return '#FECACA';
  }
  function fmtCohort(mk) {
    try {
      const [y, m] = mk.split('-');
      return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
        month: 'short',
        year: '2-digit'
      });
    } catch (_) {
      return mk;
    }
  }
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(4,1fr)',
      gap: 10,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement(KpiCard, {
    label: "Average LTV per swimmer",
    value: rm(avgLTV),
    color: "var(--primary)",
    sub: `${rm(avgMonthlyValue)}/mo · ${avgMonthsActive} mo avg lifetime`
  }), /*#__PURE__*/React.createElement(KpiCard, {
    label: "Active swimmers",
    value: `${totalActiveSwimmers} / ${totalSwimmers}`,
    color: "var(--green-tx)",
    sub: `${Math.round(totalActiveSwimmers / Math.max(totalSwimmers, 1) * 100)}% attended in last 30d`
  }), /*#__PURE__*/React.createElement(KpiCard, {
    label: "Churned (60+d inactive)",
    value: churnedSwimmers.length,
    color: "var(--red-tx)",
    sub: `${churnRate}% of total roster`
  }), /*#__PURE__*/React.createElement(KpiCard, {
    label: "Total accounts tracked",
    value: allAccounts.length,
    color: "var(--text)",
    sub: `${activeAccounts.length} have attendance recorded`
  })), /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 12,
      padding: 0,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '12px 14px',
      borderBottom: '1px solid var(--border)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 800
    }
  }, "Cohort retention \u2014 % of swimmers still attending each month after signup"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      marginTop: 3
    }
  }, "Healthy benchmarks: 75%+ at month 3 (green) \xB7 50\u201375% (yellow) \xB7 below 50% needs intervention (red). Last 12 cohorts shown.")), cohortRows.length === 0 && /*#__PURE__*/React.createElement("div", {
    className: "empty",
    style: {
      padding: 24
    }
  }, "No cohort data yet \u2014 need swimmer signup dates and recorded attendance."), cohortRows.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      overflow: 'auto'
    }
  }, /*#__PURE__*/React.createElement("table", {
    style: {
      width: '100%',
      borderCollapse: 'separate',
      borderSpacing: 0,
      fontSize: 11
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    style: {
      background: 'var(--surface-2)'
    }
  }, /*#__PURE__*/React.createElement("th", {
    style: {
      padding: '8px 10px',
      textAlign: 'left',
      position: 'sticky',
      left: 0,
      background: 'var(--surface-2)',
      zIndex: 1,
      minWidth: 90
    }
  }, "Cohort"), /*#__PURE__*/React.createElement("th", {
    style: {
      padding: '8px 6px',
      textAlign: 'right'
    }
  }, "Size"), Array.from({
    length: 12
  }, (_, i) => /*#__PURE__*/React.createElement("th", {
    key: i,
    style: {
      padding: '8px 4px',
      textAlign: 'center',
      minWidth: 42
    }
  }, "M", i)))), /*#__PURE__*/React.createElement("tbody", null, cohortRows.map(r => /*#__PURE__*/React.createElement("tr", {
    key: r.cohort
  }, /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '6px 10px',
      fontWeight: 600,
      position: 'sticky',
      left: 0,
      background: 'var(--surface)',
      zIndex: 1
    }
  }, fmtCohort(r.cohort)), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '6px',
      textAlign: 'right',
      fontWeight: 600,
      color: 'var(--text-2)'
    }
  }, r.size), r.buckets.map((pct, i) => /*#__PURE__*/React.createElement("td", {
    key: i,
    style: {
      padding: '6px 4px',
      textAlign: 'center',
      background: cellColor(pct),
      color: pct === null ? 'transparent' : '#000',
      fontWeight: 600
    }
  }, pct === null ? '—' : pct + '%')))))))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 800,
      marginBottom: 10
    }
  }, "Roster activity distribution"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      marginBottom: 12
    }
  }, "How recently each currently-marked-active swimmer was seen in class."), (() => {
    const buckets = {
      '0-7d': 0,
      '8-30d': 0,
      '31-60d': 0,
      '61-90d': 0,
      '90+d': 0,
      'never': 0
    };
    students.filter(s => s.isActive !== false).forEach(s => {
      const last = lastAttendedByStu[s.id];
      if (!last) {
        buckets['never']++;
        return;
      }
      const days = Math.floor((todayMs - new Date(last).getTime()) / 86400000);
      if (days <= 7) buckets['0-7d']++;else if (days <= 30) buckets['8-30d']++;else if (days <= 60) buckets['31-60d']++;else if (days <= 90) buckets['61-90d']++;else buckets['90+d']++;
    });
    const max = Math.max(...Object.values(buckets), 1);
    const colors = {
      '0-7d': 'var(--green-tx)',
      '8-30d': '#84CC16',
      '31-60d': 'var(--amber-tx)',
      '61-90d': '#F97316',
      '90+d': 'var(--red-tx)',
      'never': '#9CA3AF'
    };
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6
      }
    }, Object.entries(buckets).map(([k, v]) => /*#__PURE__*/React.createElement("div", {
      key: k,
      style: {
        display: 'grid',
        gridTemplateColumns: '90px 1fr 60px',
        gap: 10,
        alignItems: 'center'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--text-2)'
      }
    }, k), /*#__PURE__*/React.createElement("div", {
      style: {
        height: 18,
        borderRadius: 5,
        background: 'var(--border)',
        overflow: 'hidden'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        height: '100%',
        borderRadius: 5,
        background: colors[k],
        width: Math.round(v / max * 100) + '%',
        minWidth: 2
      }
    })), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 12,
        fontWeight: 700,
        textAlign: 'right'
      }
    }, v))));
  })()));
}

// ── KpiCard — reusable big-number tile ──────────────────────────────────────
function KpiCard({
  label,
  value,
  color,
  sub
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      padding: '12px 14px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      fontSize: 11
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 24,
      fontWeight: 800,
      color,
      marginTop: 3,
      letterSpacing: '-.3px'
    }
  }, value), sub && /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      fontSize: 10.5,
      marginTop: 4
    }
  }, sub));
}

// Helper used by Dashboard — defined at module scope
function monthAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function AgingReportView({
  invoices,
  pmts,
  branches
}) {
  const [sortBy, setSortBy] = useState('outstanding');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const today = todayStr();
  const todayMs = new Date(today).getTime();

  // Filter invoices by date range (issue_date)
  const filteredInvs = invoices.filter(inv => {
    if (dateFrom && inv.issue_date && inv.issue_date < dateFrom) return false;
    if (dateTo && inv.issue_date && inv.issue_date > dateTo) return false;
    return true;
  });
  const accountMap = {};
  filteredInvs.forEach(inv => {
    const key = inv.account_name;
    if (!accountMap[key]) accountMap[key] = {
      account: key,
      invoices: [],
      totalInvoiced: 0,
      totalPaid: 0
    };
    accountMap[key].invoices.push(inv);
    accountMap[key].totalInvoiced += Number(inv.total_amount || 0);
    accountMap[key].totalPaid += Number(inv.amount_paid || 0);
  });
  const rows = Object.values(accountMap).map(a => {
    const outstanding = Math.max(0, a.totalInvoiced - a.totalPaid);
    let current = 0,
      d1_30 = 0,
      d31_60 = 0,
      d60plus = 0;
    a.invoices.forEach(inv => {
      if (inv.status === 'paid' || inv.status === 'void') return;
      const owed = Math.max(0, Number(inv.total_amount) - Number(inv.amount_paid));
      if (!owed) return;
      if (!inv.due_date) {
        current += owed;
        return;
      }
      const age = Math.floor((todayMs - new Date(inv.due_date).getTime()) / 86400000);
      if (age <= 0) current += owed;else if (age <= 30) d1_30 += owed;else if (age <= 60) d31_60 += owed;else d60plus += owed;
    });
    const openInvs = a.invoices.filter(i => i.status !== 'paid' && i.status !== 'void');
    const oldestDue = openInvs.map(i => i.due_date).filter(Boolean).sort()[0] || null;
    const isOverdue = d1_30 > 0 || d31_60 > 0 || d60plus > 0;
    return {
      account: a.account,
      totalInvoiced: a.totalInvoiced,
      totalPaid: a.totalPaid,
      outstanding,
      current,
      d1_30,
      d31_60,
      d60plus,
      openCount: openInvs.length,
      oldestDue,
      isOverdue
    };
  }).filter(r => r.totalInvoiced > 0);
  rows.sort((a, b) => {
    if (sortBy === 'outstanding') return b.outstanding - a.outstanding;
    if (sortBy === 'account') return a.account.localeCompare(b.account);
    if (sortBy === 'oldest') return (a.oldestDue || '9999') > (b.oldestDue || '9999') ? 1 : -1;
    return 0;
  });
  const totals = rows.reduce((s, r) => ({
    invoiced: s.invoiced + r.totalInvoiced,
    paid: s.paid + r.totalPaid,
    outstanding: s.outstanding + r.outstanding,
    current: s.current + r.current,
    d1_30: s.d1_30 + r.d1_30,
    d31_60: s.d31_60 + r.d31_60,
    d60plus: s.d60plus + r.d60plus
  }), {
    invoiced: 0,
    paid: 0,
    outstanding: 0,
    current: 0,
    d1_30: 0,
    d31_60: 0,
    d60plus: 0
  });
  const rm = v => `RM ${v.toFixed(2)}`;
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      gap: 12,
      flexWrap: 'wrap',
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 18,
      fontWeight: 800
    }
  }, "Aging Report"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, "Outstanding balances by account, bucketed by how overdue they are. As of ", today, ".")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 16,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, "Total Outstanding"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 20,
      fontWeight: 800,
      color: 'var(--amber-tx)'
    }
  }, rm(totals.outstanding))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      color: 'var(--red-tx)'
    }
  }, "60+ Days"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 20,
      fontWeight: 800,
      color: 'var(--red-tx)'
    }
  }, rm(totals.d60plus))))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      alignItems: 'center',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "small subtle"
  }, "Date range (issue date):"), /*#__PURE__*/React.createElement("input", {
    type: "date",
    className: "input",
    style: {
      width: 150,
      padding: '4px 8px',
      fontSize: 12
    },
    value: dateFrom,
    onChange: e => setDateFrom(e.target.value)
  }), /*#__PURE__*/React.createElement("span", {
    className: "small subtle"
  }, "to"), /*#__PURE__*/React.createElement("input", {
    type: "date",
    className: "input",
    style: {
      width: 150,
      padding: '4px 8px',
      fontSize: 12
    },
    value: dateTo,
    onChange: e => setDateTo(e.target.value)
  }), (dateFrom || dateTo) && /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: () => {
      setDateFrom('');
      setDateTo('');
    }
  }, "Clear"), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      display: 'flex',
      gap: 6,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "small subtle"
  }, "Sort:"), [['outstanding', 'Outstanding'], ['account', 'Account'], ['oldest', 'Oldest Due']].map(([k, l]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    className: `tab ${sortBy === k ? 'active' : ''}`,
    style: {
      padding: '4px 10px',
      fontSize: 11,
      borderRadius: 6
    },
    onClick: () => setSortBy(k)
  }, l))))), rows.length === 0 && /*#__PURE__*/React.createElement("div", {
    className: "card empty",
    style: {
      padding: 28
    }
  }, "No invoiced accounts", dateFrom || dateTo ? ' in this date range' : '', " yet."), rows.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "table-wrap"
  }, /*#__PURE__*/React.createElement("table", null, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Account"), /*#__PURE__*/React.createElement("th", {
    className: "num"
  }, "Invoiced"), /*#__PURE__*/React.createElement("th", {
    className: "num"
  }, "Paid"), /*#__PURE__*/React.createElement("th", {
    className: "num"
  }, "Outstanding"), /*#__PURE__*/React.createElement("th", {
    className: "num",
    title: "Not yet due"
  }, "Current"), /*#__PURE__*/React.createElement("th", {
    className: "num",
    style: {
      color: 'var(--amber-tx)'
    }
  }, "1\u201330d"), /*#__PURE__*/React.createElement("th", {
    className: "num",
    style: {
      color: '#F97316'
    }
  }, "31\u201360d"), /*#__PURE__*/React.createElement("th", {
    className: "num",
    style: {
      color: 'var(--red-tx)'
    }
  }, "60+d"), /*#__PURE__*/React.createElement("th", {
    className: "num"
  }, "Open Inv."))), /*#__PURE__*/React.createElement("tbody", null, rows.map(r => /*#__PURE__*/React.createElement("tr", {
    key: r.account,
    style: {
      background: r.d60plus > 0 ? 'rgba(239,68,68,.06)' : r.d31_60 > 0 ? 'rgba(249,115,22,.04)' : ''
    }
  }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700
    }
  }, r.account), r.isOverdue && r.oldestDue && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: '#EF4444'
    }
  }, "Overdue since ", r.oldestDue)), /*#__PURE__*/React.createElement("td", {
    className: "num"
  }, rm(r.totalInvoiced)), /*#__PURE__*/React.createElement("td", {
    className: "num",
    style: {
      color: '#10B981'
    }
  }, rm(r.totalPaid)), /*#__PURE__*/React.createElement("td", {
    className: "num",
    style: {
      fontWeight: 800,
      color: r.outstanding > 0 ? '#F59E0B' : '#10B981'
    }
  }, r.outstanding > 0 ? rm(r.outstanding) : '\u2713'), /*#__PURE__*/React.createElement("td", {
    className: "num"
  }, r.current > 0 ? rm(r.current) : '-'), /*#__PURE__*/React.createElement("td", {
    className: "num",
    style: {
      color: r.d1_30 > 0 ? '#F59E0B' : ''
    }
  }, r.d1_30 > 0 ? rm(r.d1_30) : '-'), /*#__PURE__*/React.createElement("td", {
    className: "num",
    style: {
      color: r.d31_60 > 0 ? '#F97316' : ''
    }
  }, r.d31_60 > 0 ? rm(r.d31_60) : '-'), /*#__PURE__*/React.createElement("td", {
    className: "num",
    style: {
      fontWeight: r.d60plus > 0 ? 800 : 400,
      color: r.d60plus > 0 ? '#EF4444' : ''
    }
  }, r.d60plus > 0 ? rm(r.d60plus) : '-'), /*#__PURE__*/React.createElement("td", {
    className: "num"
  }, r.openCount)))), /*#__PURE__*/React.createElement("tfoot", null, /*#__PURE__*/React.createElement("tr", {
    style: {
      borderTop: '2px solid var(--border)',
      fontWeight: 800
    }
  }, /*#__PURE__*/React.createElement("td", null, "Totals (", rows.length, " accounts)"), /*#__PURE__*/React.createElement("td", {
    className: "num"
  }, rm(totals.invoiced)), /*#__PURE__*/React.createElement("td", {
    className: "num",
    style: {
      color: '#10B981'
    }
  }, rm(totals.paid)), /*#__PURE__*/React.createElement("td", {
    className: "num",
    style: {
      color: '#F59E0B'
    }
  }, rm(totals.outstanding)), /*#__PURE__*/React.createElement("td", {
    className: "num"
  }, totals.current > 0 ? rm(totals.current) : '-'), /*#__PURE__*/React.createElement("td", {
    className: "num",
    style: {
      color: totals.d1_30 > 0 ? '#F59E0B' : ''
    }
  }, totals.d1_30 > 0 ? rm(totals.d1_30) : '-'), /*#__PURE__*/React.createElement("td", {
    className: "num",
    style: {
      color: totals.d31_60 > 0 ? '#F97316' : ''
    }
  }, totals.d31_60 > 0 ? rm(totals.d31_60) : '-'), /*#__PURE__*/React.createElement("td", {
    className: "num",
    style: {
      fontWeight: 800,
      color: totals.d60plus > 0 ? '#EF4444' : ''
    }
  }, totals.d60plus > 0 ? rm(totals.d60plus) : '-'), /*#__PURE__*/React.createElement("td", {
    className: "num"
  }))))), /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      marginTop: 10
    }
  }, "Age buckets are calculated from invoice due dates. Invoices without a due date are counted as Current. Paid and voided invoices are excluded."));
}
function ReceiptsView({
  pmts,
  invoices,
  branches,
  externalSearchQ
}) {
  const [localSearchQ, setLocalSearchQ] = useState('');
  const searchQ = externalSearchQ !== undefined ? externalSearchQ : localSearchQ;
  const setSearchQ = setLocalSearchQ;
  const [branchFilter, setBranchFilter] = useState(null);
  const invoiceById = {};
  (invoices || []).forEach(inv => {
    invoiceById[inv.id] = inv;
  });
  const sorted = (pmts || []).slice().sort((a, b) => (b.payment_date || '').localeCompare(a.payment_date || ''));
  const filtered = sorted.filter(p => {
    const inv = invoiceById[p.invoice_id] || {};
    if (branchFilter && inv.branch_id !== branchFilter) return false;
    if (!searchQ.trim()) return true;
    const q = searchQ.toLowerCase();
    return (p.receipt_number || '').toLowerCase().includes(q) || (inv.invoice_number || '').toLowerCase().includes(q) || (inv.account_name || '').toLowerCase().includes(q) || (p.payment_method || '').toLowerCase().includes(q);
  });
  const total = filtered.reduce((s, p) => s + Number(p.amount || 0), 0);
  function fmtDate(d) {
    if (!d) return '—';
    try {
      return new Date(d).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      });
    } catch (_) {
      return d;
    }
  }
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      gap: 12,
      flexWrap: 'wrap',
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 18,
      fontWeight: 800
    }
  }, "\uD83D\uDCB0 Receipts"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      marginTop: 3
    }
  }, "All recorded payments. Click \uD83D\uDDA8 to print a receipt.")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, "Total collected", branchFilter ? ' (filtered)' : ''), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 22,
      fontWeight: 800,
      color: 'var(--green-tx)'
    }
  }, "RM", total.toFixed(2)))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      alignItems: 'center',
      flexWrap: 'wrap'
    }
  }, externalSearchQ === undefined && /*#__PURE__*/React.createElement("input", {
    className: "input",
    style: {
      flex: 1,
      maxWidth: 320
    },
    placeholder: "Search receipt #, invoice #, account, method\u2026",
    value: searchQ,
    onChange: e => setSearchQ(e.target.value)
  }), /*#__PURE__*/React.createElement(BranchFilterPills, {
    branches: branches,
    value: branchFilter,
    onChange: setBranchFilter
  }), /*#__PURE__*/React.createElement("span", {
    className: "small subtle"
  }, filtered.length, " / ", (pmts || []).length))), /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      padding: 0,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "table-wrap",
    style: {
      border: 'none',
      borderRadius: 0,
      maxHeight: '70vh'
    }
  }, /*#__PURE__*/React.createElement("table", null, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      width: 110
    }
  }, "Date"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 130
    }
  }, "Receipt #"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 130
    }
  }, "Invoice #"), /*#__PURE__*/React.createElement("th", null, "Account"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 110
    }
  }, "Method"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 110,
      textAlign: 'right'
    }
  }, "Amount"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 60
    }
  }))), /*#__PURE__*/React.createElement("tbody", null, filtered.length === 0 && /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    colSpan: 7,
    className: "empty"
  }, "No receipts found.")), filtered.map(p => {
    const inv = invoiceById[p.invoice_id] || {};
    return /*#__PURE__*/React.createElement("tr", {
      key: p.id
    }, /*#__PURE__*/React.createElement("td", null, fmtDate(p.payment_date)), /*#__PURE__*/React.createElement("td", {
      style: {
        fontFamily: 'monospace',
        fontSize: 12
      }
    }, p.receipt_number || '—'), /*#__PURE__*/React.createElement("td", {
      style: {
        fontFamily: 'monospace',
        fontSize: 12
      }
    }, inv.invoice_number || '—'), /*#__PURE__*/React.createElement("td", {
      style: {
        fontWeight: 600
      }
    }, inv.account_name || '—'), /*#__PURE__*/React.createElement("td", {
      className: "small subtle"
    }, methodLabel(p.payment_method)), /*#__PURE__*/React.createElement("td", {
      style: {
        textAlign: 'right',
        fontWeight: 700,
        color: 'var(--green-tx)'
      }
    }, "RM", Number(p.amount).toFixed(2)), /*#__PURE__*/React.createElement("td", {
      style: {
        textAlign: 'center'
      }
    }, /*#__PURE__*/React.createElement("button", {
      className: "btn btn-ghost small",
      title: "Print receipt",
      onClick: () => printReceipt(p, inv)
    }, "\uD83D\uDDA8")));
  }))))));
}
function StudentsView({
  students,
  lessonTypes,
  lessonTypeById,
  packages,
  packageById,
  groupById,
  familyGroups,
  membersByGroup,
  scheduleByStudent,
  sessions,
  jumpToWeek,
  creditByKey,
  purchasesByStudent,
  subscriptions,
  addCreditPurchase,
  deleteCreditPurchase,
  addSubscription,
  cancelSubscription,
  adjustBalanceTo,
  addStudent,
  updateStudent,
  deleteStudent,
  externalSearchQ
}) {
  const [name, setName] = useState('');
  const [dob, setDob] = useState('');
  const [gender, setGender] = useState(null);
  const [enrollments, setEnrollments] = useState([{
    lessonTypeId: '',
    packageId: ''
  }]);
  const [guardianName, setGuardianName] = useState('');
  const [guardianEmail, setGuardianEmail] = useState('');
  const [guardianPhone, setGuardianPhone] = useState('');
  const [sameAsGuardian, setSameAsGuardian] = useState(false);
  const [emergencyPhone, setEmergencyPhone] = useState('');
  const [emergencyRel, setEmergencyRel] = useState('');
  const [adultSelf, setAdultSelf] = useState(false);
  const [editId, setEditId] = useState(null);
  const [creditId, setCreditId] = useState(null);
  const [localQ, setLocalQ] = useState('');
  // Prefer the sticky sub-bar search when provided
  const q = externalSearchQ !== undefined ? externalSearchQ : localQ;
  const setQ = setLocalQ;
  const [sortBy, setSortBy] = useState('name');
  const [formExpanded, setFormExpanded] = useState(false);

  // nextScheduledByStudentLt: for each (studentId, lessonTypeId) and for
  // each (day, startMinute) slot the swimmer recurs in, find the earliest
  // weekStartDate (≥ current week) when an actual session exists for that
  // slot in that lesson type with that swimmer enrolled. Used to make each
  // Schedule cell entry a clickable link that jumps the Weekly view to
  // exactly the right week — current week if a session exists there,
  // otherwise the next upcoming scheduled week (handles forwards,
  // duplicates-into-future, etc.).
  const nextScheduledByStudentLt = useMemo(() => {
    const todayWs = weekStartStr(todayStr());
    const out = {}; // studentId → lessonTypeId → weekStartDate
    (sessions || []).forEach(s => {
      if (s.cancelledAt) return; // skip ghosts
      if (!s.weekStartDate || s.weekStartDate < todayWs) return;
      (s.students || []).forEach(st => {
        const sid = st.studentId;
        if (!sid) return;
        if (!out[sid]) out[sid] = {};
        const prev = out[sid][s.lessonTypeId];
        if (!prev || s.weekStartDate < prev) out[sid][s.lessonTypeId] = s.weekStartDate;
      });
    });
    return out;
  }, [sessions]);
  function nextWeekFor(studentId, lessonTypeName) {
    const ltId = (lessonTypes.find(lt => lt.name === lessonTypeName) || {}).id;
    if (!ltId) return null;
    return (nextScheduledByStudentLt[studentId] || {})[ltId] || null;
  }
  function colorsForId(id) {
    const t = lessonTypeById(id);
    return t ? {
      bg: t.bg_color,
      bd: t.border_color,
      tx: t.text_color,
      name: t.name
    } : {
      bg: '#eee',
      bd: '#ccc',
      tx: '#333',
      name: '(removed)'
    };
  }
  function packageLabel(s) {
    const g = s.familyGroupId && groupById ? groupById[s.familyGroupId] : null;
    if (g) {
      const gp = g.packageId ? packageById(g.packageId) : null;
      return `👪 ${g.name}${gp ? ` · ${gp.name}` : ''}`;
    }
    const p = s.packageId ? packageById(s.packageId) : null;
    if (p) {
      const b = billingText(p.billing_mode, p.billing_count);
      return `${p.name}${p.amount != null ? ` · RM${p.amount}` : ''}${b ? ` · ${b}` : ''}`;
    }
    return s.package || '—';
  }
  function scheduleLines(id) {
    const slots = scheduleByStudent[id] || [];
    if (!slots.length) return null;
    const byType = {};
    slots.forEach(sl => {
      (byType[sl.type] = byType[sl.type] || []).push(sl);
    });
    return Object.keys(byType).map(type => ({
      type,
      times: byType[type].map(sl => `${DAYS_S[sl.day]} ${minuteToTime(sl.startMinute)}`)
    }));
  }
  function creditInfo(s) {
    const pkg = s.packageId ? packageById(s.packageId) : null;
    if (!pkg || pkg.billing_mode !== 'credit') return null;
    const ltId = pkg.lesson_type_id;
    if (!ltId || !creditByKey) return null;
    const bal = creditByKey[`${s.id}:${ltId}`];
    if (!bal) return null;
    const scheduled = (scheduleByStudent[s.id] || []).filter(sl => sl.lessonTypeId === ltId).length;
    return {
      remaining: bal.remaining_balance,
      initial: bal.initial_balance,
      scheduled
    };
  }
  function handleAdultSelf(v) {
    setAdultSelf(v);
    if (v) setGuardianName(name);
  }
  function handleSameAsG(v) {
    setSameAsGuardian(v);
    if (v) {
      setEmergencyPhone(guardianPhone);
      setEmergencyRel('Parent / Guardian');
    }
  }
  const filtered = students.filter(s => {
    if (!q) return true;
    const ql = q.toLowerCase();
    return (s.name || '').toLowerCase().includes(ql) || (s.guardianName || '').toLowerCase().includes(ql) || (s.guardianPhone || '').toLowerCase().includes(ql) || (s.guardianEmail || '').toLowerCase().includes(ql);
  });

  // Always flat list — no group separators. All swimmers listed individually
  // regardless of family group membership (Groups tab handles group admin).
  const displayList = useMemo(() => {
    const sorted = filtered.slice().sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'type') {
        const tA = (a.lessonTypeIds?.[0] ? lessonTypeById(a.lessonTypeIds[0])?.name : '') || '';
        const tB = (b.lessonTypeIds?.[0] ? lessonTypeById(b.lessonTypeIds[0])?.name : '') || '';
        return tA.localeCompare(tB) || a.name.localeCompare(b.name);
      }
      if (sortBy === 'package') {
        const pA = (a.packageId ? packageById(a.packageId)?.name : '') || '';
        const pB = (b.packageId ? packageById(b.packageId)?.name : '') || '';
        return pA.localeCompare(pB) || a.name.localeCompare(b.name);
      }
      if (sortBy === 'parent') return (a.guardianName || '').localeCompare(b.guardianName || '') || a.name.localeCompare(b.name);
      return 0;
    });
    return sorted.map(s => ({
      kind: 'swimmer',
      s
    }));
  }, [filtered, sortBy]);
  const COLS = 9;
  function resetForm() {
    setName('');
    setDob('');
    setGender(null);
    setEnrollments([{
      lessonTypeId: '',
      packageId: ''
    }]);
    setGuardianName('');
    setGuardianEmail('');
    setGuardianPhone('');
    setSameAsGuardian(false);
    setEmergencyPhone('');
    setEmergencyRel('');
    setAdultSelf(false);
  }
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      alignItems: 'center',
      flexWrap: 'wrap'
    }
  }, externalSearchQ === undefined && /*#__PURE__*/React.createElement("input", {
    className: "input",
    style: {
      flex: '1 1 240px',
      maxWidth: 380
    },
    placeholder: "Search swimmer name, parent, phone\u2026",
    value: q,
    onChange: e => setQ(e.target.value)
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 4,
      alignItems: 'center',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "small subtle"
  }, "Sort:"), [['name', 'Name'], ['type', 'Lesson Type'], ['package', 'Package'], ['parent', 'Parent']].map(([k, lbl]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    className: `sub-tab${sortBy === k ? ' active' : ''}`,
    style: {
      height: 30,
      padding: '0 12px',
      fontSize: 12
    },
    onClick: () => setSortBy(k)
  }, lbl))), /*#__PURE__*/React.createElement("span", {
    className: "small subtle",
    style: {
      marginLeft: 'auto'
    }
  }, displayList.length, " / ", students.length, " swimmers"))), /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      padding: 0,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "table-wrap",
    style: {
      border: 'none',
      borderRadius: 0
    }
  }, /*#__PURE__*/React.createElement("table", null, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      width: '14%'
    }
  }, "Name"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 32
    }
  }, "Age"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: '13%'
    }
  }, "Parent"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: '10%'
    }
  }, "Emergency"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: '10%'
    }
  }, "Lesson Type"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: '17%'
    }
  }, "Package"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: '9%'
    }
  }, "Credits"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: '5%'
    }
  }, "T&C"), /*#__PURE__*/React.createElement("th", null, "Schedule"))), /*#__PURE__*/React.createElement("tbody", null, displayList.length ? displayList.map((row, ri) => {
    const s = row.s;
    const sched = scheduleLines(s.id);
    const tcOk = !!s.tcAcceptedAt;
    // Per-LT credit summary — show each LT's remaining balance as a chip
    const ltCredits = (s.lessonTypeIds || []).map(ltId => {
      const lt = lessonTypeById ? lessonTypeById(ltId) : null;
      const bal = creditByKey[`${s.id}:${ltId}`];
      const rem = bal ? Number(bal.remaining_balance) || 0 : null;
      return {
        lt,
        rem
      };
    });
    // Parent + emergency display
    const parentBits = [s.guardianName, s.guardianPhone].filter(Boolean);
    const emergencyBits = s.emergencySameAsGuardian ? /*#__PURE__*/React.createElement("span", {
      className: "subtle small",
      title: "Same as guardian"
    }, "\u2197 as guardian") : s.emergencyPhone ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", null, s.emergencyPhone), s.emergencyRelationship ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("span", {
      className: "subtle small"
    }, s.emergencyRelationship)) : null) : /*#__PURE__*/React.createElement("span", {
      className: "subtle"
    }, "\u2014");
    return /*#__PURE__*/React.createElement(React.Fragment, {
      key: s.id
    }, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
      style: {
        fontWeight: 700
      }
    }, s.name, s.gender ? /*#__PURE__*/React.createElement("span", {
      style: {
        marginLeft: 4,
        fontSize: 10,
        color: 'var(--text-3)'
      }
    }, s.gender === 'female' ? '♀' : '♂') : null), /*#__PURE__*/React.createElement("td", null, s.age != null ? s.age : '—'), /*#__PURE__*/React.createElement("td", {
      style: {
        fontSize: 11
      }
    }, parentBits.length ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: {
        fontWeight: 600
      }
    }, s.guardianName || '—'), s.guardianPhone ? /*#__PURE__*/React.createElement("div", {
      className: "subtle"
    }, s.guardianPhone) : null) : /*#__PURE__*/React.createElement("span", {
      className: "subtle"
    }, "\u2014")), /*#__PURE__*/React.createElement("td", {
      style: {
        fontSize: 11
      }
    }, emergencyBits), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 3
      }
    }, (s.lessonTypeIds || []).length ? s.lessonTypeIds.map(id => {
      const c = colorsForId(id);
      return /*#__PURE__*/React.createElement("span", {
        key: id,
        className: "chip",
        style: {
          background: c.bg,
          borderColor: c.bd,
          color: c.tx,
          fontSize: 10,
          padding: '2px 7px'
        }
      }, c.name);
    }) : /*#__PURE__*/React.createElement("span", {
      className: "subtle"
    }, "\u2014"))), /*#__PURE__*/React.createElement("td", {
      style: {
        fontSize: 12
      }
    }, packageLabel(s)), /*#__PURE__*/React.createElement("td", null, ltCredits.length ? /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: 2
      }
    }, ltCredits.map(({
      lt,
      rem
    }) => lt ? /*#__PURE__*/React.createElement("span", {
      key: lt.id,
      className: "swimmer-cred-chip"
    }, /*#__PURE__*/React.createElement("span", {
      className: "subtle",
      style: {
        fontSize: 9
      }
    }, lt.name.split(' ').slice(0, 2).join(' '), ":"), " ", /*#__PURE__*/React.createElement("strong", {
      className: rem != null && rem <= 2 ? 'credit-low' : ''
    }, rem != null ? rem : '—')) : null)) : /*#__PURE__*/React.createElement("span", {
      className: "subtle"
    }, "\u2014")), /*#__PURE__*/React.createElement("td", null, tcOk ? /*#__PURE__*/React.createElement("span", {
      className: "tc-badge-ok",
      title: `Accepted ${new Date(s.tcAcceptedAt).toLocaleDateString()} · ID: ${s.tcAcceptanceId}`
    }, "\u2705") : /*#__PURE__*/React.createElement("span", {
      className: "tc-badge-pending",
      title: "Terms & Conditions not yet accepted"
    }, "\u26A0")), /*#__PURE__*/React.createElement("td", {
      style: {
        fontSize: 11
      }
    }, sched ? sched.map((g, gi) => {
      const targetWeek = jumpToWeek ? nextWeekFor(s.id, g.type) : null;
      const handleJump = e => {
        e.stopPropagation();
        if (targetWeek) jumpToWeek(targetWeek, 0);
      };
      return targetWeek ? /*#__PURE__*/React.createElement("button", {
        key: gi,
        type: "button",
        className: "swimmer-sched-link",
        onClick: handleJump,
        title: `Jump to week of ${targetWeek}`
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          fontWeight: 700
        }
      }, g.type, ":"), " ", /*#__PURE__*/React.createElement("span", {
        className: "subtle"
      }, g.times.join(', ')), /*#__PURE__*/React.createElement("span", {
        className: "swimmer-sched-arrow",
        "aria-hidden": "true"
      }, "\u2197")) : /*#__PURE__*/React.createElement("div", {
        key: gi,
        style: {
          marginBottom: 2
        }
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          fontWeight: 700
        }
      }, g.type, ":"), " ", /*#__PURE__*/React.createElement("span", {
        className: "subtle"
      }, g.times.join(', ')));
    }) : /*#__PURE__*/React.createElement("span", {
      className: "subtle"
    }, "Not scheduled"))));
  }) : /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    colSpan: COLS,
    className: "empty"
  }, "No swimmers found.")))))));
}

// ============================================================================
// TCView — Terms & Conditions page with swimmer selection & email acceptance
// ============================================================================
const TC_COMPANY = 'Star Swim Sdn Bhd';
const TC_CONTENT = [{
  h: '1. Introduction',
  body: `These Terms and Conditions ("Agreement") govern the enrolment and participation of swimmers in swimming lessons and aquatic programmes offered by ${TC_COMPANY} ("the School", "we", "our"). By accepting this Agreement, the parent, legal guardian, or adult swimmer ("you") acknowledges having read, understood, and agreed to be bound by these terms. This Agreement constitutes a legally binding contract.`
}, {
  h: '2. Safeguarding & Child Protection',
  body: `${TC_COMPANY} is committed to providing a safe, inclusive, and supportive aquatic environment for all participants.\n\n2.1 The School adheres to the National Child Protection Principles and Malaysia's Child Act 2001. All instructors undergo background screening and hold current first aid and lifeguard certifications.\n\n2.2 Parents and guardians are required to remain within the facility premises during all sessions involving participants under 12 years of age, unless otherwise agreed in writing.\n\n2.3 Any concerns regarding the welfare of a child, safeguarding issues, or inappropriate conduct should be raised immediately with the School Administrator or reported to: Jabatan Kebajikan Masyarakat (Social Welfare Department) at 1-800-88-3900.\n\n2.4 Photography and video recording of any swimmer — including your own child — are prohibited within pool areas without prior written consent from ${TC_COMPANY} and the relevant guardian of every swimmer present.`
}, {
  h: '3. Class Cancellation & Attendance Policy',
  body: `3.1 Advance Notice: Cancellations must be communicated to the School no less than twenty-four (24) hours before the scheduled class start time. Cancellations received within this 24-hour window will be treated as an Absence unless a valid emergency and accompanying proof are provided.\n\n3.2 Medical Cancellation: Absences due to illness or medical conditions will be considered valid cancellations provided the School receives a copy of a certified Medical Certificate (MC) issued by a registered medical practitioner within 48 hours of the missed class. On receipt of a valid MC, the swimmer is entitled to one (1) replacement class.\n\n3.3 Absence (No Replacement): Where a swimmer is absent without valid 24-hour prior notice or a valid MC, the class will be recorded as "provided," credits will be deducted where applicable, and no replacement lesson will be offered.\n\n3.4 Last-Minute Emergencies: Genuine emergencies (e.g. hospitalisation, accident, bereavement) occurring within the 24-hour window may be considered at the School's discretion upon submission of appropriate supporting documentation.`
}, {
  h: '4. School-Initiated Cancellations',
  body: `4.1 Weather Conditions: Classes may be suspended or cancelled at the School's sole discretion during adverse weather — including lightning, heavy rainfall, or hazardous pool conditions. Participants will be notified as promptly as possible via WhatsApp or email. Any class cancelled due to weather entitles the swimmer to a full replacement lesson at no additional cost.\n\n4.2 Instructor Cancellation: Should a class be cancelled by ${TC_COMPANY} or by an assigned instructor for reasons within the School's control, all affected swimmers are entitled to a replacement lesson. The replacement will be scheduled within the same billing cycle where possible, or carried forward.`
}, {
  h: '5. Replacement Class Policy',
  body: `5.1 Group Classes: Replacement sessions for group classes may be attended in any currently active class of the same lesson type, provided a slot is available. Replacements must be arranged through the School and are subject to availability. Replacement swimmers are marked as "drop-in replacement" and are not carried forward in subsequent weeks.\n\n5.2 Personal & Private Classes (Personal 1, Personal 2, Personal Toddler, Stroke Lab, Premium Personal, Personal Clara): Replacement sessions for personal classes are to be arranged directly between the assigned instructor and the parent or guardian, subject to mutual time availability and pool space. The School will facilitate communication. Replacement credits will be applied and the rescheduled session logged.\n\n5.3 Validity: Replacement lessons must be utilised within 14 calendar days of the missed class, unless otherwise agreed in writing. Unused replacement entitlements expire at the end of the month in which they were granted.`
}, {
  h: '6. Credit System (Personal & Private Classes)',
  body: `6.1 Students enrolled in personal or private lesson programmes are allocated a credit balance corresponding to the number of sessions purchased in their package.\n\n6.2 One (1) credit is deducted for each scheduled and attended class. Credits are not deducted for classes cancelled by the School or for classes where a valid MC has been provided.\n\n6.3 Credits are non-refundable and non-transferable to another swimmer. Unused credits at the end of a package cycle are forfeited unless otherwise agreed in writing.\n\n6.4 The School reserves the right to apply a credit deduction when a replacement or rescheduled class is successfully attended.`
}, {
  h: '7. Fees & Payment',
  body: `7.1 All fees are due in accordance with the payment schedule indicated in your enrolment confirmation. Late payment may result in suspension from classes.\n\n7.2 Fees are non-refundable once a billing cycle has commenced, except in extraordinary circumstances at the School's discretion.\n\n7.3 The School reserves the right to revise fee structures with a minimum of 30 days' written notice.`
}, {
  h: '8. Health, Safety & Medical Disclosure',
  body: `8.1 Good Health Confirmation: You confirm that the swimmer is in good health and is medically fit to participate in aquatic activities.

8.2 Medical & Behavioural Declaration: You further declare that, to the best of your knowledge, the swimmer named in this registration:
  (a) does not have any known medical, physical, or psychological condition that would prevent safe participation in swimming lessons;
  (b) has not been advised by a medical professional to refrain from physical activity or aquatic programmes;
  (c) is not under any medication or treatment that would interfere with swim lesson participation;
  (d) does not require additional support unless previously disclosed.

8.3 Disclosure Obligation: Any pre-existing medical condition, allergy, behavioural consideration, or physical limitation must be disclosed to the School prior to the commencement of classes. If any such conditions exist, you confirm that you have disclosed them during registration or will inform the School's administrators before lessons commence.

8.4 Consequences of Non-Disclosure: You understand that failure to disclose relevant medical or behavioural information may affect the safety and quality of instruction and may result in withdrawal from the programme without refund.

8.5 Liability: The School is not liable for injuries or health events arising from undisclosed medical or behavioural conditions.

8.6 Emergency Authorisation: In the event of a medical emergency, the School is authorised to administer basic first aid and to contact emergency services. All reasonable effort will be made to contact the designated emergency contact immediately.`
}, {
  h: '9. Liability Waiver',
  body: `9.1 Participation in aquatic activities carries inherent risks. By accepting this Agreement, you acknowledge these risks and agree that ${TC_COMPANY}, its directors, instructors, and staff shall not be liable for any injury, loss, damage, or claim arising from participation in the School's programmes, except where caused by the School's gross negligence or wilful misconduct.\n\n9.2 The School maintains appropriate public liability insurance.`
}, {
  h: '10. Photography, Video & Marketing Consent',
  body: `10.1 By accepting these Terms, you consent to ${TC_COMPANY} taking photographs and video recordings of the swimmer during lessons, classes, and events for the purposes of instructor training, social media, advertising, school newsletters, and other marketing activities undertaken by the School.

10.2 Opt-Out: If you wish to withhold consent for the use of your swimmer's images in marketing materials, please notify the School in writing at the time of registration or thereafter. The School will then take reasonable steps to exclude the swimmer from marketing photography going forward; this opt-out does not retroactively remove already-published materials.

10.3 This School-led photography consent is distinct from the third-party photography restrictions described in clause 2.4. Visitors and other guardians remain prohibited from photographing or recording any swimmer (including their own child within shared pool areas) without prior written consent from ${TC_COMPANY} and the relevant guardians of every swimmer present.`
}, {
  h: '11. Acceptance & Governing Law',
  body: `This Agreement is governed by the laws of Malaysia. Any dispute shall be subject to the jurisdiction of the courts of Malaysia. By electronically accepting, you confirm you have read and agree to all clauses above on behalf of yourself and/or the enrolled swimmer.`
}];
function TCView({
  students,
  lessonTypes,
  lessonTypeById,
  onSaveAcceptance
}) {
  const [studentId, setStudentId] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // { acceptanceId, studentName, email }
  const [scrolled, setScrolled] = useState(false);
  const student = students.find(s => s.id === studentId) || null;
  const lt = student?.lessonTypeIds?.[0] ? lessonTypeById(student.lessonTypeIds[0]) : null;
  const alreadySigned = !!student?.tcAcceptedAt;
  function handleScroll(e) {
    if (e.target.scrollTop + e.target.clientHeight >= e.target.scrollHeight - 40) setScrolled(true);
  }
  async function handleAccept() {
    if (!student || !agreed || busy) return;
    if (!student.guardianEmail) {
      alert('No guardian email on file — please add an email address to this swimmer\'s profile before signing the T&C.');
      return;
    }
    try {
      setBusy(true);
      const acceptanceId = await onSaveAcceptance({
        studentId: student.id,
        guardianName: student.guardianName || student.name,
        guardianEmail: student.guardianEmail,
        lessonTypeName: lt?.name || '—'
      });
      const subj = encodeURIComponent(`Swimming Lesson Terms & Conditions — ${student.name} — ${TC_COMPANY}`);
      const dateStr = new Date().toLocaleString('en-MY', {
        dateStyle: 'long',
        timeStyle: 'short'
      });
      const emailBody = encodeURIComponent(`Dear ${student.guardianName || student.name},

This email confirms that the Terms and Conditions for ${TC_COMPANY} have been accepted for the following swimmer:

  Swimmer Name : ${student.name}
  Lesson Type  : ${lt?.name || 'Not specified'}
  Accepted By  : ${student.guardianName || student.name}
  Acceptance ID: ${acceptanceId}
  Date & Time  : ${dateStr}

This Acceptance ID is your unique reference. Please retain this email for your records.

─────────────────────────────────────────────────────
If you did NOT authorise this acceptance, or if you do not agree to the terms, please reply to this email immediately and we will resolve this with you. Failure to respond within 3 business days will be taken as confirmation of acceptance.
─────────────────────────────────────────────────────

Key Policy Highlights:
• Cancellations must be made ≥24 hrs in advance or a Medical Certificate must be provided.
• Absent without notice = class counted as provided; no replacement entitlement.
• School-cancelled classes (weather, instructor) entitle you to a replacement lesson.
• Group replacement: any active class of the same type with an available slot.
• Personal class replacement: by mutual arrangement with your instructor.

For the full Terms and Conditions, please contact us or request a copy from ${TC_COMPANY}.

Thank you for choosing ${TC_COMPANY}. We look forward to seeing ${student.name} in the pool!

Warm regards,
${TC_COMPANY} Administration`);
      window.open(`mailto:${encodeURIComponent(student.guardianEmail)}?subject=${subj}&body=${emailBody}`);
      setDone({
        acceptanceId,
        studentName: student.name,
        email: student.guardianEmail
      });
      setAgreed(false);
      setScrolled(false);
    } catch (e) {
      alert(e?.message || 'Failed to record acceptance');
    } finally {
      setBusy(false);
    }
  }
  return /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 900,
      margin: '0 auto'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 22,
      fontWeight: 800,
      marginBottom: 4
    }
  }, "Terms & Conditions"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, TC_COMPANY, " \xB7 Swimming Lesson Enrolment Agreement"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14,
      display: 'flex',
      gap: 10,
      alignItems: 'flex-end',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      margin: 0,
      flex: '1 1 240px'
    }
  }, /*#__PURE__*/React.createElement("label", null, "Select Swimmer"), /*#__PURE__*/React.createElement(StudentSelect, {
    valueId: studentId || null,
    fallbackLabel: null,
    studentById: Object.fromEntries(students.map(s => [s.id, s])),
    candidates: students.filter(s => !s.tcAcceptedAt).slice().sort((a, b) => a.name.localeCompare(b.name)),
    onPick: stu => {
      setStudentId(stu ? stu.id : '');
      setAgreed(false);
      setScrolled(false);
      setDone(null);
    },
    conflict: null
  }), /*#__PURE__*/React.createElement("div", {
    className: "hint",
    style: {
      marginTop: 4
    }
  }, "Only swimmers without a signed T&C are shown. Already-signed swimmers are filtered out.")), student && /*#__PURE__*/React.createElement("div", {
    className: "tc-student-summary"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    className: "small subtle"
  }, "Guardian:"), " ", /*#__PURE__*/React.createElement("strong", null, student.guardianName || '—')), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    className: "small subtle"
  }, "Email:"), " ", /*#__PURE__*/React.createElement("strong", null, student.guardianEmail || /*#__PURE__*/React.createElement("span", {
    className: "tc-warn"
  }, "\u26A0 No email \u2014 add in Swimmers tab"))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    className: "small subtle"
  }, "Lesson Type:"), " ", /*#__PURE__*/React.createElement("strong", null, lt?.name || '—')))), alreadySigned && /*#__PURE__*/React.createElement("div", {
    className: "tc-status-row tc-accepted",
    style: {
      marginTop: 12
    }
  }, "\u2705 T&C already accepted for ", student.name, " \xB7 ID: ", student.tcAcceptanceId, " \xB7 ", new Date(student.tcAcceptedAt).toLocaleDateString(undefined, {
    dateStyle: 'long'
  }))), /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "tc-doc-scroll",
    onScroll: handleScroll
  }, /*#__PURE__*/React.createElement("h1", {
    className: "tc-h1"
  }, TC_COMPANY), /*#__PURE__*/React.createElement("h2", {
    className: "tc-h2"
  }, "Swimming Lesson Enrolment \u2014 Terms & Conditions"), TC_CONTENT.map((sec, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "tc-section"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "tc-h3"
  }, sec.h), sec.body.split('\n\n').map((p, j) => /*#__PURE__*/React.createElement("p", {
    key: j,
    className: "tc-para"
  }, p)))), !scrolled && /*#__PURE__*/React.createElement("div", {
    className: "tc-scroll-hint"
  }, "\u2193 Scroll to the bottom to enable acceptance"))), done ? /*#__PURE__*/React.createElement("div", {
    className: "card tc-success"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 20,
      fontWeight: 800,
      marginBottom: 6
    }
  }, "\u2705 Accepted \u2014 ", done.studentName), /*#__PURE__*/React.createElement("div", {
    className: "small"
  }, "Acceptance ID: ", /*#__PURE__*/React.createElement("strong", null, done.acceptanceId)), /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      marginTop: 4
    }
  }, "Your email client has been opened with a confirmation email pre-addressed to ", /*#__PURE__*/React.createElement("strong", null, done.email), ". Please review and click Send. The email instructs them to reply if they do not agree."), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    style: {
      marginTop: 10
    },
    onClick: () => setDone(null)
  }, "Sign another swimmer")) : /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("label", {
    className: "gb-check",
    style: {
      fontSize: 14,
      display: 'flex',
      gap: 10,
      alignItems: 'flex-start',
      opacity: scrolled ? 1 : 0.4,
      transition: 'opacity .2s',
      cursor: scrolled ? 'pointer' : 'default'
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    disabled: !scrolled || !student,
    checked: agreed,
    onChange: e => setAgreed(e.target.checked),
    style: {
      marginTop: 3,
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("span", null, "I have read and fully understood the Terms & Conditions of ", TC_COMPANY, ". I agree to be bound by this Agreement on behalf of myself and/or the enrolled swimmer named above, and confirm all information provided is accurate.")), !scrolled && /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      marginTop: 6,
      marginLeft: 28
    }
  }, "Please scroll through the full document above before accepting."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'flex-end',
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary",
    disabled: !agreed || !student || busy || !student.guardianEmail,
    onClick: handleAccept,
    style: {
      padding: '10px 24px',
      fontSize: 15
    }
  }, busy ? 'Processing…' : '✍️ I Accept These Terms')), student && !student.guardianEmail && /*#__PURE__*/React.createElement("div", {
    className: "hint",
    style: {
      color: 'var(--red-tx)',
      marginTop: 6,
      textAlign: 'right'
    }
  }, "\u26A0 A guardian email address is required before accepting.")));
}
function SessionModal({
  modal,
  setModal,
  saveBusy,
  saveSession,
  deleteSession,
  openAddAtTime,
  instructors,
  lessonTypes,
  pools,
  lessonTypeByName,
  poolById,
  packageById,
  students,
  studentById,
  weekEnrollments,
  familyGroups,
  membersByGroup,
  groupById,
  trialStudentIds,
  trialByLessonType,
  creditByKey,
  purchasesByKey,
  addCreditPurchase,
  adjustCredit,
  initCredit,
  pendingByKey,
  replacementPending,
  markForReplacement,
  forwardClassToNextWeek,
  startFullClassMove,
  duplicateSessionForward
}) {
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [cancelClassOpen, setCancelClassOpen] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [reschedDay, setReschedDay] = useState(0);
  const [reschedMinute, setReschedMinute] = useState(480);
  const [initCreditInput, setInitCreditInput] = useState({});
  const [escWarn, setEscWarn] = useState(false);

  // Dirty-check: compare current form to snapshot taken when modal first opened
  const initialFormRef = React.useRef(null);
  React.useEffect(() => {
    initialFormRef.current = JSON.stringify(modal.form);
  }, []); // eslint-disable-line
  const isDirty = initialFormRef.current !== null && JSON.stringify(modal.form) !== initialFormRef.current;

  // ESC key: close immediately if clean, warn if dirty
  React.useEffect(() => {
    function onKey(e) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (escWarn) {
        setEscWarn(false);
        return;
      } // ESC again dismisses warning
      if (isDirty) setEscWarn(true);else setModal(null);
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isDirty, escWarn]);
  const currentLt = lessonTypes.find(t => t.name === modal.form.type);
  const isPersonal = currentLt?.class_type === 'personal';
  const isRescheduled = modal.rescheduledFromDay != null;

  // M2: union of durations — common standards plus every lesson type's default
  // and the currently-selected duration so the dropdown always contains the
  // active value.
  const durationOptions = useMemo(() => {
    const all = new Set([30, 45, 50, 60]);
    lessonTypes.forEach(lt => {
      if (lt.default_duration_minutes) all.add(Number(lt.default_duration_minutes));
    });
    if (modal?.form?.durationMinutes) all.add(Number(modal.form.durationMinutes));
    return [...all].sort((a, b) => a - b);
  }, [lessonTypes, modal?.form?.durationMinutes]);
  function setForm(patch) {
    setModal(prev => prev ? {
      ...prev,
      form: {
        ...prev.form,
        ...patch
      }
    } : prev);
  }
  function onTypeChange(name) {
    const lt = lessonTypes.find(t => t.name === name);
    const patch = {
      type: name,
      lessonTypeId: lt?.id || null
    };
    if (lt?.default_duration_minutes) patch.durationMinutes = Number(lt.default_duration_minutes);
    if (lt?.default_pool_id) patch.poolId = lt.default_pool_id;
    patch.studentRows = rebuildRowsForCap(modal.form.studentRows, lt?.students_per_instructor);
    setForm(patch);
  }
  function setRow(i, key, val) {
    const rows = (modal.form.studentRows || []).slice();
    rows[i] = {
      ...rows[i],
      [key]: val
    };
    setForm({
      studentRows: rows
    });
  }
  function addRow() {
    setForm({
      studentRows: [...(modal.form.studentRows || []), {
        studentId: null,
        name: '',
        age: '',
        remark: '',
        attendance: 'pending'
      }]
    });
  }
  function onInstructorChange(id) {
    const inst = instructors.find(i => i.id === id);
    setForm({
      instructorId: id || null,
      instructorName: inst?.name || ''
    });
  }

  // Pick a swimmer into a slot from the registry; snapshot name+age. null clears.
  // Bound-group auto-fill: if the picked swimmer is in a BOUND group whose
  // package matches this session's lesson type, also auto-add every other
  // member of that group that isn't already in the session. Bound members
  // must move through sessions together — this is the add counterpart of
  // the bound-removal guard in removeRow.
  function pickStudent(i, student) {
    const rows = (modal.form.studentRows || []).slice();
    const keepRemark = student ? rows[i]?.remark || '' : '';
    const keepAtt = student ? rows[i]?.attendance || 'pending' : 'pending';
    rows[i] = student ? {
      studentId: student.id,
      name: student.name,
      age: student.age === null || student.age === undefined ? '' : String(student.age),
      remark: keepRemark,
      attendance: keepAtt
    } : {
      studentId: null,
      name: '',
      age: '',
      remark: '',
      attendance: 'pending'
    };
    if (student && groupById && membersByGroup) {
      const ltId = currentLt?.id;
      const stuFull = studentById[student.id] || student;
      const groupIds = stuFull.familyGroupIds || (stuFull.familyGroupId ? [stuFull.familyGroupId] : []);
      // Find a bound group whose package matches this session's lesson type.
      let boundGrp = null;
      for (const gid of groupIds) {
        const g = groupById[gid];
        if (!g || g.groupType !== 'bound') continue;
        const pkg = g.packageId ? packageById?.(g.packageId) : null;
        if (pkg && ltId && pkg.lesson_type_id === ltId) {
          boundGrp = g;
          break;
        }
      }
      if (boundGrp) {
        const inSessionIds = new Set(rows.filter(r => r.studentId).map(r => r.studentId));
        const missingMembers = (membersByGroup[boundGrp.id] || []).filter(m => m.id !== student.id && !inSessionIds.has(m.id));
        if (missingMembers.length) {
          // Fill empty rows first, then append for any remaining.
          let cursor = 0;
          for (const m of missingMembers) {
            // Find next empty slot starting from cursor
            while (cursor < rows.length && rows[cursor].studentId) cursor++;
            const slot = {
              studentId: m.id,
              name: m.name,
              age: m.age == null ? '' : String(m.age),
              remark: '',
              attendance: 'pending'
            };
            if (cursor < rows.length) {
              rows[cursor] = slot;
              cursor++;
            } else {
              rows.push(slot);
            }
          }
        }
      }
    }
    setForm({
      studentRows: rows
    });
  }
  function setRemark(i, val) {
    const rows = (modal.form.studentRows || []).slice();
    rows[i] = {
      ...rows[i],
      remark: val
    };
    setForm({
      studentRows: rows
    });
  }
  function setAttendance(i, val) {
    const rows = (modal.form.studentRows || []).slice();
    rows[i] = {
      ...rows[i],
      attendance: val
    };
    setForm({
      studentRows: rows
    });
  }
  function setReplAttendance(i, val) {
    const rows = (modal.form.replacementRows || []).slice();
    rows[i] = {
      ...rows[i],
      attendance: val
    };
    setForm({
      replacementRows: rows
    });
  }

  // Bind this session to a family group and drop ALL its members into the slots
  // at once (padded to the lesson-type ratio). groupId '' clears the binding.
  // ── quickAddGroup: add all lesson-type-eligible members of a family
  // group to the current session additively — does NOT replace or clear
  // any existing students. For bound groups every member must go in
  // together; the user is warned if the class would go over capacity.
  // For discount groups the add is soft-warned only.
  function quickAddGroup(group) {
    const ltId = currentLt?.id || modal?.form?.lessonTypeId;
    const members = (membersByGroup && membersByGroup[group.id] || []).filter(m => !ltId || (m.lessonTypeIds || []).includes(ltId));
    if (!members.length) {
      alert(`No members of "${group.name}" are enrolled in this lesson type.`);
      return;
    }
    const currentRows = modal.form.studentRows || [];
    const alreadyIn = new Set(currentRows.filter(r => r.studentId).map(r => r.studentId));
    const toAdd = members.filter(m => !alreadyIn.has(m.id));
    if (!toAdd.length) {
      alert(`All members of "${group.name}" are already in this session.`);
      return;
    }
    const currentFilled = currentRows.filter(r => r.studentId || (r.name || '').trim()).length;
    const cap = previewMax;
    const isBound = group.groupType === 'bound';
    if (cap > 0 && currentFilled + toAdd.length > cap) {
      const msg = isBound ? `"${group.name}" is a bound group — all ${toAdd.length} member${toAdd.length === 1 ? '' : 's'} must be added together.\n\nThis would put the class over capacity (${currentFilled + toAdd.length}/${cap}). Add anyway?` : `Adding ${toAdd.length} member${toAdd.length === 1 ? '' : 's'} from "${group.name}" would put the class over capacity (${currentFilled + toAdd.length}/${cap}). Add anyway?`;
      if (!confirm(msg)) return;
    }
    // Fill empty slots first, then append new ones.
    const newRows = [...currentRows];
    const emptyIdx = [];
    newRows.forEach((r, i) => {
      if (!r.studentId && !(r.name || '').trim()) emptyIdx.push(i);
    });
    toAdd.forEach(m => {
      const row = {
        studentId: m.id,
        name: m.name,
        age: m.age != null ? String(m.age) : '',
        attendance: 'pending',
        remark: ''
      };
      if (emptyIdx.length) {
        newRows[emptyIdx.shift()] = row;
      } else {
        newRows.push(row);
      }
    });
    setModal({
      ...modal,
      form: {
        ...modal.form,
        studentRows: newRows
      }
    });
  }

  // ── Bound-group removal guard: when the user clears a slot that holds
  // a bound-group member, offer to remove all other members of the same
  // group from the session too. Multi-group aware: a swimmer can be in
  // several groups; we look for ANY bound group whose package matches the
  // current session's lesson type, because that's the group whose members
  // must move together for THIS class.
  function removeRow(i) {
    const row = (modal.form.studentRows || [])[i];
    if (row?.studentId && groupById) {
      const stu = studentById[row.studentId];
      const groupIds = stu?.familyGroupIds || (stu?.familyGroupId ? [stu.familyGroupId] : []);
      // Find a bound group of this swimmer that matches the session's lesson type
      const ltId = currentLt?.id;
      let boundGrp = null;
      for (const gid of groupIds) {
        const g = groupById[gid];
        if (!g || g.groupType !== 'bound') continue;
        const pkg = g.packageId ? packageById?.(g.packageId) : null;
        if (pkg && ltId && pkg.lesson_type_id === ltId) {
          boundGrp = g;
          break;
        }
        // Fallback: if package isn't set or lesson type can't be confirmed,
        // still treat as bound-cascade candidate (defensive for legacy data).
        if (!boundGrp) boundGrp = g;
      }
      if (boundGrp) {
        const groupMemberIds = new Set((membersByGroup && membersByGroup[boundGrp.id] || []).map(m => m.id));
        const otherBoundInSession = (modal.form.studentRows || []).filter((r, ri) => ri !== i && r.studentId && groupMemberIds.has(r.studentId));
        if (otherBoundInSession.length) {
          if (confirm(`"${stu.name}" is in the bound group "${boundGrp.name}". Bound members must move through sessions together — remove all ${otherBoundInSession.length + 1} bound group members from this session?`)) {
            const removeIds = new Set([row.studentId, ...otherBoundInSession.map(r => r.studentId)]);
            const newRows = (modal.form.studentRows || []).map(r => removeIds.has(r.studentId) ? {
              studentId: null,
              name: '',
              age: '',
              attendance: 'pending',
              remark: ''
            } : r);
            setModal({
              ...modal,
              form: {
                ...modal.form,
                studentRows: newRows
              }
            });
            return;
          }
        }
      }
    }
    // Default: just clear this one slot.
    const newRows = [...(modal.form.studentRows || [])];
    newRows[i] = {
      studentId: null,
      name: '',
      age: '',
      attendance: 'pending',
      remark: ''
    };
    setModal({
      ...modal,
      form: {
        ...modal.form,
        studentRows: newRows
      }
    });
  }

  // Capacity preview: counts the slots that hold a swimmer, against the
  // lesson type's ratio (assuming one instructor for now — splits come in M3).
  const previewStudents = (modal?.form?.studentRows || []).filter(r => r.studentId || (r.name || '').trim()).length;
  const previewLt = lessonTypeByName(modal?.form?.type);
  const previewMax = previewLt?.students_per_instructor ? Number(previewLt.students_per_instructor) : 0;
  const previewStatus = previewMax > 0 ? previewStudents > previewMax ? 'over' : previewStudents === previewMax ? 'full' : previewStudents / previewMax >= 0.8 ? 'tight' : 'open' : 'unknown';
  const previewChip = capacityChipColors(previewStatus);
  const previewPool = poolById(modal?.form?.poolId);

  // Candidates for the dropdowns: swimmers tagged for this lesson type; if none
  // are tagged yet, fall back to all active swimmers so the user isn't stuck.
  // Trial swimmers are always strictly lesson-type-scoped though — they're
  // never surfaced unless their enrolment includes the current lesson type,
  // even in fallback mode. Otherwise a trial LTS swimmer would appear as a
  // candidate when scheduling a Personal class, which makes no sense.
  const lessonTypeId = previewLt?.id || modal?.form?.lessonTypeId || null;
  const inBucket = (students || []).filter(s => s.isActive !== false && lessonTypeId && (s.lessonTypeIds || []).includes(lessonTypeId));
  const candidates = (inBucket.length ? inBucket : (students || []).filter(s => s.isActive !== false)).filter(s => {
    if (!(trialStudentIds && trialStudentIds.has(s.id))) return true;
    // Trial swimmer: only keep if their enrollment matches this lesson type.
    return !!lessonTypeId && (s.lessonTypeIds || []).includes(lessonTypeId);
  });
  const bucketFallback = lessonTypeId && !inBucket.length;
  function rowConflict(row, idx) {
    if (!row.studentId) return null;
    if ((modal.form.studentRows || []).some((r, j) => j !== idx && r.studentId === row.studentId)) return 'twice in this class';
    const others = (weekEnrollments[row.studentId] || []).filter(e => e.sessionId !== modal.id);
    if (others.length) {
      const e = others[0];
      return `${DAYS_S[e.day]} ${minuteToTime(e.startMinute)}`;
    }
    return null;
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "modal-backdrop"
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-head"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0,
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 800,
      lineHeight: 1.1
    }
  }, modal.id ? 'Edit' : 'Add', " Session"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      fontSize: 10.5,
      marginTop: 1
    }
  }, DAYS_S[modal.day], " ", minuteToTime(modal.startMinute), previewPool ? ` · ${previewPool.name}` : '')), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: () => {
      if (isDirty) setEscWarn(true);else setModal(null);
    },
    "aria-label": "Close",
    title: "Close (Esc)"
  }, "\u2715")), escWarn && /*#__PURE__*/React.createElement("div", {
    className: "esc-warn-bar"
  }, /*#__PURE__*/React.createElement("span", null, "\u26A0 You have unsaved changes."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary small",
    onClick: () => {
      setEscWarn(false);
      saveSession();
    }
  }, "Save & Close"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-danger small",
    onClick: () => {
      setEscWarn(false);
      setModal(null);
    }
  }, "Discard Changes"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: () => setEscWarn(false)
  }, "Keep Editing"))), /*#__PURE__*/React.createElement("div", {
    className: "modal-body"
  }, /*#__PURE__*/React.createElement("div", {
    className: "form-grid form-grid-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Lesson Type"), /*#__PURE__*/React.createElement("select", {
    className: "select",
    value: modal.form.type,
    onChange: e => onTypeChange(e.target.value)
  }, lessonTypes.map(x => /*#__PURE__*/React.createElement("option", {
    key: x.id,
    value: x.name
  }, x.name)))), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Pool"), /*#__PURE__*/React.createElement("select", {
    className: "select",
    value: modal.form.poolId || '',
    onChange: e => setForm({
      poolId: e.target.value || null
    })
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "(no pool)"), pools.map(p => /*#__PURE__*/React.createElement("option", {
    key: p.id,
    value: p.id
  }, p.name, " \xB7 cap ", p.capacity_total)))), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Instructor"), /*#__PURE__*/React.createElement("select", {
    className: "select",
    value: modal.form.instructorId || '',
    onChange: e => onInstructorChange(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "(unassigned)"), instructors.map(x => /*#__PURE__*/React.createElement("option", {
    key: x.id,
    value: x.id
  }, x.name)))), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Duration"), /*#__PURE__*/React.createElement("select", {
    className: "select",
    value: String(modal.form.durationMinutes),
    onChange: e => setForm({
      durationMinutes: Number(e.target.value)
    })
  }, durationOptions.map(d => /*#__PURE__*/React.createElement("option", {
    key: d,
    value: d
  }, d, " min")))), /*#__PURE__*/React.createElement("div", {
    className: "modal-meta-strip",
    style: {
      gridColumn: '1 / -1'
    }
  }, /*#__PURE__*/React.createElement("span", null, "\u23F1 ", /*#__PURE__*/React.createElement("strong", null, formatRange(modal.startMinute, modal.form.durationMinutes))), previewMax > 0 ? /*#__PURE__*/React.createElement("span", {
    className: previewStatus === 'over' ? 'meta-warn' : ''
  }, "\uD83D\uDC65 ", /*#__PURE__*/React.createElement("strong", null, previewStudents, " / ", previewMax), previewStatus === 'over' ? ' Over' : previewStatus === 'full' ? ' Full' : previewStatus === 'tight' ? ' Tight' : '') : /*#__PURE__*/React.createElement("span", null, "\uD83D\uDC65 ", /*#__PURE__*/React.createElement("strong", null, previewStudents))), /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      gridColumn: '1 / -1'
    }
  }, /*#__PURE__*/React.createElement("label", null, "Swimmers"), /*#__PURE__*/React.createElement("div", {
    className: "stu-list"
  }, (modal.form.studentRows || []).map((r, i) => {
    // Trial flag is per-lesson-type — only fires if this swimmer's
    // enrolment includes the current session's lesson type.
    const trialSetForLt = trialByLessonType && currentLt?.id ? trialByLessonType[currentLt.id] : null;
    const isTrial = !!(r.studentId && trialSetForLt && trialSetForLt.has(r.studentId));
    const wk = modal.weekStartDate;
    const ltId = currentLt?.id;
    const isPending = !!(r.studentId && ltId && pendingByKey && pendingByKey[`${r.studentId}:${ltId}:${wk}`]);
    const canMarkReplacement = !isPersonal && r.studentId && modal.id && currentLt && !isPending;
    // ── Package label (req #6) ──────────────────────────────
    // Show the swimmer's package for the current lesson type
    // subtly beside their name. Looks up:
    //   student.enrollments[ltId] → packageId → package.name
    let pkgLabel = null;
    if (r.studentId && packageById && currentLt?.id) {
      const stu = studentById[r.studentId];
      const enrol = (stu?.enrollments || []).find(e => e.lessonTypeId === currentLt.id);
      const pkg = enrol?.packageId ? packageById(enrol.packageId) : null;
      if (pkg) pkgLabel = pkg.name;
    }
    return /*#__PURE__*/React.createElement("div", {
      className: "stu-row",
      key: i
    }, /*#__PURE__*/React.createElement("span", {
      className: "stu-num"
    }, i + 1), /*#__PURE__*/React.createElement("div", {
      className: "stu-fields"
    }, /*#__PURE__*/React.createElement(StudentSelect, {
      valueId: r.studentId,
      fallbackLabel: r.studentId ? null : r.name ? `${r.name}${r.age ? ` (${r.age})` : ''}` : '',
      studentById: studentById,
      candidates: candidates,
      onPick: stu => pickStudent(i, stu),
      conflict: rowConflict(r, i),
      trialStudentIds: trialStudentIds,
      trialByLessonType: trialByLessonType,
      pendingByKey: pendingByKey,
      weekStartDate: wk,
      lessonTypeId: ltId
    }), pkgLabel && !isTrial ? /*#__PURE__*/React.createElement("span", {
      className: "stu-pkg-label",
      title: `Enrolled package for ${currentLt?.name}`
    }, pkgLabel) : null, isTrial ? /*#__PURE__*/React.createElement("span", {
      className: "trial-pill",
      title: "Trial package \u2014 one-off booking."
    }, "trial") : null, canMarkReplacement ? /*#__PURE__*/React.createElement("button", {
      type: "button",
      className: "repl-mark-btn",
      title: "Move this swimmer out for replacement",
      onClick: async () => {
        const ok = await markForReplacement({
          studentId: r.studentId,
          sessionId: modal.id,
          weekStartDate: wk,
          lessonTypeId: ltId,
          lessonTypeName: currentLt.name,
          day: modal.day,
          startMinute: modal.startMinute
        });
        if (ok) {
          setModal(null);
        }
      }
    }, "\u2192 R") : null, r.studentId || (r.name || '').trim() ? /*#__PURE__*/React.createElement("div", {
      className: "att-seg",
      role: "group",
      "aria-label": "Attendance"
    }, /*#__PURE__*/React.createElement("button", {
      type: "button",
      className: `att-btn att-pending ${(r.attendance || 'pending') === 'pending' ? 'is-on' : ''}`,
      onClick: () => setAttendance(i, 'pending'),
      title: "Not yet marked"
    }, "\u23F3"), /*#__PURE__*/React.createElement("button", {
      type: "button",
      className: `att-btn att-attended ${r.attendance === 'attended' ? 'is-on' : ''}`,
      onClick: () => setAttendance(i, 'attended'),
      title: "Attended \u2014 \u22121 credit on save"
    }, "\u2713"), /*#__PURE__*/React.createElement("button", {
      type: "button",
      className: `att-btn att-absent ${r.attendance === 'absent' ? 'is-on' : ''}`,
      onClick: () => setAttendance(i, 'absent'),
      title: "Absent \u2014 \u22121 credit on save"
    }, "\u2717")) : null, /*#__PURE__*/React.createElement("input", {
      className: "input stu-remark",
      placeholder: "Remark",
      value: r.remark || '',
      onChange: e => setRemark(i, e.target.value)
    }), r.studentId || (r.name || '').trim() ? /*#__PURE__*/React.createElement("button", {
      type: "button",
      className: "stu-x",
      title: "Clear this slot (bound-group members prompt a group-remove)",
      onClick: () => removeRow(i)
    }, "\xD7") : null));
  })))), !isPersonal && /*#__PURE__*/React.createElement("div", {
    className: "repl-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "repl-section-head"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    className: "repl-section-title"
  }, "Replacement Students")), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: () => {
      const filled = (modal.form.studentRows || []).filter(r => r.studentId || (r.name || '').trim()).length;
      const repl = (modal.form.replacementRows || []).length;
      const cap = sessionCapacity({
        students: Array(filled + repl),
        instructors: currentLt ? [{}] : []
      }, currentLt);
      if (cap.max > 0 && filled + repl >= cap.max) {
        if (!confirm(`Class is full (${filled + repl}/${cap.max}). Add another replacement slot anyway? The class will be over capacity.`)) return;
      }
      setModal({
        ...modal,
        form: {
          ...modal.form,
          replacementRows: [...(modal.form.replacementRows || []), {
            studentId: null,
            name: '',
            age: null,
            replacementFrom: '',
            attendance: 'pending'
          }]
        }
      });
    }
  }, "+ Add replacement")), (() => {
    // Surface quick-pick candidates above the manual selector:
    //  • TRIAL — students on a trial package with a positive credit balance
    //    for THIS lesson type (skip if balance is 0 or student is missing).
    //  • PENDING REPLACEMENT — every pending replacement record for THIS
    //    lesson type within a 4-week forward window from this session's
    //    week. (Used to be only "this week", which caused replacements
    //    to disappear from quick-pick after one week.)
    const wk = modal.weekStartDate;
    const ltId = currentLt?.id;
    if (!ltId) return null;
    // Forward window: this week plus the next 3. Past-week limbo
    // records are also included — they remain pending until placed,
    // so they must stay in quick-pick across weeks.
    const windowWeeks = new Set([0, 1, 2, 3].map(n => addDays(wk, n * 7)));
    const pendingCandidates = (replacementPending || []).filter(p => p.lesson_type_id === ltId && (windowWeeks.has(p.week_start_date) || p.week_start_date < wk) && studentById[p.student_id] &&
    // student must exist
    !(modal.form.replacementRows || []).some(r => r.studentId === p.student_id));
    const trialCandidates = students.filter(s => {
      if (!trialStudentIds || !trialStudentIds.has(s.id)) return false;
      if (!(s.lessonTypeIds || []).includes(ltId)) return false;
      // Must have credit balance > 0 for this lesson type
      const bal = creditByKey ? Number(creditByKey[`${s.id}:${ltId}`] || 0) : 0;
      if (bal <= 0) return false;
      if ((modal.form.studentRows || []).some(r => r.studentId === s.id)) return false;
      if ((modal.form.replacementRows || []).some(r => r.studentId === s.id)) return false;
      return true;
    });
    if (!pendingCandidates.length && !trialCandidates.length) return null;
    function addAsReplacement(studentId, fromLabel) {
      const stu = studentById[studentId];
      if (!stu) return;
      // Cap check before adding (matches the "+ Add replacement" guard).
      const filled = (modal.form.studentRows || []).filter(r => r.studentId || (r.name || '').trim()).length;
      const repl = (modal.form.replacementRows || []).length;
      const cap = sessionCapacity({
        students: Array(filled + repl),
        instructors: currentLt ? [{}] : []
      }, currentLt);
      if (cap.max > 0 && filled + repl >= cap.max) {
        if (!confirm(`Class is full (${filled + repl}/${cap.max}). Add ${stu.name} as replacement anyway? The class will be over capacity.`)) return;
      }
      const rows = [...(modal.form.replacementRows || []), {
        studentId,
        name: stu.name,
        age: stu.age,
        replacementFrom: fromLabel || '',
        attendance: 'pending'
      }];
      setModal({
        ...modal,
        form: {
          ...modal.form,
          replacementRows: rows
        }
      });
    }
    // Compact name: truncate to 14 chars with ellipsis
    const trunc = (s, n = 14) => {
      s = String(s || '');
      return s.length > n ? s.slice(0, n - 1) + '…' : s;
    };
    return /*#__PURE__*/React.createElement("div", {
      className: "repl-quickpick"
    }, /*#__PURE__*/React.createElement("div", {
      className: "small subtle",
      style: {
        marginBottom: 4,
        fontWeight: 700,
        fontSize: 11
      }
    }, "Quick-pick (", pendingCandidates.length + trialCandidates.length, ") ", /*#__PURE__*/React.createElement("span", {
      style: {
        fontWeight: 400
      }
    }, "\xB7 trials need credit \xB7 pending shown for next 4 weeks")), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 3,
        flexWrap: 'wrap'
      }
    }, pendingCandidates.map(p => {
      const stu = studentById[p.student_id];
      if (!stu) return null;
      const weekTag = p.week_start_date === wk ? '' : ` (${p.week_start_date.slice(5)})`;
      return /*#__PURE__*/React.createElement("button", {
        key: `p-${p.id}`,
        type: "button",
        className: "quickpick-chip quickpick-rpending",
        style: {
          padding: '2px 7px',
          fontSize: 10.5,
          lineHeight: 1.3
        },
        onClick: () => addAsReplacement(p.student_id, encodeReplacementFrom(p.original_session_id, p.original_session_label)),
        title: `Pending replacement from ${p.original_session_label}${weekTag ? ` · week of ${p.week_start_date}` : ''}`
      }, /*#__PURE__*/React.createElement("span", {
        className: "qp-tag qp-tag-r",
        style: {
          padding: '0 4px',
          fontSize: 9
        }
      }, "R"), " ", trunc(stu.name), stu.age != null ? ` ${stu.age}` : '', weekTag);
    }), trialCandidates.map(s => {
      const bal = creditByKey ? Number(creditByKey[`${s.id}:${ltId}`] || 0) : 0;
      return /*#__PURE__*/React.createElement("button", {
        key: `t-${s.id}`,
        type: "button",
        className: "quickpick-chip quickpick-trial",
        style: {
          padding: '2px 7px',
          fontSize: 10.5,
          lineHeight: 1.3
        },
        onClick: () => addAsReplacement(s.id, '(trial)'),
        title: `Trial swimmer · ${bal} credit${bal === 1 ? '' : 's'} remaining`
      }, /*#__PURE__*/React.createElement("span", {
        className: "qp-tag qp-tag-trial",
        style: {
          padding: '0 4px',
          fontSize: 9
        }
      }, "T"), " ", trunc(s.name), s.age != null ? ` ${s.age}` : '');
    })));
  })(), !(modal.form.replacementRows || []).length && /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      padding: '8px 0'
    }
  }, "No replacement students this week."), (modal.form.replacementRows || []).map((r, i) => {
    const wk = modal.weekStartDate;
    const ltId = currentLt?.id;
    const isPending = !!(r.studentId && ltId && pendingByKey && pendingByKey[`${r.studentId}:${ltId}:${wk}`]);
    const trialSetReplLt = trialByLessonType && ltId ? trialByLessonType[ltId] : null;
    const isTrialRow = !!(r.studentId && trialSetReplLt && trialSetReplLt.has(r.studentId));
    const replCandidates = students.filter(s => !(modal.form.studentRows || []).some(sr => sr.studentId === s.id) && !(modal.form.replacementRows || []).some((rr, ri) => ri !== i && rr.studentId === s.id));
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      className: "repl-row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "repl-badge-sm"
    }, "R"), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: '1.5',
        minWidth: 0,
        position: 'relative'
      }
    }, /*#__PURE__*/React.createElement(StudentSelect, {
      valueId: r.studentId,
      fallbackLabel: r.name || '',
      studentById: studentById,
      candidates: replCandidates,
      onPick: stu => {
        const rows = [...(modal.form.replacementRows || [])];
        const pendingHit = stu && ltId && pendingByKey && pendingByKey[`${stu.id}:${ltId}:${wk}`];
        rows[i] = {
          ...rows[i],
          studentId: stu?.id || null,
          name: stu?.name || '',
          age: stu?.age ?? null,
          replacementFrom: pendingHit ? encodeReplacementFrom(pendingHit.original_session_id, pendingHit.original_session_label) : trialStudentIds && stu && trialStudentIds.has(stu.id) ? '(trial)' : rows[i].replacementFrom
        };
        setModal({
          ...modal,
          form: {
            ...modal.form,
            replacementRows: rows
          }
        });
      },
      conflict: null,
      trialStudentIds: trialStudentIds,
      trialByLessonType: trialByLessonType,
      pendingByKey: pendingByKey,
      weekStartDate: wk,
      lessonTypeId: ltId
    }), isPending ? /*#__PURE__*/React.createElement("span", {
      className: "qp-tag qp-tag-r",
      style: {
        position: 'absolute',
        top: -8,
        right: 6,
        zIndex: 1
      }
    }, "R-pending") : isTrialRow ? /*#__PURE__*/React.createElement("span", {
      className: "qp-tag qp-tag-trial",
      style: {
        position: 'absolute',
        top: -8,
        right: 6,
        zIndex: 1
      }
    }, "trial") : null), /*#__PURE__*/React.createElement("input", {
      className: "input",
      style: {
        flex: 1
      },
      placeholder: "From class (e.g. Tue 10:00 AM)",
      value: replFromLabel(r.replacementFrom) || '',
      onChange: e => {
        const rows = [...(modal.form.replacementRows || [])];
        rows[i] = {
          ...rows[i],
          replacementFrom: encodeReplacementFrom(rows[i].originalSessionId || null, e.target.value)
        };
        setModal({
          ...modal,
          form: {
            ...modal.form,
            replacementRows: rows
          }
        });
      }
    }), r.studentId || (r.name || '').trim() ? /*#__PURE__*/React.createElement("div", {
      className: "att-seg",
      role: "group",
      "aria-label": "Attendance"
    }, /*#__PURE__*/React.createElement("button", {
      type: "button",
      className: `att-btn att-pending ${(r.attendance || 'pending') === 'pending' ? 'is-on' : ''}`,
      onClick: () => setReplAttendance(i, 'pending'),
      title: "Not yet marked \u2014 credit untouched"
    }, "\u23F3"), /*#__PURE__*/React.createElement("button", {
      type: "button",
      className: `att-btn att-attended ${r.attendance === 'attended' ? 'is-on' : ''}`,
      onClick: () => setReplAttendance(i, 'attended'),
      title: "Attended \u2014 lesson delivered (\u22121 credit on save)"
    }, "\u2713"), /*#__PURE__*/React.createElement("button", {
      type: "button",
      className: `att-btn att-absent ${r.attendance === 'absent' ? 'is-on' : ''}`,
      onClick: () => setReplAttendance(i, 'absent'),
      title: "Absent \u2014 counts as a delivered lesson, no replacement entitled (\u22121 credit on save)"
    }, "\u2717")) : null, /*#__PURE__*/React.createElement("button", {
      className: "btn btn-ghost small",
      style: {
        flexShrink: 0
      },
      onClick: async () => {
        // If this is a real placed-replacement student, check whether
        // the session week has already passed before silently removing them.
        if (r.studentId) {
          const sessionWeek = modal.weekStartDate || selectedWeekStart;
          const datePassed = sessionWeek < todayStr();
          const fromLabel = r.replacementFrom ? ` (placed from: ${r.replacementFrom})` : '';
          const passedNote = datePassed ? `\n\n⚠️ Note: The session week (${sessionWeek}) has already passed. The student can still be restored to their original slot — it will be recorded in a past week.` : '';
          const choice = datePassed ? window.confirm(`Remove ${r.name} from this replacement slot${fromLabel}?\n\nThey will be returned to the pending replacement (limbo) state.${passedNote}\n\nClick OK to restore to limbo. Click Cancel to leave them in this session.`) : true;
          if (!choice) {
            return;
          }
        }
        const rows = (modal.form.replacementRows || []).filter((_, ri) => ri !== i);
        setModal({
          ...modal,
          form: {
            ...modal.form,
            replacementRows: rows
          }
        });
      }
    }, "\xD7"));
  })), isPersonal && /*#__PURE__*/React.createElement("div", {
    className: "repl-section"
  }, isRescheduled && /*#__PURE__*/React.createElement("div", {
    className: "reschedule-notice"
  }, /*#__PURE__*/React.createElement("span", {
    className: "reschedule-from-badge"
  }, "\u21C4 Rescheduled this week \u2014 was originally ", DAYS_F[modal.rescheduledFromDay], " at ", minuteToTime(modal.rescheduledFromStartMinute)), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: () => setModal({
      ...modal,
      day: modal.rescheduledFromDay,
      startMinute: modal.rescheduledFromStartMinute,
      rescheduledFromDay: null,
      rescheduledFromStartMinute: null
    })
  }, "Restore original slot")), /*#__PURE__*/React.createElement("div", {
    className: "reschedule-head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "repl-section-title"
  }, "\u21C4 Reschedule this week only"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: () => {
      setReschedDay(modal.day);
      setReschedMinute(modal.startMinute);
      setRescheduleOpen(o => !o);
    }
  }, rescheduleOpen ? 'Cancel' : 'Change slot')), rescheduleOpen && /*#__PURE__*/React.createElement("div", {
    className: "reschedule-form"
  }, /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      margin: 0
    }
  }, /*#__PURE__*/React.createElement("label", null, "New day"), /*#__PURE__*/React.createElement("select", {
    className: "select",
    value: reschedDay,
    onChange: e => setReschedDay(Number(e.target.value))
  }, DAYS_F.map((d, i) => /*#__PURE__*/React.createElement("option", {
    key: i,
    value: i
  }, d)))), /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      margin: 0
    }
  }, /*#__PURE__*/React.createElement("label", null, "New start time"), /*#__PURE__*/React.createElement("select", {
    className: "select",
    value: reschedMinute,
    onChange: e => setReschedMinute(Number(e.target.value))
  }, Array.from({
    length: 25
  }, (_, i) => 480 + i * 30).map(m => /*#__PURE__*/React.createElement("option", {
    key: m,
    value: m
  }, minuteToTime(m))))), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary small",
    style: {
      alignSelf: 'flex-end'
    },
    onClick: () => {
      setModal(prev => ({
        ...prev,
        rescheduledFromDay: prev.rescheduledFromDay ?? prev.day,
        rescheduledFromStartMinute: prev.rescheduledFromStartMinute ?? prev.startMinute,
        day: reschedDay,
        startMinute: reschedMinute
      }));
      setRescheduleOpen(false);
    }
  }, "Apply reschedule"), /*#__PURE__*/React.createElement("div", {
    className: "hint",
    style: {
      gridColumn: '1/-1',
      marginTop: 0
    }
  }, "Returns to canonical slot from next week."))), (modal.form.studentRows || []).some(r => r.studentId) && /*#__PURE__*/React.createElement("div", {
    className: "repl-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "repl-section-title",
    style: {
      marginBottom: 6
    }
  }, "Credit Balances"), (modal.form.studentRows || []).filter(r => r.studentId).map((r, i) => {
    const bal = creditByKey && creditByKey[`${r.studentId}:${currentLt?.id}`];
    // Most recent purchase for this (swimmer, lesson type), used
    // to surface "purchased on" info inline so the scheduler can
    // confirm which batch the balance was seeded from.
    const purchases = purchasesByKey && currentLt?.id ? purchasesByKey[`${r.studentId}:${currentLt.id}`] || [] : [];
    const lastPurchase = purchases[0] || null;
    const lastPurchaseLabel = lastPurchase ? `${Number(lastPurchase.credits_added) > 0 ? '+' : ''}${lastPurchase.credits_added} on ${lastPurchase.purchase_date}` : null;
    return /*#__PURE__*/React.createElement("div", {
      key: r.studentId || i,
      className: "credit-row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "credit-row-name"
    }, r.name || 'Student', lastPurchaseLabel ? /*#__PURE__*/React.createElement("span", {
      className: "credit-row-last"
    }, " \xB7 last ", lastPurchaseLabel) : null), bal ? /*#__PURE__*/React.createElement("div", {
      className: "credit-controls"
    }, /*#__PURE__*/React.createElement("span", {
      className: `credit-count ${bal.remaining_balance <= 2 ? 'credit-low' : ''}`
    }, bal.remaining_balance, " credits"), /*#__PURE__*/React.createElement("button", {
      className: "credit-btn",
      title: "Deduct 1 credit (class attended)",
      onClick: () => adjustCredit(r.studentId, currentLt.id, -1)
    }, "\u2212"), /*#__PURE__*/React.createElement("button", {
      className: "credit-btn",
      title: "Add 1 credit (credit returned)",
      onClick: () => adjustCredit(r.studentId, currentLt.id, +1)
    }, "+")) : /*#__PURE__*/React.createElement("div", {
      className: "credit-init"
    }, /*#__PURE__*/React.createElement("input", {
      className: "input",
      style: {
        width: 64,
        fontSize: 12
      },
      type: "number",
      min: "1",
      placeholder: "Credits",
      value: initCreditInput[r.studentId] || 4,
      onChange: e => setInitCreditInput(prev => ({
        ...prev,
        [r.studentId]: e.target.value
      }))
    }), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-ghost small",
      title: "Record this as a purchase (with today's date) and set the initial balance",
      onClick: async () => {
        const n = Number(initCreditInput[r.studentId] || 4);
        if (!n || !currentLt?.id) return;
        // Prefer addCreditPurchase so the seed shows up in the
        // swimmer's purchase ledger with today's date. Falls
        // back to initCredit if the purchases backend isn't
        // available yet (e.g. migration not run).
        if (addCreditPurchase) {
          await addCreditPurchase({
            studentId: r.studentId,
            lessonTypeId: currentLt.id,
            purchaseDate: toDateStr(new Date()),
            creditsAdded: n,
            source: 'signup',
            notes: 'Seeded from session editor'
          });
        } else {
          initCredit(r.studentId, currentLt.id, n);
        }
      }
    }, "Record purchase")));
  })), modal.id && /*#__PURE__*/React.createElement("div", {
    className: "cancel-class-panel"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `cancel-class-toggle ${cancelClassOpen ? 'is-open' : ''}`,
    onClick: () => setCancelClassOpen(o => !o)
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDEAB Cancel entire class for this week"), /*#__PURE__*/React.createElement("span", {
    className: "cancel-class-chev"
  }, cancelClassOpen ? '▴' : '▾')), cancelClassOpen && /*#__PURE__*/React.createElement("div", {
    className: "cancel-class-options"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cancel-class-hint"
  }, "All swimmers in this session are affected. Their credits will not be consumed for this cancellation."), /*#__PURE__*/React.createElement("div", {
    className: "cancel-class-buttons"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "cancel-class-opt",
    onClick: () => {
      const label = `${currentLt?.name || modal.form.type} on ${DAYS_F[modal.day]} ${minuteToTime(modal.startMinute)}`;
      forwardClassToNextWeek && forwardClassToNextWeek(modal.id, label);
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "cancel-class-opt-title"
  }, "\u23ED Forward to next week"), /*#__PURE__*/React.createElement("div", {
    className: "cancel-class-opt-sub"
  }, "Cancels this week's run and recreates the same class next week (same day, time, swimmers). Any credits already consumed this week are refunded. If next week already has this class, it merges in instead of duplicating.")), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "cancel-class-opt",
    onClick: () => {
      const label = `${DAYS_F[modal.day]} ${minuteToTime(modal.startMinute)}`;
      const swimmerCount = (modal.form.studentRows || []).filter(r => r.studentId || (r.name || '').trim()).length + (modal.form.replacementRows || []).filter(r => r.studentId || (r.name || '').trim()).length;
      startFullClassMove && startFullClassMove({
        sessionId: modal.id,
        sourceLabel: label,
        lessonTypeName: currentLt?.name || modal.form.type,
        weekStartDate: modal.weekStartDate,
        originalDay: modal.day,
        originalStartMinute: modal.startMinute,
        swimmerCount
      });
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "cancel-class-opt-title"
  }, "\uD83D\uDCC5 Reschedule to another slot"), /*#__PURE__*/React.createElement("div", {
    className: "cancel-class-opt-sub"
  }, "Pick a day & time on the weekly grid. Same swimmers, same instructor, same pool \u2014 just a different slot this week."))))), modal.id && duplicateSessionForward && /*#__PURE__*/React.createElement("div", {
    className: "cancel-class-panel"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `cancel-class-toggle ${dupOpen ? 'is-open' : ''}`,
    onClick: () => setDupOpen(o => !o),
    style: {
      background: '#EFF6FF',
      borderColor: '#BFDBFE',
      color: '#1E40AF'
    }
  }, /*#__PURE__*/React.createElement("span", null, "\u23E9 Duplicate this session to future weeks"), /*#__PURE__*/React.createElement("span", {
    className: "cancel-class-chev",
    style: {
      color: '#1E40AF'
    }
  }, dupOpen ? '▴' : '▾')), dupOpen && /*#__PURE__*/React.createElement("div", {
    className: "cancel-class-options",
    style: {
      background: '#EFF6FF',
      borderColor: '#BFDBFE'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "cancel-class-hint",
    style: {
      color: '#1E40AF'
    }
  }, "Clones this session into the next N weeks at the same day & time, with the same swimmers, instructor, and pool. Existing matching sessions at those slots will be skipped."), /*#__PURE__*/React.createElement("div", {
    className: "dup-buttons"
  }, [1, 2, 3, 4, 8, 12].map(n => /*#__PURE__*/React.createElement("button", {
    key: n,
    type: "button",
    className: "dup-btn",
    onClick: () => duplicateSessionForward(modal.id, n)
  }, n === 1 ? 'Next week' : `Next ${n} weeks`)), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "dup-btn",
    onClick: () => {
      const v = prompt('How many weeks ahead to duplicate? (1–52)', '4');
      const n = Math.max(1, Math.min(52, parseInt(v, 10) || 0));
      if (n > 0) duplicateSessionForward(modal.id, n);
    }
  }, "Custom\u2026"))))), /*#__PURE__*/React.createElement("div", {
    className: "modal-foot"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      flexWrap: 'wrap'
    }
  }, modal.id ? /*#__PURE__*/React.createElement("button", {
    className: "btn btn-danger small",
    onClick: deleteSession
  }, "Delete") : null, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: () => openAddAtTime(modal.day, modal.startMinute, modal.form.poolId)
  }, "+ Same Time")), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary",
    onClick: saveSession
  }, saveBusy ? 'Saving…' : 'Save Session'))));
}

// ============================================================================
// PrintWeeklyTableSection (M2: pool labels per session in cells)
// ============================================================================

function PrintWeeklyTableSection({
  weekBlocksAllPools,
  wb,
  selectedWeekStart,
  gridSlots,
  gridBounds,
  slotToMinute,
  poolById,
  branchLabel
}) {
  const dayHeaders = DAYS_F.map((d, di) => {
    const dateObj = new Date(wb.start);
    dateObj.setDate(wb.start.getDate() + di);
    return {
      label: d,
      dateStr: dateObj.toLocaleDateString(undefined, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      })
    };
  });

  // Each day is already a packed array of all-pool blocks; attach pool name.
  const flatBlocksByDay = Array.from({
    length: 7
  }, (_, di) => {
    return (weekBlocksAllPools[di] || []).map(b => ({
      ...b,
      _poolName: poolById(b.poolId)?.name || ''
    }));
  });
  const startMap = {};
  const coveredMap = {};
  flatBlocksByDay.forEach((dayBlocks, di) => {
    dayBlocks.forEach(block => {
      const sk = `${di}-${block.startMinute}`;
      if (!startMap[sk]) startMap[sk] = [];
      startMap[sk].push(block);
      for (let m = block.startMinute + SLOT_MIN; m < block.startMinute + block.durationMinutes; m += SLOT_MIN) {
        coveredMap[`${di}-${m}`] = true;
      }
    });
  });
  const rows = Array.from({
    length: gridSlots
  }, (_, si) => {
    const slotMin = slotToMinute(si);
    const isHour = slotMin % 60 === 0;
    return /*#__PURE__*/React.createElement("tr", {
      key: si,
      className: isHour ? 'wt-row wt-hour-row' : 'wt-row wt-half-row'
    }, /*#__PURE__*/React.createElement("td", {
      className: "wt-time-cell"
    }, isHour ? /*#__PURE__*/React.createElement("strong", null, minuteToTime(slotMin)) : /*#__PURE__*/React.createElement("span", {
      className: "wt-half-label"
    }, minuteToTime(slotMin))), Array.from({
      length: 7
    }, (_, di) => {
      const k = `${di}-${slotMin}`;
      const starts = startMap[k];
      const isCovered = coveredMap[k];
      if (starts && starts.length) {
        return /*#__PURE__*/React.createElement("td", {
          key: di,
          className: "wt-cell wt-session-cell"
        }, starts.map((block, idx) => /*#__PURE__*/React.createElement("div", {
          key: block.id,
          className: idx > 0 ? 'wt-sess wt-sess-sep' : 'wt-sess'
        }, /*#__PURE__*/React.createElement("div", {
          className: "wt-sess-type"
        }, block.type), /*#__PURE__*/React.createElement("div", {
          className: "wt-sess-meta"
        }, block.instructors[0]?.name || block.legacyInstructor || '—', " \xB7 ", block.durationMinutes, "\u2009min", block._poolName ? ` · ${block._poolName}` : ''), block.students.length > 0 ? /*#__PURE__*/React.createElement("div", {
          className: "wt-sess-students"
        }, block.students.map(studentLabel).join(', ')) : null)));
      }
      if (isCovered) {
        return /*#__PURE__*/React.createElement("td", {
          key: di,
          className: "wt-cell wt-cont-cell"
        }, /*#__PURE__*/React.createElement("span", {
          className: "wt-cont-bar"
        }, "|"));
      }
      return /*#__PURE__*/React.createElement("td", {
        key: di,
        className: "wt-cell wt-empty-cell"
      });
    }));
  });
  return /*#__PURE__*/React.createElement("div", {
    className: "print-weekly-table"
  }, /*#__PURE__*/React.createElement("div", {
    className: "wt-header"
  }, /*#__PURE__*/React.createElement("div", {
    className: "wt-title"
  }, "Weekly Schedule", branchLabel ? ` — ${branchLabel}` : ''), /*#__PURE__*/React.createElement("div", {
    className: "wt-meta"
  }, "Week of ", selectedWeekStart, " \xA0\xB7\xA0 ", wb.start.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }), " \u2013 ", wb.end.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }))), /*#__PURE__*/React.createElement("table", {
    className: "wt-table"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    className: "wt-th-time"
  }, "Time"), dayHeaders.map((dh, i) => /*#__PURE__*/React.createElement("th", {
    key: i,
    className: "wt-th-day"
  }, /*#__PURE__*/React.createElement("div", {
    className: "wt-th-dayname"
  }, dh.label), /*#__PURE__*/React.createElement("div", {
    className: "wt-th-daydate"
  }, dh.dateStr))))), /*#__PURE__*/React.createElement("tbody", null, rows, /*#__PURE__*/React.createElement("tr", {
    className: "wt-row wt-hour-row"
  }, /*#__PURE__*/React.createElement("td", {
    className: "wt-time-cell"
  }, /*#__PURE__*/React.createElement("strong", null, minuteToTime(gridBounds.endMin))), Array.from({
    length: 7
  }, (_, di) => /*#__PURE__*/React.createElement("td", {
    key: di,
    className: "wt-cell wt-empty-cell"
  }))))));
}

// ============================================================================
// Global error trap + mount
// ============================================================================

// ── Error reporting ───────────────────────────────────────────────────
// Babel-transformed scripts can mask real errors as the generic "Script
// error." string. We capture as much detail as the runtime gives us
// (message, source, line:col, stack) and present it readably so issues
// can actually be diagnosed instead of dead-ending at "Script error." A
// "Copy details" button puts everything onto the clipboard for sharing.

function showDiagnosticError(label, detail) {
  const root = document.getElementById('root');
  if (!root) return;
  const block = document.createElement('div');
  block.style.cssText = 'padding:24px 18px;max-width:880px;margin:24px auto;font-family:Inter,system-ui,sans-serif';
  block.innerHTML = `
    <div style="background:#FEE2E2;border:1px solid #FCA5A5;color:#7F1D1D;padding:20px 22px;border-radius:14px;box-shadow:0 4px 16px rgba(0,0,0,.08)">
      <div style="font-size:18px;font-weight:800;margin-bottom:6px">⚠ ${label}</div>
      <div style="font-size:13px;margin-bottom:14px;color:#9B2B2B">The app caught an error. Please screenshot or copy the details below and share them.</div>
      <pre style="white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #FECACA;border-radius:10px;padding:12px 14px;font-size:12px;font-family:'SF Mono',Menlo,Consolas,monospace;color:#7F1D1D;max-height:280px;overflow:auto">${detail.replace(/[&<>]/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;'
  })[c])}</pre>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button id="err-copy" style="background:#7F1D1D;color:#fff;border:none;padding:9px 16px;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer">Copy details</button>
        <button id="err-reload" style="background:#fff;color:#7F1D1D;border:1px solid #FCA5A5;padding:9px 16px;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer">Reload</button>
      </div>
    </div>`;
  root.innerHTML = '';
  root.appendChild(block);
  const copyBtn = document.getElementById('err-copy');
  if (copyBtn) copyBtn.onclick = () => {
    try {
      navigator.clipboard.writeText(`${label}\n\n${detail}`);
      copyBtn.textContent = 'Copied';
    } catch (_) {}
  };
  const reloadBtn = document.getElementById('err-reload');
  if (reloadBtn) reloadBtn.onclick = () => location.reload();
}
function formatErrEvent(ev) {
  const lines = [];
  if (ev.error) {
    lines.push(`Message: ${ev.error.message || '(none)'}`);
    if (ev.error.stack) lines.push(`\nStack:\n${ev.error.stack}`);
  } else {
    lines.push(`Message: ${ev.message || '(none)'}`);
  }
  if (ev.filename) lines.push(`\nSource: ${ev.filename}:${ev.lineno}:${ev.colno}`);
  if (navigator.userAgent) lines.push(`\nUA: ${navigator.userAgent}`);
  return lines.join('\n');
}
window.addEventListener('error', ev => {
  try {
    console.error('[ssb] window error:', ev.error || ev);
    showDiagnosticError('App error', formatErrEvent(ev));
  } catch (_) {}
});
window.addEventListener('unhandledrejection', ev => {
  try {
    const reason = ev.reason;
    const detail = reason && reason.stack ? `Message: ${reason.message || reason}\n\nStack:\n${reason.stack}` : String(reason);
    console.error('[ssb] unhandled promise rejection:', reason);
    showDiagnosticError('Async error', detail);
  } catch (_) {}
});

// React Error Boundary — catches errors thrown during render or in
// lifecycle methods (event handlers still bubble to window.onerror).
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      err: null,
      info: null
    };
  }
  static getDerivedStateFromError(err) {
    return {
      err
    };
  }
  componentDidCatch(err, info) {
    console.error('[ssb] render error:', err, info);
    this.setState({
      info
    });
  }
  render() {
    if (this.state.err) {
      const lines = [`Message: ${this.state.err.message || this.state.err}`];
      if (this.state.err.stack) lines.push(`\nStack:\n${this.state.err.stack}`);
      if (this.state.info && this.state.info.componentStack) lines.push(`\nComponent stack:${this.state.info.componentStack}`);
      // Use setTimeout so we render normally first, then swap to the
      // diagnostic — avoids re-entering setState during render.
      setTimeout(() => showDiagnosticError('Render error', lines.join('\n')), 0);
      return null;
    }
    return this.props.children;
  }
}

// ============================================================================
// Invoicing helpers
// ============================================================================
// ── Replacement-from codec ───────────────────────────────────────────────────
// replacement_from in the DB encodes BOTH the original session UUID and the
// human-readable label so the student can be fully restored after being
// un-placed from a makeup slot.
// Format: "<uuid>||<label>"  — backward compat: bare strings without || are labels only.
function encodeReplacementFrom(sessionId, label) {
  return sessionId ? `${sessionId}||${label || ''}` : label || '';
}
function decodeReplacementFrom(raw) {
  if (!raw) return {
    sessionId: null,
    label: ''
  };
  const sepIdx = raw.indexOf('||');
  if (sepIdx < 0) return {
    sessionId: null,
    label: raw
  };
  return {
    sessionId: raw.slice(0, sepIdx) || null,
    label: raw.slice(sepIdx + 2)
  };
}
function replFromLabel(raw) {
  return decodeReplacementFrom(raw).label;
}
function invoiceStatusLabel(s) {
  return {
    draft: 'Draft',
    sent: 'Sent',
    partial: 'Part Paid',
    paid: 'Paid',
    void: 'Void'
  }[s] || s;
}
function invoiceStatusColor(s) {
  return {
    draft: '#94A3B8',
    sent: '#3B82F6',
    partial: '#F59E0B',
    paid: '#10B981',
    void: '#EF4444'
  }[s] || '#94A3B8';
}
function methodLabel(m) {
  return {
    cash: 'Cash',
    bank_transfer: 'Bank Transfer',
    duitnow: 'DuitNow',
    card: 'Card',
    cheque: 'Cheque',
    other: 'Other'
  }[m] || m;
}

// Helper: resolve swimmer names for a group line

function InvoicesView({
  branches,
  invoices,
  invoiceLines,
  pmts,
  pendingCredits,
  lessonTypeById,
  packageById,
  studentById,
  membersByGroup,
  invoiceSettings,
  onSaveSettings,
  formatInvoiceNumber,
  formatReceiptNumber,
  onVoid,
  onDelete,
  onUpdateStatus,
  onRecordPayment,
  onConfirmCredit,
  onReverseCredit,
  onAddLine,
  onUpdateLine,
  onDeleteLine,
  externalSearchQ
}) {
  const [statusFilter, setStatusFilter] = useState('all');
  const [localSearchQ, setLocalSearchQ] = useState('');
  const searchQ = externalSearchQ !== undefined ? externalSearchQ : localSearchQ;
  const setSearchQ = setLocalSearchQ;
  const [expandedId, setExpandedId] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [branchFilter, setBranchFilter] = useState(null);
  const today = todayStr();
  function isOverdue(inv) {
    return inv.due_date && inv.due_date < today && inv.status !== 'paid' && inv.status !== 'void';
  }
  const counts = useMemo(() => {
    const c = {
      all: invoices.length,
      draft: 0,
      sent: 0,
      partial: 0,
      paid: 0,
      void: 0,
      overdue: 0
    };
    invoices.forEach(i => {
      if (c[i.status] != null) c[i.status]++;
      if (isOverdue(i)) c.overdue++;
    });
    return c;
  }, [invoices]);
  const filtered = useMemo(() => {
    let list = invoices.slice();
    if (branchFilter) list = list.filter(i => i.branch_id === branchFilter);
    if (statusFilter === 'overdue') list = list.filter(i => isOverdue(i));else if (statusFilter !== 'all') list = list.filter(i => i.status === statusFilter);
    if (searchQ.trim()) {
      const q = searchQ.toLowerCase();
      list = list.filter(i => (i.invoice_number || '').toLowerCase().includes(q) || (i.account_name || '').toLowerCase().includes(q));
    }
    return list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  }, [invoices, statusFilter, searchQ, branchFilter]);
  function toggleSelect(id) {
    const s = new Set(selectedIds);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelectedIds(s);
  }
  function toggleAll() {
    setSelectedIds(selectedIds.size === filtered.length ? new Set() : new Set(filtered.map(i => i.id)));
  }
  const selCount = selectedIds.size;
  const selDraft = filtered.filter(i => selectedIds.has(i.id) && i.status === 'draft').length;
  async function bulkMarkSent() {
    const targets = filtered.filter(i => selectedIds.has(i.id) && i.status === 'draft');
    for (const inv of targets) await onUpdateStatus(inv.id, 'sent');
    setSelectedIds(new Set());
  }
  async function bulkPrint() {
    const targets = filtered.filter(i => selectedIds.has(i.id));
    targets.forEach(inv => {
      const lines = invoiceLines.filter(l => l.invoice_id === inv.id);
      printInvoice(inv, lines, membersByGroup);
    });
  }
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      gap: 12,
      flexWrap: 'wrap',
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 18,
      fontWeight: 800
    }
  }, "\uD83E\uDDFE Invoices"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      marginTop: 3
    }
  }, "Create and manage invoices, record payments, and issue receipts."))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      flexWrap: 'wrap',
      alignItems: 'center',
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement(BranchFilterPills, {
    branches: branches,
    value: branchFilter,
    onChange: setBranchFilter
  }), [['all', 'All'], ['draft', 'Draft'], ['sent', 'Sent'], ['partial', 'Part Paid'], ['paid', 'Paid'], ['void', 'Void'], ['overdue', 'Overdue']].map(([k, l]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    className: `tab ${statusFilter === k ? 'active' : ''}`,
    style: {
      padding: '4px 10px',
      fontSize: 11
    },
    onClick: () => setStatusFilter(k)
  }, l, " ", counts[k] != null ? `(${counts[k]})` : null))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      alignItems: 'center'
    }
  }, externalSearchQ === undefined && /*#__PURE__*/React.createElement("input", {
    className: "input",
    style: {
      flex: 1,
      maxWidth: 340
    },
    placeholder: "Search invoice # or account\u2026",
    value: searchQ,
    onChange: e => setSearchQ(e.target.value)
  }), /*#__PURE__*/React.createElement("label", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 12,
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: selCount === filtered.length && filtered.length > 0,
    onChange: toggleAll
  }), " Select all"), /*#__PURE__*/React.createElement("span", {
    className: "small subtle"
  }, filtered.length, " / ", invoices.length)), selCount > 0 && /*#__PURE__*/React.createElement("div", {
    className: "inv-bulk-bar"
  }, /*#__PURE__*/React.createElement("span", {
    className: "small",
    style: {
      fontWeight: 700
    }
  }, selCount, " selected"), selDraft > 0 && /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: bulkMarkSent
  }, "Mark Sent (", selDraft, ")"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: bulkPrint
  }, "\uD83D\uDDA8 Print Selected"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: () => setSelectedIds(new Set())
  }, "Clear"))), filtered.length === 0 && /*#__PURE__*/React.createElement("div", {
    className: "card empty",
    style: {
      padding: 32
    }
  }, "No invoices match the current filter."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 4
    }
  }, filtered.map(inv => {
    const overdue = isOverdue(inv);
    const isExpanded = expandedId === inv.id;
    const isSelected = selectedIds.has(inv.id);
    const invLines = invoiceLines.filter(l => l.invoice_id === inv.id);
    const invPmts = pmts.filter(p => p.invoice_id === inv.id);
    const invPcs = pendingCredits.filter(pc => pc.invoice_id === inv.id);
    const total = Number(inv.total_amount) || 0;
    const paid = Number(inv.amount_paid) || 0;
    const outstanding = Math.max(0, total - paid);
    return /*#__PURE__*/React.createElement("div", {
      key: inv.id,
      className: `inv-card${isExpanded ? ' is-expanded' : ''}${overdue ? ' is-overdue' : ''}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "inv-card-head",
      onClick: () => setExpandedId(isExpanded ? null : inv.id)
    }, /*#__PURE__*/React.createElement("label", {
      style: {
        display: 'flex',
        alignItems: 'center'
      },
      onClick: e => e.stopPropagation()
    }, /*#__PURE__*/React.createElement("input", {
      type: "checkbox",
      checked: isSelected,
      onChange: () => toggleSelect(inv.id)
    })), /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: 'monospace',
        fontSize: 11,
        fontWeight: 700,
        minWidth: 90,
        flexShrink: 0
      }
    }, inv.invoice_number || '#—'), /*#__PURE__*/React.createElement("span", {
      className: `inv-status-chip s-${inv.status || 'draft'}`
    }, invoiceStatusLabel(inv.status)), overdue && /*#__PURE__*/React.createElement("span", {
      className: "inv-status-chip s-overdue"
    }, "Overdue"), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        minWidth: 0,
        fontSize: 11.5,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }
    }, inv.account_name || '—'), /*#__PURE__*/React.createElement("span", {
      className: "small subtle",
      style: {
        fontSize: 10.5,
        whiteSpace: 'nowrap',
        flexShrink: 0
      }
    }, inv.issue_date || '—', inv.due_date ? ` → ${inv.due_date}` : ''), /*#__PURE__*/React.createElement("span", {
      style: {
        fontWeight: 700,
        fontSize: 12,
        minWidth: 80,
        textAlign: 'right',
        flexShrink: 0
      }
    }, "RM ", total.toFixed(2)), paid > 0 && /*#__PURE__*/React.createElement("span", {
      className: "small subtle",
      style: {
        fontSize: 10,
        minWidth: 90,
        textAlign: 'right',
        flexShrink: 0,
        color: outstanding > 0 ? 'var(--amber-tx)' : 'var(--green-tx)'
      }
    }, outstanding > 0 ? `Owed ${outstanding.toFixed(2)}` : `Paid`), /*#__PURE__*/React.createElement("span", {
      style: {
        flexShrink: 0,
        color: 'var(--text-3)',
        fontSize: 10,
        width: 14,
        textAlign: 'center'
      }
    }, isExpanded ? '▲' : '▼')), isExpanded && /*#__PURE__*/React.createElement(InvoiceDetailPanel, {
      invoice: inv,
      lines: invLines,
      pmts: invPmts,
      pendingCredits: invPcs,
      isOverdue: overdue,
      membersByGroup: membersByGroup,
      onVoid: () => onVoid(inv.id),
      onDelete: onDelete ? () => onDelete(inv.id) : null,
      onUpdateStatus: s => onUpdateStatus(inv.id, s),
      onRecordPayment: data => onRecordPayment({
        invoiceId: inv.id,
        ...data
      }),
      onConfirmCredit: onConfirmCredit,
      onReverseCredit: onReverseCredit,
      onAddLine: data => onAddLine(inv.id, data),
      onUpdateLine: onUpdateLine,
      onDeleteLine: onDeleteLine
    }));
  })));
}
function InvoiceDetailPanel({
  invoice,
  lines,
  pmts,
  pendingCredits,
  isOverdue,
  membersByGroup,
  onVoid,
  onDelete,
  onUpdateStatus,
  onRecordPayment,
  onConfirmCredit,
  onReverseCredit,
  onAddLine,
  onUpdateLine,
  onDeleteLine
}) {
  const [showPayForm, setShowPayForm] = useState(false);
  const [lastReceipt, setLastReceipt] = useState(null);
  const outstanding = Math.max(0, (Number(invoice.total_amount) || 0) - (Number(invoice.amount_paid) || 0));
  const [payAmt, setPayAmt] = useState('');
  const [payDate, setPayDate] = useState(todayStr());
  const [payMethod, setPayMethod] = useState('cash');
  const [payRef, setPayRef] = useState('');
  const [payNotes, setPayNotes] = useState('');
  const [payBusy, setPayBusy] = useState(false);
  async function submitPayment() {
    if (!payAmt || isNaN(Number(payAmt)) || Number(payAmt) <= 0) {
      alert('Enter a valid amount.');
      return;
    }
    setPayBusy(true);
    try {
      const pmt = await onRecordPayment({
        amount: Number(payAmt),
        payment_date: payDate,
        payment_method: payMethod,
        reference_number: payRef.trim() || null,
        notes: payNotes.trim() || null
      });
      setLastReceipt(pmt);
      setShowPayForm(false);
      setPayAmt('');
      setPayRef('');
      setPayNotes('');
    } catch (err) {
      alert(err.message || 'Failed to record payment');
    } finally {
      setPayBusy(false);
    }
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "inv-detail"
  }, isOverdue && /*#__PURE__*/React.createElement("div", {
    className: "inv-overdue-banner"
  }, "\u26A0 This invoice is overdue. Due date was ", invoice.due_date, "."), /*#__PURE__*/React.createElement("div", {
    className: "inv-detail-head"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, "Bill To"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700
    }
  }, invoice.account_name || '—'), invoice.account_email && /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, invoice.account_email), invoice.notes && /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      marginTop: 4,
      fontStyle: 'italic'
    }
  }, invoice.notes)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      flexWrap: 'wrap',
      alignItems: 'flex-start'
    }
  }, invoice.status === 'draft' && /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: () => onUpdateStatus('sent')
  }, "Mark Sent"), invoice.status === 'sent' && /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: () => onUpdateStatus('partial')
  }, "Mark Part Paid"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: () => printInvoice(invoice, lines, membersByGroup)
  }, "\uD83D\uDDA8 Print Invoice"), (invoice.status === 'paid' || outstanding <= 0) && pmts && pmts.length > 0 && /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary small",
    onClick: () => {
      const lastPmt = [...pmts].sort((a, b) => (b.payment_date || '').localeCompare(a.payment_date || ''))[0];
      printInvoiceAndReceipt(invoice, lines, lastPmt, membersByGroup);
    }
  }, "\uD83D\uDDA8 Print Invoice & Receipt"), invoice.status !== 'void' && invoice.status !== 'paid' && /*#__PURE__*/React.createElement("button", {
    className: "btn btn-danger small",
    onClick: onVoid
  }, "Void"), onDelete && /*#__PURE__*/React.createElement("button", {
    className: "btn btn-danger small",
    onClick: onDelete,
    style: {
      marginLeft: 'auto'
    }
  }, "\uD83D\uDDD1 Delete Invoice"))), /*#__PURE__*/React.createElement("div", {
    className: "table-wrap",
    style: {
      margin: '10px 0'
    }
  }, /*#__PURE__*/React.createElement("table", null, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Lesson Type & Package"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 120
    }
  }, "Swimmers"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 120,
      textAlign: 'right'
    }
  }, "Amount"))), /*#__PURE__*/React.createElement("tbody", null, lines.map(l => {
    const swimmers = getSwimmerNames(l, membersByGroup);
    const ltName = l.lesson_type_name || l.description || '—';
    const pkgName = l.package_name || (l.line_type === 'group_bundle' ? 'Group Bundle' : 'Individual');
    return /*#__PURE__*/React.createElement("tr", {
      key: l.id
    }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", {
      style: {
        fontWeight: 600
      }
    }, ltName), /*#__PURE__*/React.createElement("div", {
      className: "small subtle"
    }, pkgName)), /*#__PURE__*/React.createElement("td", {
      className: "small subtle"
    }, swimmers.length > 0 ? swimmers.join(', ') : '—'), /*#__PURE__*/React.createElement("td", {
      style: {
        textAlign: 'right',
        fontWeight: 600
      }
    }, "RM ", Number(l.amount).toFixed(2)));
  })), /*#__PURE__*/React.createElement("tfoot", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    colSpan: 2,
    style: {
      textAlign: 'right',
      fontWeight: 700
    }
  }, "Total"), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: 'right',
      fontWeight: 800,
      fontSize: 15
    }
  }, "RM ", Number(invoice.total_amount || 0).toFixed(2)))))), pmts.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      marginBottom: 6
    }
  }, "Payments"), /*#__PURE__*/React.createElement("div", {
    className: "table-wrap"
  }, /*#__PURE__*/React.createElement("table", null, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Date"), /*#__PURE__*/React.createElement("th", null, "Receipt #"), /*#__PURE__*/React.createElement("th", null, "Method"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: 'right'
    }
  }, "Amount"), /*#__PURE__*/React.createElement("th", null))), /*#__PURE__*/React.createElement("tbody", null, pmts.map(p => /*#__PURE__*/React.createElement("tr", {
    key: p.id
  }, /*#__PURE__*/React.createElement("td", null, p.payment_date || '—'), /*#__PURE__*/React.createElement("td", {
    style: {
      fontFamily: 'monospace',
      fontSize: 11
    }
  }, p.receipt_number || '—'), /*#__PURE__*/React.createElement("td", null, methodLabel(p.payment_method)), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: 'right',
      fontWeight: 700,
      color: 'var(--green-tx)'
    }
  }, "RM ", Number(p.amount).toFixed(2)), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    title: "Print receipt",
    onClick: () => printReceipt(p, invoice)
  }, "\uD83D\uDDA8 Receipt"))))))), /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      marginTop: 4
    }
  }, "Paid RM ", Number(invoice.amount_paid || 0).toFixed(2), " \xB7 Outstanding RM ", outstanding.toFixed(2))), !showPayForm && outstanding > 0 && invoice.status !== 'void' && /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary small",
    onClick: () => {
      setPayAmt(outstanding.toFixed(2));
      setShowPayForm(true);
    }
  }, "+ Record Payment"), showPayForm && /*#__PURE__*/React.createElement("div", {
    className: "inv-pay-form"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      marginBottom: 8
    }
  }, "Record Payment"), /*#__PURE__*/React.createElement("div", {
    className: "form-grid",
    style: {
      gridTemplateColumns: '1fr 1fr 1fr'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Amount (RM)"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "number",
    step: "0.01",
    min: "0.01",
    value: payAmt,
    onChange: e => setPayAmt(e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Date"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "date",
    value: payDate,
    onChange: e => setPayDate(e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Method"), /*#__PURE__*/React.createElement("select", {
    className: "select",
    value: payMethod,
    onChange: e => setPayMethod(e.target.value)
  }, [['cash', 'Cash'], ['bank_transfer', 'Bank Transfer'], ['duitnow', 'DuitNow'], ['card', 'Card'], ['cheque', 'Cheque'], ['other', 'Other']].map(([v, l]) => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, l)))), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Reference #"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: payRef,
    onChange: e => setPayRef(e.target.value),
    placeholder: "e.g. TXN-12345"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Notes"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: payNotes,
    onChange: e => setPayNotes(e.target.value)
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary small",
    onClick: submitPayment,
    disabled: payBusy
  }, payBusy ? 'Saving…' : 'Save Payment'), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: () => setShowPayForm(false)
  }, "Cancel"))));
}
function InvoiceSettingsPanel({
  settings,
  onSave,
  formatInvoiceNumber,
  formatReceiptNumber
}) {
  const [form, setForm] = useState({
    invoice_prefix: settings.invoice_prefix || 'INV',
    receipt_prefix: settings.receipt_prefix || 'RCT',
    next_invoice_seq: String(settings.next_invoice_seq || 1),
    next_receipt_seq: String(settings.next_receipt_seq || 1),
    leading_zeros: String(settings.leading_zeros || 3),
    include_date: settings.include_date !== false,
    date_format: settings.date_format || 'YYYYMM',
    allow_delete_invoice: !!settings.allow_delete_invoice
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  React.useEffect(() => {
    setForm({
      invoice_prefix: settings.invoice_prefix || 'INV',
      receipt_prefix: settings.receipt_prefix || 'RCT',
      next_invoice_seq: String(settings.next_invoice_seq || 1),
      next_receipt_seq: String(settings.next_receipt_seq || 1),
      leading_zeros: String(settings.leading_zeros || 3),
      include_date: settings.include_date !== false,
      date_format: settings.date_format || 'YYYYMM',
      allow_delete_invoice: !!settings.allow_delete_invoice
    });
  }, [settings]);
  const set = (k, v) => setForm(f => ({
    ...f,
    [k]: v
  }));
  const draftSettings = {
    ...form,
    leading_zeros: Number(form.leading_zeros) || 3,
    include_date: !!form.include_date
  };
  const invPreview = formatInvoiceNumber ? formatInvoiceNumber(draftSettings, Number(form.next_invoice_seq) || 1) : '—';
  const rctPreview = formatReceiptNumber ? formatReceiptNumber(draftSettings, Number(form.next_receipt_seq) || 1) : '—';
  async function handleSave() {
    setSaving(true);
    setSaved(false);
    await onSave({
      invoice_prefix: form.invoice_prefix.trim() || 'INV',
      receipt_prefix: form.receipt_prefix.trim() || 'RCT',
      next_invoice_seq: Math.max(1, Number(form.next_invoice_seq) || 1),
      next_receipt_seq: Math.max(1, Number(form.next_receipt_seq) || 1),
      leading_zeros: Math.min(8, Math.max(1, Number(form.leading_zeros) || 3)),
      include_date: !!form.include_date,
      date_format: form.date_format,
      allow_delete_invoice: !!form.allow_delete_invoice
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "inv-settings-panel",
    style: {
      background: 'var(--surface-2)',
      border: '1px solid var(--border)',
      borderRadius: 10,
      padding: 14,
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700
    }
  }, "\u2699 Invoice Numbering"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost small",
    onClick: () => {
      if (confirm('Reset both counters to 1?')) {
        {
          set('next_invoice_seq', '1');
          set('next_receipt_seq', '1');
        }
      }
    }
  }, "\u21BA Reset"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary small",
    onClick: handleSave,
    disabled: saving
  }, saving ? 'Saving…' : saved ? '✓ Saved' : 'Save'))), /*#__PURE__*/React.createElement("div", {
    className: "form-grid",
    style: {
      gridTemplateColumns: 'repeat(3,1fr)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Invoice Prefix"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: form.invoice_prefix,
    onChange: e => set('invoice_prefix', e.target.value.replace(/\s/g, '')),
    placeholder: "INV",
    maxLength: 12
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Receipt Prefix"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: form.receipt_prefix,
    onChange: e => set('receipt_prefix', e.target.value.replace(/\s/g, '')),
    placeholder: "RCT",
    maxLength: 12
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Date Segment"), /*#__PURE__*/React.createElement("select", {
    className: "select",
    value: form.include_date ? form.date_format : 'none',
    onChange: e => {
      if (e.target.value === 'none') {
        set('include_date', false);
      } else {
        set('include_date', true);
        set('date_format', e.target.value);
      }
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: "YYYYMM"
  }, "Year + Month (202606)"), /*#__PURE__*/React.createElement("option", {
    value: "YYYY"
  }, "Year only (2026)"), /*#__PURE__*/React.createElement("option", {
    value: "MM"
  }, "Month only (06)"), /*#__PURE__*/React.createElement("option", {
    value: "none"
  }, "None \u2014 sequence only"))), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Leading Zeros"), /*#__PURE__*/React.createElement("select", {
    className: "select",
    value: form.leading_zeros,
    onChange: e => set('leading_zeros', e.target.value)
  }, [1, 2, 3, 4, 5].map(n => /*#__PURE__*/React.createElement("option", {
    key: n,
    value: n
  }, n, " \u2014 e.g. ", String(1).padStart(n, '0'))))), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Next Invoice #"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "number",
    min: "1",
    value: form.next_invoice_seq,
    onChange: e => set('next_invoice_seq', e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Next Receipt #"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "number",
    min: "1",
    value: form.next_receipt_seq,
    onChange: e => set('next_receipt_seq', e.target.value)
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10,
      padding: '8px 12px',
      background: 'var(--surface)',
      borderRadius: 8,
      border: '1px solid var(--border)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      marginBottom: 4
    }
  }, "Preview"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'monospace',
      fontWeight: 700
    }
  }, "Invoice: ", invPreview), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'monospace',
      fontWeight: 700,
      marginLeft: 24
    }
  }, "Receipt: ", rctPreview)), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 16,
      padding: '14px 16px',
      background: form.allow_delete_invoice ? 'linear-gradient(135deg,#FFF1F1,#FFF5F5)' : 'var(--surface-2)',
      border: `1px solid ${form.allow_delete_invoice ? 'var(--red-bd)' : 'var(--border)'}`,
      borderRadius: 10,
      transition: 'background .2s,border-color .2s'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      fontSize: 13,
      marginBottom: 4
    }
  }, "\uD83D\uDD10 Invoice Permissions"), /*#__PURE__*/React.createElement("div", {
    className: "small subtle",
    style: {
      marginBottom: 12
    }
  }, "These controls will be tied to user roles in a future login phase. Keep Delete disabled unless actively cleaning up test data."), /*#__PURE__*/React.createElement("label", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      cursor: 'pointer',
      userSelect: 'none'
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: () => set('allow_delete_invoice', !form.allow_delete_invoice),
    style: {
      width: 44,
      height: 24,
      borderRadius: 12,
      background: form.allow_delete_invoice ? 'var(--red-tx)' : 'var(--border-2)',
      position: 'relative',
      cursor: 'pointer',
      transition: 'background .2s',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 3,
      left: form.allow_delete_invoice ? 22 : 3,
      width: 18,
      height: 18,
      borderRadius: '50%',
      background: '#fff',
      boxShadow: '0 1px 4px rgba(0,0,0,.25)',
      transition: 'left .2s'
    }
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 600,
      fontSize: 13,
      color: form.allow_delete_invoice ? 'var(--red-tx)' : 'var(--text-2)'
    }
  }, form.allow_delete_invoice ? '🔓 Delete Invoice — ENABLED' : '🔒 Delete Invoice — Disabled'), /*#__PURE__*/React.createElement("div", {
    className: "small subtle"
  }, form.allow_delete_invoice ? 'The 🗑 Delete button is visible on all invoices. Deletions are permanent and cascade to payments and line items.' : 'The delete button is hidden on all invoices. Safe for normal operations.')))));
}
function getSwimmerNames(line, membersByGroup) {
  if (!line.family_group_id || !membersByGroup) return [];
  const members = membersByGroup[line.family_group_id] || [];
  return members.map(m => m.name || m.student_name || '').filter(Boolean);
}
function printInvoice(invoice, lines, membersByGroup) {
  const billable = (lines || []).filter(l => l.is_billable);
  const paidAmt = Number(invoice.amount_paid) || 0;
  const total = Number(invoice.total_amount) || 0;
  const outstanding = Math.max(0, total - paidAmt);
  const isPaid = outstanding <= 0 && invoice.status !== 'void';
  const logoUrl = window.location.origin + '/logo.png';
  const linesHtml = billable.map(l => {
    const swimmers = getSwimmerNames(l, membersByGroup);
    // Description = Lesson Type · Package (never the group name)
    const ltName = l.lesson_type_name || l.description || '';
    const pkgName = l.package_name || (l.line_type === 'group_bundle' ? 'Group Bundle' : 'Individual');
    const descText = [ltName, pkgName].filter(Boolean).join(' · ');
    const descHtml = swimmers.length ? `${descText}<div style="font-size:7pt;color:#777;margin-top:2pt;line-height:1.5">${swimmers.join(' &middot; ')}</div>` : descText;
    return `<tr><td class="td-desc">${descHtml}</td><td class="td-type">${pkgName}</td><td class="td-amt">RM ${Number(l.amount).toFixed(2)}</td></tr>`;
  }).join('');
  const branchRow = (() => {
    try {
      const b = (window.__SSB_BRANCHES__ || []).find(x => x.id === invoice.branch_id);
      return b ? `<span>Branch: ${b.name}${b.code ? ' (' + b.code + ')' : ''}</span>` : '';
    } catch (_) {
      return '';
    }
  })();
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${invoice.invoice_number}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:8.5pt;color:#1a1a1a;background:#fff}
@page{size:A5 landscape;margin:6mm 9mm}
@media print{.page{padding:0}}
.page{width:210mm;height:148mm;padding:5mm 7mm;display:flex;flex-direction:column;overflow:hidden}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:5pt;border-bottom:1pt solid #1a1a1a;margin-bottom:6pt}
.brand-logo{height:28pt;width:auto;object-fit:contain;display:block}
.brand-text{font-size:6.5pt;color:#555;margin-top:4pt;line-height:1.5}
.inv-number{font-size:10pt;font-weight:400;letter-spacing:.5px;color:#1a1a1a}
.inv-meta{font-size:7pt;color:#777;margin-top:2pt;line-height:1.5;text-align:right}
.status-chip{display:inline-block;padding:1pt 5pt;border-radius:2pt;font-size:6.5pt;font-weight:600;margin-top:2pt}
.s-draft{background:#f1f5f9;color:#475569}.s-sent{background:#dbeafe;color:#1d4ed8}
.s-partial{background:#fef3c7;color:#92400e}.s-paid{background:#d1fae5;color:#065f46}.s-void{background:#fee2e2;color:#7f1d1d}
.bill-row{display:flex;gap:12pt;margin-bottom:5pt}
.bill-box{background:#f8f9fa;border-radius:2pt;padding:3pt 6pt;flex:1}
.bill-label{font-size:6pt;text-transform:uppercase;letter-spacing:.5px;color:#999;margin-bottom:1pt}
.bill-name{font-size:8.5pt;font-weight:600;line-height:1.3}
.bill-contact{font-size:7pt;color:#666;margin-top:1pt}
table{width:100%;border-collapse:collapse;margin-bottom:5pt}
thead th{font-size:6.5pt;text-transform:uppercase;letter-spacing:.5px;color:#999;font-weight:600;padding:3pt 4pt;border-bottom:1pt solid #e5e5e5;text-align:left}
thead th.td-amt{text-align:right}
.td-desc{padding:3pt 4pt;font-size:8pt;border-bottom:1pt solid #f0f0f0;line-height:1.4}
.td-type{padding:3pt 4pt;font-size:7pt;color:#777;border-bottom:1pt solid #f0f0f0;white-space:nowrap}
.td-amt{padding:3pt 4pt;font-size:8pt;font-weight:600;text-align:right;border-bottom:1pt solid #f0f0f0;white-space:nowrap}
.totals{margin-left:auto;min-width:120pt}
.tot-row{display:flex;justify-content:space-between;gap:10pt;padding:2pt 0;font-size:8pt;color:#555}
.tot-row.grand{font-size:9.5pt;font-weight:700;color:#1a1a1a;border-top:1pt solid #1a1a1a;margin-top:3pt;padding-top:4pt}
.tot-row.paid-line{color:#059669}
.notes{font-size:7pt;color:#666;background:#f8f9fa;border-radius:2pt;padding:3pt 6pt;margin-bottom:4pt}
.footer{margin-top:auto;padding-top:4pt;border-top:1pt solid #e5e5e5;font-size:6pt;color:#aaa;display:flex;justify-content:space-between}
</style>
<script>window.onload=function(){setTimeout(function(){window.print()},350)}<\/script>
</head><body><div class="page">
<div class="hdr">
  <div>
    <img class="brand-logo" src="${logoUrl}" onerror="this.style.display='none'">
    <div class="brand-text">Star Swim Sdn Bhd (1602674-U)<br>No.137 Jalan Sultan Abdul Jalil, 30000 Ipoh, Perak<br>TIN: C59796139050</div>
  </div>
  <div style="text-align:right">
    <div class="inv-number">INVOICE</div>
    <div style="font-size:12pt;font-weight:300;letter-spacing:1px;margin-top:1pt">${invoice.invoice_number || ''}</div>
    <div class="inv-meta">Issued: ${invoice.issue_date || '—'}${invoice.due_date ? `<br>Due: ${invoice.due_date}` : ''}<br>
    <span class="status-chip s-${invoice.status || 'draft'}">${invoiceStatusLabel(invoice.status)}</span></div>
  </div>
</div>
<div class="bill-row">
  <div class="bill-box">
    <div class="bill-label">Bill To</div>
    <div class="bill-name">${invoice.account_name || '—'}</div>
    ${invoice.account_email || invoice.account_phone ? `<div class="bill-contact">${[invoice.account_email, invoice.account_phone].filter(Boolean).join(' &middot; ')}</div>` : ''}
  </div>
</div>
${invoice.notes ? `<div class="notes">${invoice.notes}</div>` : ''}
<table>
  <thead><tr><th>Description &amp; Swimmers</th><th>Type</th><th class="td-amt">Amount</th></tr></thead>
  <tbody>${linesHtml}</tbody>
</table>
<div class="totals">
  <div class="tot-row"><span>Subtotal</span><span>RM ${total.toFixed(2)}</span></div>
  ${paidAmt > 0 ? `<div class="tot-row paid-line"><span>Paid</span><span>− RM ${paidAmt.toFixed(2)}</span></div>` : ''}
  <div class="tot-row grand">
    <span>${isPaid ? 'Paid in full ✓' : 'Outstanding'}</span>
    <span>${isPaid ? 'RM 0.00' : 'RM ' + outstanding.toFixed(2)}</span>
  </div>
</div>
<div class="footer"><span>Thank you for choosing Star Swim Sdn Bhd${branchRow ? ' &middot; ' + branchRow : ''}</span><span>Generated ${new Date().toLocaleDateString(undefined, {
    dateStyle: 'long'
  })}</span></div>
</div></body></html>`;
  const w = window.open('', '_blank');
  if (w) {
    w.document.write(html);
    w.document.close();
  }
}
function printReceipt(pmt, invoice) {
  const logoUrl = window.location.origin + '/logo.png';
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Receipt ${pmt.receipt_number || ''}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:9pt;color:#1a1a1a;background:#fff}
@page{size:A5 landscape;margin:6mm 9mm}
.page{width:210mm;height:148mm;padding:5mm 7mm;display:flex;flex-direction:column;overflow:hidden}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:5pt;border-bottom:1pt solid #1a1a1a;margin-bottom:8pt}
.brand-logo{height:28pt;object-fit:contain;display:block}
.brand-text{font-size:6.5pt;color:#555;margin-top:3pt;line-height:1.5}
.rct-title{font-size:10pt;font-weight:300;letter-spacing:.8px;color:#1a1a1a;margin-bottom:1pt}
.rct-num{font-size:12pt;font-weight:300;letter-spacing:1px}
.row{display:flex;justify-content:space-between;padding:4pt 0;border-bottom:1pt solid #f0f0f0;font-size:8.5pt}
.row-label{color:#777}
.row-val{font-weight:500}
.row.amount{border-bottom:none;border-top:1.5pt solid #1a1a1a;margin-top:6pt;padding-top:6pt;font-size:12pt;font-weight:700}
.paid-stamp{display:inline-block;border:1.5pt solid #059669;color:#059669;padding:3pt 10pt;border-radius:2pt;font-size:8.5pt;font-weight:600;letter-spacing:.5px;margin-top:8pt}
.footer{margin-top:auto;padding-top:4pt;border-top:1pt solid #e5e5e5;font-size:6pt;color:#aaa;display:flex;justify-content:space-between}
</style>
<script>window.onload=function(){setTimeout(function(){window.print()},350)}<\/script>
</head><body><div class="page">
<div class="hdr">
  <div>
    <img class="brand-logo" src="${logoUrl}" onerror="this.style.display='none'">
    <div class="brand-text">Star Swim Sdn Bhd (1602674-U)<br>No.137 Jalan Sultan Abdul Jalil, 30000 Ipoh, Perak<br>TIN: C59796139050</div>
  </div>
  <div style="text-align:right"><div class="rct-title">RECEIPT</div><div class="rct-num">${pmt.receipt_number || '—'}</div></div>
</div>
<div class="row"><span class="row-label">Invoice</span><span class="row-val">${invoice.invoice_number || '—'}</span></div>
<div class="row"><span class="row-label">Account</span><span class="row-val">${invoice.account_name || '—'}</span></div>
<div class="row"><span class="row-label">Date</span><span class="row-val">${pmt.payment_date || '—'}</span></div>
<div class="row"><span class="row-label">Payment Method</span><span class="row-val">${methodLabel(pmt.payment_method)}</span></div>
${pmt.reference_number ? `<div class="row"><span class="row-label">Reference</span><span class="row-val">${pmt.reference_number}</span></div>` : ''}
${pmt.notes ? `<div class="row"><span class="row-label">Notes</span><span class="row-val">${pmt.notes}</span></div>` : ''}
<div class="row amount"><span>Amount Paid</span><span>RM ${Number(pmt.amount).toFixed(2)}</span></div>
<div><span class="paid-stamp">PAID IN FULL</span></div>
<div class="footer"><span>Thank you for your payment · Star Swim Sdn Bhd</span><span>Generated ${new Date().toLocaleDateString(undefined, {
    dateStyle: 'long'
  })}</span></div>
</div></body></html>`;
  const w = window.open('', '_blank');
  if (w) {
    w.document.write(html);
    w.document.close();
  }
}
function printInvoiceAndReceipt(invoice, lines, pmt, membersByGroup) {
  const logoUrl = window.location.origin + '/logo.png';
  const billable = (lines || []).filter(l => l.is_billable);
  const paidAmt = Number(invoice.amount_paid) || 0;
  const total = Number(invoice.total_amount) || 0;
  const linesHtml = billable.map(l => {
    const swimmers = getSwimmerNames(l, membersByGroup);
    const ltName = l.lesson_type_name || l.description || '';
    const pkgName = l.package_name || (l.line_type === 'group_bundle' ? 'Group Bundle' : 'Individual');
    const descText = [ltName, pkgName].filter(Boolean).join(' · ');
    const descHtml = swimmers.length ? `${descText}<div style="font-size:6.5pt;color:#666;margin-top:1pt">${swimmers.join(' &middot; ')}</div>` : descText;
    return `<tr><td class="td-d">${descHtml}</td><td class="td-t">${pkgName}</td><td class="td-a">RM ${Number(l.amount).toFixed(2)}</td></tr>`;
  }).join('');
  const co = `<img class="logo" src="${logoUrl}" onerror="this.style.display='none'"><div class="co">Star Swim Sdn Bhd (1602674-U)<br>No.137 Jalan Sultan Abdul Jalil, 30000 Ipoh<br>TIN: C59796139050</div>`;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Invoice & Receipt</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:8pt;color:#1a1a1a;background:#fff}
@page{size:A4 portrait;margin:5mm}
.block{width:197mm;height:141mm;overflow:hidden;display:flex;flex-direction:column;padding:5mm 7mm}
.block+.block{border-top:1pt dashed #ccc}
.hdr{display:flex;justify-content:space-between;padding-bottom:4pt;border-bottom:1pt solid #1a1a1a;margin-bottom:5pt}
.logo{height:22pt;object-fit:contain}
.co{font-size:5.5pt;color:#666;margin-top:2pt;line-height:1.5}
.rtitle{font-size:8pt;font-weight:400;letter-spacing:.5px}
.rnum{font-size:9.5pt;font-weight:300;letter-spacing:.8px}
.rmeta{font-size:6pt;color:#888;margin-top:1pt;text-align:right;line-height:1.4}
.bill{background:#f8f9fa;border-radius:2pt;padding:2.5pt 5pt;margin-bottom:4pt;font-size:7pt}
.bill strong{font-size:7.5pt;display:block}
table{width:100%;border-collapse:collapse;margin-bottom:4pt}
th{font-size:5.5pt;text-transform:uppercase;letter-spacing:.4px;color:#999;font-weight:600;padding:2pt 3pt;border-bottom:1pt solid #e5e5e5;text-align:left}
.td-d,.td-t,.td-a{padding:2.5pt 3pt;font-size:7.5pt;border-bottom:1pt solid #f2f2f2;line-height:1.4}
.td-a{text-align:right;font-weight:600;white-space:nowrap}
.td-t{color:#888;white-space:nowrap}
.totals{margin-left:auto;min-width:90pt}
.tr{display:flex;justify-content:space-between;font-size:7pt;color:#666;padding:1.5pt 0}
.tr.grand{font-size:8.5pt;font-weight:700;color:#1a1a1a;border-top:1pt solid #1a1a1a;margin-top:2pt;padding-top:3pt}
.row{display:flex;justify-content:space-between;padding:3pt 0;border-bottom:1pt solid #f0f0f0;font-size:7.5pt}
.rl{color:#777}.rv{font-weight:500}
.row.big{border-top:1.5pt solid #1a1a1a;border-bottom:none;margin-top:3pt;padding-top:4pt;font-size:9.5pt;font-weight:700}
.stamp{display:inline-block;border:1pt solid #059669;color:#059669;padding:2pt 7pt;border-radius:2pt;font-size:7pt;font-weight:600;margin-top:5pt}
.foot{margin-top:auto;padding-top:3pt;border-top:1pt solid #eee;font-size:5.5pt;color:#bbb;display:flex;justify-content:space-between}
</style>
<script>window.onload=function(){setTimeout(function(){window.print()},350)}<\/script>
</head><body>
<div class="block">
  <div class="hdr">
    <div>${co}</div>
    <div style="text-align:right">
      <div class="rtitle">INVOICE</div>
      <div class="rnum">${invoice.invoice_number || ''}</div>
      <div class="rmeta">Issued: ${invoice.issue_date || '—'}${invoice.due_date ? `<br>Due: ${invoice.due_date}` : ''}</div>
    </div>
  </div>
  <div class="bill"><span style="font-size:5pt;text-transform:uppercase;letter-spacing:.4px;color:#999">Bill To</span><strong>${invoice.account_name || '—'}</strong>${invoice.account_email ? `<span style="font-size:6.5pt;color:#666"> ${invoice.account_email}</span>` : ''}</div>
  <table><thead><tr><th>Description &amp; Swimmers</th><th>Type</th><th style="text-align:right">Amount</th></tr></thead><tbody>${linesHtml}</tbody></table>
  <div class="totals">
    <div class="tr"><span>Subtotal</span><span>RM ${total.toFixed(2)}</span></div>
    ${paidAmt > 0 ? `<div class="tr" style="color:#059669"><span>Paid</span><span>− RM ${paidAmt.toFixed(2)}</span></div>` : ''}
    <div class="tr grand"><span>Paid in full</span><span>RM 0.00</span></div>
  </div>
  <div class="foot"><span>Thank you · Star Swim Sdn Bhd</span><span>${new Date().toLocaleDateString(undefined, {
    dateStyle: 'long'
  })}</span></div>
</div>
${pmt ? `<div class="block">
  <div class="hdr">
    <div>${co}</div>
    <div style="text-align:right"><div class="rtitle">RECEIPT</div><div class="rnum">${pmt.receipt_number || '—'}</div></div>
  </div>
  <div class="row"><span class="rl">Invoice</span><span class="rv">${invoice.invoice_number || '—'}</span></div>
  <div class="row"><span class="rl">Account</span><span class="rv">${invoice.account_name || '—'}</span></div>
  <div class="row"><span class="rl">Date</span><span class="rv">${pmt.payment_date || '—'}</span></div>
  <div class="row"><span class="rl">Method</span><span class="rv">${methodLabel(pmt.payment_method)}</span></div>
  ${pmt.reference_number ? `<div class="row"><span class="rl">Reference</span><span class="rv">${pmt.reference_number}</span></div>` : ''}
  <div class="row big"><span>Amount Paid</span><span>RM ${Number(pmt.amount).toFixed(2)}</span></div>
  <div><span class="stamp">PAID IN FULL</span></div>
  <div class="foot"><span>Thank you for your payment</span><span>${new Date().toLocaleDateString(undefined, {
    dateStyle: 'long'
  })}</span></div>
</div>` : ''}
</body></html>`;
  const w = window.open('', '_blank');
  if (w) {
    w.document.write(html);
    w.document.close();
  }
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(ErrorBoundary, null, React.createElement(App)));
