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

const { useState, useEffect, useMemo } = React;

// ───────────────────────────────────────────────────────────────────── constants

const DAYS_S = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const DAYS_F = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
const SLOT_MIN = 30;
const ROW_H = 42;
const DEFAULT_OPEN = 480;    // 8:00 AM fallback if operating_hours table is empty
const DEFAULT_CLOSE = 1260;  // 9:00 PM fallback

const DEFAULT_TYPES = {
  "LTS": { bg:"#DBEAFE", bd:"#3B82F6", tx:"#1E40AF" },
  "LTS Adult": { bg:"#CFFAFE", bd:"#06B6D4", tx:"#0E7490" },
  "Personal 1": { bg:"#FED7AA", bd:"#F97316", tx:"#C2410C" },
  "Personal 2": { bg:"#FEF9C3", bd:"#CA8A04", tx:"#854D0E" },
  "Fam3": { bg:"#D1FAE5", bd:"#10B981", tx:"#065F46" },
  "Fam4": { bg:"#DCFCE7", bd:"#22C55E", tx:"#14532D" },
  "Fam5": { bg:"#D9F99D", bd:"#84CC16", tx:"#365314" },
  "Toddler": { bg:"#FCE7F3", bd:"#EC4899", tx:"#831843" },
  "Baby&Me": { bg:"#EDE9FE", bd:"#8B5CF6", tx:"#4C1D95" },
  "Personal Clara": { bg:"#FEE2E2", bd:"#EF4444", tx:"#7F1D1D" }
};

// ───────────────────────────────────────────────────────────────────── REST glue

const cfg = window.APP_CONFIG || {};
const BASE_HEADERS = {
  apikey: cfg.supabaseAnonKey || '',
  Authorization: `Bearer ${cfg.supabaseAnonKey || ''}`,
  'Content-Type': 'application/json'
};
function apiUrl(path){ return `${cfg.supabaseUrl}/rest/v1/${path}`; }
async function rest(path, opts={}){
  const mergedHeaders = { ...BASE_HEADERS, ...(opts.headers || {}) };
  const res = await fetch(apiUrl(path), { ...opts, headers: mergedHeaders });
  const txt = await res.text();
  if(!res.ok) throw new Error(txt || `HTTP ${res.status}`);
  return txt ? JSON.parse(txt) : null;
}
async function selectRows(table, select='*', extra=''){ return rest(`${table}?select=${select}${extra}`); }
async function insertRows(table, payload, select='*'){ return rest(`${table}?select=${select}`, { method:'POST', headers:{ Prefer:'return=representation' }, body: JSON.stringify(Array.isArray(payload)?payload:[payload]) }); }
async function patchRows(table, match, payload, select='*'){
  const q = Object.entries(match).map(([k,v]) => `&${encodeURIComponent(k)}=eq.${encodeURIComponent(v)}`).join('');
  return rest(`${table}?select=${select}${q}`, { method:'PATCH', headers:{ Prefer:'return=representation' }, body: JSON.stringify(payload) });
}
async function deleteRows(table, match, select='*'){
  const q = Object.entries(match).map(([k,v]) => `&${encodeURIComponent(k)}=eq.${encodeURIComponent(v)}`).join('');
  return rest(`${table}?select=${select}${q}`, { method:'DELETE', headers:{ Prefer:'return=representation' } });
}

// ───────────────────────────────────────────────────────────────────── helpers

function toDateStr(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function fromDateStr(s){ const [y,m,d] = s.split('-').map(Number); return new Date(y,m-1,d); }
function todayStr(){ return toDateStr(new Date()); }
function minuteToTime(mins){ const h24 = Math.floor(mins / 60), m = mins % 60, ampm = h24 < 12 ? 'AM' : 'PM'; const h = h24 % 12 || 12; return `${h}:${String(m).padStart(2,'0')} ${ampm}`; }
// Compact label for whole-hour agenda rows: "10 AM", "12 PM", "1:30 PM".
function hourLabel(mins){ const h24 = Math.floor(mins / 60), m = mins % 60, ampm = h24 < 12 ? 'AM' : 'PM'; const h = h24 % 12 || 12; return m === 0 ? `${h} ${ampm}` : `${h}:${String(m).padStart(2,'0')} ${ampm}`; }
// Display-only: shorten a full name to its first two words ("Ashton Ang Zi Yang" → "Ashton Ang"). Full name is untouched in the database.
function shortName(name){ const parts = String(name || '').trim().split(/\s+/).filter(Boolean); return parts.slice(0, 3).join(' '); }
// Age shown in years, e.g. " (5)". Blank when unknown.
function ageSuffix(s){ return (s && s.age !== null && s.age !== undefined && s.age !== '') ? ` (${s.age})` : ''; }
// Compute total months between a DOB and today. Birthday-aware (subtracts a
// month if today is before the day-of-month). Returns null on invalid input.
function ageMonthsFromDob(dob){
  if(!dob) return null;
  try{
    const d = (typeof dob === 'string') ? fromDateStr(dob) : new Date(dob);
    const now = new Date();
    let months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
    if(now.getDate() < d.getDate()) months--;
    return Math.max(0, months);
  } catch(_){ return null; }
}
// Display age: half-year precision for under-5s (e.g. 1.5, 2.0, 4.5),
// integer years for 5+. Matches the precision the swim school actually
// uses when slotting toddlers into age-banded classes.
function ageFromDob(dob){
  const m = ageMonthsFromDob(dob);
  if(m == null) return null;
  if(m < 60) return Math.floor(m / 6) / 2;
  return Math.floor(m / 12);
}
function ageDisplay(age){
  if(age === null || age === undefined || age === '') return '—';
  return `${age}y`;
}
function studentLabel(s){ return s.name + ageSuffix(s) + (s && s.remark ? ` — ${s.remark}` : ''); }
// Build the modal's student rows: existing students first, padded with blanks
// up to the lesson type's ratio (so "max 4" shows 4 boxes). Falls back to 4.
function buildStudentRows(existing, cap){
  const rows = (existing || []).map(s => ({ studentId: s.studentId || null, name: s.name || '', age: (s.age === null || s.age === undefined ? '' : String(s.age)), remark: s.remark || '', attendance: s.attendance || 'pending' }));
  const c = Number(cap) > 0 ? Number(cap) : 4;
  const target = Math.max(c, rows.length, 1);
  while(rows.length < target) rows.push({ studentId:null, name:'', age:'', remark:'', attendance:'pending' });
  return rows;
}
// Re-normalize rows when the lesson type changes: keep filled rows, pad to the new ratio.
function rebuildRowsForCap(rows, cap){
  const filled = (rows || []).filter(r => (r.name || '').trim() || r.studentId);
  const c = Number(cap) > 0 ? Number(cap) : 4;
  const target = Math.max(c, filled.length, 1);
  const out = filled.slice();
  while(out.length < target) out.push({ studentId:null, name:'', age:'', remark:'', attendance:'pending' });
  return out;
}
function formatRange(startMin, durationMin){ return `${minuteToTime(startMin)}–${minuteToTime(startMin + durationMin)}`; }
// Compact form for tight cards: drops ":00" and the space before AM/PM, keeps
// non-zero minutes ("11AM", "11:30AM", "12PM-1PM").
function compactTime(mins){ const h24 = Math.floor(mins / 60), m = mins % 60, ampm = h24 < 12 ? 'AM' : 'PM'; const h = h24 % 12 || 12; return m === 0 ? `${h}${ampm}` : `${h}:${String(m).padStart(2,'0')}${ampm}`; }
function compactRange(startMin, durationMin){ return `${compactTime(startMin)}-${compactTime(startMin + durationMin)}`; }
function longDate(s){ return fromDateStr(s).toLocaleDateString(undefined, { weekday:'long', year:'numeric', month:'long', day:'numeric' }); }
function monthCells(d){ const y=d.getFullYear(), m=d.getMonth(); const first=new Date(y,m,1); const offset=(first.getDay()+6)%7; const start=new Date(y,m,1-offset); return Array.from({length:42},(_,i)=>{ const x=new Date(start); x.setDate(start.getDate()+i); return x; }); }
function monthKey(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function dateToWeekdayIndex(dateStr){ return (fromDateStr(dateStr).getDay() + 6) % 7; }
function excludeFromStudentTotals(sessionType){
  const t = String(sessionType || '').toLowerCase();
  return t.includes('replacement') || t.includes('trial');
}
function weekBounds(dateStr){ const d = fromDateStr(dateStr); const monday = new Date(d); monday.setDate(d.getDate() - ((d.getDay()+6)%7)); const sunday = new Date(monday); sunday.setDate(monday.getDate()+6); return { start:monday, end:sunday }; }
function weekStartStr(dateStr){ return toDateStr(weekBounds(dateStr).start); }
function addDays(dateStr, days){ const d = fromDateStr(dateStr); d.setDate(d.getDate()+days); return toDateStr(d); }

// M2: dynamic grid bounds from operating_hours rows. Falls back to 8 AM - 9 PM.
// Uses the widest window across all open days so days that close earlier just
// show empty cells past their close time.
function computeGridBounds(operatingHours){
  const open = (operatingHours || []).filter(h => h.is_open !== false);
  if(!open.length) return { startMin: DEFAULT_OPEN, endMin: DEFAULT_CLOSE };
  const startMin = Math.min(...open.map(h => Number(h.open_minute)));
  const endMin   = Math.max(...open.map(h => Number(h.close_minute)));
  // Snap to the SLOT_MIN grid so row arithmetic stays clean.
  return {
    startMin: Math.floor(startMin / SLOT_MIN) * SLOT_MIN,
    endMin:   Math.ceil(endMin / SLOT_MIN) * SLOT_MIN
  };
}

// M2: mirrors the Postgres pool_occupancy() rounding so JS and DB agree on
// when one session blocks another.
function effectiveEndMinute(startMin, durationMin){
  return Math.ceil((Number(startMin) + Number(durationMin)) / SLOT_MIN) * SLOT_MIN;
}

// M2: compute current/max capacity for a session given its lesson type.
function sessionCapacity(session, lessonType){
  const ratio = Number((lessonType && lessonType.students_per_instructor) || 0);
  const instCount = Math.max(0, (session.instructors || []).length);
  const max = ratio > 0 ? ratio * Math.max(1, instCount) : 0;
  const current = (session.students || []).length;
  let status = 'unknown';
  if(max > 0){
    if(current > max) status = 'over';
    else if(current === max) status = 'full';
    else if(current / max >= 0.8) status = 'tight';
    else status = 'open';
  }
  return { current, max, status };
}

function capacityChipColors(status){
  switch(status){
    case 'open':  return { bg:'#E4F6EC', tx:'#138A53', bd:'#BFE8CF' };
    case 'tight': return { bg:'#FCEFD6', tx:'#B45309', bd:'#F2DCA8' };
    case 'full':  return { bg:'#FCE7D6', tx:'#C2410C', bd:'#F3D2B0' };
    case 'over':  return { bg:'#FCE7E7', tx:'#D63B3B', bd:'#F3C9C9' };
    default:      return { bg:'#F0F0F5', tx:'#6C6C7E', bd:'#E1E1EC' };
  }
}

// M2: print helpers preserved as before.
function printWeeklyView(){ document.body.setAttribute('data-print-view','weekly'); window.print(); setTimeout(()=>document.body.removeAttribute('data-print-view'),300); }
function printDailyView(dateStr){ document.body.setAttribute('data-print-view','daily'); document.body.setAttribute('data-print-date', dateStr || ''); window.print(); setTimeout(()=>{document.body.removeAttribute('data-print-view'); document.body.removeAttribute('data-print-date');},300); }
function printWeeklyTable(){ const s=document.createElement('style'); s.id='wt-page-style'; s.textContent='@page{size:A3 landscape;margin:8mm}'; document.head.appendChild(s); document.body.setAttribute('data-print-view','weekly-table'); window.print(); setTimeout(()=>{ document.body.removeAttribute('data-print-view'); const el=document.getElementById('wt-page-style'); if(el) el.remove(); },500); }

// M2: assign _col / _total within a set of overlapping sessions. Extracted from
// the prior inline logic so it can be reused per (day, pool) tuple.
function packParallelColumns(items){
  const sorted = items.slice().sort((a,b) => a.startMinute - b.startMinute || String(a.id).localeCompare(String(b.id)));
  const cols = [];
  const out = [];
  sorted.forEach(item => {
    const end = item.startMinute + item.durationMinutes;
    let idx = 0;
    while(idx < cols.length && cols[idx] > item.startMinute) idx++;
    cols[idx] = end;
    out.push({ ...item, _col: idx });
  });
  const total = Math.max(cols.length, 1);
  return out.map(x => ({ ...x, _total: total }));
}

// ============================================================================
// App
// ============================================================================

// M2.1: human week-range label, e.g. "May 25 – 31, 2026" or "May 25 – Jun 1, 2026".
function weekRangeLabel(wkStart){
  const start = fromDateStr(wkStart);
  const end = new Date(start); end.setDate(start.getDate()+6);
  const sM = start.toLocaleDateString(undefined,{month:'short'});
  const eM = end.toLocaleDateString(undefined,{month:'short'});
  const sY = start.getFullYear(), eY = end.getFullYear();
  if(sY !== eY) return `${sM} ${start.getDate()}, ${sY} – ${eM} ${end.getDate()}, ${eY}`;
  if(sM === eM) return `${sM} ${start.getDate()} – ${end.getDate()}, ${eY}`;
  return `${sM} ${start.getDate()} – ${eM} ${end.getDate()}, ${eY}`;
}

// M2.1: one navigation band shared by Weekly and Daily. A week stepper with a
// readable range label, a "This Week" reset, and a right-aligned actions slot.
function PeriodNav({ rangeLabel, onPrev, onNext, onToday, isCurrent, children }){
  return <div className="period-nav">
    <div className="period-nav-left">
      <div className="period-stepper">
        <button className="step-btn" onClick={onPrev} title="Previous week" aria-label="Previous week">‹</button>
        <div className="period-label">{rangeLabel}</div>
        <button className="step-btn" onClick={onNext} title="Next week" aria-label="Next week">›</button>
      </div>
      <button className={`today-btn ${isCurrent?'is-current':''}`} onClick={onToday} disabled={isCurrent} title="Jump to the current week">This Week</button>
    </div>
    {children ? <div className="period-nav-actions">{children}</div> : null}
  </div>;
}

function App(){
  const [view,setView] = useState('week');
  const [adminSection,setAdminSection] = useState('summary');
  const [loading,setLoading] = useState(true);
  const [status,setStatus] = useState('');
  const [error,setError] = useState('');
  const [sessions,setSessions] = useState([]);
  const [students,setStudents] = useState([]);
  const [familyGroups,setFamilyGroups] = useState([]);
  const [groupMemberships,setGroupMemberships] = useState([]);
  const [creditBalances,setCreditBalances] = useState([]);
  const [creditPurchases,setCreditPurchases] = useState([]);
  const [subscriptions,setSubscriptions] = useState([]);
  const [codes,setCodes] = useState([]);
  const [replacementPending,setReplacementPending] = useState([]);
  const [tcAcceptances,setTcAcceptances] = useState([]);
  const [remarks,setRemarks] = useState({});
  const [options,setOptions] = useState({ instructors:[], durations:[], lessonTypes:[], pools:[], operatingHours:[], packages:[] });
  const [monthCursor,setMonthCursor] = useState(new Date());
  const [selectedDate,setSelectedDate] = useState(todayStr());
  const [selectedPoolId,setSelectedPoolId] = useState(null);
  const [enabledTypes,setEnabledTypes] = useState(null);
  const [selectedInstructors,setSelectedInstructors] = useState(new Set());
  const [modal,setModal] = useState(null);
  const [saveBusy,setSaveBusy] = useState(false);
  const [remarkDraft,setRemarkDraft] = useState('');
  // ── Invoicing state ────────────────────────────────────────────────
  const [invoices,setInvoices] = useState([]);
  const [invoiceLines,setInvoiceLines] = useState([]);
  const [pmts,setPmts] = useState([]);
  const [pendingCredits,setPendingCredits] = useState([]);
  const [invoiceSettings,setInvoiceSettings] = useState({ invoice_prefix:'INV', receipt_prefix:'RCT', next_invoice_seq:1, next_receipt_seq:1, leading_zeros:3, include_date:true, date_format:'YYYYMM' });

  useEffect(() => { boot(); }, []);
  useEffect(() => { if(cfg.supabaseUrl && cfg.supabaseAnonKey) loadRemarks(monthCursor).catch(handleErr); }, [monthCursor]);
  useEffect(() => { setRemarkDraft(remarks[selectedDate] || ''); }, [selectedDate, remarks]);

  function handleErr(err){ console.error(err); setError(err?.message || String(err)); setStatus('Error'); }

  async function boot(){
    if(!cfg.supabaseUrl || !cfg.supabaseAnonKey){ setError('Missing config.js values.'); setLoading(false); return; }
    try{
      setLoading(true); setError('');
      await loadOptions();
      await Promise.all([loadSessions(), loadStudents(), loadGroups(), loadGroupMemberships(), loadCreditBalances(), loadCreditPurchases(), loadSubscriptions(), loadCodes(), loadReplacementPending(), loadTcAcceptances(), loadRemarks(monthCursor), loadInvoiceData()]);
      setStatus('Connected');
    } catch(err){ handleErr(err); }
    finally{ setLoading(false); }
  }

  // ── Invoice loaders ────────────────────────────────────────────────
  async function loadInvoiceData(){
    try{
      const [invRows, lineRows, payRows, pcRows, settRows] = await Promise.all([
        selectRows('invoices','*','&order=created_at.desc'),
        selectRows('invoice_lines','*','&order=invoice_id.asc,sort_order.asc'),
        selectRows('payments','*','&order=invoice_id.asc,created_at.asc'),
        selectRows('pending_credits','*','&order=created_at.desc'),
        selectRows('invoice_settings','*').catch(()=>[]),
      ]);
      setInvoices(invRows||[]);
      setInvoiceLines(lineRows||[]);
      setPmts(payRows||[]);
      setPendingCredits(pcRows||[]);
      if(settRows?.[0]) setInvoiceSettings(settRows[0]);
    }catch(e){ console.warn('Invoice tables not found — run migrations first.',e); }
  }

  // ── Number formatting ──────────────────────────────────────────────
  // Pure helper — builds a formatted number string from a settings object
  // and a raw sequence integer. Used for live preview and generation.
  function formatInvoiceNumber(sett, seq){
    const now = new Date();
    const y = now.getFullYear(), m = String(now.getMonth()+1).padStart(2,'0');
    const yy = String(y).slice(-2);
    const datePart = sett.include_date !== false ? {
      YYYYMM: `-${y}${m}`,
      YYYY:   `-${y}`,
      MM:     `-${m}`,
      MMYY:   `-${m}${yy}`,
      none:   '',
    }[sett.date_format||'YYYYMM'] ?? `-${y}${m}` : '';
    const pad = Math.max(1, Number(sett.leading_zeros)||3);
    const seqStr = String(seq).padStart(pad,'0');
    return `${sett.invoice_prefix||'INV'}${datePart}-${seqStr}`;
  }
  function formatReceiptNumber(sett, seq){
    const now = new Date();
    const y = now.getFullYear(), m = String(now.getMonth()+1).padStart(2,'0');
    const yy = String(y).slice(-2);
    const datePart = sett.include_date !== false ? {
      YYYYMM: `-${y}${m}`,
      YYYY:   `-${y}`,
      MM:     `-${m}`,
      MMYY:   `-${m}${yy}`,
      none:   '',
    }[sett.date_format||'YYYYMM'] ?? `-${y}${m}` : '';
    const pad = Math.max(1, Number(sett.leading_zeros)||3);
    const seqStr = String(seq).padStart(pad,'0');
    return `${sett.receipt_prefix||'RCT'}${datePart}-${seqStr}`;
  }

  // Save invoice settings (upsert on id=1)
  async function saveInvoiceSettings(patch){
    try{
      await patchRows('invoice_settings',{id:1},patch);
      await loadInvoiceData();
    }catch(err){ handleErr(err); alert(err.message||'Failed to save settings'); }
  }

  // ── Invoice CRUD ───────────────────────────────────────────────────
  async function createInvoice({ accountName, accountEmail, accountPhone, lines, notes, dueDate }){
    // Read current settings (fresh from DB to get latest seq)
    const settRows = await selectRows('invoice_settings','*').catch(()=>[]);
    const sett = settRows?.[0] || invoiceSettings;
    const seq = Number(sett.next_invoice_seq)||1;
    const invoiceNumber = formatInvoiceNumber(sett, seq);
    // Increment counter immediately so concurrent creates don't collide
    await patchRows('invoice_settings',{id:1},{next_invoice_seq: seq+1}).catch(()=>{});
    const totalAmount = lines.reduce((s,l)=>s+Number(l.amount||0),0);
    const now = new Date();
    const inserted = await insertRows('invoices',{
      invoice_number:invoiceNumber, account_name:accountName,
      account_email:accountEmail||null, account_phone:accountPhone||null,
      status:'draft', issue_date:toDateStr(now), due_date:dueDate||null,
      notes:notes||null, total_amount:totalAmount, amount_paid:0
    });
    const invoiceId = inserted?.[0]?.id;
    if(invoiceId && lines.length){
      await insertRows('invoice_lines', lines.map((l,i)=>({
        invoice_id:invoiceId, description:l.description,
        lesson_type_name:l.lessonTypeName||null, lesson_type_id:l.lessonTypeId||null,
        package_name:l.packageName||null, package_id:l.packageId||null,
        family_group_id:l.familyGroupId||null, family_group_name:l.familyGroupName||null,
        student_names:l.studentNames||null, student_ids:l.studentIds||null,
        amount:Number(l.amount||0), quantity:1, is_billable:true,
        line_type:l.lineType||'package',
        credits_per_swimmer:l.creditsPerSwimmer||null, billing_mode:l.billingMode||null,
        sort_order:i
      })));
    }
    await loadInvoiceData();
    return invoiceId;
  }

  async function recordPayment({ invoiceId, amount, paymentDate, paymentMethod, referenceNumber, notes:pNotes }){
    // Read current settings (fresh) for receipt number
    const settRows = await selectRows('invoice_settings','*').catch(()=>[]);
    const sett = settRows?.[0] || invoiceSettings;
    const seq = Number(sett.next_receipt_seq)||1;
    const receiptNumber = formatReceiptNumber(sett, seq);
    await patchRows('invoice_settings',{id:1},{next_receipt_seq: seq+1}).catch(()=>{});
    const inserted = await insertRows('payments',{
      invoice_id:invoiceId, receipt_number:receiptNumber,
      amount:Number(amount), payment_date:paymentDate||toDateStr(now),
      payment_method:paymentMethod||'cash',
      reference_number:referenceNumber||null, notes:pNotes||null
    });
    const paymentId = inserted?.[0]?.id;
    // Seed pending_credits from billable lines
    if(paymentId){
      const invLines = invoiceLines.filter(l=>l.invoice_id===invoiceId && l.is_billable);
      const creditRows = [];
      invLines.forEach(l=>{
        if(l.family_group_id){
          creditRows.push({ invoice_id:invoiceId, payment_id:paymentId,
            family_group_id:l.family_group_id, lesson_type_id:l.lesson_type_id,
            package_id:l.package_id, description:l.description,
            credits_per_swimmer:l.credits_per_swimmer||4, status:'pending' });
        } else if(l.student_ids){
          l.student_ids.split(',').map(s=>s.trim()).filter(Boolean).forEach(sid=>{
            creditRows.push({ invoice_id:invoiceId, payment_id:paymentId,
              student_id:sid, lesson_type_id:l.lesson_type_id,
              package_id:l.package_id, description:l.description,
              credits_per_swimmer:l.credits_per_swimmer||4, status:'pending' });
          });
        }
      });
      if(creditRows.length) await insertRows('pending_credits',creditRows);
    }
    // Recalculate invoice status
    const invoice = invoices.find(i=>i.id===invoiceId);
    const existingPaid = pmts.filter(p=>p.invoice_id===invoiceId).reduce((s,p)=>s+Number(p.amount),0);
    const totalPaid = existingPaid + Number(amount);
    const newStatus = totalPaid >= Number(invoice?.total_amount||0) ? 'paid' : totalPaid>0 ? 'partial' : 'sent';
    await patchRows('invoices',{id:invoiceId},{amount_paid:totalPaid,status:newStatus,updated_at:new Date().toISOString()});
    await loadInvoiceData();
    return { receiptNumber };
  }

  async function confirmCredit(credit){
    const pkg = options.packages?.find(p=>p.id===credit.package_id);
    const creditsNum = credit.credits_per_swimmer || pkg?.billing_count || 4;
    try{
      await addSubscription({
        subjectType: credit.family_group_id ? 'family_group' : 'student',
        subjectId: credit.family_group_id || credit.student_id,
        lessonTypeId: credit.lesson_type_id, packageId: credit.package_id,
        creditsPerSwimmer: creditsNum, quantity:1, subscriptionDate: toDateStr(new Date())
      });
      await patchRows('pending_credits',{id:credit.id},{status:'confirmed',confirmed_at:new Date().toISOString()});
      await loadInvoiceData(); await loadStudents();
    }catch(err){ handleErr(err); alert(err.message||'Failed to confirm credit'); }
  }

  async function reverseCredit(credit){
    if(!confirm('Reverse this pending credit? Credits will not be allocated.')) return;
    try{
      await patchRows('pending_credits',{id:credit.id},{status:'reversed',reversed_at:new Date().toISOString()});
      await loadInvoiceData();
    }catch(err){ handleErr(err); alert(err.message||'Failed to reverse'); }
  }

  async function voidInvoice(id){
    if(!confirm('Void this invoice? This cannot be undone.')) return;
    try{ await patchRows('invoices',{id},{status:'void',updated_at:new Date().toISOString()}); await loadInvoiceData(); }
    catch(err){ handleErr(err); alert(err.message||'Failed to void'); }
  }

  async function updateInvoiceStatus(id,newStatus){
    try{ await patchRows('invoices',{id},{status:newStatus,updated_at:new Date().toISOString()}); await loadInvoiceData(); }
    catch(err){ handleErr(err); alert(err.message||'Failed to update status'); }
  }

  // ── Invoice line CRUD (Phase 2) ────────────────────────────────────
  async function recalcInvoiceTotal(invoiceId){
    // Re-sum billable lines and push to invoices.total_amount
    const lines = invoiceLines.filter(l=>l.invoice_id===invoiceId && l.is_billable);
    const total = lines.reduce((s,l)=>s+Number(l.amount||0),0);
    await patchRows('invoices',{id:invoiceId},{total_amount:total,updated_at:new Date().toISOString()});
  }

  async function addInvoiceLine(invoiceId, lineData){
    try{
      const existing = invoiceLines.filter(l=>l.invoice_id===invoiceId);
      await insertRows('invoice_lines',{
        invoice_id:invoiceId, description:lineData.description||'Custom line',
        amount:Number(lineData.amount||0), quantity:1, is_billable:true,
        line_type:lineData.lineType||'other',
        lesson_type_name:lineData.lessonTypeName||null, package_name:lineData.packageName||null,
        sort_order: existing.length
      });
      await loadInvoiceData();
      // Recalc after reload so new line is in invoiceLines
      const refreshed = await selectRows('invoice_lines','*',`&invoice_id=eq.${invoiceId}&is_billable=eq.true`).catch(()=>[]);
      const total = (refreshed||[]).reduce((s,l)=>s+Number(l.amount||0),0);
      await patchRows('invoices',{id:invoiceId},{total_amount:total,updated_at:new Date().toISOString()});
      await loadInvoiceData();
    }catch(err){ handleErr(err); alert(err.message||'Failed to add line'); }
  }

  async function updateInvoiceLine(lineId, patch){
    try{
      await patchRows('invoice_lines',{id:lineId},patch);
      // Find the invoice this line belongs to
      const line = invoiceLines.find(l=>l.id===lineId);
      if(line){
        await loadInvoiceData();
        const refreshed = await selectRows('invoice_lines','*',`&invoice_id=eq.${line.invoice_id}&is_billable=eq.true`).catch(()=>[]);
        const total = (refreshed||[]).reduce((s,l)=>s+Number(l.amount||0),0);
        await patchRows('invoices',{id:line.invoice_id},{total_amount:total,updated_at:new Date().toISOString()});
      }
      await loadInvoiceData();
    }catch(err){ handleErr(err); alert(err.message||'Failed to update line'); }
  }

  async function deleteInvoiceLine(lineId){
    if(!confirm('Remove this line from the invoice?')) return;
    try{
      const line = invoiceLines.find(l=>l.id===lineId);
      await deleteRows('invoice_lines',{id:lineId});
      if(line){
        await loadInvoiceData();
        const refreshed = await selectRows('invoice_lines','*',`&invoice_id=eq.${line.invoice_id}&is_billable=eq.true`).catch(()=>[]);
        const total = (refreshed||[]).reduce((s,l)=>s+Number(l.amount||0),0);
        await patchRows('invoices',{id:line.invoice_id},{total_amount:total,updated_at:new Date().toISOString()});
      }
      await loadInvoiceData();
    }catch(err){ handleErr(err); alert(err.message||'Failed to delete line'); }
  }

  // M2: also loads pools and operating_hours.
  async function loadOptions(){
    const [instructors, durations, lessonTypes, pools, operatingHours, packages] = await Promise.all([
      selectRows('scheduler_instructors', '*', '&order=sort_order.asc,name.asc'),
      selectRows('scheduler_durations', '*', '&order=sort_order.asc,slots.asc'),
      selectRows('scheduler_lesson_types', '*', '&order=sort_order.asc,name.asc'),
      selectRows('pools', '*', '&order=sort_order.asc,name.asc'),
      selectRows('operating_hours', '*', '&order=weekday.asc'),
      selectRows('packages', '*', '&order=sort_order.asc,name.asc').catch(()=>[])
    ]);
    setOptions({
      instructors: instructors || [],
      durations: durations || [],
      lessonTypes: lessonTypes || [],
      pools: pools || [],
      operatingHours: operatingHours || [],
      packages: packages || []
    });
  }

  // M2: also fetches session_instructors and instructors, then merges so each
  // session carries instructors:[{id,name}] alongside students:[{id,name}].
  async function loadSessions(){
    const [sessionRows, studentRows, instructorJoinRows, instructorCatalog] = await Promise.all([
      selectRows('weekly_sessions', '*', '&order=week_start_date.asc,weekday.asc,start_minute.asc,created_at.asc'),
      selectRows('weekly_session_students', '*', '&order=created_at.asc,student_name.asc'),
      selectRows('session_instructors', '*'),
      selectRows('scheduler_instructors', '*')
    ]);
    const instructorById = {};
    (instructorCatalog || []).forEach(i => { instructorById[i.id] = i; });
    const studentsBySession = {};
    (studentRows || []).forEach(r => {
      const key = String(r.session_id);
      if(!studentsBySession[key]) studentsBySession[key] = [];
      studentsBySession[key].push({ id:r.id, studentId:r.student_id || null, name:r.student_name || '', age:(r.student_age === null || r.student_age === undefined ? null : Number(r.student_age)), remark:r.remark || '', isReplacement: !!r.is_replacement, replacementFrom: r.replacement_from || '', attendance: r.attendance_status || 'pending' });
    });
    const instructorsBySession = {};
    (instructorJoinRows || []).forEach(r => {
      const key = String(r.session_id);
      if(!instructorsBySession[key]) instructorsBySession[key] = [];
      const inst = instructorById[r.instructor_id];
      if(inst) instructorsBySession[key].push({ id: inst.id, name: inst.name });
    });
    const merged = (sessionRows || []).map(r => ({
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
      // Cancellation state — when set, this session is a "ghost" left at
      // its original spot after being forwarded or rescheduled. The
      // target_session_id points to the replacement (next-week clone or
      // new-slot session). Clicking the ghost in the grid offers a
      // restore action that unwinds back to this row.
      cancelledAt: r.cancelled_at || null,
      cancelledReason: r.cancelled_reason || null,
      cancelledTargetSessionId: r.cancelled_target_session_id || null,
      students: studentsBySession[String(r.id)] || [],
      instructors: instructorsBySession[String(r.id)] || []
    }));
    setSessions(merged);
  }

  async function loadStudents(){
    try{
      const [rows, enrollmentRows] = await Promise.all([
        selectRows('students', '*', '&order=name.asc'),
        selectRows('student_enrollments', '*').catch(()=>[]) // table may not exist yet
      ]);
      const byStudent = {};
      (enrollmentRows || []).forEach(e => {
        if(!byStudent[e.student_id]) byStudent[e.student_id] = [];
        byStudent[e.student_id].push({ id: e.id, lessonTypeId: e.lesson_type_id, packageId: e.package_id });
      });
      setStudents((rows || []).map(r => {
        const dob = r.date_of_birth || null;
        // DOB is the source of truth — age is recomputed every load so it
        // tracks today's date (a 4-year-old becomes 5 on their birthday
        // without any data write). Fallback to stored age only when DOB is
        // missing (legacy rows pre-migration).
        const ageNow = dob != null ? ageFromDob(dob) : (r.age === null || r.age === undefined ? null : Number(r.age));
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
          emergencyPhone: r.emergency_phone || '',
          emergencyName: r.emergency_name || '',
          emergencyRelationship: r.emergency_relationship || '',
          emergencySameAsGuardian: !!r.emergency_same_as_guardian,
          tcAcceptedAt: r.tc_accepted_at || null,
          tcAcceptanceId: r.tc_acceptance_id || null
        };
      }));
    } catch(e){ console.warn('Swimmer registry not available yet (run the students migration):', e?.message || e); setStudents([]); }
  }

  async function loadGroups(){
    try{
      const rows = await selectRows('family_groups', '*', '&order=name.asc');
      setFamilyGroups((rows || []).map(r => ({ id:r.id, name:r.name || '', packageId:r.package_id || null, groupType: r.group_type || 'discount' })));
    } catch(e){ console.warn('Family groups not available yet (run the family groups migration):', e?.message || e); setFamilyGroups([]); }
  }

  // Many-to-many membership loader. A swimmer can belong to multiple
  // family groups (one per unique lesson_type+package). See migration
  // `supabase_family_group_members_migration.sql`. On a fresh DB before
  // that migration runs, the query 404s and we fall back to deriving
  // memberships from the legacy students.family_group_id column.
  async function loadGroupMemberships(){
    try{
      const rows = await selectRows('family_group_members', '*');
      setGroupMemberships((rows || []).map(r => ({ familyGroupId: r.family_group_id, studentId: r.student_id })));
    } catch(e){
      console.warn('family_group_members table not yet available (run the migration). Falling back to legacy single-FK derivation:', e?.message || e);
      // Fallback: derive from students.family_group_id (read in loadStudents)
      setGroupMemberships(null);  // null sentinel — useMemo uses students as source instead
    }
  }

  async function loadCreditBalances(){
    try{
      const rows = await selectRows('student_credit_balances', '*');
      setCreditBalances(rows || []);
    } catch(e){ console.warn('Credit balances not available (run the replacement+credits migration):', e?.message || e); setCreditBalances([]); }
  }

  // ── Credit Purchases ────────────────────────────────────────────────
  // Every credit-issuing event (sign-up, top-up, gift, manual adjustment)
  // recorded as its own row. The running balance in
  // student_credit_balances is the denormalised cache. Use:
  //   - addCreditPurchase to record a purchase AND bump the balance
  //   - reverseCreditPurchase (delete) to remove a purchase AND
  //     decrement the balance accordingly
  async function loadCreditPurchases(){
    try{
      const rows = await selectRows('credit_purchases', '*', '&order=purchase_date.desc,created_at.desc');
      setCreditPurchases(rows || []);
    } catch(e){ console.warn('Credit purchases not available (run the ghost+credits migration):', e?.message || e); setCreditPurchases([]); }
  }
  async function addCreditPurchase({ studentId, lessonTypeId, purchaseDate, creditsAdded, source, notes }){
    try{
      setError('');
      const add = Number(creditsAdded);
      if(!studentId || !lessonTypeId || !add) return;
      await insertRows('credit_purchases', [{
        student_id: studentId, lesson_type_id: lessonTypeId,
        purchase_date: purchaseDate || toDateStr(new Date()),
        credits_added: add,
        source: source || 'manual',
        notes: notes || null
      }]);
      // Bump the running balance row. If none exists yet, create it
      // with this purchase as the seed.
      const key = creditKey(studentId, lessonTypeId);
      const bal = creditByKey[key];
      if(bal){
        const newRemaining = Math.max(0, (Number(bal.remaining_balance) || 0) + add);
        const newInitial = Math.max(0, (Number(bal.initial_balance) || 0) + Math.max(0, add));
        await patchRows('student_credit_balances', { student_id: studentId, lesson_type_id: lessonTypeId }, {
          remaining_balance: newRemaining,
          initial_balance: newInitial,
          updated_at: new Date().toISOString()
        });
      } else {
        // First purchase for this (student, LT) — seed the balance row.
        await insertRows('student_credit_balances', [{
          student_id: studentId, lesson_type_id: lessonTypeId,
          initial_balance: Math.max(0, add), remaining_balance: Math.max(0, add)
        }]);
      }
      await Promise.all([loadCreditBalances(), loadCreditPurchases()]);
      setStatus(`Recorded ${add > 0 ? '+' : ''}${add} credit${Math.abs(add)===1?'':'s'} for swimmer.`);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to add credit purchase'); }
  }
  async function deleteCreditPurchase(purchase){
    if(!purchase || !purchase.id) return;
    if(!confirm(`Delete this credit record: ${purchase.credits_added > 0 ? '+' : ''}${purchase.credits_added} on ${purchase.purchase_date}?\n\nThe running balance will be adjusted accordingly.`)) return;
    try{
      await deleteRows('credit_purchases', { id: purchase.id });
      // Reverse the running balance.
      const key = creditKey(purchase.student_id, purchase.lesson_type_id);
      const bal = creditByKey[key];
      if(bal){
        const next = Math.max(0, (Number(bal.remaining_balance) || 0) - Number(purchase.credits_added));
        const init = Math.max(0, (Number(bal.initial_balance) || 0) - Math.max(0, Number(purchase.credits_added)));
        await patchRows('student_credit_balances', { student_id: purchase.student_id, lesson_type_id: purchase.lesson_type_id }, {
          remaining_balance: next,
          initial_balance: init,
          updated_at: new Date().toISOString()
        });
      }
      await Promise.all([loadCreditBalances(), loadCreditPurchases()]);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to delete credit record'); }
  }

  // ── Subscriptions ────────────────────────────────────────────────────
  // A subscription is one purchase event. For an individual swimmer it
  // credits N credits to one balance. For a family group it credits N to
  // each eligible member's balance (creating one credit_purchases row per
  // member, all sharing the same subscription_id). Cancelling reverses by
  // inserting negative-credit purchases — the ledger keeps the full audit
  // trail and the running balance corrects itself.
  async function loadSubscriptions(){
    try{
      const rows = await selectRows('subscriptions', '*', '&order=subscription_date.desc,created_at.desc');
      setSubscriptions(rows || []);
    } catch(e){ console.warn('Subscriptions not available (run subscriptions migration):', e?.message || e); setSubscriptions([]); }
  }

  // ============================================================================
  // Referral & Discount Codes — one unified codes table handles both kinds.
  // Industry standard (Stripe Coupons / Shopify Discounts): a single record
  // can be either an owner-attached referral or a business-issued promo,
  // with shared validity/usage/scope semantics so the future invoice module
  // applies them through one lookup.
  // ============================================================================
  async function loadCodes(){
    try{
      const rows = await selectRows('scheduler_codes', '*', '&order=created_at.desc');
      setCodes(rows || []);
    } catch(e){ console.warn('Codes table not available (run codes migration):', e?.message || e); setCodes([]); }
  }
  async function addCode(input){
    // Normalises the form payload into the storage-shape, then inserts.
    // Returns the inserted row so the caller can immediately render it.
    try{
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
      if(!row.code) throw new Error('Code string is required');
      const ins = await insertRows('scheduler_codes', row);
      await loadCodes();
      return ins?.[0] || null;
    } catch(e){ setError(`addCode: ${e?.message || e}`); throw e; }
  }
  async function updateCode(id, patch){
    try{
      setError('');
      const body = {};
      if('code' in patch) body.code = (patch.code || '').trim().toUpperCase();
      if('codeType' in patch) body.code_type = patch.codeType;
      if('ownerStudentId' in patch) body.owner_student_id = patch.ownerStudentId || null;
      if('discountType' in patch) body.discount_type = patch.discountType || null;
      if('discountValue' in patch) body.discount_value = patch.discountValue != null && patch.discountValue !== '' ? Number(patch.discountValue) : null;
      if('referrerRewardType' in patch) body.referrer_reward_type = patch.referrerRewardType || null;
      if('referrerRewardValue' in patch) body.referrer_reward_value = patch.referrerRewardValue != null && patch.referrerRewardValue !== '' ? Number(patch.referrerRewardValue) : null;
      if('validFrom' in patch) body.valid_from = patch.validFrom || null;
      if('validUntil' in patch) body.valid_until = patch.validUntil || null;
      if('maxUses' in patch) body.max_uses = patch.maxUses != null && patch.maxUses !== '' ? Number(patch.maxUses) : null;
      if('maxUsesPerCustomer' in patch) body.max_uses_per_customer = patch.maxUsesPerCustomer != null && patch.maxUsesPerCustomer !== '' ? Number(patch.maxUsesPerCustomer) : 1;
      if('appliesTo' in patch) body.applies_to = patch.appliesTo;
      if('applicablePackageIds' in patch) body.applicable_package_ids = patch.applicablePackageIds || null;
      if('minimumAmount' in patch) body.minimum_amount = patch.minimumAmount != null && patch.minimumAmount !== '' ? Number(patch.minimumAmount) : null;
      if('isActive' in patch) body.is_active = !!patch.isActive;
      if('notes' in patch) body.notes = patch.notes || null;
      await patchRows('scheduler_codes', `id=eq.${id}`, body);
      await loadCodes();
    } catch(e){ setError(`updateCode: ${e?.message || e}`); throw e; }
  }
  async function deleteCode(id){
    try{
      setError('');
      await deleteRows('scheduler_codes', `id=eq.${id}`);
      await loadCodes();
    } catch(e){ setError(`deleteCode: ${e?.message || e}`); throw e; }
  }

  // bumpBalance: idempotent helper that either creates or updates the
  // student_credit_balances cache after a purchase is inserted.
  // adjustBalanceTo: hard-set the remaining balance for (student, lt) to a
  // target number by inserting a single credit_purchase row whose
  // credits_added equals the required delta. Audit-friendly (source
  // 'manual', notes default to "Manual adjustment to N"), reverses the
  // problem where a legacy direct-seeded balance can't be cancelled
  // because it has no purchase or subscription record to undo.
  async function adjustBalanceTo(studentId, lessonTypeId, targetBalance, notes){
    try{
      setError('');
      const key = creditKey(studentId, lessonTypeId);
      const bal = creditByKey[key];
      const current = bal ? Number(bal.remaining_balance) || 0 : 0;
      const target = Math.max(0, Number(targetBalance) || 0);
      const delta = target - current;
      if(delta === 0){ alert(`Balance is already ${target}.`); return; }
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
    } catch(err){ handleErr(err); alert(err.message || 'Failed to adjust balance'); }
  }

  async function bumpBalance(studentId, lessonTypeId, delta){
    const key = creditKey(studentId, lessonTypeId);
    const bal = creditByKey[key];
    const d = Number(delta);
    if(bal){
      const newRemaining = Math.max(0, (Number(bal.remaining_balance) || 0) + d);
      const newInitial = Math.max(0, (Number(bal.initial_balance) || 0) + Math.max(0, d));
      await patchRows('student_credit_balances', { student_id: studentId, lesson_type_id: lessonTypeId }, {
        remaining_balance: newRemaining, initial_balance: newInitial, updated_at: new Date().toISOString()
      });
    } else if(d > 0){
      await insertRows('student_credit_balances', [{ student_id: studentId, lesson_type_id: lessonTypeId, initial_balance: d, remaining_balance: d }]);
    }
  }

  // addSubscription({ subjectType, subjectId, lessonTypeId, creditsPerSwimmer, ... })
  // For 'student': credits one swimmer. For 'family_group': credits every
  // member enrolled in the given lesson type. Returns the subscription row.
  async function addSubscription({ subjectType, subjectId, lessonTypeId, creditsPerSwimmer, source, notes, amountPaid, receiptNumber, subscriptionDate, packageId, quantity = 1 }){
    try{
      setError('');
      const credits = Number(creditsPerSwimmer);
      const qty = Math.max(1, Number(quantity) || 1);
      if(!subjectId || !lessonTypeId || !credits) { alert('Subscription requires a subject, lesson type, and credits.'); return null; }
      // Resolve affected swimmers based on subject type.
      let affectedStudents = [];
      if(subjectType === 'student'){
        const stu = studentById[subjectId];
        if(!stu) { alert('Swimmer not found.'); return null; }
        affectedStudents = [stu];
      } else if(subjectType === 'family_group'){
        const members = (membersByGroup && membersByGroup[subjectId]) || [];
        affectedStudents = members.filter(m => (m.lessonTypeIds || []).includes(lessonTypeId));
        if(!affectedStudents.length){ alert('No members of this group are enrolled in the selected lesson type.'); return null; }
      } else { alert('Unknown subscription subject type.'); return null; }
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
      if(!sub){ alert('Failed to create subscription.'); return null; }
      // Insert credit_purchases for each affected swimmer.
      const purchasePayload = affectedStudents.map(s => ({
        student_id: s.id, lesson_type_id: lessonTypeId,
        purchase_date: date, credits_added: totalCreditsPerSwimmer,
        source: source || 'subscription',
        notes: notes || null,
        subscription_id: sub.id
      }));
      await insertRows('credit_purchases', purchasePayload);
      // Bump each balance.
      for(const s of affectedStudents){
        await bumpBalance(s.id, lessonTypeId, totalCreditsPerSwimmer);
      }
      await Promise.all([loadCreditBalances(), loadCreditPurchases(), loadSubscriptions()]);
      setStatus(`Added subscription: +${totalCreditsPerSwimmer} credits to ${affectedStudents.length} swimmer${affectedStudents.length===1?'':'s'}.`);
      return sub;
    } catch(err){ handleErr(err); alert(err.message || 'Failed to add subscription'); return null; }
  }

  // cancelSubscription(subscription): inserts negative-credit purchases
  // matching each original purchase (linked by subscription_id), then
  // marks the subscription as cancelled_at = now.
  async function cancelSubscription(subscription, reason){
    if(!subscription || !subscription.id) return;
    if(subscription.cancelled_at){ alert('This subscription is already cancelled.'); return; }
    if(!confirm(`Cancel subscription from ${subscription.subscription_date}?\n\nThis reverses the ${subscription.credits_per_swimmer} credits per swimmer for ${subscription.swimmer_count} swimmer${subscription.swimmer_count===1?'':'s'}. The original purchase records stay in the ledger; offsetting negative entries will be added.`)) return;
    try{
      // Fetch the original purchase rows for this subscription so we can
      // reverse each one (handles the case where some swimmers' purchases
      // were since edited or the row count differs from swimmer_count).
      const originals = (creditPurchases || []).filter(p => p.subscription_id === subscription.id && Number(p.credits_added) > 0);
      if(!originals.length){ alert('No original purchase records found for this subscription.'); return; }
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
      for(const r of reversals){
        await bumpBalance(r.student_id, r.lesson_type_id, r.credits_added);
      }
      // Mark subscription cancelled.
      await patchRows('subscriptions', { id: subscription.id }, {
        cancelled_at: new Date().toISOString(),
        cancelled_reason: reason || null
      });
      await Promise.all([loadCreditBalances(), loadCreditPurchases(), loadSubscriptions()]);
      setStatus(`Cancelled subscription — ${reversals.length} reversal${reversals.length===1?'':'s'} recorded.`);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to cancel subscription'); }
  }

  // Pending-replacement state — swimmers who were removed from their booked
  // class for the week and are awaiting placement into another same-LT class.
  async function loadReplacementPending(){
    try{
      const rows = await selectRows('replacement_pending', '*');
      setReplacementPending(rows || []);
    } catch(e){ console.warn('Replacement pending not available (run the replacement pending migration):', e?.message || e); setReplacementPending([]); }
  }

  // Key by student+LT+week so the modal can quickly check if a candidate has
  // a pending state for the active week. Resolved entries are deleted, not
  // flagged, so anything in this map is currently awaiting placement.
  const pendingByKey = useMemo(() => {
    const m = {};
    replacementPending.forEach(p => { m[`${p.student_id}:${p.lesson_type_id}:${p.week_start_date}`] = p; });
    return m;
  }, [replacementPending]);

  // ── markForReplacement: remove a swimmer from their booked class for the
  // week and queue them as a replacement candidate. The row in
  // weekly_session_students is deleted and a replacement_pending entry is
  // created (so they appear with an "R-pending" flag in same-LT dropdowns).
  async function markForReplacement({ studentId, sessionId, weekStartDate, lessonTypeId, lessonTypeName, day, startMinute }){
    if(!studentId || !sessionId || !lessonTypeId){ alert('Cannot mark for replacement: missing session information.'); return false; }
    const label = `${DAYS_S[day]} ${minuteToTime(startMinute)}`;
    if(!confirm(`Move this swimmer out of ${lessonTypeName} ${label} for replacement?\n\nThey will become a replacement candidate in any other ${lessonTypeName} class this week. The original slot will be released.`)) return false;
    try{
      await deleteRows('weekly_session_students', { session_id: sessionId, student_id: studentId });
      // Upsert pending entry — re-marking the same swimmer simply refreshes it.
      await rest('replacement_pending?on_conflict=student_id,week_start_date,lesson_type_id', { method:'POST', headers:{ Prefer:'return=representation,resolution=merge-duplicates' }, body: JSON.stringify([{ student_id: studentId, week_start_date: weekStartDate, lesson_type_id: lessonTypeId, original_session_label: label, original_session_id: sessionId }]) });
      await Promise.all([loadSessions(), loadReplacementPending()]);
      return true;
    } catch(err){ handleErr(err); alert(err.message || 'Failed to mark for replacement'); return false; }
  }

  async function clearPendingReplacement({ studentId, weekStartDate, lessonTypeId }){
    try{
      await deleteRows('replacement_pending', { student_id: studentId, week_start_date: weekStartDate, lesson_type_id: lessonTypeId });
      await loadReplacementPending();
    } catch(_){}
  }

  async function cancelPendingReplacement(pending, opts = { restore: true }){
    if(!pending || !pending.id) return false;
    const student = studentById[pending.student_id];
    const swimmerName = student?.name || 'this swimmer';
    const originalSession = sessions.find(s => s.id === pending.original_session_id);
    const willRestore = !!opts.restore && pending.original_session_id && !!originalSession;
    // If the spot has been filled while the swimmer was in limbo and the
    // class is now at/over cap, ask before pushing them back in.
    if(willRestore){
      const lt = lessonTypeById(pending.lesson_type_id);
      const cap = sessionCapacity(originalSession, lt);
      if(cap.max > 0 && cap.current >= cap.max){
        if(!confirm(`${pending.original_session_label} is now full (${cap.current}/${cap.max}). Add ${swimmerName} back anyway? The class will be over capacity.`)) return false;
      }
    }
    const msg = willRestore
      ? `Cancel pending replacement for ${swimmerName} and put them back in ${pending.original_session_label}?`
      : `Remove ${swimmerName} from the pending-replacement bucket?\n\n(Their original class no longer exists, so they won't be auto-restored. You can re-add them manually if needed.)`;
    if(!confirm(msg)) return false;
    try{
      if(willRestore){
        await insertRows('weekly_session_students', [{
          session_id: pending.original_session_id,
          student_id: pending.student_id,
          student_name: student?.name || swimmerName,
          student_age: student?.age != null ? Number(student.age) : null,
          is_replacement: false,
          attendance_status: 'pending'
        }]);
      }
      await deleteRows('replacement_pending', { id: pending.id });
      await Promise.all([loadSessions(), loadReplacementPending()]);
      setStatus(willRestore ? `Restored ${swimmerName} to ${pending.original_session_label}.` : `Cancelled pending replacement for ${swimmerName}.`);
      return true;
    } catch(err){ handleErr(err); alert(err.message || 'Failed to cancel pending replacement'); return false; }
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
  async function forwardClassToNextWeek(sessionId, sourceLabel){
    if(!sessionId) return;
    const src = sessions.find(s => s.id === sessionId);
    if(!src){ alert('Source session not found.'); return; }
    if(src.cancelledAt){ alert('This session is already cancelled.'); return; }

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
    const existingNextWeek = sessions.find(s =>
      s.weekStartDate === nextWeekStart &&
      s.day === src.day &&
      s.startMinute === src.startMinute &&
      s.lessonTypeId === src.lessonTypeId &&
      (s.poolId || null) === (src.poolId || null) &&
      !s.cancelledAt
    );
    const enrolledRegular = (src.students || []).filter(s => !s.isReplacement);
    const swimmerCount = enrolledRegular.length;
    const confirmMsg = existingNextWeek
      ? `Forward ${sourceLabel} to next week (${nextWeekStart})?\n\nNext week already has the same class at the same slot — this week's run is cancelled and the ${swimmerCount} swimmer${swimmerCount===1?'':'s'} will attend that existing session.\n\nThe original spot stays visible as a greyed-out shell; click it to restore. Credits already consumed this week will be refunded.`
      : `Forward ${sourceLabel} to next week (${nextWeekStart})?\n\nThis week's session is cancelled and recreated next week (same day, same time) with the same ${swimmerCount} swimmer${swimmerCount===1?'':'s'}.\n\nThe original spot stays visible as a greyed-out shell; click it to restore. Credits already consumed this week will be refunded.`;
    if(!confirm(confirmMsg)) return;

    try{
      // Refund credits for any swimmer whose attendance was already marked
      // attended/absent on this session — those credits were deducted on
      // the prior save but shouldn't have been, since the class is now
      // being forwarded (i.e., it didn't actually happen this week).
      if(src.lessonTypeId){
        for(const s of (src.students || [])){
          if(!s.studentId) continue;
          const att = s.attendance || 'pending';
          if(att === 'attended' || att === 'absent'){
            await adjustCredit(s.studentId, src.lessonTypeId, 1);
          }
        }
      }

      let targetId = existingNextWeek ? existingNextWeek.id : null;
      if(!existingNextWeek){
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
        if(targetId){
          if(enrolledRegular.length){
            await insertRows('weekly_session_students', enrolledRegular.map(s => ({
              session_id: targetId,
              student_id: s.studentId || null,
              student_name: s.name || '',
              student_age: s.age != null ? Number(s.age) : null,
              remark: s.remark || null,
              is_replacement: false,
              attendance_status: 'pending'   // fresh week, fresh attendance
            })));
          }
          if(src.instructors && src.instructors.length){
            try{
              await insertRows('session_instructors', src.instructors.map(i => ({
                session_id: targetId,
                instructor_id: i.id
              })));
            } catch(_){} // session_instructors table may not exist on older DBs — instructor name is also on the session row as a fallback
          }
        }
      }

      // Mark this week's session as cancelled-forwarded, pointing at the
      // target. Don't delete — the original stays as a ghost.
      await patchRows('weekly_sessions', { id: sessionId }, {
        cancelled_at: new Date().toISOString(),
        cancelled_reason: 'forwarded',
        cancelled_target_session_id: targetId || null
      });

      await loadSessions();
      setModal(null);
      setStatus(existingNextWeek
        ? `Forwarded ${sourceLabel} → ${nextWeekStart} (merged into existing next-week session). Original is greyed out — click to restore.`
        : `Forwarded ${sourceLabel} → ${nextWeekStart} (cloned ${swimmerCount} swimmer${swimmerCount===1?'':'s'} forward). Original is greyed out — click to restore.`);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to forward class'); }
  }

  // restoreCancelledSession — unwind a forward/reschedule. Deletes the
  // target session (which holds students + instructors that were cloned
  // over) and clears the cancellation marker on the original so it
  // becomes live again at its original spot. We don't reverse any credit
  // refunds the cancellation issued — those were correct for the period
  // the class was missing; if attendance is re-marked the credits will
  // re-deduct on save normally.
  async function restoreCancelledSession(sessionId){
    const ghost = sessions.find(s => s.id === sessionId);
    if(!ghost){ alert('Session not found.'); return; }
    if(!ghost.cancelledAt){ alert('This session is not cancelled.'); return; }

    const label = `${ghost.type} on ${DAYS_F[ghost.day]} ${minuteToTime(ghost.startMinute)}`;
    const reasonLabel = ghost.cancelledReason === 'forwarded' ? 'forward to next week'
                      : ghost.cancelledReason === 'rescheduled' ? 'reschedule'
                      : 'cancellation';
    if(!confirm(`Restore ${label} to its original spot?\n\nThis undoes the ${reasonLabel}: the replacement session will be deleted and this slot becomes live again with its swimmers.`)) return;
    try{
      // Delete the target (replacement) session if we have one and it
      // still exists. The on-delete-set-null FK means we don't strictly
      // need to clear cancelled_target_session_id first, but we do it
      // anyway in the PATCH below.
      if(ghost.cancelledTargetSessionId){
        const target = sessions.find(s => s.id === ghost.cancelledTargetSessionId);
        if(target){
          await deleteRows('weekly_session_students', { session_id: target.id });
          try{ await deleteRows('session_instructors', { session_id: target.id }); } catch(_){}
          await deleteRows('weekly_sessions', { id: target.id });
        }
      }
      // Clear the cancellation marker on the original.
      await patchRows('weekly_sessions', { id: sessionId }, {
        cancelled_at: null,
        cancelled_reason: null,
        cancelled_target_session_id: null
      });
      await loadSessions();
      setStatus(`Restored ${label} to its original slot.`);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to restore session'); }
  }
  function startFullClassMove({ sessionId, sourceLabel, lessonTypeName, weekStartDate, originalDay, originalStartMinute, swimmerCount }){
    if(!sessionId) return;
    setPendingMove({ sessionId, sourceLabel, lessonTypeName, weekStartDate, originalDay, originalStartMinute, swimmerCount });
    setModal(null);
    setStatus(`Click an empty slot in the weekly grid to drop ${lessonTypeName} (${sourceLabel}).`);
  }
  function cancelPendingMove(){ setPendingMove(null); setStatus(''); }
  async function placePendingMove(targetDay, targetStartMinute){
    if(!pendingMove) return;
    const src = sessions.find(s => s.id === pendingMove.sessionId);
    if(!src){ alert('Source session not found.'); setPendingMove(null); return; }
    if(src.cancelledAt){ alert('This session is already cancelled.'); setPendingMove(null); return; }
    const targetLabel = `${DAYS_F[targetDay]} ${minuteToTime(targetStartMinute)}`;
    if(!confirm(`Move ${pendingMove.lessonTypeName} (${pendingMove.swimmerCount} swimmer${pendingMove.swimmerCount===1?'':'s'}) from ${pendingMove.sourceLabel} to ${targetLabel}?\n\nThe original spot stays visible as a greyed-out shell — click it to restore.`)) return;
    try{
      // Refund any credits already consumed on the original — same logic
      // as Forward: the class is being moved so attendance to date is
      // wiped on the clone (it starts at "pending").
      if(src.lessonTypeId){
        for(const s of (src.students || [])){
          if(!s.studentId) continue;
          const att = s.attendance || 'pending';
          if(att === 'attended' || att === 'absent'){
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
      if(targetId){
        if(enrolledRegular.length){
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
        if(src.instructors && src.instructors.length){
          try{
            await insertRows('session_instructors', src.instructors.map(i => ({
              session_id: targetId,
              instructor_id: i.id
            })));
          } catch(_){}
        }
      }

      // Mark original as cancelled-rescheduled, pointing at the clone.
      await patchRows('weekly_sessions', { id: pendingMove.sessionId }, {
        cancelled_at: new Date().toISOString(),
        cancelled_reason: 'rescheduled',
        cancelled_target_session_id: targetId || null
      });

      await loadSessions();
      setPendingMove(null);
      setStatus(`Moved ${pendingMove.lessonTypeName} to ${targetLabel}. Original spot greyed out — click to restore.`);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to move class'); }
  }

  async function loadTcAcceptances(){
    try{
      const rows = await selectRows('tc_acceptances', '*');
      setTcAcceptances(rows || []);
    } catch(e){ console.warn('T&C acceptances not available (run the student profile migration):', e?.message || e); setTcAcceptances([]); }
  }

  async function saveTcAcceptance({ studentId, guardianName, guardianEmail, lessonTypeName }){
    try{
      const acceptanceId = `TC-${Date.now().toString(36).toUpperCase().slice(-7)}`;
      const now = new Date().toISOString();
      // Upsert — one record per swimmer, updates on re-acceptance.
      await rest('tc_acceptances?on_conflict=student_id', { method:'POST', headers:{ Prefer:'return=representation,resolution=merge-duplicates' }, body: JSON.stringify([{ student_id:studentId, acceptance_id:acceptanceId, accepted_at:now, guardian_name:guardianName, guardian_email:guardianEmail, lesson_type_name:lessonTypeName }]) });
      // Mirror acceptance info onto the student row for quick list display.
      await patchRows('students', { id: studentId }, { tc_accepted_at: now, tc_acceptance_id: acceptanceId });
      await Promise.all([loadTcAcceptances(), loadStudents()]);
      return acceptanceId;
    } catch(err){ handleErr(err); throw err; }
  }

  // creditBalanceKey — quickly look up a balance by student + lesson type.
  function creditKey(studentId, lessonTypeId){ return `${studentId}:${lessonTypeId}`; }
  const creditByKey = useMemo(() => {
    const m = {};
    creditBalances.forEach(b => { m[creditKey(b.student_id, b.lesson_type_id)] = b; });
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

  async function loadRemarks(cursor){
    const start = new Date(cursor.getFullYear(), cursor.getMonth()-1, 1);
    const end = new Date(cursor.getFullYear(), cursor.getMonth()+2, 0);
    const rows = await selectRows('calendar_remarks', '*', `&calendar_date=gte.${toDateStr(start)}&calendar_date=lte.${toDateStr(end)}&order=calendar_date.asc`);
    const map = {};
    (rows || []).forEach(r => { map[r.calendar_date] = r.remark || ''; });
    setRemarks(map);
  }

  function activeInstructors(){ return options.instructors.filter(x => x.is_active !== false); }
  function activeDurations(){ return options.durations.filter(x => x.is_active !== false); }
  function activeLessonTypes(){ return options.lessonTypes.filter(x => x.is_active !== false); }
  function activePools(){ return options.pools.filter(x => x.is_active !== false); }
  function activePackages(){ return options.packages.filter(x => x.is_active !== false); }
  function packageById(id){ return options.packages.find(p => p.id === id) || null; }

  function lessonTypeByName(name){ return options.lessonTypes.find(t => t.name === name) || null; }
  function lessonTypeById(id){ return options.lessonTypes.find(t => t.id === id) || null; }
  function poolById(id){ return options.pools.find(p => p.id === id) || null; }
  function instructorByName(name){ return options.instructors.find(i => i.name === name) || null; }

  function colorsFor(type){
    const x = lessonTypeByName(type);
    return x ? { bg:x.bg_color, bd:x.border_color, tx:x.text_color } : (DEFAULT_TYPES[type] || { bg:'#E2E8F0', bd:'#64748B', tx:'#0F172A' });
  }

  const gridBounds = useMemo(() => computeGridBounds(options.operatingHours), [options.operatingHours]);
  const gridSlots = Math.max(1, Math.round((gridBounds.endMin - gridBounds.startMin) / SLOT_MIN));
  function slotToMinute(slot){ return gridBounds.startMin + slot * SLOT_MIN; }
  function minuteToSlot(min){ return Math.round((min - gridBounds.startMin) / SLOT_MIN); }

  const selectedWeekStart = weekStartStr(selectedDate);
  const currentWeekStart = weekStartStr(todayStr());
  const isFutureSelectedWeek = selectedWeekStart > currentWeekStart;

  function sessionsForDate(dateStr){
    const day = dateToWeekdayIndex(dateStr);
    const ws = weekStartStr(dateStr);
    return sessions.filter(s => s.weekStartDate === ws && s.day === day).sort((a,b) => a.startMinute - b.startMinute);
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
  function passesFilters(s){
    if(enabledTypes !== null && !enabledTypes.has(s.type)) return false;
    if(selectedInstructors.size > 0){
      const ids = (s.instructors || []).map(i => i.id);
      if(!ids.some(id => selectedInstructors.has(id))) return false;
    }
    return true;
  }
  function filteredSessionsForDate(dateStr){ return sessionsForDate(dateStr).filter(passesFilters); }

  const weekBlocks = useMemo(() => {
    const fallbackPoolId = activePools()[0]?.id || null;
    return Array.from({length:7}, (_, day) => {
      let items = weekSessions.filter(s => s.day === day);
      if(selectedPoolId) items = items.filter(s => (s.poolId || fallbackPoolId) === selectedPoolId);
      items = items.filter(passesFilters);
      const packed = packParallelColumns(items);
      const peak = packed.length ? packed[0]._total : 1;
      return { packed, peak: Math.max(1, peak) };
    });
  }, [weekSessions, selectedPoolId, enabledTypes, selectedInstructors, options.pools]);

  // ── Lesson-type legend filters ──
  const allTypesShown = useMemo(() => {
    if(enabledTypes === null) return true;
    const names = activeLessonTypes().map(t => t.name);
    return names.length > 0 && names.every(n => enabledTypes.has(n));
  }, [enabledTypes, options.lessonTypes]);
  function isTypeEnabled(name){ return enabledTypes === null ? true : enabledTypes.has(name); }
  function toggleType(name){
    setEnabledTypes(prev => {
      const base = prev === null ? new Set(activeLessonTypes().map(t => t.name)) : new Set(prev);
      if(base.has(name)) base.delete(name); else base.add(name);
      return base;
    });
  }
  function toggleAllTypes(){ setEnabledTypes(allTypesShown ? new Set() : null); }

  // ── Instructor legend filters with cascade ──
  function isInstructorActive(id){ return selectedInstructors.has(id); }
  function toggleInstructor(id){
    const next = new Set(selectedInstructors);
    if(next.has(id)) next.delete(id); else next.add(id);
    setSelectedInstructors(next);
    // Cascade: instructor selection rewrites the visible types to the union
    // of what the selected instructors teach this week. Deselecting the last
    // instructor restores the all-types-on state.
    if(next.size === 0){
      setEnabledTypes(null);
    } else {
      const taught = new Set();
      sessions.forEach(s => {
        if((s.instructors || []).some(i => next.has(i.id))) taught.add(s.type);
      });
      setEnabledTypes(taught);
    }
  }
  function clearInstructors(){ setSelectedInstructors(new Set()); setEnabledTypes(null); }

  // All-pools packing, ignoring the filter — used for the printed weekly table
  // so a printout is always the complete record.
  const weekBlocksAllPools = useMemo(() => {
    return Array.from({length:7}, (_, day) => packParallelColumns(weekSessions.filter(s => s.day === day)));
  }, [weekSessions]);

  const summary = useMemo(() => {
    const byType = {}, byInst = {}, byPool = {};
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
      if(s.cancelledAt) return;
      totalSessions += 1;
      const excluded = excludeFromStudentTotals(s.type);
      const count = excluded ? 0 : s.students.length;
      byType[s.type] = (byType[s.type] || 0) + count;
      const pool = poolById(s.poolId);
      if(pool) byPool[pool.name] = (byPool[pool.name] || 0) + count;
      s.instructors.forEach(inst => { byInst[inst.name] = (byInst[inst.name] || 0) + count; });
      totalStudents += count;
    });
    return { byType, byInst, byPool, totalStudents, totalSessions };
  }, [weekSessions, options]);

  function defaultFormForStart(startMinute, poolId){
    const firstType = activeLessonTypes()[0];
    const firstInst = activeInstructors()[0];
    const firstPool = poolId || (firstType && firstType.default_pool_id) || (activePools()[0] && activePools()[0].id) || null;
    const dur = (firstType && firstType.default_duration_minutes) || 50;
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

  function openAdd(day, slot, poolId){
    const startMinute = slotToMinute(slot);
    setModal({ mode:'add', id:null, weekStartDate: selectedWeekStart, day, startMinute, form: defaultFormForStart(startMinute, poolId) });
  }

  function openAddAtTime(day, startMinute, poolId){
    setModal({ mode:'add', id:null, weekStartDate: selectedWeekStart, day, startMinute, form: defaultFormForStart(startMinute, poolId) });
  }

  function openEdit(item){
    // Ghost session — clicking the greyed-out shell prompts to restore
    // it to its original slot, undoing the forward/reschedule. We hand
    // off to restoreCancelledSession rather than opening the editor;
    // the underlying row is locked while cancelled (no edits allowed).
    if(item && item.cancelledAt){
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
      if(s.studentId) originalAttendance[s.studentId] = s.attendance || 'pending';
    });
    setModal({
      mode:'edit', id:item.id, weekStartDate:item.weekStartDate, day:item.day, startMinute:item.startMinute,
      rescheduledFromDay: item.rescheduledFromDay ?? null,
      rescheduledFromStartMinute: item.rescheduledFromStartMinute ?? null,
      originalAttendance,
      form:{
        type:item.type,
        lessonTypeId:item.lessonTypeId,
        instructorId: firstInst ? firstInst.id : (instructorByName(item.legacyInstructor)?.id || null),
        instructorName: firstInst ? firstInst.name : (item.legacyInstructor || ''),
        poolId: item.poolId,
        familyGroupId: item.familyGroupId || null,
        durationMinutes:item.durationMinutes,
        studentRows: buildStudentRows(regularStudents, lessonTypeByName(item.type)?.students_per_instructor),
        replacementRows: replacementStudents.map(s => ({ studentId:s.studentId, name:s.name, age:s.age, replacementFrom:s.replacementFrom || '', attendance: s.attendance || 'pending' }))
      }
    });
  }

  // M4: open an existing session from the Enroll matcher, pre-dropping the
  // chosen swimmer into the first empty slot so the user just confirms + saves.
  function openEnroll(item, swimmers){
    // swimmers may be: a single student object (legacy callers) or an array.
    const list = Array.isArray(swimmers) ? swimmers : (swimmers ? [swimmers] : []);
    const firstInst = item.instructors[0] || null;
    const rows = buildStudentRows(item.students, lessonTypeByName(item.type)?.students_per_instructor);
    list.forEach(student => {
      if(!student) return;
      if(rows.some(r => r.studentId === student.id)) return;
      const slot = { studentId: student.id, name: student.name, age: (student.age == null ? '' : String(student.age)) };
      const idx = rows.findIndex(r => !r.studentId && !(r.name || '').trim());
      if(idx >= 0) rows[idx] = slot; else rows.push(slot);
    });
    setModal({
      mode:'edit', id:item.id, weekStartDate:item.weekStartDate, day:item.day, startMinute:item.startMinute,
      form:{
        type:item.type, lessonTypeId:item.lessonTypeId,
        instructorId: firstInst ? firstInst.id : (instructorByName(item.legacyInstructor)?.id || null),
        instructorName: firstInst ? firstInst.name : (item.legacyInstructor || ''),
        poolId: item.poolId, durationMinutes:item.durationMinutes, studentRows: rows,
        replacementRows: []
      }
    });
  }

  // M4: open a fresh session prefilled with the matcher's type/day/time and the
  // swimmer already in slot 1. weekStartDate is explicit so it lands in the week
  // the matcher was searching, regardless of the app's current selected week.
  function openCreateFor(weekStart, day, startMinute, lessonType, swimmers){
    const list = Array.isArray(swimmers) ? swimmers.filter(Boolean) : (swimmers ? [swimmers] : []);
    const firstInst = activeInstructors()[0] || null;
    const existing = list.map(s => ({ studentId:s.id, name:s.name, age:s.age }));
    setSelectedDate(addDays(weekStart, day));
    setModal({
      mode:'add', id:null, weekStartDate: weekStart, day, startMinute,
      form:{
        type: lessonType?.name || activeLessonTypes()[0]?.name || '',
        lessonTypeId: lessonType?.id || null,
        instructorId: firstInst?.id || null,
        instructorName: firstInst?.name || '',
        poolId: (lessonType && lessonType.default_pool_id) || (activePools()[0] && activePools()[0].id) || null,
        durationMinutes: (lessonType && lessonType.default_duration_minutes) || 50,
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
  async function saveSession(){
    if(!modal) return;
    try{
      setSaveBusy(true); setError('');
      const lt = lessonTypeByName(modal.form.type) || lessonTypeById(modal.form.lessonTypeId);
      const inst = options.instructors.find(i => i.id === modal.form.instructorId) || instructorByName(modal.form.instructorName);
      const payload = {
        week_start_date: modal.weekStartDate || selectedWeekStart,
        weekday: modal.day + 1,
        start_minute: modal.startMinute,
        duration_minutes: Number(modal.form.durationMinutes),
        lesson_type: modal.form.type || '',
        lesson_type_id: lt ? lt.id : null,
        pool_id: modal.form.poolId || null,
        family_group_id: null,   // sessions are no longer bound to a group; quick-add is a one-time add action
        instructor: inst ? inst.name : '',
        // Reschedule tracking (personal classes): store original position so
        // duplicate week can restore it. Null = not rescheduled.
        rescheduled_from_day: modal.rescheduledFromDay != null ? modal.rescheduledFromDay + 1 : null,
        rescheduled_from_start_minute: modal.rescheduledFromStartMinute ?? null
      };
      let sessionId = modal.id;
      if(modal.id){
        const updated = await patchRows('weekly_sessions', { id: modal.id }, payload);
        sessionId = updated?.[0]?.id || modal.id;
        await deleteRows('weekly_session_students', { session_id: sessionId });
        await deleteRows('session_instructors', { session_id: sessionId });
      } else {
        const inserted = await insertRows('weekly_sessions', payload);
        sessionId = inserted?.[0]?.id;
      }
      // Regular enrolled students
      const rows = (modal.form.studentRows || []).map(r => ({ studentId:r.studentId || null, name:(r.name || '').trim(), age:r.age, remark:(r.remark || '').trim(), attendance: r.attendance || 'pending' })).filter(r => r.name || r.studentId);
      if(sessionId && rows.length){
        await insertRows('weekly_session_students', rows.map(r => ({ session_id: sessionId, student_id: r.studentId, student_name: r.name, student_age: (r.age === '' || r.age === null || r.age === undefined) ? null : Number(r.age), remark: r.remark || null, is_replacement: false, attendance_status: r.attendance })));
      }
      // Replacement students (group classes) — one-off, tagged separately
      const replRows = (modal.form.replacementRows || []).filter(r => r.name || r.studentId);
      if(sessionId && replRows.length){
        await insertRows('weekly_session_students', replRows.map(r => ({ session_id: sessionId, student_id: r.studentId || null, student_name: (r.name || '').trim(), student_age: r.age != null ? Number(r.age) : null, remark: r.remark || null, is_replacement: true, replacement_from: (r.replacementFrom || '').trim() || null, attendance_status: r.attendance || 'pending' })));
        // Clear pending-replacement entries for swimmers who were placed by this save.
        const wk = modal.weekStartDate || selectedWeekStart;
        for(const r of replRows){
          if(r.studentId && lt?.id && pendingByKey[`${r.studentId}:${lt.id}:${wk}`]){
            try{ await deleteRows('replacement_pending', { student_id: r.studentId, week_start_date: wk, lesson_type_id: lt.id }); } catch(_){}
          }
        }
        await loadReplacementPending();
      }
      if(sessionId && inst){
        await insertRows('session_instructors', [{ session_id: sessionId, instructor_id: inst.id }]);
      }
      // Auto-seed credit balance for any swimmer placed in this session who
      // doesn't already have one. All lesson types are credit-based now —
      // not just personals. Default is 4 credits/month (matches the
      // 4-weeks-1-lesson-per-week cadence); a package with billing_count
      // overrides that default.
      if(lt && lt.id && sessionId){
        const pkg = (options.packages || []).find(p => p.lesson_type_id === lt.id && (p.name || '').toLowerCase() === 'normal' && p.is_active !== false);
        const initCredits = pkg?.billing_count ? Number(pkg.billing_count) : 4;
        for(const r of rows){
          if(!r.studentId) continue;
          const key = creditKey(r.studentId, lt.id);
          if(!creditByKey[key] && initCredits > 0){
            try{ await insertRows('student_credit_balances', [{ student_id: r.studentId, lesson_type_id: lt.id, initial_balance: initCredits, remaining_balance: initCredits }]); }
            catch(_){} // ignore duplicate-key on parallel saves
          }
        }
        await loadCreditBalances();
      }
      // Attendance → credit deltas. Compare each saved student's new
      // attendance to the originalAttendance snapshot. Any pending → marked
      // transition deducts a credit (one lesson consumed); any marked →
      // pending restores one. attended ↔ absent doesn't change credits.
      // adjustCredit is a no-op when the swimmer has no balance row, which
      // is exactly the right behavior for monthly-package swimmers — their
      // attendance is still recorded for reporting, just no credit math.
      if(sessionId && lt?.id){
        const orig = modal.originalAttendance || {};
        const allSavedRows = [...rows, ...replRows.map(r => ({ studentId: r.studentId, attendance: r.attendance || 'pending' }))];
        const isConsuming = (s) => s === 'attended' || s === 'absent';
        for(const r of allSavedRows){
          if(!r.studentId) continue;
          const oldS = orig[r.studentId] || 'pending';
          const newS = r.attendance || 'pending';
          if(oldS === newS) continue;
          if(!isConsuming(oldS) && isConsuming(newS)){
            await adjustCredit(r.studentId, lt.id, -1);
          } else if(isConsuming(oldS) && !isConsuming(newS)){
            await adjustCredit(r.studentId, lt.id, 1);
          }
          // attended ↔ absent: no credit change (both already consumed the lesson)
        }
      }
      await loadSessions();
      setModal(null);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to save session'); }
    finally{ setSaveBusy(false); }
  }

  async function adjustCredit(studentId, lessonTypeId, delta){
    const key = creditKey(studentId, lessonTypeId);
    const bal = creditByKey[key];
    if(!bal) return;
    const next = Math.max(0, (bal.remaining_balance || 0) + delta);
    try{ await patchRows('student_credit_balances', { student_id: studentId, lesson_type_id: lessonTypeId }, { remaining_balance: next, updated_at: new Date().toISOString() }); await loadCreditBalances(); }
    catch(err){ alert(err.message || 'Failed to adjust credit'); }
  }

  async function initCredit(studentId, lessonTypeId, initial){
    const n = Number(initial);
    if(!n || n < 0) return;
    try{
      await rest(`student_credit_balances?select=*`, { method:'POST', headers:{ Prefer:'return=representation,resolution=merge-duplicates' }, body: JSON.stringify([{ student_id:studentId, lesson_type_id:lessonTypeId, initial_balance:n, remaining_balance:n }]) });
      await loadCreditBalances();
    } catch(err){ alert(err.message || 'Failed to set credits'); }
  }

  async function deleteSession(){
    if(!modal?.id) return;
    if(!confirm('Delete this scheduled session for the selected week?')) return;
    try{
      await deleteRows('weekly_session_students', { session_id: modal.id });
      await deleteRows('session_instructors', { session_id: modal.id });
      await deleteRows('weekly_sessions', { id: modal.id });
      await loadSessions();
      setModal(null);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to delete session'); }
  }

  async function saveRemark(){
    try{
      setError('');
      const val = remarkDraft.trim();
      if(remarks[selectedDate] !== undefined){
        if(val) await patchRows('calendar_remarks', { calendar_date: selectedDate }, { remark: val });
        else await deleteRows('calendar_remarks', { calendar_date: selectedDate });
      } else if(val) {
        await insertRows('calendar_remarks', { calendar_date: selectedDate, remark: val });
      }
      await loadRemarks(monthCursor);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to save remark'); }
  }

  // ───── Settings mutations ─────────────────────────────────────────────────

  async function addOption(kind, extra={}){
    try{
      if(kind === 'instructor') await insertRows('scheduler_instructors', { name: extra.name, gender: extra.gender || null, sort_order: options.instructors.length + 1, is_active:true });
      if(kind === 'duration') await insertRows('scheduler_durations', { label: extra.label, slots: Number(extra.slots), sort_order: options.durations.length + 1, is_active:true });
      if(kind === 'lessonType'){
        const inserted = await insertRows('scheduler_lesson_types', { name: extra.name, bg_color: extra.bg, border_color: extra.bd, text_color: extra.tx, sort_order: options.lessonTypes.length + 1, is_active:true });
        const newId = inserted?.[0]?.id;
        if(newId){
          // Auto-relink: any decoupled sessions that still carry this exact name (and no link) reattach to the new type.
          await rest(`weekly_sessions?lesson_type=eq.${encodeURIComponent(extra.name)}&lesson_type_id=is.null`, { method:'PATCH', headers:{ Prefer:'return=minimal' }, body: JSON.stringify({ lesson_type_id: newId }) });
          // Seed the two default packages every lesson type ships with.
          await insertRows('packages', [
            { lesson_type_id: newId, name: 'Normal', sort_order: 1, is_active: true, billing_mode: 'monthly' },
            { lesson_type_id: newId, name: 'Trial',  sort_order: 2, is_active: true, billing_mode: 'monthly' }
          ]);
        }
        await loadSessions();
      }
      if(kind === 'pool') await insertRows('pools', { name: extra.name, capacity_total: Number(extra.capacity), sort_order: options.pools.length + 1, is_active:true });
      if(kind === 'package'){
        const ltId = extra.lessonTypeId || null;
        const siblings = ltId ? options.packages.filter(p => p.lesson_type_id === ltId) : options.packages.filter(p => !p.lesson_type_id);
        await insertRows('packages', { lesson_type_id: ltId, name: extra.name, pax: (extra.pax === '' || extra.pax == null) ? null : Number(extra.pax), amount: (extra.amount === '' || extra.amount == null) ? null : Number(extra.amount), billing_mode: extra.billingMode || 'monthly', billing_count: (extra.billingCount === '' || extra.billingCount == null) ? null : Number(extra.billingCount), is_group: !!extra.isGroup, fallback_per_pax: (extra.fallbackPerPax === '' || extra.fallbackPerPax == null) ? null : Number(extra.fallbackPerPax), sort_order: siblings.length + 1, is_active:true });
      }
      await loadOptions();
    } catch(err){ handleErr(err); alert(err.message || 'Failed to add option'); }
  }

  // Edit a lesson type. If the name changes, cascade the new name onto every
  // linked session's text column so colors and labels stay correct everywhere.
  async function saveLessonType(row, patch){
    try{
      setError('');
      await patchRows('scheduler_lesson_types', { id: row.id }, patch);
      if(patch.name && patch.name !== row.name){
        await rest(`weekly_sessions?lesson_type_id=eq.${encodeURIComponent(row.id)}`, { method:'PATCH', headers:{ Prefer:'return=minimal' }, body: JSON.stringify({ lesson_type: patch.name }) });
      }
      await loadOptions();
      await loadSessions();
    } catch(err){ handleErr(err); alert(err.message || 'Failed to update lesson type'); }
  }

  // Delete a lesson type but keep its classes. Sessions are decoupled
  // (lesson_type_id → null) while their lesson_type text name is preserved, so
  // re-creating a type with the same name relinks them automatically.
  async function deleteLessonType(row){
    const linked = sessions.filter(s => s.lessonTypeId === row.id).length;
    const msg = linked > 0
      ? `${linked} class${linked===1?'':'es'} currently use "${row.name}".\n\nDeleting will UNLINK them: the classes stay in the schedule and keep the name "${row.name}", but lose this color/metadata link. Re-creating a lesson type with the exact same name will automatically relink them.\n\nProceed?`
      : `Delete lesson type "${row.name}"? No classes are currently using it.`;
    if(!confirm(msg)) return;
    try{
      setError('');
      if(linked > 0){
        await rest(`weekly_sessions?lesson_type_id=eq.${encodeURIComponent(row.id)}`, { method:'PATCH', headers:{ Prefer:'return=minimal' }, body: JSON.stringify({ lesson_type_id: null }) });
      }
      await deleteRows('scheduler_lesson_types', { id: row.id });
      await loadOptions();
      await loadSessions();
      setStatus(linked > 0 ? `Unlinked ${linked} class${linked===1?'':'es'}; "${row.name}" kept on the schedule.` : `Deleted "${row.name}".`);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to delete lesson type'); }
  }

  async function toggleOption(table, row){
    try{ await patchRows(table, { id: row.id }, { is_active: !row.is_active }); await loadOptions(); }
    catch(err){ handleErr(err); alert(err.message || 'Failed to update option'); }
  }
  async function deleteOption(table, row, label){
    if(!confirm(`Delete "${label}" from this dropdown list? Existing schedule rows will stay unchanged.`)) return;
    try{ await deleteRows(table, { id: row.id }); await loadOptions(); }
    catch(err){ handleErr(err); alert(err.message || 'Failed to delete option'); }
  }

  // Instructor delete is special: a FK on session_instructors blocks the raw
  // delete when the instructor is assigned to any class. We surface the usage
  // count in a tailored confirm, preserve the deleted name on each affected
  // session's legacy `instructor` column so the scheduler can still see who
  // used to teach it (rendered greyed-out with an amber ⚠), then drop the
  // FK rows and the instructor itself. Classes and students are left intact.
  async function deleteInstructor(row){
    try{
      const affected = sessions.filter(s => s.instructors.some(i => i.id === row.id));
      const message = affected.length
        ? `"${row.name}" is currently assigned to ${affected.length} class${affected.length===1?'':'es'}.\n\n` +
          `Deleting will leave those classes without an instructor. Their card will show an amber ⚠ warning until you reassign someone from the instructor list — the classes, students, times, and pool stay exactly as they are.\n\n` +
          `Proceed with deletion?`
        : `Delete "${row.name}" from the instructor list? No classes reference this instructor.`;
      if(!confirm(message)) return;
      // Preserve the name on each affected session's legacy text column so the
      // scheduler still sees a greyed-out reference until reassignment.
      for(const s of affected){
        const remaining = s.instructors.filter(i => i.id !== row.id);
        if(remaining.length === 0 && !s.legacyInstructor){
          await patchRows('weekly_sessions', { id: s.id }, { instructor: row.name });
        }
      }
      // Drop FK rows first so the parent delete can succeed.
      await deleteRows('session_instructors', { instructor_id: row.id });
      await deleteRows('scheduler_instructors', { id: row.id });
      await Promise.all([loadOptions(), loadSessions()]);
      setStatus(`Deleted "${row.name}"${affected.length ? ` · ${affected.length} class${affected.length===1?'':'es'} now need a new instructor` : ''}.`);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to delete instructor'); }
  }
  async function patchOption(table, idOrMatch, patch){
    try{
      const match = (typeof idOrMatch === 'object' && idOrMatch !== null) ? idOrMatch : { id: idOrMatch };
      await patchRows(table, match, patch);
      await loadOptions();
    } catch(err){ handleErr(err); alert(err.message || 'Failed to update option'); }
  }

  // Reorder a settings list by reindexing sort_order across the whole list, so
  // the result is clean and gap-free regardless of the existing values.
  async function reorderOption(table, list, index, dir){
    const arr = (list || []).slice();
    const j = index + dir;
    if(j < 0 || j >= arr.length) return;
    const tmp = arr[index]; arr[index] = arr[j]; arr[j] = tmp;
    try{
      await Promise.all(arr.map((r, i) => patchRows(table, { id: r.id }, { sort_order: i + 1 })));
      await loadOptions();
    } catch(err){ handleErr(err); alert(err.message || 'Failed to reorder'); }
  }

  // ───── Swimmer registry CRUD ──────────────────────────────────────────────
  async function addStudent({ name, dateOfBirth, gender, enrollments, guardianName, guardianEmail, guardianPhone, emergencyName, emergencyPhone, emergencyRelationship, emergencySameAsGuardian, tcAcceptedAt, tcAcceptanceId }){
    try{
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
        package_id: primaryPackageId, package: primaryPkg ? primaryPkg.name : null,
        lesson_type_ids: lessonTypeIds, is_active: true,
        guardian_name: guardianName || null, guardian_email: guardianEmail || null, guardian_phone: guardianPhone || null,
        emergency_name: sameAsG ? (guardianName || null) : (emergencyName || null),
        emergency_phone: sameAsG ? (guardianPhone || null) : (emergencyPhone || null),
        emergency_relationship: sameAsG ? 'Parent / Guardian' : (emergencyRelationship || null),
        emergency_same_as_guardian: sameAsG,
        // T&C inheritance: a swimmer added under an existing account
        // inherits the account-level T&C acceptance so the whole household
        // shares one consent record.
        tc_accepted_at: tcAcceptedAt || null,
        tc_acceptance_id: tcAcceptanceId || null
      });
      const studentId = inserted?.[0]?.id;
      if(studentId && validEnrollments.length){
        try{ await insertRows('student_enrollments', validEnrollments.map(e => ({ student_id: studentId, lesson_type_id: e.lessonTypeId, package_id: e.packageId || null }))); }
        catch(err){ console.warn('Could not insert enrollments (table may not exist yet):', err?.message || err); }
        // Credit-based for every lesson type now — seed 4 credits (or
        // package.billing_count if set) per (student, lesson_type) the
        // moment they sign up. Silent on duplicate-key races.
        for(const e of validEnrollments){
          const pkg = e.packageId ? (options.packages || []).find(p => p.id === e.packageId) : null;
          const init = pkg?.billing_count ? Number(pkg.billing_count) : 4;
          if(init > 0){
            try{ await insertRows('student_credit_balances', [{ student_id: studentId, lesson_type_id: e.lessonTypeId, initial_balance: init, remaining_balance: init }]); }
            catch(_){}
          }
        }
        await loadCreditBalances();
      }
      await loadStudents();
    } catch(err){ handleErr(err); alert(err.message || 'Failed to add swimmer'); }
  }
  async function updateStudent(id, patch){
    try{
      setError('');
      const body = {};
      if('name' in patch) body.name = patch.name;
      if('dateOfBirth' in patch){
        const dob = patch.dateOfBirth || null;
        body.date_of_birth = dob;
        body.age = dob ? ageFromDob(dob) : null;
      }
      if('gender' in patch) body.gender = patch.gender || null;
      if('guardianName' in patch) body.guardian_name = patch.guardianName || null;
      if('guardianEmail' in patch) body.guardian_email = patch.guardianEmail || null;
      if('guardianPhone' in patch) body.guardian_phone = patch.guardianPhone || null;
      if('emergencySameAsGuardian' in patch) body.emergency_same_as_guardian = !!patch.emergencySameAsGuardian;
      if('emergencyPhone' in patch) body.emergency_phone = patch.emergencyPhone || null;
      if('emergencyName' in patch) body.emergency_name = patch.emergencyName || null;
      if('emergencyRelationship' in patch) body.emergency_relationship = patch.emergencyRelationship || null;
      if('isActive' in patch) body.is_active = !!patch.isActive;
      // Enrollments: mirror onto legacy columns for backward compat, then
      // sync the student_enrollments table (delete-all then insert).
      if('enrollments' in patch){
        const validEnrollments = (patch.enrollments || []).filter(e => e.lessonTypeId);
        const lessonTypeIds = [...new Set(validEnrollments.map(e => e.lessonTypeId))];
        const primaryPackageId = validEnrollments[0]?.packageId || null;
        const primaryPkg = primaryPackageId ? packageById(primaryPackageId) : null;
        body.lesson_type_ids = lessonTypeIds;
        body.package_id = primaryPackageId;
        body.package = primaryPkg ? primaryPkg.name : null;
      }
      await patchRows('students', { id }, body);
      if('enrollments' in patch){
        const validEnrollments = (patch.enrollments || []).filter(e => e.lessonTypeId);
        try{
          await deleteRows('student_enrollments', { student_id: id });
          if(validEnrollments.length){
            await insertRows('student_enrollments', validEnrollments.map(e => ({ student_id: id, lesson_type_id: e.lessonTypeId, package_id: e.packageId || null })));
          }
        } catch(err){ console.warn('Could not sync enrollments (table may not exist yet):', err?.message || err); }
        // Credit-based for every lesson type — make sure each enrollment
        // has a balance. Skips lesson types where the swimmer already has
        // one (avoids resetting an in-progress month back to 4).
        for(const e of validEnrollments){
          const key = creditKey(id, e.lessonTypeId);
          if(creditByKey[key]) continue;
          const pkg = e.packageId ? (options.packages || []).find(p => p.id === e.packageId) : null;
          const init = pkg?.billing_count ? Number(pkg.billing_count) : 4;
          if(init > 0){
            try{ await insertRows('student_credit_balances', [{ student_id: id, lesson_type_id: e.lessonTypeId, initial_balance: init, remaining_balance: init }]); }
            catch(_){}
          }
        }
        await loadCreditBalances();
      }
      await loadStudents();
    } catch(err){ handleErr(err); alert(err.message || 'Failed to update swimmer'); }
  }
  async function deleteStudent(row){
    const enrolled = sessions.filter(s => s.students.some(st => st.studentId === row.id)).length;
    const msg = enrolled > 0
      ? `${row.name} is attached to ${enrolled} scheduled session${enrolled===1?'':'s'}.\n\nDeleting from the registry keeps those enrollments on the schedule (the name stays) but unlinks them. Proceed?`
      : `Delete swimmer "${row.name}" from the registry?`;
    if(!confirm(msg)) return;
    try{
      setError('');
      await deleteRows('students', { id: row.id });
      await loadStudents();
      await loadSessions();
    } catch(err){ handleErr(err); alert(err.message || 'Failed to delete swimmer'); }
  }

  // ───── Family groups (single-payer bundles) ──────────────────────────────
  async function addGroup({ name, packageId, groupType }){
    try{
      setError('');
      const ins = await insertRows('family_groups', { name, package_id: packageId || null, group_type: groupType || 'discount' });
      await loadGroups();
      return ins?.[0] || null;
    } catch(err){ handleErr(err); alert(err.message || 'Failed to create family group'); return null; }
  }
  async function updateGroup(id, patch){
    try{
      setError('');
      const body = {};
      if('name' in patch) body.name = patch.name;
      if('packageId' in patch) body.package_id = patch.packageId || null;
      if('groupType' in patch) body.group_type = patch.groupType;
      await patchRows('family_groups', { id }, body);
      await loadGroups();
    } catch(err){ handleErr(err); alert(err.message || 'Failed to update family group'); }
  }
  async function deleteGroup(row, silent){
    if(!silent){
      const memberCount = (membersByGroup[row.id] || []).length;
      if(!confirm(memberCount > 0
        ? `Delete family group "${row.name}"? Its ${memberCount} member${memberCount===1?'':'s'} stay in the swimmer registry but will no longer be billed as a group.`
        : `Delete family group "${row.name}"?`)) return;
    }
    try{ setError(''); await deleteRows('family_groups', { id: row.id }); await loadGroups(); await loadGroupMemberships(); await loadStudents(); }
    catch(err){ handleErr(err); alert(err.message || 'Failed to delete family group'); }
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
  async function addStudentToGroup(studentId, groupId, targetOverride){
    try{
      setError('');
      const target = targetOverride || familyGroups.find(g => g.id === groupId);
      if(!target){ alert('Group not found.'); return false; }
      // Check uniqueness: is the swimmer already in another group with
      // the same (lesson_type, package)? Skip if target group has no
      // package set yet — that's a misconfiguration the UI surfaces
      // separately.
      if(target.packageId){
        const existingGroupIds = groupIdsByStudent[studentId] || new Set();
        for(const otherId of existingGroupIds){
          if(otherId === groupId) return true; // already in this group — no-op
          const other = familyGroups.find(g => g.id === otherId);
          if(other && other.packageId === target.packageId){
            alert(`This swimmer is already in "${other.name}" which has the same package. A swimmer can only be in one group per (lesson type, package) combination — remove them from "${other.name}" first.`);
            return false;
          }
        }
      }
      await insertRows('family_group_members', { family_group_id: groupId, student_id: studentId });
      await loadGroupMemberships();
      return true;
    } catch(err){
      // Idempotent: PK conflict on duplicate add is silently OK
      if(err?.message && /duplicate|conflict|23505/i.test(err.message)){ await loadGroupMemberships(); return true; }
      handleErr(err); alert(err.message || 'Failed to add swimmer to group'); return false;
    }
  }
  async function removeStudentFromGroup(studentId, groupId){
    try{
      setError('');
      await deleteRows('family_group_members', { family_group_id: groupId, student_id: studentId });
      await loadGroupMemberships();
      return true;
    } catch(err){ handleErr(err); alert(err.message || 'Failed to remove swimmer from group'); return false; }
  }
  // Back-compat shim — old call sites still pass setStudentGroup(id, groupId|null).
  // groupId is non-null → ADD to group (with uniqueness check).
  // groupId is null     → REMOVE from any/all groups (used when "uncheck all").
  async function setStudentGroup(studentId, groupId){
    if(groupId){ return addStudentToGroup(studentId, groupId); }
    // null = remove from all groups the swimmer is in
    const ids = Array.from(groupIdsByStudent[studentId] || []);
    for(const gid of ids){ await removeStudentFromGroup(studentId, gid); }
    return true;
  }

  // Move an item from one index to another (used by drag-and-drop), then reindex.
  async function moveOption(table, list, from, to){
    if(from === to || from == null || to == null) return;
    const arr = (list || []).slice();
    if(from < 0 || to < 0 || from >= arr.length || to >= arr.length) return;
    const [it] = arr.splice(from, 1);
    arr.splice(to, 0, it);
    try{
      await Promise.all(arr.map((r, i) => patchRows(table, { id: r.id }, { sort_order: i + 1 })));
      await loadOptions();
    } catch(err){ handleErr(err); alert(err.message || 'Failed to reorder'); }
  }

  // duplicateSessionForward: clone ONE session into N future weeks at the
  // same weekday + start_minute. Same lesson type, same pool, same
  // instructor, same regular students (replacements excluded — they're
  // week-scoped one-offs). Attendance resets to 'pending' on the clones.
  // If a clone slot already has a matching session in a target week, that
  // week is skipped silently (avoids creating parallel duplicates).
  async function duplicateSessionForward(sessionId, weekCount){
    const src = sessions.find(s => s.id === sessionId);
    if(!src){ alert('Source session not found.'); return; }
    if(src.cancelledAt){ alert('Cannot duplicate a cancelled session — restore it first.'); return; }
    const n = Math.max(1, Math.min(52, Number(weekCount) || 1));
    const enrolledRegular = (src.students || []).filter(s => !s.isReplacement);
    if(!confirm(`Duplicate "${src.type}" on ${DAYS_F[src.day]} ${minuteToTime(src.startMinute)} to the next ${n} week${n===1?'':'s'}?\n\n${enrolledRegular.length} swimmer${enrolledRegular.length===1?'':'s'} will be cloned. Attendance resets to pending each week. Weeks that already have a matching session at the same slot will be skipped.`)) return;
    let created = 0, skipped = 0;
    try{
      for(let w = 1; w <= n; w++){
        const targetWeekStart = addDays(src.weekStartDate, 7 * w);
        const exists = sessions.find(s =>
          s.weekStartDate === targetWeekStart &&
          s.day === src.day &&
          s.startMinute === src.startMinute &&
          s.lessonTypeId === src.lessonTypeId &&
          (s.poolId || null) === (src.poolId || null) &&
          !s.cancelledAt
        );
        if(exists){ skipped++; continue; }
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
        if(newId){
          if(enrolledRegular.length){
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
          if(src.instructors && src.instructors.length){
            try{
              await insertRows('session_instructors', src.instructors.map(i => ({
                session_id: newId, instructor_id: i.id
              })));
            } catch(_){}
          }
          created++;
        }
      }
      await loadSessions();
      setModal(null);
      setStatus(`Duplicated forward: ${created} week${created===1?'':'s'} created${skipped ? `, ${skipped} skipped (already had a session at that slot)` : ''}.`);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to duplicate session forward'); }
  }

  async function duplicatePreviousWeek(){
    try{
      if(!isFutureSelectedWeek){ alert('Week duplication is only available for a future week.'); return; }
      const prevWeekStart = addDays(selectedWeekStart, -7);
      const sourceSessions = sessions
        .filter(s => s.weekStartDate === prevWeekStart && !s.cancelledAt)
        .sort((a,b) => a.day - b.day || a.startMinute - b.startMinute);
      if(!sourceSessions.length){ alert('No classes found in the previous week to duplicate.'); return; }
      // Pre-count trial swimmers in the source so we can mention it in the confirm prompt.
      const trialInSource = sourceSessions.reduce((n, s) => n + (s.students || []).filter(st => st.studentId && trialStudentIds.has(st.studentId)).length, 0);
      const trialNote = trialInSource
        ? `\n\nNote: ${trialInSource} trial swimmer${trialInSource===1?'':'s'} on these classes won’t be carried over — trial bookings are one-offs by design. Re-add them next week if they convert to a regular package.`
        : '';
      if(!confirm(`Duplicate all classes from ${prevWeekStart} into ${selectedWeekStart}? Existing classes in the selected week will remain.${trialNote}`)) return;
      // Rescheduled personal sessions: restore original day/time for the new week.
      // Replacement students: one-off only — skip on duplicate.
      const payload = sourceSessions.map(s => ({
        week_start_date: selectedWeekStart,
        // If session was rescheduled for last week, restore its canonical position.
        weekday:      s.rescheduledFromDay          != null ? s.rescheduledFromDay + 1          : s.day + 1,
        start_minute: s.rescheduledFromStartMinute  != null ? s.rescheduledFromStartMinute  : s.startMinute,
        duration_minutes: s.durationMinutes,
        lesson_type: s.type,
        lesson_type_id: s.lessonTypeId,
        pool_id: s.poolId,
        family_group_id: s.familyGroupId || null,
        instructor: s.legacyInstructor,
        rescheduled_from_day: null,           // clear reschedule flag in the new week
        rescheduled_from_start_minute: null
      }));
      const inserted = await insertRows('weekly_sessions', payload);
      const studentPayload = [];
      const instructorPayload = [];
      let skippedTrials = 0, skippedReplacements = 0;
      (inserted || []).forEach((row, idx) => {
        const src = sourceSessions[idx];
        (src.students || []).forEach(st => {
          if(st.isReplacement){ skippedReplacements++; return; } // one-off — do not carry forward
          if(st.studentId && trialStudentIds.has(st.studentId)){ skippedTrials++; return; }
          studentPayload.push({ session_id: row.id, student_id: st.studentId || null, student_name: st.name, student_age: (st.age === null || st.age === undefined) ? null : Number(st.age) });
        });
        (src.instructors || []).forEach(it => instructorPayload.push({ session_id: row.id, instructor_id: it.id }));
      });
      if(studentPayload.length) await insertRows('weekly_session_students', studentPayload);
      if(instructorPayload.length) await insertRows('session_instructors', instructorPayload);
      await loadSessions();
      const skips = [skippedTrials ? `${skippedTrials} trial` : null, skippedReplacements ? `${skippedReplacements} replacement` : null].filter(Boolean);
      setStatus(`Duplicated ${sourceSessions.length} class${sourceSessions.length===1?'':'es'} from previous week${skips.length ? ` · skipped ${skips.join(' and ')} swimmer${(skippedTrials+skippedReplacements)===1?'':'s'}` : ''}.`);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to duplicate previous week'); }
  }

  async function clearDayClasses(dayIndex){
    try{
      if(!isFutureSelectedWeek){ alert('You can only remove all classes for a future week. Current week and past weeks are protected.'); return; }
      const dayLabel = DAYS_F[dayIndex];
      const targets = sessions.filter(s => s.weekStartDate === selectedWeekStart && s.day === dayIndex);
      if(!targets.length){ alert(`No classes found for ${dayLabel} in the selected week.`); return; }
      if(!confirm(`Remove all classes for ${dayLabel} in the week starting ${selectedWeekStart}? This will not affect the current week or any past week.`)) return;
      for(const s of targets){
        await deleteRows('weekly_session_students', { session_id: s.id });
        await deleteRows('session_instructors', { session_id: s.id });
        await deleteRows('weekly_sessions', { id: s.id });
      }
      await loadSessions();
      setStatus(`Removed ${targets.length} class${targets.length===1?'':'es'} for ${dayLabel}.`);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to remove day classes'); }
  }

  // Export the selected week as a multi-tab attendance roster (one tab per day
  // that has classes), mirroring the AquaLabz monthly-roster layout: numbered
  // student rows with Name/Age/Gender/Remarks, a per-date attendance column,
  // a payment/notes column, and a teacher signature line per class.
  function exportWeekExcel(){
    if(typeof XLSX === 'undefined'){ alert('Excel library is still loading. Please try again in a moment.'); return; }
    const DSHORT = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    const sheets = [];
    for(let day = 0; day < 7; day++){
      const ds = addDays(selectedWeekStart, day);
      const dObj = fromDateStr(ds);
      const daySessions = weekSessions.filter(s => s.day === day).sort((a,b) => a.startMinute - b.startMinute || String(a.type).localeCompare(String(b.type)));
      if(!daySessions.length) continue;
      const dateLabel = `${dObj.getDate()}/${dObj.getMonth()+1}/${dObj.getFullYear()}`;
      const longDay = dObj.toLocaleDateString(undefined, { weekday:'long', day:'numeric', month:'long', year:'numeric' });
      const aoa = [];
      const merges = [];
      const mergeFull = (r) => merges.push({ s:{ r, c:0 }, e:{ r, c:6 } });
      mergeFull(aoa.length); aoa.push([`AquaLabz — ${longDay}`,'','','','','','']);
      mergeFull(aoa.length); aoa.push(['✓ = attended,  X = absent','','','','','','']);
      aoa.push(['','','','','','','']);
      daySessions.forEach(s => {
        const lt = lessonTypeByName(s.type);
        const cap = lt && lt.students_per_instructor ? Number(lt.students_per_instructor) : 0;
        const instr = s.instructors.map(i=>i.name).join(', ') || s.legacyInstructor || '';
        const pool = poolById(s.poolId)?.name || '';
        const titleBits = [s.type || 'Class', formatRange(s.startMinute, s.durationMinutes)];
        if(pool) titleBits.push(pool);
        if(instr) titleBits.push(instr);
        mergeFull(aoa.length); aoa.push([titleBits.join('  ·  '),'','','','','','']);
        aoa.push(['No.','Name','Age','Gender','Remarks', dateLabel, 'Payment / Notes']);
        s.students.forEach((stu, i) => aoa.push([i+1, stu.name || '', (stu.age === null || stu.age === undefined || stu.age === '') ? '' : stu.age, '', stu.remark || '', '', '']));
        const fillTo = Math.max(cap, s.students.length) + 2;
        for(let i = s.students.length; i < fillTo; i++) aoa.push([i+1, '', '', '', '', '', '']);
        aoa.push(['','','','','','T : ____________________','']);
        aoa.push(['','','','','','','']);
      });
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{wch:5},{wch:30},{wch:8},{wch:11},{wch:22},{wch:13},{wch:28}];
      ws['!merges'] = merges;
      sheets.push({ name: `${DSHORT[day]} ${dObj.getDate()} ${dObj.toLocaleDateString(undefined,{month:'short'})}`.slice(0,31), ws });
    }
    if(!sheets.length){ alert('No classes are scheduled in this week, so there is nothing to export.'); return; }
    const wb = XLSX.utils.book_new();
    sheets.forEach(s => XLSX.utils.book_append_sheet(wb, s.ws, s.name));
    const start = fromDateStr(selectedWeekStart);
    const end = fromDateStr(addDays(selectedWeekStart, 6));
    const fmt = (d) => `${d.getDate()} ${d.toLocaleDateString(undefined,{month:'short'})}`;
    const fname = `${start.toLocaleDateString(undefined,{month:'long'})} ${start.getFullYear()} (${fmt(start)} - ${fmt(end)}).xlsx`;
    XLSX.writeFile(wb, fname);
    setStatus(`Exported ${sheets.length} day${sheets.length===1?'':'s'} to ${fname}`);
  }

  const monthDates = monthCells(monthCursor);
  const selectedItems = sessionsForDate(selectedDate);
  // selectedWeekLabel removed — the header now shows today's date instead.
  const lessonTypeCounts = useMemo(() => {
    const m = {};
    sessions.forEach(s => { if(s.lessonTypeId) m[s.lessonTypeId] = (m[s.lessonTypeId] || 0) + 1; });
    return m;
  }, [sessions]);

  // Set of swimmer IDs currently on a "trial" package (one-off bookings). Drives
  // the trial annotation in the modal/cards and the duplicate-week skip rule.
  const trialStudentIds = useMemo(() => {
    const trialPkgIds = new Set((options.packages || []).filter(p => (p.name || '').toLowerCase().includes('trial')).map(p => p.id));
    const ids = new Set();
    students.forEach(s => { if(s.packageId && trialPkgIds.has(s.packageId)) ids.add(s.id); });
    return ids;
  }, [students, options.packages]);
  // Lesson-type-scoped trial lookup: trialByLessonType[ltId] is the Set of
  // trial student IDs enrolled in that lesson type. A student in the global
  // trial set who's only enrolled in LTS won't appear under PERSONAL —
  // matching the policy that "trial" is per-lesson-type, not global.
  const trialByLessonType = useMemo(() => {
    const m = {};
    students.forEach(s => {
      if(!trialStudentIds.has(s.id)) return;
      (s.lessonTypeIds || []).forEach(ltId => {
        if(!m[ltId]) m[ltId] = new Set();
        m[ltId].add(s.id);
      });
    });
    return m;
  }, [students, trialStudentIds]);
  const groupById = useMemo(() => { const m = {}; familyGroups.forEach(g => m[g.id] = g); return m; }, [familyGroups]);
  // Multi-group membership derived from the junction table when available,
  // falling back to the legacy single-FK column. Two related maps:
  //   • groupIdsByStudent: studentId → Set<groupId>
  //   • membersByGroup:    groupId → student rows
  const { groupIdsByStudent, membersByGroup, studentsWithGroups } = useMemo(() => {
    const idsByStu = {};
    const byGroup = {};
    if(groupMemberships === null){
      // Legacy fallback path (junction table not migrated yet)
      students.forEach(s => {
        if(s.familyGroupId){
          idsByStu[s.id] = new Set([s.familyGroupId]);
          (byGroup[s.familyGroupId] = byGroup[s.familyGroupId] || []).push(s);
        }
      });
    } else {
      const stuById = {}; students.forEach(s => { stuById[s.id] = s; });
      (groupMemberships || []).forEach(m => {
        if(!idsByStu[m.studentId]) idsByStu[m.studentId] = new Set();
        idsByStu[m.studentId].add(m.familyGroupId);
        const s = stuById[m.studentId];
        if(s){ (byGroup[m.familyGroupId] = byGroup[m.familyGroupId] || []).push(s); }
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
    return { groupIdsByStudent: idsByStu, membersByGroup: byGroup, studentsWithGroups: withGroups };
  }, [students, groupMemberships]);

  // Indexed by id but using the ENRICHED row set so callers can read
  // `.familyGroupIds` (the multi-group array) — needed by the SessionModal's
  // bound-cascade logic, the Billing Preview, and any other consumer that
  // wants to know all groups a swimmer is in. MUST be declared AFTER the
  // destructuring above so `studentsWithGroups` is in scope.
  const studentById = useMemo(() => { const m = {}; (studentsWithGroups || []).forEach(s => m[s.id] = s); return m; }, [studentsWithGroups]);

  // parentGroups: nest swimmers under their guardian (parent) account.
  // No explicit parents table — we cluster on guardian_email (most
  // unique), falling back to guardian_phone, then guardian_name. A
  // swimmer with no guardian info at all lands in a single "Unassigned"
  // pseudo-parent so they're still findable.
  const parentGroups = useMemo(() => {
    const m = {};
    (studentsWithGroups || []).forEach(s => {
      const emailKey = (s.guardianEmail || '').toLowerCase().trim();
      const phoneKey = (s.guardianPhone || '').replace(/\s+/g,'').trim();
      const nameKey = (s.guardianName || '').toLowerCase().trim();
      const key = emailKey ? `e:${emailKey}` : phoneKey ? `p:${phoneKey}` : nameKey ? `n:${nameKey}` : '__unassigned__';
      if(!m[key]){
        m[key] = {
          key,
          name: s.guardianName || (key === '__unassigned__' ? '— Unassigned —' : '— No name —'),
          email: s.guardianEmail || '',
          phone: s.guardianPhone || '',
          // Emergency contact lives at the account level — surface it from
          // the first swimmer in this account; ParentContactEditor edits
          // propagate the new value to every child below.
          emergencyPhone: s.emergencyPhone || '',
          emergencyName: s.emergencyName || '',
          emergencyRelationship: s.emergencyRelationship || '',
          emergencySameAsGuardian: !!s.emergencySameAsGuardian,
          swimmers: []
        };
      }
      m[key].swimmers.push(s);
    });
    // Parent status is derived from swimmer-level is_active: a parent is
    // "Active" if any of their swimmers is active, "Archived" only when
    // every swimmer is inactive. Toggling at parent level propagates to
    // all children so the state is always coherent.
    Object.values(m).forEach(pg => {
      pg.isActive = pg.swimmers.some(s => s.isActive !== false);
    });
    return Object.values(m).sort((a,b) => {
      if(a.key === '__unassigned__') return 1;
      if(b.key === '__unassigned__') return -1;
      return a.name.localeCompare(b.name);
    });
  }, [studentsWithGroups]);

  // Which sessions (in the selected week) each swimmer is already in — drives the
  // double-booking warning in the enrollment modal.
  const weekEnrollments = useMemo(() => {
    const m = {};
    weekSessions.forEach(s => {
      // Cancelled ghosts retain their student rows for restore purposes
      // but those swimmers aren't actually booked into this slot anymore —
      // skip the ghost so the double-booking warning doesn't false-fire.
      if(s.cancelledAt) return;
      s.students.forEach(st => {
        if(!st.studentId) return;
        (m[st.studentId] = m[st.studentId] || []).push({ day:s.day, startMinute:s.startMinute, type:s.type, sessionId:s.id });
      });
    });
    return m;
  }, [weekSessions]);

  // Each swimmer's recurring class slots across all weeks, de-duplicated by
  // (lesson type, weekday, start), for the Swimmers tab schedule column.
  const scheduleByStudent = useMemo(() => {
    const m = {};
    sessions.forEach(s => s.students.forEach(st => {
      const id = st.studentId; if(!id) return;
      const key = `${s.type}|${s.day}|${s.startMinute}`;
      if(!m[id]) m[id] = {};
      if(!m[id][key]) m[id][key] = { type:s.type, lessonTypeId:s.lessonTypeId, day:s.day, startMinute:s.startMinute, durationMinutes:s.durationMinutes };
    }));
    const out = {};
    Object.keys(m).forEach(id => { out[id] = Object.values(m[id]).sort((a,b) => a.day - b.day || a.startMinute - b.startMinute); });
    return out;
  }, [sessions]);

  return <div>
    <div className="header"><div className="header-inner">
      <div className="brand"><img src="./logo.png" alt="Star Swim Sdn Bhd" className="logo" /><div><div style={{fontSize:14,fontWeight:800,letterSpacing:'-.3px',lineHeight:1}}>SSB Scheduler</div><div style={{fontSize:9,color:'#64748B',marginTop:2}}>Pool-aware lesson calendar</div></div></div>
      <div className="header-meta">
        <div className="header-summary"><span style={{color:'var(--primary)',fontWeight:800}}>{summary.totalStudents}</span> students · <span style={{color:'var(--primary)',fontWeight:800}}>{summary.totalSessions}</span> sessions · <span style={{color:'var(--primary)',fontWeight:800}}>{new Date().toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'})}</span></div>
        <div className="header-status"><span className={`status-dot ${loading?'is-loading':(error?'is-error':'is-ok')}`} aria-hidden="true" />{loading ? 'Connecting…' : (error ? 'Error' : (status || 'Ready'))}</div>
      </div>
      <div className="header-tabs">
        <div className="tabs">
          {['day','week','month','accounts','students','enroll'].map(v => <button key={v} className={`tab ${view===v?'active':''}`} onClick={() => setView(v)}>{v==='week'?'📅 Weekly':v==='day'?'📋 Daily':v==='month'?'🗓️ Monthly':v==='accounts'?'👤 Accounts':v==='students'?'👥 Swimmers':'🔍 Explore'}</button>)}
          {/* Intake opens intake.html in a new tab. */}
          <button type="button" className="tab tab-link" onClick={() => window.open('./intake.html', '_blank', 'noopener,noreferrer')} title="Open the digital parent intake form in a new tab">📝 Intake <span aria-hidden="true" style={{marginLeft:3,opacity:.6,fontSize:11}}>↗</span></button>
        </div>
        <div className="tabs tabs-right">
          <button className={`tab ${view==='settings'?'active':''}`} onClick={() => setView('settings')}>🔧 Admin</button>
        </div>
      </div>
    </div></div>

    <div className="wrap">
      {loading ? <div className="card" style={{textAlign:'center',padding:'42px'}}><div style={{fontSize:34,marginBottom:10}}>⏳</div><div>Loading scheduler…</div><div className="small subtle" style={{marginTop:6}}>{status || 'Connecting to Supabase'}</div></div> : null}
      {!loading && error ? <div className="card error-card"><div style={{fontWeight:800,marginBottom:4}}>Error</div><div className="small">{error}</div></div> : null}

      {!loading && view==='week' && <WeekView
        weekBlocks={weekBlocks}
        weekBlocksAllPools={weekBlocksAllPools}
        pools={activePools()}
        selectedPoolId={selectedPoolId}
        setSelectedPoolId={setSelectedPoolId}
        gridBounds={gridBounds}
        gridSlots={gridSlots}
        slotToMinute={slotToMinute}
        minuteToSlot={minuteToSlot}
        colorsFor={colorsFor}
        lessonTypeByName={lessonTypeByName}
        poolById={poolById}
        onAdd={openAdd}
        onEdit={openEdit}
        activeLessonTypes={activeLessonTypes()}
        selectedDate={selectedDate}
        sessionsForDate={sessionsForDate}
        selectedWeekStart={selectedWeekStart}
        currentWeekStart={currentWeekStart}
        isFutureSelectedWeek={isFutureSelectedWeek}
        onPrevWeek={()=>setSelectedDate(addDays(selectedDate,-7))}
        onNextWeek={()=>setSelectedDate(addDays(selectedDate,7))}
        onThisWeek={()=>setSelectedDate(todayStr())}
        onDuplicateWeek={duplicatePreviousWeek}
        onClearDay={clearDayClasses}
        onJumpToDay={(dayIndex)=>{ const d=fromDateStr(selectedWeekStart); d.setDate(d.getDate()+dayIndex); setSelectedDate(toDateStr(d)); setView('day'); }}
        isTypeEnabled={isTypeEnabled}
        onToggleType={toggleType}
        onToggleAllTypes={toggleAllTypes}
        allTypesShown={allTypesShown}
        activeInstructors={activeInstructors()}
        isInstructorActive={isInstructorActive}
        onToggleInstructor={toggleInstructor}
        onClearInstructors={clearInstructors}
        instructorFilterActive={selectedInstructors.size > 0}
        weekPendingReplacements={replacementPending.filter(p => p.week_start_date === selectedWeekStart)}
        lessonTypeById={lessonTypeById}
        studentById={studentById}
        onCancelPendingReplacement={cancelPendingReplacement}
        pendingMove={pendingMove}
        onPlacePendingMove={placePendingMove}
        onCancelPendingMove={cancelPendingMove}
        onExportExcel={exportWeekExcel}
        trialStudentIds={trialStudentIds}
        trialByLessonType={trialByLessonType}
        creditByKey={creditByKey}
      />}

      {!loading && view==='day' && <DailyView
        selectedDate={selectedDate} setSelectedDate={setSelectedDate}
        sessionsForDate={filteredSessionsForDate} colorsFor={colorsFor}
        lessonTypeByName={lessonTypeByName} poolById={poolById}
        onAddAtTime={openAddAtTime} onEdit={openEdit}
        selectedWeekStart={selectedWeekStart}
        currentWeekStart={currentWeekStart}
        onPrevWeek={()=>setSelectedDate(addDays(selectedDate,-7))}
        onNextWeek={()=>setSelectedDate(addDays(selectedDate,7))}
        onThisWeek={()=>setSelectedDate(todayStr())}
        onExportExcel={exportWeekExcel}
        activeLessonTypes={activeLessonTypes()}
        isTypeEnabled={isTypeEnabled}
        onToggleType={toggleType}
        onToggleAllTypes={toggleAllTypes}
        allTypesShown={allTypesShown}
        activeInstructors={activeInstructors()}
        isInstructorActive={isInstructorActive}
        onToggleInstructor={toggleInstructor}
        onClearInstructors={clearInstructors}
        instructorFilterActive={selectedInstructors.size > 0}
        colorsFor={colorsFor}
        trialStudentIds={trialStudentIds}
        trialByLessonType={trialByLessonType}
        creditByKey={creditByKey}
      />}

      {!loading && view==='month' && <MonthView
        monthCursor={monthCursor} setMonthCursor={setMonthCursor}
        selectedDate={selectedDate} setSelectedDate={setSelectedDate}
        monthDates={monthDates} sessionsForDate={sessionsForDate} colorsFor={colorsFor}
        remarks={remarks} remarkDraft={remarkDraft} setRemarkDraft={setRemarkDraft} saveRemark={saveRemark}
        selectedItems={selectedItems}
      />}

      {!loading && view==='accounts' && <ParentsView
        parentGroups={parentGroups}
        lessonTypes={activeLessonTypes()}
        lessonTypeById={lessonTypeById}
        packages={activePackages()}
        packageById={packageById}
        familyGroups={familyGroups}
        groupById={groupById}
        membersByGroup={membersByGroup}
        creditByKey={creditByKey}
        subscriptions={subscriptions}
        addStudent={addStudent}
        updateStudent={updateStudent}
        deleteStudent={deleteStudent}
        addGroup={addGroup}
        updateGroup={updateGroup}
        deleteGroup={deleteGroup}
        setStudentGroup={setStudentGroup}
        addStudentToGroup={addStudentToGroup}
        removeStudentFromGroup={removeStudentFromGroup}
        groupIdsByStudent={groupIdsByStudent}
        addSubscription={addSubscription}
        cancelSubscription={cancelSubscription}
        adjustBalanceTo={adjustBalanceTo}
        scheduleByStudent={scheduleByStudent}
        sessions={sessions}
        poolById={poolById}
        selectedWeekStart={selectedWeekStart}
        createInvoice={createInvoice}
        setAdminSection={setAdminSection}
        setView={setView}
      />}

      {!loading && view==='students' && <>
        <StudentsView
          students={students}
          lessonTypes={activeLessonTypes()}
          lessonTypeById={lessonTypeById}
          packages={activePackages()}
          packageById={packageById}
          groupById={groupById}
          familyGroups={familyGroups}
          membersByGroup={membersByGroup}
          scheduleByStudent={scheduleByStudent}
          sessions={sessions}
          jumpToWeek={(weekStartDate, dayIndex)=>{ const d = fromDateStr(weekStartDate); d.setDate(d.getDate() + (dayIndex || 0)); setSelectedDate(toDateStr(d)); setView('week'); }}
          creditByKey={creditByKey}
          purchasesByStudent={purchasesByStudent}
          subscriptions={subscriptions}
          addCreditPurchase={addCreditPurchase}
          deleteCreditPurchase={deleteCreditPurchase}
          addSubscription={addSubscription}
          cancelSubscription={cancelSubscription}
          adjustBalanceTo={adjustBalanceTo}
          addStudent={addStudent}
          updateStudent={updateStudent}
          deleteStudent={deleteStudent}
        />
        {/* FamilyGroupsPanel removed — family groups are now managed
            exclusively inside the Accounts tab, per-account context. */}
        <div style={{height:'42vh'}} aria-hidden="true"></div>
      </>}
      {!loading && view==='enroll' && <EnrollView
        sessions={sessions}
        students={students}
        studentById={studentById}
        lessonTypes={activeLessonTypes()}
        lessonTypeById={lessonTypeById}
        lessonTypeByName={lessonTypeByName}
        poolById={poolById}
        colorsFor={colorsFor}
        gridBounds={gridBounds}
        packages={options.packages}
        instructors={activeInstructors()}
        initialWeekStart={selectedWeekStart}
        onEnroll={openEnroll}
        onCreate={openCreateFor}
      />}
      {/* ── Admin Hub — left sidebar + content panel ───────────────── */}
      {!loading && view==='settings' && <div className="admin-hub">
        <div className="admin-hub-sidebar">
          <div className="admin-hub-title">🔧 Admin</div>
          {[
            { key:'summary',     icon:'📊', label:'Summary' },
            { key:'pools',       icon:'🏊', label:'Pools & Operating Hours' },
            { key:'instructors', icon:'👨‍🏫', label:'Instructors' },
            { key:'lessonTypes', icon:'📋', label:'Lesson Types' },
            { key:'codes',       icon:'🎟', label:'Referral & Discount Codes' },
            { key:'receipts',    icon:'💰', label:'Receipts' },
            { key:'invoices',       icon:'🧾', label:'Invoices' },
            { key:'pendingCredits', icon:'⏳', label:'Pending Credits' },
            { key:'aging',          icon:'📈', label:'Aging Report' },
          ].map(item => <button key={item.key} className={`admin-hub-item ${adminSection===item.key?'is-on':''}`} onClick={()=>setAdminSection(item.key)}>
            <span className="admin-hub-icon">{item.icon}</span>
            <span>{item.label}</span>
          </button>)}
        </div>
        <div className="admin-hub-content">
          {adminSection === 'summary' && <SummaryView summary={summary} pools={activePools()} />}
          {adminSection === 'receipts' && <ReceiptsView
            subscriptions={subscriptions}
            students={students}
            studentById={studentById}
            familyGroups={familyGroups}
            groupById={groupById}
            lessonTypeById={lessonTypeById}
            cancelSubscription={cancelSubscription}
          />}
          {adminSection === 'invoices' && <InvoicesView
            invoices={invoices}
            invoiceLines={invoiceLines}
            pmts={pmts}
            pendingCredits={pendingCredits}
            lessonTypeById={lessonTypeById}
            packageById={packageById}
            studentById={studentById}
            invoiceSettings={invoiceSettings}
            onSaveSettings={saveInvoiceSettings}
            formatInvoiceNumber={formatInvoiceNumber}
            formatReceiptNumber={formatReceiptNumber}
            onVoid={voidInvoice}
            onUpdateStatus={updateInvoiceStatus}
            onRecordPayment={recordPayment}
            onConfirmCredit={confirmCredit}
            onReverseCredit={reverseCredit}
            onAddLine={addInvoiceLine}
            onUpdateLine={updateInvoiceLine}
            onDeleteLine={deleteInvoiceLine}
          />}
          {adminSection === 'pendingCredits' && <PendingCreditsView
            pendingCredits={pendingCredits}
            invoices={invoices}
            studentById={studentById}
            familyGroups={familyGroups}
            groupById={groupById}
            lessonTypeById={lessonTypeById}
            packageById={packageById}
            onConfirm={confirmCredit}
            onReverse={reverseCredit}
          />}
          {adminSection === 'aging' && <AgingReportView
            invoices={invoices}
            pmts={pmts}
          />}
          {(adminSection === 'pools' || adminSection === 'instructors' || adminSection === 'lessonTypes' || adminSection === 'codes') && <SettingsView
            section={adminSection}
            options={options}
            status={status}
            addOption={addOption}
            toggleOption={toggleOption}
            deleteOption={deleteOption}
            deleteInstructor={deleteInstructor}
            patchOption={patchOption}
            reorderOption={reorderOption}
            moveOption={moveOption}
            saveLessonType={saveLessonType}
            deleteLessonType={deleteLessonType}
            lessonTypeCounts={lessonTypeCounts}
            codes={codes}
            students={students}
            packages={options.packages}
            addCode={addCode}
            updateCode={updateCode}
            deleteCode={deleteCode}
          />}
        </div>
      </div>}
      {/* T&C view removed from the menu — parents now sign T&C inside intake.html. */}
    </div>

    {modal ? <SessionModal
      modal={modal} setModal={setModal} saveBusy={saveBusy}
      saveSession={saveSession} deleteSession={deleteSession}
      openAddAtTime={openAddAtTime}
      instructors={activeInstructors()}
      lessonTypes={activeLessonTypes()}
      pools={activePools()}
      lessonTypeByName={lessonTypeByName}
      poolById={poolById}
      packageById={packageById}
      students={students}
      studentById={studentById}
      weekEnrollments={weekEnrollments}
      familyGroups={familyGroups}
      membersByGroup={membersByGroup}
      groupById={groupById}
      trialStudentIds={trialStudentIds}
        trialByLessonType={trialByLessonType}
      creditByKey={creditByKey}
      purchasesByKey={purchasesByKey}
      addCreditPurchase={addCreditPurchase}
      adjustCredit={adjustCredit}
      initCredit={initCredit}
      pendingByKey={pendingByKey}
      replacementPending={replacementPending}
      markForReplacement={markForReplacement}
      forwardClassToNextWeek={forwardClassToNextWeek}
      startFullClassMove={startFullClassMove}
      duplicateSessionForward={duplicateSessionForward}
    /> : null}
  </div>;
}

// ============================================================================
// WeekView (M2: pool toggle, sub-cols, capacity chips)
// ============================================================================

function WeekView(props){
  const { weekBlocks, weekBlocksAllPools, pools, selectedPoolId, setSelectedPoolId,
          gridBounds, gridSlots, slotToMinute, minuteToSlot, colorsFor,
          lessonTypeByName, poolById, onAdd, onEdit, activeLessonTypes,
          selectedDate, sessionsForDate, selectedWeekStart, currentWeekStart, isFutureSelectedWeek,
          onPrevWeek, onNextWeek, onThisWeek, onDuplicateWeek, onClearDay, onJumpToDay,
          isTypeEnabled, onToggleType, onToggleAllTypes, allTypesShown, onExportExcel,
          activeInstructors, isInstructorActive, onToggleInstructor, onClearInstructors, instructorFilterActive,
          weekPendingReplacements, lessonTypeById, studentById, onCancelPendingReplacement,
          pendingMove, onPlacePendingMove, onCancelPendingMove,
          trialStudentIds, trialByLessonType, creditByKey } = props;

  const [printMenu, setPrintMenu] = useState(false);

  const wb = weekBounds(selectedDate);
  const printDays = Array.from({length:7}, (_,i) => { const d = new Date(wb.start); d.setDate(wb.start.getDate()+i); const ds = toDateStr(d); return { date:d, ds, items:sessionsForDate(ds) }; });

  // Full-width agenda: 7 equal day columns fill the screen, one row per hour.
  // Sessions stack vertically inside each day-hour cell, so a busy slot grows
  // downward instead of forcing a horizontal scrollbar. Each card lays its
  // details out on separate lines.
  const showPoolBadge = !selectedPoolId && pools.length > 1;
  const startHour = Math.floor(gridBounds.startMin / 60) * 60;
  const hours = [];
  for(let h = startHour; h < gridBounds.endMin; h += 60) hours.push(h);

  const weekGrid = <>
    <div className="pool-tabs">
      <button className={`pool-tab ${selectedPoolId===null?'active':''}`} onClick={()=>setSelectedPoolId(null)}>All pools</button>
      {pools.map(p => <button key={p.id} className={`pool-tab ${selectedPoolId===p.id?'active':''}`} onClick={()=>setSelectedPoolId(p.id)}>{p.name} <span className="pool-tab-cap">cap {p.capacity_total}</span></button>)}
    </div>

    <div className="wagenda">
      <div className="wa-corner" />
      {DAYS_S.map((d,di) => {
        const dateObj = new Date(wb.start); dateObj.setDate(wb.start.getDate()+di);
        const dateStr = dateObj.toLocaleDateString(undefined,{month:'short', day:'numeric'});
        return <div key={'head'+di} className="wa-dayhead">
          <button className="week-day-link" onClick={() => onJumpToDay(di)} title={`Open ${DAYS_F[di]} daily view`}>
            <div>{d}</div>
            <div style={{fontSize:'10px',fontWeight:600,color:'#94A3B8'}}>{dateStr}</div>
          </button>
          {isFutureSelectedWeek ? <button className="week-clear-btn" onClick={(e)=>{e.stopPropagation(); onClearDay(di);}}>Remove all</button> : <div className="week-clear-placeholder">Protected</div>}
        </div>;
      })}
      {hours.map(h => <React.Fragment key={h}>
        <div className="wa-time">{hourLabel(h)}</div>
        {DAYS_S.map((_,di) => {
          const cell = weekBlocks[di].packed.filter(b => b.startMinute >= h && b.startMinute < h + 60);
          return <div key={di+'-'+h} className={`wa-cell ${pendingMove?'wa-cell-targetable':''}`} onClick={() => {
            if(pendingMove){
              onPlacePendingMove && onPlacePendingMove(di, slotToMinute(minuteToSlot(h)));
            } else {
              onAdd(di, minuteToSlot(h), selectedPoolId || undefined);
            }
          }}>
            {cell.map(block => <AgendaCard key={block.id} block={block} colorsFor={colorsFor} lessonTypeByName={lessonTypeByName} poolById={poolById} showPoolBadge={showPoolBadge} onEdit={onEdit} trialStudentIds={trialStudentIds}
        trialByLessonType={trialByLessonType} creditByKey={creditByKey} />)}
          </div>;
        })}
      </React.Fragment>)}
    </div>
  </>;

  return <>
    <div className="card print-target" style={{marginBottom:16}}>
      <div className="view-head">
        <div>
          <div className="view-title">Weekly View</div>
          <div className="small subtle">Pool shown as a badge — use the pool tabs to focus one pool. Busy days widen and scroll sideways; the time axis stays pinned.</div>
        </div>
      </div>
      <PeriodNav rangeLabel={weekRangeLabel(selectedWeekStart)} onPrev={onPrevWeek} onNext={onNextWeek} onToday={onThisWeek} isCurrent={selectedWeekStart === currentWeekStart}>
        <button className="btn btn-primary small-btn" onClick={onDuplicateWeek} disabled={!isFutureSelectedWeek}>Duplicate Previous Week</button>
        <div className="print-wrap">
          <button className="btn btn-print small-btn" onClick={()=>setPrintMenu(v=>!v)}>Print <span className="caret">▾</span></button>
          {printMenu ? <>
            <div className="menu-backdrop" onClick={()=>setPrintMenu(false)} />
            <div className="drop-menu">
              <button className="drop-item" onClick={()=>{ setPrintMenu(false); printWeeklyView(); }}>Weekly rundown <span className="drop-hint">A4 · per-day list</span></button>
              <button className="drop-item" onClick={()=>{ setPrintMenu(false); printWeeklyTable(); }}>Weekly grid <span className="drop-hint">A3 · time table</span></button>
            </div>
          </> : null}
        </div>
        <button className="btn btn-print small-btn" onClick={onExportExcel} title="Download this week as a multi-tab attendance roster">Export Excel</button>
      </PeriodNav>
      <div className="nav-note">{isFutureSelectedWeek ? 'Future week — "Remove all classes" and "Duplicate Previous Week" are enabled.' : 'Current and past weeks are protected from bulk removal.'}</div>
      <div className="legend-bar legend-bar-v" style={{marginBottom:12}}>
        <div className="legend-row">
          <span className="legend-label">Types</span>
          <div className="legend">
            {activeLessonTypes.map(t => { const c = colorsFor(t.name); const on = isTypeEnabled(t.name); return <button key={t.id || t.name} className={`chip chip-toggle ${on?'':'chip-off'}`} style={on?{background:c.bg,borderColor:c.bd,color:c.tx}:undefined} onClick={()=>onToggleType(t.name)} title={on?'Showing — click to hide':'Hidden — click to show'}>{t.name}</button>; })}
          </div>
          <button className={`legend-allbtn ${allTypesShown?'':'is-off'}`} onClick={onToggleAllTypes}>
            <span className="dot" />{allTypesShown ? 'Hide all' : 'Show all'}
          </button>
        </div>
        <div className="legend-row legend-row-instructors">
          <span className="legend-label">Instructors</span>
          <div className="legend">
            {(activeInstructors || []).length === 0 ? <span className="small subtle">No instructors</span> : (activeInstructors || []).map(inst => {
              const on = isInstructorActive(inst.id);
              const gIcon = inst.gender === 'female' ? '♀' : (inst.gender === 'male' ? '♂' : '');
              return <button key={inst.id} className={`chip chip-instructor ${on?'is-on':''}`} onClick={()=>onToggleInstructor(inst.id)} title={on?`Filtering — click to remove ${inst.name}`:`Click to filter to ${inst.name}'s classes`}>{gIcon ? <span className="inst-chip-g" aria-hidden="true">{gIcon}</span> : null}{inst.name}</button>;
            })}
          </div>
          <button className={`legend-allbtn ${instructorFilterActive?'':'is-off'}`} onClick={onClearInstructors} disabled={!instructorFilterActive} title={instructorFilterActive?'Remove instructor filter':'No instructor filter active'}>
            <span className="dot" />{instructorFilterActive ? 'Clear' : 'No filter'}
          </button>
        </div>
      </div>
      {pendingMove && <div className="pending-move-banner">
        <div className="pending-move-icon" aria-hidden="true">📅</div>
        <div className="pending-move-text">
          <div className="pending-move-title">Pick a slot to place {pendingMove.lessonTypeName}</div>
          <div className="pending-move-sub">Moving from <strong>{pendingMove.sourceLabel}</strong> · {pendingMove.swimmerCount} swimmer{pendingMove.swimmerCount===1?'':'s'} — click any time-cell in the grid below.</div>
        </div>
        <button type="button" className="btn btn-ghost small" onClick={onCancelPendingMove}>Cancel move</button>
      </div>}
      {(weekPendingReplacements || []).length > 0 && <div className="pending-repl-card">
        <div className="pending-repl-head">
          <span className="pending-repl-badge" aria-hidden="true">R</span>
          <div>
            <div className="pending-repl-title">Pending Replacements · {weekPendingReplacements.length}</div>
            <div className="pending-repl-sub">Swimmers in limbo for this week — credit untouched until they're placed in another class. Cancel below to put them back in their original class (or clear the limbo state).</div>
          </div>
        </div>
        <div className="pending-repl-list">
          {weekPendingReplacements.map(p => {
            const stu = studentById ? studentById[p.student_id] : null;
            const lt = lessonTypeById ? lessonTypeById(p.lesson_type_id) : null;
            const stillExists = (props.weekBlocks || []).some(day => (day.packed || []).some(b => b.id === p.original_session_id));
            return <div key={p.id} className="pending-repl-row">
              <div className="pending-repl-info">
                <span className="pending-repl-name">{stu ? `${stu.name}${stu.age != null ? ` (${stu.age})` : ''}` : '(unknown swimmer)'}</span>
                <span className="pending-repl-meta">{lt ? lt.name : p.lesson_type_id} · from {p.original_session_label}{!stillExists ? ' · original class deleted' : ''}</span>
              </div>
              <button type="button" className="btn btn-ghost small" onClick={()=>onCancelPendingReplacement && onCancelPendingReplacement(p, { restore: true })} title={stillExists ? `Cancel — restore to ${p.original_session_label}` : 'Original class no longer exists — clearing the limbo state only'}>{stillExists ? 'Cancel & restore' : 'Cancel only'}</button>
            </div>;
          })}
        </div>
      </div>}
      {weekGrid}
    </div>

    <div className="print-rundown">
      <div className="print-title">Weekly Daily Rundown</div>
      <div className="print-meta">{wb.start.toLocaleDateString()} to {wb.end.toLocaleDateString()}</div>
      {printDays.map(({date, ds, items}) => <div className="print-day" key={ds}>
        <h3>{date.toLocaleDateString(undefined,{weekday:'long', year:'numeric', month:'long', day:'numeric'})}</h3>
        <table><thead><tr><th style={{width:'18%'}}>Time</th><th style={{width:'17%'}}>Lesson Type</th><th style={{width:'12%'}}>Pool</th><th style={{width:'18%'}}>Instructor</th><th>Students</th></tr></thead><tbody>
          {items.length ? items.map(it => {
            const p = poolById(it.poolId);
            const instLabel = it.instructors.map(i=>i.name).join(', ') || it.legacyInstructor || '-';
            return <tr key={it.id}><td className="print-time-cell">{formatRange(it.startMinute, it.durationMinutes)}</td><td className="print-type-cell">{it.type}</td><td>{p?p.name:'-'}</td><td>{instLabel}</td><td>{it.students.map(studentLabel).join(', ') || '-'}</td></tr>;
          }) : <tr className="empty-row"><td colSpan="5">No sessions</td></tr>}
        </tbody></table>
      </div>)}
    </div>
    <PrintWeeklyTableSection weekBlocksAllPools={weekBlocksAllPools} wb={wb} selectedWeekStart={selectedWeekStart} gridSlots={gridSlots} gridBounds={gridBounds} slotToMinute={slotToMinute} poolById={poolById} />
  </>;
}

// M2.2: agenda card — a static, full-width card inside a day-hour cell. Details
// stack on separate lines; the student list wraps to use vertical space.
function AgendaCard({ block, colorsFor, lessonTypeByName, poolById, showPoolBadge, onEdit, trialStudentIds, trialByLessonType, creditByKey }){
  const c = colorsFor(block.type);
  const lt = lessonTypeByName(block.type);
  const cap = sessionCapacity(block, lt);
  const chip = capacityChipColors(cap.status);
  const pool = poolById(block.poolId);
  const isOver = cap.status === 'over';
  const missingInst = block.instructors.length === 0;
  const instName = (block.instructors[0]?.name) || block.legacyInstructor || '';
  const isPersonal = lessonTypeByName(block.type)?.class_type === 'personal';
  const isRescheduled = block.rescheduledFromDay != null;
  const isCancelled = !!block.cancelledAt;
  // Trial flag is per-lesson-type: only fires if the swimmer's enrollment
  // matches this card's lesson type. Falls back to the global set if no map
  // is passed (defensive — shouldn't happen in normal mount path).
  const trialSet = (trialByLessonType && block.lessonTypeId) ? trialByLessonType[block.lessonTypeId] : trialStudentIds;
  // Cancelled session — greyed-out shell. Clicking calls onEdit which
  // detects the cancelled state and routes to restore. Don't render
  // capacity, students, or instructor details — they're misleading
  // on a class that didn't happen.
  if(isCancelled){
    const reasonLabel = block.cancelledReason === 'forwarded' ? 'Forwarded → next week'
                      : block.cancelledReason === 'rescheduled' ? 'Rescheduled — moved'
                      : 'Cancelled';
    return <div className="wa-card wa-card-cancelled" onClick={(e)=>{e.stopPropagation(); onEdit(block);}} title="Click to restore this session to its original slot">
      <div className="wa-card-head">
        <span className="wa-card-title wa-card-title-strike">{block.type}</span>
        <span className="wa-cancelled-tag">{reasonLabel}</span>
      </div>
      <div className="wa-card-line wa-card-strike">{compactRange(block.startMinute, block.durationMinutes)}{instName ? ` · ${instName}` : ''}</div>
      <div className="wa-card-restore-hint">Click to restore</div>
    </div>;
  }
  return <div className={`wa-card ${isOver?'event-over':''} ${missingInst?'wa-card-warn':''}`}
    onClick={(e)=>{e.stopPropagation(); onEdit(block);}}
    style={{ background:c.bg, borderLeft:`3px solid ${c.bd}`, color:c.tx }}>
    {missingInst ? <span className="card-warn-corner" title="No instructor assigned — needs reassignment">⚠</span> : null}
    <div className="wa-card-head">
      <span className="wa-card-title">{block.type}</span>
      {cap.max > 0 ? <span className="cap-chip" style={{background:chip.bg, color:chip.tx, borderColor:chip.bd}}>{cap.current}/{cap.max}</span> : <span className="cap-chip cap-chip-unknown">{cap.current}</span>}
    </div>
    <div className="wa-card-line">{showPoolBadge && pool ? <span className="event-pool-pill">{pool.name}</span> : null}{compactRange(block.startMinute, block.durationMinutes)}{isRescheduled ? <span className="reschedule-tag" title={`Rescheduled — was ${DAYS_S[block.rescheduledFromDay]} ${minuteToTime(block.rescheduledFromStartMinute)}`}>⇄</span> : null}</div>
    <div className={`wa-card-line wa-card-inst ${missingInst?'inst-missing':''}`}>{missingInst ? <span className="warn-tri" title="Instructor was removed — pick a new one in the modal">⚠</span> : null}<span className={missingInst?'inst-orphan':''}>{instName || 'Unassigned'}</span>{missingInst ? <span className="inst-warn-chip">Needs instructor</span> : null}</div>
    {block.students.length
      ? <div className="wa-card-students">{block.students.map((s,i) => {
          const isTrial = !!(s.studentId && trialSet && trialSet.has(s.studentId));
          const isRepl = s.isReplacement;
          const bal = s.studentId && creditByKey ? creditByKey[`${s.studentId}:${block.lessonTypeId}`] : null;
          return <span key={s.id || i} className={`wa-stu ${isRepl?'wa-stu-repl':''}`} title={studentLabel(s) + (isTrial?' (trial)':'') + (isRepl?` replacing from ${s.replacementFrom||'?'}`:'')}>{isRepl?<span className="repl-mark">R</span>:null}{shortName(s.name) + ageSuffix(s)}{isTrial ? <span className="trial-mark"> (trial)</span> : null}{bal ? <span className={`credit-mark ${bal.remaining_balance<=2?'credit-low':''}`}> · {bal.remaining_balance}cr</span> : null}{s.remark ? ` — ${s.remark}` : ''}</span>;
        })}</div>
      : <div className="wa-card-line wa-card-students-empty">—</div>}
  </div>;
}

// ============================================================================
// DailyView (M2: pool labels on each session)
// ============================================================================

function DailyView({ selectedDate, setSelectedDate, sessionsForDate, colorsFor, lessonTypeByName, poolById, onAddAtTime, onEdit, selectedWeekStart, currentWeekStart, onPrevWeek, onNextWeek, onThisWeek, onExportExcel, activeLessonTypes, isTypeEnabled, onToggleType, onToggleAllTypes, allTypesShown, activeInstructors, isInstructorActive, onToggleInstructor, onClearInstructors, instructorFilterActive, trialStudentIds, trialByLessonType, creditByKey }){
  const wb = weekBounds(selectedDate);
  const weekDays = Array.from({length:7}, (_,i) => { const d = new Date(wb.start); d.setDate(wb.start.getDate()+i); return { date:d, ds:toDateStr(d), idx:i }; });
  const items = sessionsForDate(selectedDate);
  const hourStarts = Array.from({length:13}, (_,i) => 480 + i*60);
  return <div className="grid">
    <div className="card no-print">
      <div className="view-head">
        <div>
          <div className="view-title">Daily View</div>
          <div className="small subtle">Hour-by-hour for the selected day. Every hour is shown even when empty.</div>
        </div>
      </div>
      <PeriodNav rangeLabel={weekRangeLabel(selectedWeekStart)} onPrev={onPrevWeek} onNext={onNextWeek} onToday={onThisWeek} isCurrent={selectedWeekStart === currentWeekStart}>
        <button className="btn btn-print" onClick={() => printDailyView(selectedDate)}>Print</button>
        <button className="btn btn-print" onClick={onExportExcel} title="Download this week as a multi-tab attendance roster">Export Excel</button>
      </PeriodNav>
      <div className="nav-note">Showing <b style={{color:'var(--text)'}}>{longDate(selectedDate)}</b></div>
      <div className="daily-day-tabs">
        {weekDays.map(({date, ds, idx}) => <button key={ds} className={`daily-day-tab ${selectedDate===ds?'active':''}`} onClick={() => setSelectedDate(ds)}>{DAYS_S[idx]} · {date.toLocaleDateString(undefined,{month:'short', day:'numeric'})}</button>)}
      </div>
      <div className="legend-bar legend-bar-v" style={{marginBottom:12}}>
        <div className="legend-row">
          <span className="legend-label">Types</span>
          <div className="legend">
            {(activeLessonTypes || []).map(t => { const c = colorsFor(t.name); const on = isTypeEnabled(t.name); return <button key={t.id || t.name} className={`chip chip-toggle ${on?'':'chip-off'}`} style={on?{background:c.bg,borderColor:c.bd,color:c.tx}:undefined} onClick={()=>onToggleType(t.name)} title={on?'Showing — click to hide':'Hidden — click to show'}>{t.name}</button>; })}
          </div>
          <button className={`legend-allbtn ${allTypesShown?'':'is-off'}`} onClick={onToggleAllTypes}>
            <span className="dot" />{allTypesShown ? 'Hide all' : 'Show all'}
          </button>
        </div>
        <div className="legend-row legend-row-instructors">
          <span className="legend-label">Instructors</span>
          <div className="legend">
            {(activeInstructors || []).length === 0 ? <span className="small subtle">No instructors</span> : (activeInstructors || []).map(inst => {
              const on = isInstructorActive(inst.id);
              const gIcon = inst.gender === 'female' ? '♀' : (inst.gender === 'male' ? '♂' : '');
              return <button key={inst.id} className={`chip chip-instructor ${on?'is-on':''}`} onClick={()=>onToggleInstructor(inst.id)} title={on?`Filtering — click to remove ${inst.name}`:`Click to filter to ${inst.name}'s classes`}>{gIcon ? <span className="inst-chip-g" aria-hidden="true">{gIcon}</span> : null}{inst.name}</button>;
            })}
          </div>
          <button className={`legend-allbtn ${instructorFilterActive?'':'is-off'}`} onClick={onClearInstructors} disabled={!instructorFilterActive}>
            <span className="dot" />{instructorFilterActive ? 'Clear' : 'No filter'}
          </button>
        </div>
      </div>
      <div className="daily-grid">
        {hourStarts.map(start => {
          const rowItems = items.filter(it => it.startMinute >= start && it.startMinute < start + 60);
          return <div className="daily-row" key={start}>
            <div className="daily-time">{minuteToTime(start)}</div>
            <div className={`daily-slot ${rowItems.length ? '' : 'empty'}`}>
              {rowItems.length ? <div className="daily-sessions">
                {rowItems.map(it => {
                  const c = colorsFor(it.type);
                  const lt = lessonTypeByName(it.type);
                  const cap = sessionCapacity(it, lt);
                  const chip = capacityChipColors(cap.status);
                  const pool = poolById(it.poolId);
                  const missingInst = it.instructors.length === 0;
                  const instName = (it.instructors[0]?.name) || it.legacyInstructor || '';
                  const isPersonalIt = lessonTypeByName(it.type)?.class_type === 'personal';
                  const isRescheduledIt = it.rescheduledFromDay != null;
                  return <div key={it.id} className={`daily-event ${missingInst?'daily-event-warn':''}`} onClick={() => onEdit(it)} style={{background:c.bg, borderLeftColor:c.bd, color:c.tx}}>
                    {missingInst ? <span className="card-warn-corner" title="No instructor assigned — needs reassignment">⚠</span> : null}
                    <div className="daily-event-top">
                      <div style={{minWidth:0,flex:1}}>
                        <div className="daily-event-title" style={{color:c.tx}}>{it.type} {pool ? <span className="pool-badge">{pool.name}</span> : null}{it.familyGroupId ? <span title="Family group booking" style={{marginLeft:4}}>👪</span> : null}{isRescheduledIt ? <span className="reschedule-tag" title={`Rescheduled — was ${DAYS_S[it.rescheduledFromDay]} ${minuteToTime(it.rescheduledFromStartMinute)}`}> ⇄</span> : null}</div>
                        <div className={`daily-event-sub ${missingInst?'inst-missing':''}`}>{compactRange(it.startMinute, it.durationMinutes)} · {missingInst ? <><span className="warn-tri">⚠</span><span className="inst-orphan">{instName || 'Unassigned'}</span><span className="inst-warn-chip">Needs instructor</span></> : instName || '—'}</div>
                        {it.students.length
                          ? (() => {
                              // Per-session trial set: only swimmers whose
                              // enrolment includes THIS lesson type flag as
                              // trial. Falls back to global set defensively.
                              const trialSet = (trialByLessonType && it.lessonTypeId) ? trialByLessonType[it.lessonTypeId] : trialStudentIds;
                              return <div className="daily-event-students">{it.students.map((s, si) => {
                                const isTrial = !!(s.studentId && trialSet && trialSet.has(s.studentId));
                                const isRepl = s.isReplacement;
                                const bal = s.studentId && creditByKey ? creditByKey[`${s.studentId}:${it.lessonTypeId}`] : null;
                                return <span key={s.id || si} className={`daily-event-stu ${isRepl?'daily-stu-repl':''}`} title={isRepl?`Replacement from ${s.replacementFrom||'?'}`:undefined}>{isRepl?<span className="repl-mark-sm">R</span>:null}{s.name + ageSuffix(s)}{isTrial ? <span className="trial-mark"> (trial)</span> : null}{bal ? <span className={`credit-mark ${bal.remaining_balance<=2?'credit-low':''}`}> · {bal.remaining_balance}cr</span> : null}</span>;
                              })}</div>;
                            })()
                          : <div className="daily-event-sub">No students listed</div>}
                        {it.students.filter(s=>s.remark).map((s,ri)=><div key={ri} className="daily-event-note">📝 {shortName(s.name)}: {s.remark}</div>)}
                      </div>
                      <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:6}}>
                        {cap.max > 0 ? <span className="cap-chip cap-chip-lg" style={{background:chip.bg, color:chip.tx, borderColor:chip.bd}}>{cap.current}/{cap.max}</span> : <span className="cap-chip cap-chip-lg cap-chip-unknown">{cap.current}</span>}
                      </div>
                    </div>
                  </div>;
                })}
              </div> : <>
                <div className="small subtle">No sessions</div>
                <button className="btn btn-secondary small-btn" onClick={() => onAddAtTime(dateToWeekdayIndex(selectedDate), start)}>Add Session</button>
              </>}
              {rowItems.length ? <div style={{display:'flex',justifyContent:'flex-end',marginTop:8}}><button className="btn btn-secondary small-btn" onClick={() => onAddAtTime(dateToWeekdayIndex(selectedDate), start)}>Add Session</button></div> : null}
            </div>
          </div>;
        })}
        <div className="daily-row">
          <div className="daily-time">{minuteToTime(1260)}</div>
          <div className="daily-slot empty"><div className="small subtle">Day end marker</div></div>
        </div>
      </div>
    </div>
    <div className="print-daily">
      <div className="print-daily-heading">Daily Schedule</div>
      <div className="print-daily-date">{longDate(selectedDate)}</div>
      <table className="print-daily-table">
        <thead>
          <tr>
            <th className="print-th-time">Time</th>
            <th className="print-th-detail">Session Details</th>
          </tr>
        </thead>
        <tbody>
          {hourStarts.map(start => {
            const rowItems = items.filter(it => it.startMinute >= start && it.startMinute < start + 60);
            return <tr key={`p-${start}`}>
              <td className="print-time-cell">{minuteToTime(start)}</td>
              <td className="print-detail-cell">
                {rowItems.length
                  ? <div className="print-day-cols">
                      {rowItems.map(it => {
                        const pool = poolById(it.poolId);
                        const inst = it.instructors.map(i=>i.name).join(', ') || it.legacyInstructor || '';
                        const meta = [pool ? pool.name : '', inst].filter(Boolean).join(' · ');
                        return <div key={it.id} className="print-day-col">
                          <div className="print-session-head">{formatRange(it.startMinute, it.durationMinutes)} · {it.type}</div>
                          {meta && <div className="print-session-meta">{meta}</div>}
                          <div className="print-session-students">{it.students.length ? it.students.map(studentLabel).join(', ') : 'No students listed'}</div>
                        </div>;
                      })}
                    </div>
                  : <span className="print-no-session">—</span>
                }
              </td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>
  </div>;
}

// ============================================================================
// MonthView (unchanged from M1)
// ============================================================================

function MonthView({ monthCursor, setMonthCursor, selectedDate, setSelectedDate, monthDates, sessionsForDate, colorsFor, remarks, remarkDraft, setRemarkDraft, saveRemark, selectedItems }){
  const options = [];
  for(let y=2025;y<=2032;y++) for(let m=0;m<12;m++){ const d = new Date(y,m,1); options.push(<option key={`${y}-${m}`} value={monthKey(d)}>{d.toLocaleDateString(undefined,{month:'long', year:'numeric'})}</option>); }
  return <>
    <div className="grid grid-2">
      <div className="card">
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,flexWrap:'wrap',marginBottom:14}}>
          <div><div style={{fontSize:18,fontWeight:800}}>Monthly Calendar</div><div className="small subtle">Monday-first calendar. Click a day to expand the rundown below.</div></div>
          <div style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}}>
            <button className="btn btn-ghost" onClick={() => setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth()-1, 1))}>←</button>
            <select className="select" style={{width:240}} value={monthKey(monthCursor)} onChange={(e)=>{ const [y,m] = e.target.value.split('-').map(Number); setMonthCursor(new Date(y,m-1,1)); }}>{options}</select>
            <button className="btn btn-ghost" onClick={() => setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth()+1, 1))}>→</button>
          </div>
        </div>
        <div className="month-grid">
          {DAYS_S.map(d => <div key={d} className="month-dow">{d}</div>)}
          {monthDates.map(d => {
            const ds = toDateStr(d), inMonth = d.getMonth() === monthCursor.getMonth(), items = sessionsForDate(ds), hasRemark = !!(remarks[ds] || '').trim();
            return <div key={ds} className={`day-box ${inMonth?'':'outside'} ${selectedDate===ds?'selected':''}`} onClick={() => setSelectedDate(ds)}>
              <div className="day-top"><div className="day-num">{d.getDate()}</div><div className={`remark-dot ${hasRemark ? 'has-content' : 'empty'}`}>+remark</div></div>
              <div>{items.length ? items.slice(0,3).map(ev => { const c = colorsFor(ev.type); return <div key={ev.id} className="mini-item" style={{background:c.bg,borderLeftColor:c.bd,color:c.tx}}>{minuteToTime(ev.startMinute)} · {ev.type}</div>; }) : <div className="small subtle">No sessions</div>}</div>
            </div>;
          })}
        </div>
      </div>
      <div className="card">
        <div style={{fontSize:18,fontWeight:800}}>One-off Day Remark</div>
        <div className="small subtle" style={{margin:'4px 0 12px'}}>This remark is saved only for <b>{longDate(selectedDate)}</b>. It does not recur.</div>
        <textarea className="textarea" value={remarkDraft} onChange={(e)=>setRemarkDraft(e.target.value)} placeholder="Add closure note, special arrangement, replacement note, etc." />
        <div style={{display:'flex',justifyContent:'flex-end',marginTop:10}}><button className="btn btn-primary" onClick={saveRemark}>Save Remark</button></div>
      </div>
    </div>
    <div className="card" style={{marginTop:16}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,flexWrap:'wrap',marginBottom:12}}>
        <div><div style={{fontSize:18,fontWeight:800}}>Daily Rundown</div><div className="small subtle">{longDate(selectedDate)}</div></div>
        <div className="pill">Sessions for this date in this week's schedule</div>
      </div>
      <div className="table-wrap"><table><thead><tr><th style={{width:130}}>Time</th><th style={{width:170}}>Lesson Type</th><th style={{width:160}}>Instructor</th><th>Students</th></tr></thead><tbody>
        {selectedItems.length ? selectedItems.map(g => <tr key={g.id}><td>{formatRange(g.startMinute, g.durationMinutes)}</td><td><span className="pill">{g.type}</span></td><td>{g.instructors.map(i=>i.name).join(', ') || g.legacyInstructor}</td><td>{g.students.map(s=>s.name+ageSuffix(s)).join(', ') || '-'}</td></tr>) : <tr><td colSpan="4" className="empty">No schedule for this day.</td></tr>}
      </tbody></table></div>
    </div>
  </>;
}

// ============================================================================
// SummaryView (M2: by-pool breakdown added)
// ============================================================================

function SummaryView({ summary, pools }){
  const typeRows = Object.entries(summary.byType).sort((a,b)=>b[1]-a[1]);
  const instRows = Object.entries(summary.byInst).sort((a,b)=>b[1]-a[1]);
  const poolRows = Object.entries(summary.byPool).sort((a,b)=>b[1]-a[1]);
  return <>
    <div className="grid grid-3">
      <div className="card"><div className="small subtle">Total students</div><div style={{fontSize:34,fontWeight:800,color:'var(--primary)'}}>{summary.totalStudents}</div><div className="small subtle" style={{marginTop:6}}>Excludes lesson types containing "replacement" or "trial".</div></div>
      <div className="card"><div className="small subtle">Sessions this week</div><div style={{fontSize:34,fontWeight:800,color:'var(--teal)'}}>{summary.totalSessions}</div></div>
      <div className="card"><div className="small subtle">Active pools</div><div style={{fontSize:34,fontWeight:800,color:'#F59E0B'}}>{pools.length}</div></div>
    </div>
    <div className="grid grid-3" style={{marginTop:16}}>
      <div className="card"><div style={{fontSize:18,fontWeight:800,marginBottom:10}}>By Lesson Type</div><div className="table-wrap"><table><thead><tr><th>Lesson Type</th><th>Students</th></tr></thead><tbody>{typeRows.map(([k,v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody></table></div></div>
      <div className="card"><div style={{fontSize:18,fontWeight:800,marginBottom:10}}>By Pool</div><div className="table-wrap"><table><thead><tr><th>Pool</th><th>Students</th></tr></thead><tbody>{poolRows.map(([k,v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody></table></div></div>
      <div className="card"><div style={{fontSize:18,fontWeight:800,marginBottom:10}}>By Instructor</div><div className="table-wrap"><table><thead><tr><th>Instructor</th><th>Students</th></tr></thead><tbody>{instRows.map(([k,v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody></table></div></div>
    </div>
  </>;
}

// ============================================================================
// SettingsView (M2: pools, operating hours, expanded lesson-type editor)
// ============================================================================

function billingText(mode, count){ if(count === null || count === undefined || count === '') return ''; return `${count} ${mode === 'credit' ? 'credits' : 'monthly'}`; }
function fmtMoney(n){ if(n === null || n === undefined) return '—'; return Number.isInteger(Number(n)) ? String(Number(n)) : Number(n).toFixed(2); }

// Render package <option>s grouped by their lesson type, with any unassigned
// (legacy) packages collected at the bottom. Reused by every package dropdown.
function packageOptionGroups(packages, lessonTypes){
  const pkgs = packages || [];
  return React.createElement(React.Fragment, null,
    (lessonTypes || []).map(lt => {
      const inLt = pkgs.filter(p => p.lesson_type_id === lt.id);
      if(!inLt.length) return null;
      return React.createElement('optgroup', { key:lt.id, label:lt.name },
        inLt.map(p => React.createElement('option', { key:p.id, value:p.id },
          `${p.name}${p.pax!=null?` · ${p.pax}pax`:''}${p.amount!=null?` · RM${p.amount}`:''}${billingText(p.billing_mode,p.billing_count)?` · ${billingText(p.billing_mode,p.billing_count)}`:''}${p.is_group?' · family':''}`
        ))
      );
    }),
    (() => {
      const orphans = pkgs.filter(p => !p.lesson_type_id);
      if(!orphans.length) return null;
      return React.createElement('optgroup', { key:'__unassigned__', label:'Unassigned' },
        orphans.map(p => React.createElement('option', { key:p.id, value:p.id }, p.name))
      );
    })()
  );
}

// Look up a lesson type's "Trial" package amount (its trial fee).
function trialAmountFor(lt, packages){
  if(!lt) return null;
  const trial = (packages || []).find(p => p.lesson_type_id === lt.id && (p.name || '').toLowerCase() === 'trial' && p.is_active !== false);
  return (trial && trial.amount != null) ? Number(trial.amount) : null;
}

// Live billing for a family group. New rule: the bundle price covers the
// group regardless of how many members are actually in it (1, 2, … up to
// `required`). The account is billed for the package, not per swimmer.
// Underfill is fully allowed. Only an overfill (more members than the
// package's pax allowance) triggers the per-pax overflow surcharge — and
// even that is only applied if `fallback_per_pax` is set on the package.
function groupBilling(pkg, memberCount){
  const n = memberCount;
  if(!pkg) return { n, status:'unknown', total:null, perHead:null, required:null, bundle:null, fb:null, credits:null, mode:null, isGroup:false };
  const required = (pkg.pax != null) ? Number(pkg.pax) : null;
  const bundle   = (pkg.amount != null) ? Number(pkg.amount) : null;
  const fb       = (pkg.fallback_per_pax != null) ? Number(pkg.fallback_per_pax) : null;
  const credits  = (pkg.billing_count != null) ? Number(pkg.billing_count) : null;
  const mode     = pkg.billing_mode || 'monthly';
  // Flat / private package (e.g. a credit-based private class): the group is
  // simply a binding of swimmers sharing one package — no discount fallback.
  if(!pkg.is_group){
    const total = bundle;
    const perHead = (total != null && n > 0) ? total / n : null;
    // For a flat/private package, pax is the MAXIMUM capacity (Clara 1–3, Duo
    // 1–2). Fewer than the max is perfectly fine; only exceeding it warns.
    let status = 'flat';
    if(required != null && n > required) status = 'over_soft';
    return { n, status, total, perHead, required, bundle, fb, credits, mode, isGroup:false };
  }
  // Family bundle: account is billed the bundle price for any size ≤ required.
  // Underfill no longer falls back to per-pax — that rule was removed: a
  // Family-5 group with 3 swimmers still pays the Family-5 bundle. The
  // account opts out of the family price by changing each swimmer's
  // individual package on their enrolment instead.
  let status = 'unknown', total = null;
  if(required != null && bundle != null){
    if(n === 0){
      status = 'empty'; total = bundle;  // bundle still charged even if empty (package was purchased)
    } else if(n < required){
      status = 'under_ok'; total = bundle;  // bundle covers underfill — no fallback
    } else if(n === required){
      status = 'qualified'; total = bundle;
    } else {
      // Overfill: bundle + (extras × per-pax fallback if set, otherwise just bundle)
      status = 'over'; total = (fb != null ? bundle + (n - required) * fb : bundle);
    }
  } else if(bundle != null){
    // No pax constraint set — bundle is a flat charge regardless of size
    status = n === 0 ? 'empty' : 'flat_bundle'; total = bundle;
  }
  const perHead = (total != null && n > 0) ? total / n : null;
  return { n, status, total, perHead, required, bundle, fb, credits, mode, isGroup:true };
}

// Monthly/Credit segmented toggle + a count input whose suffix flips to match.
function BillingControl({ mode, count, onMode, onCount }){
  return <div style={{display:'flex',alignItems:'flex-end',gap:12,flexWrap:'wrap'}}>
    <div className="field" style={{margin:0}}>
      <label>Billing</label>
      <div className="seg">
        <button type="button" className={`seg-btn ${mode === 'credit' ? '' : 'on'}`} onClick={()=>onMode('monthly')}>Monthly</button>
        <button type="button" className={`seg-btn ${mode === 'credit' ? 'on' : ''}`} onClick={()=>onMode('credit')}>Credit</button>
      </div>
    </div>
    <div className="field" style={{margin:0}}>
      <label>{mode === 'credit' ? 'Credits' : 'Lessons per month'}</label>
      <div className="suffix-input">
        <input className="input" type="number" min="0" value={count} onChange={(e)=>onCount(e.target.value)} placeholder={mode === 'credit' ? '6' : '4'} />
        <span className="suffix-tag">{mode === 'credit' ? 'credits' : 'monthly'}</span>
      </div>
    </div>
  </div>;
}

function PackageEditor({ row, onSave, onCancel }){
  const [name, setName] = useState(row.name || '');
  const [pax, setPax] = useState(row.pax == null ? '' : String(row.pax));
  const [amount, setAmount] = useState(row.amount == null ? '' : String(row.amount));
  const [mode, setMode] = useState(row.billing_mode === 'credit' ? 'credit' : 'monthly');
  const [count, setCount] = useState(row.billing_count == null ? '' : String(row.billing_count));
  const [isGroup, setIsGroup] = useState(!!row.is_group);
  const [fallback, setFallback] = useState(row.fallback_per_pax == null ? '' : String(row.fallback_per_pax));
  return <div style={{width:'100%'}}>
    <div style={{display:'grid',gridTemplateColumns:'minmax(0,1fr) 90px 130px',gap:10}}>
      <div className="field" style={{margin:0}}><label>Package name</label><input className="input" value={name} onChange={(e)=>setName(e.target.value)} /></div>
      <div className="field" style={{margin:0}}><label>{isGroup ? 'Required pax' : 'Pax'}</label><input className="input" type="number" min="1" value={pax} onChange={(e)=>setPax(e.target.value)} /></div>
      <div className="field" style={{margin:0}}><label>{isGroup ? 'Bundle total (RM)' : 'Amount (RM)'}</label><input className="input" type="number" min="0" step="0.01" value={amount} onChange={(e)=>setAmount(e.target.value)} /></div>
    </div>
    <div style={{marginTop:10}}><BillingControl mode={mode} count={count} onMode={setMode} onCount={setCount} /></div>
    <label className="gb-check" style={{marginTop:10}}><input type="checkbox" checked={isGroup} onChange={e=>setIsGroup(e.target.checked)} /> Family unit (single payer for the required pax)</label>
    {isGroup ? <div className="field" style={{marginTop:8,maxWidth:280}}><label>Standard rate per pax if under-enrolled (RM)</label><input className="input" type="number" min="0" step="0.01" value={fallback} onChange={e=>setFallback(e.target.value)} placeholder="200" /></div> : null}
    <div style={{display:'flex',justifyContent:'flex-end',gap:8,marginTop:10}}>
      <button className="btn btn-ghost small" onClick={onCancel}>Cancel</button>
      <button className="btn btn-primary small" onClick={()=>{ const v = name.trim(); if(!v) return; onSave({ name:v, pax:(pax === '' ? null : Number(pax)), amount:(amount === '' ? null : Number(amount)), billing_mode:mode, billing_count:(count === '' ? null : Number(count)), is_group:isGroup, fallback_per_pax:(fallback === '' ? null : Number(fallback)) }); }}>Save</button>
    </div>
  </div>;
}

function SettingsView({ section, options, status, addOption, toggleOption, deleteOption, deleteInstructor, patchOption, reorderOption, moveOption, saveLessonType, deleteLessonType, lessonTypeCounts, codes, students, packages, addCode, updateCode, deleteCode }){
  const dragRef = React.useRef({ canDrag:false });
  const [drag, setDrag] = useState({ key:null, idx:null });
  const [over, setOver] = useState(null);
  function gripEl(){ return <span className="grip" title="Drag to reorder" onMouseDown={()=>{ dragRef.current.canDrag = true; }} onTouchStart={()=>{ dragRef.current.canDrag = true; }}>⠿</span>; }
  function dragProps(listKey, table, list, idx){
    return {
      draggable:true,
      onDragStart:(e)=>{ if(!dragRef.current.canDrag){ e.preventDefault(); return; } setDrag({ key:listKey, idx }); try{ e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain', String(idx)); }catch(_){} },
      onDragOver:(e)=>{ if(drag.key !== listKey) return; e.preventDefault(); if(over !== idx) setOver(idx); },
      onDrop:(e)=>{ e.preventDefault(); if(drag.key === listKey && drag.idx != null && drag.idx !== idx) moveOption(table, list, drag.idx, idx); setDrag({ key:null, idx:null }); setOver(null); dragRef.current.canDrag = false; },
      onDragEnd:()=>{ setDrag({ key:null, idx:null }); setOver(null); dragRef.current.canDrag = false; }
    };
  }
  function dragClass(listKey, idx){ return `${drag.key===listKey && drag.idx===idx ? 'lt-dragging' : ''} ${drag.key===listKey && over===idx && drag.idx!=null && drag.idx!==idx ? 'lt-drop' : ''}`; }
  function reorderCluster(listKey, table, list, idx){
    return <span style={{display:'inline-flex',alignItems:'center',gap:4}}>
      {gripEl()}
      <span className="reorder">
        <button className="reorder-btn" disabled={idx===0} title="Move up" onClick={()=>reorderOption(table, list, idx, -1)}>↑</button>
        <button className="reorder-btn" disabled={idx===list.length-1} title="Move down" onClick={()=>reorderOption(table, list, idx, 1)}>↓</button>
      </span>
    </span>;
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

  return <>
    {/* Pools & Operating Hours */}
    {section === 'pools' && <div className="settings-cols" style={{gridTemplateColumns:'1fr 1fr'}}>
      <div className="card">
        <div style={{fontSize:16,fontWeight:800}}>Pools</div>
        <div className="small subtle" style={{marginTop:4}}>Capacity includes every body in the water, instructors included.</div>
        <div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:12}}>
          <input className="input" style={{flex:'1 1 130px'}} placeholder="Pool name" value={newPoolName} onChange={(e)=>setNewPoolName(e.target.value)} />
          <input className="input" style={{width:96}} type="number" min="1" placeholder="Cap" value={newPoolCap} onChange={(e)=>setNewPoolCap(e.target.value)} />
          <button className="btn btn-primary" onClick={()=>{ const v = newPoolName.trim(); const c = Number(newPoolCap); if(!v || !c || c < 1) return; addOption('pool', { name:v, capacity:c }); setNewPoolName(''); setNewPoolCap(16); }}>Add</button>
        </div>
        <div className="settings-list">
          {options.pools.length ? options.pools.map((r, idx) => <div key={r.id} className={`row-item ${dragClass('pool', idx)}`} {...dragProps('pool', 'pools', options.pools, idx)}>
            <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
              {reorderCluster('pool', 'pools', options.pools, idx)}
              <span className="pill" style={{background:r.is_active?'var(--primary-soft)':'#F0F0F5',color:r.is_active?'var(--primary-on-soft)':'#9C9CAD'}}>{r.is_active?'Active':'Hidden'}</span>
              <div style={{fontWeight:600}}>{r.name}</div>
              <input className="input" style={{width:74,padding:'4px 8px',fontSize:12}} type="number" defaultValue={r.capacity_total} onBlur={(e)=>{ const v = Number(e.target.value); if(v > 0 && v !== r.capacity_total) patchOption('pools', r.id, { capacity_total: v }); }} />
            </div>
            <div style={{display:'flex',gap:6}}>
              <button className="btn btn-ghost small" onClick={()=>toggleOption('pools',r)}>{r.is_active?'Hide':'Show'}</button>
              <button className="btn btn-danger small" onClick={()=>deleteOption('pools',r,r.name)}>Delete</button>
            </div>
          </div>) : <div className="empty">No pools</div>}
        </div>
      </div>

      <div className="card">
        <div style={{fontSize:16,fontWeight:800}}>Operating Hours</div>
        <div className="small subtle" style={{marginTop:4}}>Per-weekday open and close window. Drives the visible weekly grid bounds.</div>
        <div className="settings-list">
          {DAYS_F.map((label, idx) => {
            const row = options.operatingHours.find(h => Number(h.weekday) === idx + 1);
            if(!row) return <div key={idx} className="row-item"><div className="small subtle">{label}: not configured</div></div>;
            const fmtTime = (m) => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
            return <div key={row.weekday} className="row-item">
              <div style={{display:'flex',alignItems:'center',gap:7,flexWrap:'wrap'}}>
                <div style={{minWidth:74,fontWeight:700}}>{label}</div>
                <input className="input" style={{width:128,padding:'6px 8px',fontSize:13}} type="time" defaultValue={fmtTime(row.open_minute)} onBlur={(e)=>{ const [h,m] = e.target.value.split(':').map(Number); const v = h*60+m; if(Number.isFinite(v) && v !== row.open_minute) patchOption('operating_hours', { weekday: row.weekday }, { open_minute: v }); }} />
                <span className="small subtle">to</span>
                <input className="input" style={{width:128,padding:'6px 8px',fontSize:13}} type="time" defaultValue={fmtTime(row.close_minute)} onBlur={(e)=>{ const [h,m] = e.target.value.split(':').map(Number); const v = h*60+m; if(Number.isFinite(v) && v !== row.close_minute) patchOption('operating_hours', { weekday: row.weekday }, { close_minute: v }); }} />
                <label className="small" style={{display:'flex',alignItems:'center',gap:4}}>
                  <input type="checkbox" checked={row.is_open !== false} onChange={(e)=>patchOption('operating_hours', { weekday: row.weekday }, { is_open: e.target.checked })} />
                  Open
                </label>
              </div>
            </div>;
          })}
        </div>
      </div>
    </div>}

    {/* ── Instructors ──────────────────────────────────────────────── */}
    {section === 'instructors' && <div className="card">
        <div style={{fontSize:16,fontWeight:800}}>Instructors</div>
        <div className="small subtle" style={{marginTop:4}}>Names available in the session instructor dropdown. Edit to rename or set a gender.</div>
        <div className="inst-add">
          <input className="input" placeholder="Add instructor name" value={newInstructor} onChange={(e)=>setNewInstructor(e.target.value)} />
          <div className="gender-toggle gender-toggle-sm" role="radiogroup" aria-label="Gender">
            <button type="button" className={`gender-opt ${newInstructorGender==='female'?'active':''}`} onClick={()=>setNewInstructorGender(newInstructorGender==='female'?null:'female')} title="Female">♀ F</button>
            <button type="button" className={`gender-opt ${newInstructorGender==='male'?'active':''}`} onClick={()=>setNewInstructorGender(newInstructorGender==='male'?null:'male')} title="Male">♂ M</button>
          </div>
          <button className="btn btn-primary" onClick={()=>{ const v = newInstructor.trim(); if(!v) return; addOption('instructor', { name:v, gender:newInstructorGender }); setNewInstructor(''); setNewInstructorGender(null); }}>Add</button>
        </div>
        <div className="settings-list">{options.instructors.length ? options.instructors.map((r, idx) => {
          const assigned = (lessonTypeCounts && lessonTypeCounts.__bySessionInstructor && lessonTypeCounts.__bySessionInstructor[r.id]) || 0; // not provided; computed below in row instead
          return editingInstructorId === r.id
            ? <div key={r.id} className="row-item" style={{display:'block'}}>
                <InstructorEditor row={r} onCancel={()=>setEditingInstructorId(null)} onSave={(patch)=>{ patchOption('scheduler_instructors', r.id, patch); setEditingInstructorId(null); }} />
              </div>
            : <div key={r.id} className={`row-item ${dragClass('inst', idx)}`} {...dragProps('inst', 'scheduler_instructors', options.instructors, idx)}>
                <div style={{display:'flex',alignItems:'center',gap:6,flexWrap:'nowrap',minWidth:0,overflow:'hidden'}}>
                  {reorderCluster('inst', 'scheduler_instructors', options.instructors, idx)}
                  <span className="pill" style={{fontSize:10,padding:'2px 7px',background:r.is_active?'var(--primary-soft)':'#F0F0F5',color:r.is_active?'var(--primary-on-soft)':'#9C9CAD',flexShrink:0}}>{r.is_active?'Active':'Hidden'}</span>
                  <div style={{fontWeight:700,fontSize:12,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',minWidth:0}}>{r.name}</div>
                  {r.gender ? <span className={`gender-chip gender-chip-${r.gender}`} style={{fontSize:10,padding:'2px 6px',flexShrink:0}} title={r.gender==='female'?'Female':'Male'}>{r.gender==='female'?'♀':'♂'}</span> : null}
                </div>
                <div style={{display:'flex',gap:6}}>
                  <button className="btn btn-ghost small" onClick={()=>setEditingInstructorId(r.id)}>Edit</button>
                  <button className="btn btn-ghost small" onClick={()=>toggleOption('scheduler_instructors',r)}>{r.is_active?'Hide':'Show'}</button>
                  <button className="btn btn-danger small" onClick={()=>deleteInstructor(r)}>Delete</button>
                </div>
              </div>;
        }) : <div className="empty">No instructors</div>}</div>
    </div>}

    {/* ── Lesson Types ─────────────────────────────────────────────── */}
    {section === 'lessonTypes' && <><div className="card">
      <div style={{fontSize:18,fontWeight:800}}>Lesson Types</div>
      <div className="small subtle" style={{marginTop:4}}>Create a type and pick its colors. Click Edit on a row to rename it, set age range, ratio, billing, and default pool. Renaming or recoloring updates every class on the schedule.</div>

      <div style={{display:'grid',gridTemplateColumns:'minmax(0,1fr) 78px 78px 78px 132px auto',gap:10,alignItems:'end',marginTop:14}}>
        <div className="field" style={{margin:0}}><label>Name</label><input className="input" placeholder="e.g. LTS Group" value={newTypeName} onChange={(e)=>setNewTypeName(e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>Background</label><input className="swatch" type="color" value={bg} onChange={(e)=>setBg(e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>Border</label><input className="swatch" type="color" value={bd} onChange={(e)=>setBd(e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>Text</label><input className="swatch" type="color" value={tx} onChange={(e)=>setTx(e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>Preview</label><span className="chip" style={{display:'inline-flex',alignItems:'center',justifyContent:'center',height:38,background:bg,borderColor:bd,color:tx,fontWeight:800}}>{newTypeName.trim() || 'Sample'}</span></div>
        <button className="btn btn-primary" style={{height:38}} onClick={()=>{ const v = newTypeName.trim(); if(!v) return; addOption('lessonType', { name:v, bg, bd, tx }); setNewTypeName(''); }}>Add</button>
      </div>

      <div className="settings-list">
        {options.lessonTypes.length ? options.lessonTypes.map((r, idx) => { const n = counts[r.id] || 0; const pkgCount = (options.packages||[]).filter(p=>p.lesson_type_id===r.id).length; const poolName = (options.pools.find(p=>p.id===r.default_pool_id)?.name); const editingThis = editingLessonId===r.id; const pkgPanelOpen = pkgPanelLtId===r.id; return <div key={r.id}
          className={`lesson-row ${dragClass('lt', idx)}`} {...dragProps('lt', 'scheduler_lesson_types', options.lessonTypes, idx)}>
          <div className={`lt-row-card ${!r.is_active ? 'lt-row-hidden' : ''}`}>
            <div className="lt-row-top">
              <div className="lt-row-lead">
                {reorderCluster('lt', 'scheduler_lesson_types', options.lessonTypes, idx)}
                <span className="lt-name-chip" style={{background:r.bg_color,borderColor:r.border_color,color:r.text_color}}>{r.name}</span>
                <span className={`lt-type-badge lt-type-${r.class_type||'group'}`}>{r.class_type==='personal'?'🧑 Personal':'👥 Group'}</span>
                <span className="lt-classes-pill" title="Classes on the schedule using this type">{n} {n===1?'class':'classes'}</span>
              </div>
              <div className="lt-row-actions">
                <button className={`btn-packages ${pkgPanelOpen?'active':''}`} onClick={()=>setPkgPanelLtId(pkgPanelOpen?null:r.id)} title="Manage packages nested under this lesson type">Packages <span className="pkg-count-badge">{pkgCount}</span></button>
                <button className={`btn btn-ghost small ${editingThis?'btn-active':''}`} onClick={()=>setEditingLessonId(editingThis?null:r.id)}>{editingThis?'Close':'Edit'}</button>
                <button className="btn btn-ghost small" onClick={()=>toggleOption('scheduler_lesson_types',r)}>{r.is_active?'Hide':'Show'}</button>
                <button className="btn btn-danger small" onClick={()=>deleteLessonType(r)}>Delete</button>
              </div>
            </div>
            <div className="lt-row-meta">
              <div className="lt-meta-tile">
                <span className="lt-meta-label">Ratio</span>
                <span className={`lt-meta-value ${r.students_per_instructor?'':'lt-meta-empty'}`}>{r.students_per_instructor ? `1:${r.students_per_instructor}` : '—'}</span>
              </div>
              <div className="lt-meta-tile">
                <span className="lt-meta-label">Duration</span>
                <span className={`lt-meta-value ${r.default_duration_minutes?'':'lt-meta-empty'}`}>{r.default_duration_minutes ? `${r.default_duration_minutes} min` : '—'}</span>
              </div>
              <div className="lt-meta-tile">
                <span className="lt-meta-label">Billing</span>
                <span className={`lt-meta-value ${r.billing_model?'':'lt-meta-empty'}`}>{r.billing_model || '—'}</span>
              </div>
              <div className="lt-meta-tile">
                <span className="lt-meta-label">Default Pool</span>
                <span className={`lt-meta-value ${poolName?'':'lt-meta-empty'}`}>{poolName || 'None set'}</span>
              </div>
              <div className="lt-meta-tile">
                <span className="lt-meta-label">Age</span>
                <span className={`lt-meta-value ${(r.age_min_months!=null||r.age_max_months!=null)?'':'lt-meta-empty'}`}>{(r.age_min_months!=null||r.age_max_months!=null) ? `${r.age_min_months!=null?Math.floor(r.age_min_months/12)+'y':'·'}–${r.age_max_months!=null?Math.floor(r.age_max_months/12)+'y':'·'}` : 'Any age'}</span>
              </div>
            </div>
          </div>
          {editingLessonId === r.id ? <LessonTypeEditor row={r} pools={options.pools} onSave={(patch)=>{ saveLessonType(r, patch); setEditingLessonId(null); }} /> : null}
          {pkgPanelLtId === r.id ? <LessonTypePackages
            lessonType={r}
            packages={(options.packages||[]).filter(p=>p.lesson_type_id===r.id).slice().sort((a,b)=>(a.sort_order||0)-(b.sort_order||0))}
            editPkgId={editPkgId}
            setEditPkgId={setEditPkgId}
            addOption={addOption}
            toggleOption={toggleOption}
            deleteOption={deleteOption}
            patchOption={patchOption}
            reorderOption={reorderOption}
          /> : null}
        </div>; }) : <div className="empty">No lesson types</div>}
      </div>
    </div>

    {/* Legacy packages — pre-nesting orphans, with a reassign-to-lesson-type control */}
    {(() => {
      const orphans = (options.packages || []).filter(p => !p.lesson_type_id);
      if(!orphans.length) return null;
      return <div className="card" style={{marginTop:16}}>
        <div style={{fontSize:16,fontWeight:800}}>Legacy Packages</div>
        <div className="small subtle" style={{marginTop:4}}>These packages exist from before packages were nested under lesson types. Assign each to a lesson type, or delete it. Swimmers and family groups on these still work until you reassign.</div>
        <div className="settings-list" style={{marginTop:10}}>{orphans.map(r => <div key={r.id} className="row-item">
          <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
            <span className="pill" style={{background:'#FEF3C7',color:'#92400E',borderColor:'#FCD34D'}}>Unassigned</span>
            <div style={{fontWeight:700}}>{r.name}</div>
            <span className="small subtle">{r.pax != null ? `${r.pax} pax` : '—'}{r.amount != null ? ` · RM${r.amount}` : ''}{billingText(r.billing_mode, r.billing_count) ? ` · ${billingText(r.billing_mode, r.billing_count)}` : ''}{r.is_group ? ' · 👪 family' : ''}</span>
          </div>
          <div style={{display:'flex',gap:6,alignItems:'center'}}>
            <select className="select" defaultValue="" onChange={(e)=>{ if(e.target.value) patchOption('packages', r.id, { lesson_type_id: e.target.value }); }}>
              <option value="">Move to…</option>
              {options.lessonTypes.map(lt => <option key={lt.id} value={lt.id}>{lt.name}</option>)}
            </select>
            <button className="btn btn-danger small" onClick={()=>deleteOption('packages',r,r.name)}>Delete</button>
          </div>
        </div>)}</div>
      </div>;
    })()}
    </>}

    {/* ── Referral & Discount Codes ─────────────────────────────────── */}
    {section === 'codes' && addCode && <CodesPanel codes={codes||[]} students={students||[]} packages={packages||[]} addCode={addCode} updateCode={updateCode} deleteCode={deleteCode} />}
  </>;
}

// ============================================================================
// CodesPanel — Referral & Discount code management. Two filter pills toggle
// between the two kinds, then a single table-style list with inline create/edit.
// The same row schema serves both kinds; the editor adapts its fields to
// the selected code_type. Pure record-keeping for now — redemption logic
// will live in the future invoice module.
// ============================================================================
function CodesPanel({ codes, students, packages, addCode, updateCode, deleteCode }){
  const [filter, setFilter] = useState('all');         // all | referral | discount | active | expired
  const [editingId, setEditingId] = useState(null);
  const [creating, setCreating] = useState(false);

  const today = todayStr();
  const filtered = (codes || []).filter(c => {
    if(filter === 'all') return true;
    if(filter === 'referral' || filter === 'discount') return c.code_type === filter;
    if(filter === 'active'){
      if(!c.is_active) return false;
      if(c.valid_until && c.valid_until < today) return false;
      if(c.max_uses != null && (c.current_uses || 0) >= c.max_uses) return false;
      return true;
    }
    if(filter === 'expired'){
      if(!c.is_active) return true;
      if(c.valid_until && c.valid_until < today) return true;
      if(c.max_uses != null && (c.current_uses || 0) >= c.max_uses) return true;
      return false;
    }
    return true;
  });

  function codeStatus(c){
    if(!c.is_active) return { label:'Inactive', tone:'grey' };
    if(c.valid_until && c.valid_until < today) return { label:'Expired', tone:'red' };
    if(c.valid_from && c.valid_from > today) return { label:'Scheduled', tone:'blue' };
    if(c.max_uses != null && (c.current_uses || 0) >= c.max_uses) return { label:'Used up', tone:'red' };
    return { label:'Active', tone:'green' };
  }
  function summarizeDiscount(c){
    if(!c.discount_type || c.discount_value == null) return '—';
    if(c.discount_type === 'percentage') return `${c.discount_value}% off`;
    if(c.discount_type === 'fixed') return `RM${c.discount_value} off`;
    if(c.discount_type === 'credit') return `+${c.discount_value} credits`;
    return '—';
  }
  function summarizeReferrerReward(c){
    if(c.code_type !== 'referral') return '—';
    if(!c.referrer_reward_type || c.referrer_reward_value == null) return '—';
    if(c.referrer_reward_type === 'percentage') return `${c.referrer_reward_value}% off`;
    if(c.referrer_reward_type === 'fixed') return `RM${c.referrer_reward_value} off`;
    if(c.referrer_reward_type === 'credit') return `+${c.referrer_reward_value} credits`;
    return '—';
  }
  function ownerName(id){
    const s = (students || []).find(x => x.id === id);
    return s ? s.name : '—';
  }

  return <div className="card" style={{marginTop:16}}>
    <div className="settings-section-title" style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
      <span>🎟 Referral &amp; Discount Codes</span>
      <span className="small subtle" style={{fontWeight:400,letterSpacing:0,textTransform:'none'}}>Manage promotional and referral codes. These are captured at intake and will be validated when invoices are generated.</span>
    </div>

    <div className="codes-toolbar" style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap',marginBottom:12}}>
      <div className="codes-filter" style={{display:'flex',gap:4,border:'1px solid var(--border-2)',borderRadius:6,padding:2,background:'var(--surface)'}}>
        {['all','referral','discount','active','expired'].map(f =>
          <button key={f} className={`codes-filter-pill ${filter===f?'active':''}`} onClick={()=>setFilter(f)}>{f.charAt(0).toUpperCase()+f.slice(1)}</button>
        )}
      </div>
      <div style={{marginLeft:'auto'}}>
        <button className="btn btn-primary small" onClick={()=>{ setCreating(true); setEditingId(null); }}>+ New Code</button>
      </div>
    </div>

    {creating && <CodeEditor
      initial={{}}
      students={students}
      packages={packages}
      onCancel={()=>setCreating(false)}
      onSave={async (input)=>{ try{ await addCode(input); setCreating(false); } catch(_){} }}
    />}

    {filtered.length === 0 && !creating && <div className="empty" style={{padding:24,textAlign:'center',color:'var(--text-3)'}}>No codes match this filter.</div>}

    {filtered.length > 0 && <div className="codes-table-wrap" style={{border:'1px solid var(--border-2)',borderRadius:8,overflow:'hidden'}}>
      <table className="codes-table" style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
        <thead style={{background:'var(--surface-2)'}}>
          <tr>
            <th style={{textAlign:'left',padding:'9px 10px',fontSize:10,textTransform:'uppercase',letterSpacing:.6,color:'var(--text-3)',fontWeight:800}}>Code</th>
            <th style={{textAlign:'left',padding:'9px 10px',fontSize:10,textTransform:'uppercase',letterSpacing:.6,color:'var(--text-3)',fontWeight:800}}>Type</th>
            <th style={{textAlign:'left',padding:'9px 10px',fontSize:10,textTransform:'uppercase',letterSpacing:.6,color:'var(--text-3)',fontWeight:800}}>Redeemer Benefit</th>
            <th style={{textAlign:'left',padding:'9px 10px',fontSize:10,textTransform:'uppercase',letterSpacing:.6,color:'var(--text-3)',fontWeight:800}}>Referrer Reward</th>
            <th style={{textAlign:'left',padding:'9px 10px',fontSize:10,textTransform:'uppercase',letterSpacing:.6,color:'var(--text-3)',fontWeight:800}}>Validity</th>
            <th style={{textAlign:'left',padding:'9px 10px',fontSize:10,textTransform:'uppercase',letterSpacing:.6,color:'var(--text-3)',fontWeight:800}}>Uses</th>
            <th style={{textAlign:'left',padding:'9px 10px',fontSize:10,textTransform:'uppercase',letterSpacing:.6,color:'var(--text-3)',fontWeight:800}}>Status</th>
            <th style={{textAlign:'right',padding:'9px 10px',fontSize:10,textTransform:'uppercase',letterSpacing:.6,color:'var(--text-3)',fontWeight:800}}></th>
          </tr>
        </thead>
        <tbody>
          {filtered.map(c => {
            const st = codeStatus(c);
            const isEditing = editingId === c.id;
            return <React.Fragment key={c.id}>
              <tr style={{borderTop:'1px solid var(--border-2)'}}>
                <td style={{padding:'9px 10px',fontWeight:800,fontFamily:'ui-monospace,monospace',letterSpacing:.5}}>{c.code}</td>
                <td style={{padding:'9px 10px'}}>
                  {c.code_type === 'referral'
                    ? <span style={{display:'inline-flex',gap:5,alignItems:'center',fontSize:11,fontWeight:700,color:'var(--green-tx)',background:'var(--green-bg)',padding:'2px 8px',borderRadius:5,border:'1px solid var(--green-bd)'}}>👥 Referral</span>
                    : <span style={{display:'inline-flex',gap:5,alignItems:'center',fontSize:11,fontWeight:700,color:'var(--amber-tx)',background:'var(--amber-bg)',padding:'2px 8px',borderRadius:5,border:'1px solid var(--amber-bd)'}}>🏷 Discount</span>}
                  {c.code_type === 'referral' && c.owner_student_id ? <div className="small subtle" style={{marginTop:3}}>Owner: {ownerName(c.owner_student_id)}</div> : null}
                </td>
                <td style={{padding:'9px 10px'}}>{summarizeDiscount(c)}</td>
                <td style={{padding:'9px 10px'}}>{summarizeReferrerReward(c)}</td>
                <td style={{padding:'9px 10px',fontSize:11}}>{c.valid_from || c.valid_until
                  ? <span>{c.valid_from || '—'} → {c.valid_until || 'open'}</span>
                  : <span className="subtle">Always</span>}</td>
                <td style={{padding:'9px 10px',fontSize:11}}>{c.current_uses || 0}{c.max_uses != null ? ` / ${c.max_uses}` : ' (∞)'}</td>
                <td style={{padding:'9px 10px'}}>
                  <span className={`code-status-pill code-status-${st.tone}`}>{st.label}</span>
                </td>
                <td style={{padding:'9px 10px',textAlign:'right',whiteSpace:'nowrap'}}>
                  <button className="btn btn-ghost small" onClick={()=>setEditingId(isEditing?null:c.id)}>{isEditing?'Close':'Edit'}</button>
                  <button className="btn btn-ghost small" onClick={()=>updateCode(c.id, { isActive: !c.is_active })} title={c.is_active?'Deactivate':'Reactivate'}>{c.is_active?'⏸':'▶'}</button>
                  <button className="btn btn-danger small" onClick={()=>{ if(confirm(`Delete code "${c.code}"? This cannot be undone.`)) deleteCode(c.id); }}>×</button>
                </td>
              </tr>
              {isEditing && <tr><td colSpan={8} style={{padding:0,background:'var(--surface-2)'}}>
                <div style={{padding:'12px 14px'}}>
                  <CodeEditor
                    initial={c}
                    students={students}
                    packages={packages}
                    onCancel={()=>setEditingId(null)}
                    onSave={async (input)=>{ try{ await updateCode(c.id, input); setEditingId(null); } catch(_){} }}
                  />
                </div>
              </td></tr>}
            </React.Fragment>;
          })}
        </tbody>
      </table>
    </div>}
  </div>;
}

// Inline form for creating / editing a single code. Adapts to the selected
// code_type — referral codes get an owner picker and referrer-reward fields,
// discount codes hide those.
function CodeEditor({ initial, students, packages, onCancel, onSave }){
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

  return <div className="code-editor" style={{padding:14,background:'var(--surface)',border:'1px solid var(--border-2)',borderRadius:8,marginBottom:12}}>
    <div style={{fontSize:11,textTransform:'uppercase',letterSpacing:.6,fontWeight:800,color:'var(--text-3)',marginBottom:10}}>
      {initial.id ? `Edit code "${initial.code}"` : 'New code'}
    </div>

    {/* Type + Code string */}
    <div className="form-grid" style={{gridTemplateColumns:'auto 1fr auto'}}>
      <div className="field">
        <label>Type</label>
        <div style={{display:'flex',gap:4,border:'1px solid var(--border-2)',borderRadius:6,padding:2,background:'var(--surface-2)'}}>
          <button type="button" className={`codes-type-toggle ${codeType==='discount'?'active':''}`} onClick={()=>setCodeType('discount')}>🏷 Discount</button>
          <button type="button" className={`codes-type-toggle ${codeType==='referral'?'active':''}`} onClick={()=>setCodeType('referral')}>👥 Referral</button>
        </div>
      </div>
      <div className="field">
        <label>Code <span className="req">*</span></label>
        <input className="input" value={codeStr} onChange={e=>setCodeStr(e.target.value.toUpperCase())} placeholder="e.g. SARAH2025 or NEW50" style={{fontFamily:'ui-monospace,monospace',letterSpacing:.5,fontWeight:700}} />
      </div>
      <div className="field">
        <label>Status</label>
        <label className="gb-check" style={{height:38,display:'inline-flex',alignItems:'center',gap:6}}>
          <input type="checkbox" checked={isActive} onChange={e=>setIsActive(e.target.checked)} /> Active
        </label>
      </div>
    </div>

    {isReferral && <div className="form-grid" style={{gridTemplateColumns:'1fr',marginTop:8}}>
      <div className="field">
        <label>Owner (existing customer who shares this code)</label>
        <select className="select" value={ownerStudentId} onChange={e=>setOwnerStudentId(e.target.value)}>
          <option value="">— Select swimmer —</option>
          {(students || []).filter(s => s.isActive !== false).map(s => <option key={s.id} value={s.id}>{s.name}{s.guardianName ? ` (${s.guardianName})` : ''}</option>)}
        </select>
      </div>
    </div>}

    {/* Redeemer benefit */}
    <div style={{marginTop:12,padding:'10px 12px',background:'#F0F9FF',border:'1px solid #BFDBFE',borderRadius:6}}>
      <div style={{fontSize:10,textTransform:'uppercase',letterSpacing:.6,fontWeight:800,color:'#1E40AF',marginBottom:7}}>Redeemer Benefit — what the new customer gets</div>
      <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr'}}>
        <div className="field">
          <label>Benefit Type</label>
          <select className="select" value={discountType} onChange={e=>setDiscountType(e.target.value)}>
            <option value="percentage">Percentage off</option>
            <option value="fixed">Fixed amount off (RM)</option>
            <option value="credit">Bonus credits</option>
          </select>
        </div>
        <div className="field">
          <label>Value <span className="subtle small">({discountType==='percentage'?'%':discountType==='fixed'?'RM':'credits'})</span></label>
          <input className="input" type="number" min="0" step="0.01" value={discountValue} onChange={e=>setDiscountValue(e.target.value)} placeholder={discountType==='percentage'?'10':discountType==='fixed'?'50':'4'} />
        </div>
      </div>
    </div>

    {/* Referrer reward */}
    {isReferral && <div style={{marginTop:10,padding:'10px 12px',background:'#F0FDF4',border:'1px solid #BBF7D0',borderRadius:6}}>
      <div style={{fontSize:10,textTransform:'uppercase',letterSpacing:.6,fontWeight:800,color:'#065F46',marginBottom:7}}>Referrer Reward — what the existing customer earns</div>
      <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr'}}>
        <div className="field">
          <label>Reward Type</label>
          <select className="select" value={referrerRewardType} onChange={e=>setReferrerRewardType(e.target.value)}>
            <option value="credit">Bonus credits</option>
            <option value="fixed">Fixed amount off (RM)</option>
            <option value="percentage">Percentage off</option>
          </select>
        </div>
        <div className="field">
          <label>Value <span className="subtle small">({referrerRewardType==='percentage'?'%':referrerRewardType==='fixed'?'RM':'credits'})</span></label>
          <input className="input" type="number" min="0" step="0.01" value={referrerRewardValue} onChange={e=>setReferrerRewardValue(e.target.value)} placeholder={referrerRewardType==='percentage'?'10':referrerRewardType==='fixed'?'50':'2'} />
        </div>
      </div>
    </div>}

    {/* Validity + limits */}
    <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr',marginTop:10}}>
      <div className="field">
        <label>Valid From <span className="subtle small">(blank = anytime)</span></label>
        <input className="input" type="date" value={validFrom} onChange={e=>setValidFrom(e.target.value)} />
      </div>
      <div className="field">
        <label>Valid Until <span className="subtle small">(blank = no expiry)</span></label>
        <input className="input" type="date" value={validUntil} onChange={e=>setValidUntil(e.target.value)} />
      </div>
    </div>
    <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr 1fr',marginTop:8}}>
      <div className="field">
        <label>Max Total Uses <span className="subtle small">(blank = ∞)</span></label>
        <input className="input" type="number" min="0" value={maxUses} onChange={e=>setMaxUses(e.target.value)} placeholder="unlimited" />
      </div>
      <div className="field">
        <label>Max Uses per Customer</label>
        <input className="input" type="number" min="1" value={maxUsesPerCustomer} onChange={e=>setMaxUsesPerCustomer(e.target.value)} placeholder="1" />
      </div>
      <div className="field">
        <label>Minimum Invoice (RM)</label>
        <input className="input" type="number" min="0" step="0.01" value={minimumAmount} onChange={e=>setMinimumAmount(e.target.value)} placeholder="none" />
      </div>
    </div>
    <div className="form-grid" style={{gridTemplateColumns:'1fr 2fr',marginTop:8}}>
      <div className="field">
        <label>Applies To</label>
        <select className="select" value={appliesTo} onChange={e=>setAppliesTo(e.target.value)}>
          <option value="all">All purchases</option>
          <option value="first_purchase">First purchase only</option>
        </select>
      </div>
      <div className="field">
        <label>Internal Notes</label>
        <input className="input" value={notes} onChange={e=>setNotes(e.target.value)} placeholder="e.g. Q1 launch promo, only for new families" />
      </div>
    </div>

    <div style={{display:'flex',gap:6,justifyContent:'flex-end',marginTop:14}}>
      <button className="btn btn-ghost small" onClick={onCancel}>Cancel</button>
      <button className="btn btn-primary small" onClick={()=>{
        if(!codeStr.trim()){ alert('Code string is required.'); return; }
        onSave({
          code: codeStr,
          codeType,
          ownerStudentId: isReferral ? (ownerStudentId || null) : null,
          discountType, discountValue,
          referrerRewardType: isReferral ? referrerRewardType : null,
          referrerRewardValue: isReferral ? referrerRewardValue : null,
          validFrom, validUntil,
          maxUses, maxUsesPerCustomer,
          appliesTo, minimumAmount,
          isActive, notes
        });
      }}>{initial.id ? 'Save Changes' : 'Create Code'}</button>
    </div>
  </div>;
}

// Manage packages nested under one lesson type: add, edit (PackageEditor),
// reorder with ↑/↓, hide, delete. Same controls as the old top-level card but
// scoped to its lesson type — so each type owns its Normal, Trial, Family 3…
// Inline editor for an instructor: rename + Female/Male toggle.
function InstructorEditor({ row, onSave, onCancel }){
  const [name, setName] = useState(row.name || '');
  const [gender, setGender] = useState(row.gender || null);
  function apply(){ const v = (name || '').trim(); if(!v) return; onSave({ name:v, gender: gender || null }); }
  return <div className="inst-editor">
    <div className="field" style={{margin:0,flex:1,minWidth:160}}>
      <label>Name</label>
      <input className="input" value={name} onChange={e=>setName(e.target.value)} placeholder="Instructor name" />
    </div>
    <div className="field" style={{margin:0}}>
      <label>Gender</label>
      <div className="gender-toggle">
        <button type="button" className={`gender-opt ${gender==='female'?'active':''}`} onClick={()=>setGender(gender==='female'?null:'female')}>♀ Female</button>
        <button type="button" className={`gender-opt ${gender==='male'?'active':''}`} onClick={()=>setGender(gender==='male'?null:'male')}>♂ Male</button>
      </div>
    </div>
    <div style={{display:'flex',gap:6,alignSelf:'flex-end'}}>
      <button className="btn btn-ghost small" onClick={onCancel}>Cancel</button>
      <button className="btn btn-primary small" onClick={apply}>Save</button>
    </div>
  </div>;
}

function LessonTypePackages({ lessonType, packages, editPkgId, setEditPkgId, addOption, toggleOption, deleteOption, patchOption, reorderOption }){
  const [name, setName] = useState('');
  const [pax, setPax] = useState('');
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState('monthly');
  const [count, setCount] = useState('');
  const [isGroup, setIsGroup] = useState(false);
  const [fallback, setFallback] = useState('');
  function reset(){ setName(''); setPax(''); setAmount(''); setMode('monthly'); setCount(''); setIsGroup(false); setFallback(''); }
  return <div className="lt-packages">
    <div className="lt-packages-head">
      <span className="chip" style={{background:lessonType.bg_color,borderColor:lessonType.border_color,color:lessonType.text_color,fontWeight:800}}>{lessonType.name}</span>
      <span className="small subtle">Packages nested under this lesson type</span>
    </div>

    <div className="lt-packages-list">
      {packages.length ? packages.map((r, i) => editPkgId === r.id
        ? <div key={r.id} className="row-item" style={{display:'block'}}>
            <PackageEditor row={r} onCancel={()=>setEditPkgId(null)} onSave={(patch)=>{ patchOption('packages', r.id, patch); setEditPkgId(null); }} />
          </div>
        : <div key={r.id} className="row-item">
            <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
              <div className="reorder">
                <button className="reorder-btn" disabled={i===0} title="Move up" onClick={()=>reorderOption('packages', packages, i, -1)}>↑</button>
                <button className="reorder-btn" disabled={i===packages.length-1} title="Move down" onClick={()=>reorderOption('packages', packages, i, 1)}>↓</button>
              </div>
              <span className="pill" style={{background:r.is_active?'var(--primary-soft)':'#F0F0F5',color:r.is_active?'var(--primary-on-soft)':'#9C9CAD'}}>{r.is_active?'Active':'Hidden'}</span>
              <div style={{fontWeight:700}}>{r.name}</div>
              <span className="small subtle">{r.pax != null ? `${r.pax}${r.is_group ? ' pax req.' : ' pax'}` : '—'} · {r.amount != null ? `RM${r.amount}${r.is_group ? ' bundle' : ''}` : 'no amount'}{billingText(r.billing_mode, r.billing_count) ? ` · ${billingText(r.billing_mode, r.billing_count)}` : ''}{r.is_group ? ` · 👪 family${r.fallback_per_pax != null ? `, RM${r.fallback_per_pax}/pax fallback` : ''}` : ''}</span>
            </div>
            <div style={{display:'flex',gap:6}}>
              <button className="btn btn-ghost small" onClick={()=>setEditPkgId(r.id)}>Edit</button>
              <button className="btn btn-ghost small" onClick={()=>toggleOption('packages',r)}>{r.is_active?'Hide':'Show'}</button>
              <button className="btn btn-danger small" onClick={()=>deleteOption('packages',r,r.name)}>Delete</button>
            </div>
          </div>) : <div className="empty">No packages yet for this lesson type.</div>}
    </div>

    <div className="lt-packages-add">
      <div style={{fontSize:13,fontWeight:700,marginBottom:6}}>+ Add a package under {lessonType.name}</div>
      <div style={{display:'grid',gridTemplateColumns:'minmax(0,1fr) 90px 130px',gap:10}}>
        <div className="field" style={{margin:0}}><label>Name</label><input className="input" placeholder="e.g. Family of 4" value={name} onChange={(e)=>setName(e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>Pax</label><input className="input" type="number" min="1" value={pax} onChange={(e)=>setPax(e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>Amount (RM)</label><input className="input" type="number" min="0" step="0.01" value={amount} onChange={(e)=>setAmount(e.target.value)} /></div>
      </div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-end',gap:12,marginTop:10,flexWrap:'wrap'}}>
        <BillingControl mode={mode} count={count} onMode={setMode} onCount={setCount} />
        <button className="btn btn-primary small" onClick={()=>{ const v = name.trim(); if(!v) return; addOption('package', { lessonTypeId:lessonType.id, name:v, pax, amount, billingMode:mode, billingCount:count, isGroup, fallbackPerPax:fallback }); reset(); }}>Add Package</button>
      </div>
      <div style={{display:'flex',alignItems:'flex-end',gap:14,marginTop:8,flexWrap:'wrap'}}>
        <label className="gb-check"><input type="checkbox" checked={isGroup} onChange={e=>setIsGroup(e.target.checked)} /> Family unit (single payer)</label>
        {isGroup ? <div className="field" style={{margin:0,maxWidth:260}}><label>Standard rate per pax if under-enrolled (RM)</label><input className="input" type="number" min="0" step="0.01" placeholder="200" value={fallback} onChange={e=>setFallback(e.target.value)} /></div> : null}
      </div>
    </div>
  </div>;
}

// M2: inline editor for the new lesson-type fields. Saves on Apply.
function LessonTypeEditor({ row, pools, onSave }){
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
  function setF(k, v){ setDraft(d => ({ ...d, [k]: v })); }
  function clean(v){ if(v === '' || v === undefined) return null; const n = Number(v); return Number.isFinite(n) ? n : v; }
  return <div className="lesson-edit">
    <div className="form-grid" style={{gridTemplateColumns:'repeat(4, minmax(0,1fr))'}}>
      <div className="field" style={{gridColumn:'1 / 3'}}><label>Name</label><input className="input" value={draft.name} onChange={(e)=>setF('name', e.target.value)} placeholder="Lesson type name" /></div>
      <div className="field"><label>Age min (months)</label><input className="input" type="number" value={draft.age_min_months} onChange={(e)=>setF('age_min_months', e.target.value)} placeholder="60 for 5 years" /></div>
      <div className="field"><label>Age max (months)</label><input className="input" type="number" value={draft.age_max_months} onChange={(e)=>setF('age_max_months', e.target.value)} placeholder="216 for 18 years" /></div>
      <div className="field"><label>Students per instructor</label><input className="input" type="number" value={draft.students_per_instructor} onChange={(e)=>setF('students_per_instructor', e.target.value)} placeholder="6 for 1:6" /></div>
      <div className="field"><label>Default duration (min)</label><input className="input" type="number" value={draft.default_duration_minutes} onChange={(e)=>setF('default_duration_minutes', e.target.value)} placeholder="50" /></div>
      <div className="field"><label>Default pool</label><select className="select" value={draft.default_pool_id} onChange={(e)=>setF('default_pool_id', e.target.value)}><option value="">(none)</option>{pools.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
      <div className="field"><label>Billing model</label><select className="select" value={draft.billing_model} onChange={(e)=>setF('billing_model', e.target.value)}><option value="monthly">Monthly</option><option value="credit">Credit</option></select></div>
      <div className="field"><label>Class type</label>
        <div className="gender-toggle" style={{marginTop:2}}>
          <button type="button" className={`gender-opt ${draft.class_type==='group'?'active':''}`} onClick={()=>setF('class_type','group')}>👥 Group</button>
          <button type="button" className={`gender-opt ${draft.class_type==='personal'?'active':''}`} onClick={()=>setF('class_type','personal')}>🧑 Personal</button>
        </div>
        <div className="hint" style={{marginTop:4}}>{draft.class_type==='personal'?'Private lesson — enables credit tracking and per-week reschedule':'Group lesson — enables drop-in replacement for absent swimmers'}</div>
      </div>
      <div className="field"><label>Coach in pool</label><div style={{display:'flex',alignItems:'center',gap:8,padding:'10px 0'}}><input type="checkbox" checked={draft.coach_in_pool} onChange={(e)=>setF('coach_in_pool', e.target.checked)} /><span className="small subtle">Uncheck for on-deck coaching (Strokelab Elite)</span></div></div>
      {draft.billing_model === 'monthly' ? <>
        <div className="field"><label>Monthly fee</label><input className="input" type="number" step="0.01" value={draft.monthly_fee} onChange={(e)=>setF('monthly_fee', e.target.value)} /></div>
        <div className="field"><label>Lessons per month</label><input className="input" type="number" value={draft.lessons_per_month} onChange={(e)=>setF('lessons_per_month', e.target.value)} placeholder="4" /></div>
      </> : <>
        <div className="field"><label>Credit count</label><input className="input" type="number" value={draft.credit_count} onChange={(e)=>setF('credit_count', e.target.value)} placeholder="4 or 6" /></div>
        <div className="field"><label>Credit fee (full pack)</label><input className="input" type="number" step="0.01" value={draft.credit_fee} onChange={(e)=>setF('credit_fee', e.target.value)} /></div>
      </>}
      <div className="field"><label>Background</label><input className="swatch" type="color" value={draft.bg_color} onChange={(e)=>setF('bg_color', e.target.value)} /></div>
      <div className="field"><label>Border</label><input className="swatch" type="color" value={draft.border_color} onChange={(e)=>setF('border_color', e.target.value)} /></div>
      <div className="field"><label>Text</label><input className="swatch" type="color" value={draft.text_color} onChange={(e)=>setF('text_color', e.target.value)} /></div>
    </div>
    <div style={{display:'flex',justifyContent:'flex-end',gap:8,marginTop:10}}>
      <button className="btn btn-primary" onClick={()=>{
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
      }}>Apply Changes</button>
    </div>
  </div>;
}

// ============================================================================
// SessionModal (M2: pool selector, lesson-type auto-default, capacity preview)
// ============================================================================

// M4: deterministic enrollment matcher. Given an age (or a registered swimmer)
// plus availability, it filters the selected week's sessions to age-eligible
// lesson types, ranks them by open capacity, and offers one-tap enroll/create.
function EnrollView({ sessions, students, studentById, lessonTypes, lessonTypeById, lessonTypeByName, poolById, colorsFor, gridBounds, packages, instructors, initialWeekStart, onEnroll, onCreate }){
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
  React.useEffect(() => { setActiveInsts(new Set(allInstNames)); }, [allInstNames]);

  function toggleLt(id){ setActiveLts(s => { const n = new Set(s); if(n.has(id)) n.delete(id); else n.add(id); return n; }); }
  function toggleInst(name){ setActiveInsts(s => { const n = new Set(s); if(n.has(name)) n.delete(name); else n.add(name); return n; }); setGenderMode('custom'); }
  function setGender(mode){
    setGenderMode(mode);
    if(mode === 'all'){ setActiveInsts(new Set(allInstNames)); return; }
    const filtered = (instructors || []).filter(i => (i.gender || '').toLowerCase() === mode).map(i => i.name);
    setActiveInsts(new Set(filtered));
  }

  // ── Session analysis + filtering ──────────────────────────────────
  const weekSessions = useMemo(() => sessions.filter(s => s.weekStartDate === weekStart), [sessions, weekStart]);

  const analyzed = useMemo(() => {
    return weekSessions.map(s => {
      const lt = (s.lessonTypeId && lessonTypeById(s.lessonTypeId)) || lessonTypeByName(s.type);
      const cap = sessionCapacity(s, lt);
      const isFull = cap.max > 0 && cap.current >= cap.max;
      const instName = (s.instructors?.[0]?.name) || s.legacyInstructor || '';
      return { s, lt, ltId: lt?.id, cap, isFull, instName };
    });
  }, [weekSessions, lessonTypeById, lessonTypeByName]);

  const visible = useMemo(() => {
    return analyzed.filter(a => {
      // 1. Lesson type: if any selected, must match
      if(activeLts.size > 0 && !activeLts.has(a.ltId)) return false;
      // 2. Not Full filter
      if(notFull && a.isFull) return false;
      // 3. Instructor filter
      if(a.instName && !activeInsts.has(a.instName)) return false;
      return true;
    });
  }, [analyzed, activeLts, notFull, activeInsts]);

  const byDay = useMemo(() => Array.from({length:7}, (_,di) => visible.filter(v => v.s.day === di).sort((a,b) => a.s.startMinute - b.s.startMinute)), [visible]);

  const startHour = Math.floor(gridBounds.startMin / 60) * 60;
  const hours = []; for(let h = startHour; h < gridBounds.endMin; h += 60) hours.push(h);
  const wb = weekBounds(weekStart);

  // Stats
  const totalShown = visible.length;
  const totalAll = analyzed.length;
  const fullCount = visible.filter(v => v.isFull).length;
  const openCount = totalShown - fullCount;

  return <>
    <div className="card" style={{marginBottom:16}}>
      <div className="view-head">
        <div>
          <div className="view-title">Schedule Explorer</div>
          <div className="small subtle">Filter the weekly schedule by lesson type, availability, and instructor. Click any session to view or edit.</div>
        </div>
        <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
          <span className="enroll-stat fits">{openCount} open</span>
          <span className="enroll-stat full">{fullCount} full</span>
          <span className="small subtle">{totalShown}/{totalAll} shown</span>
        </div>
      </div>
      <PeriodNav rangeLabel={weekRangeLabel(weekStart)} onPrev={()=>setWeekStart(addDays(weekStart,-7))} onNext={()=>setWeekStart(addDays(weekStart,7))} onToday={()=>setWeekStart(initialWeekStart)} isCurrent={weekStart===initialWeekStart} />

      {/* ── Lesson Type pills (additive: none selected = show all) ─── */}
      <div className="enroll-filter-section">
        <div className="enroll-filter-label">Lesson Type</div>
        <div className="enroll-filter-pills">
          {lessonTypes.map(lt => {
            const isOn = activeLts.has(lt.id);
            const c = colorsFor(lt.name);
            return <button key={lt.id} type="button" className={`enroll-pill ${isOn ? 'is-on' : ''}`} style={isOn ? {background:c.bg, borderColor:c.bd, color:c.tx} : {}} onClick={()=>toggleLt(lt.id)}>{lt.name}</button>;
          })}
          {activeLts.size > 0 ? <button type="button" className="enroll-pill-clear" onClick={()=>setActiveLts(new Set())}>✕ Clear</button> : null}
        </div>
      </div>

      {/* ── Availability toggle ──────────────────────────────────────── */}
      <div className="enroll-filter-section">
        <div className="enroll-filter-label">Availability</div>
        <div className="enroll-filter-pills">
          <button type="button" className={`enroll-pill ${notFull ? 'is-on' : ''}`} style={notFull ? {background:'#D1FAE5',borderColor:'#10B981',color:'#065F46'} : {}} onClick={()=>setNotFull(v=>!v)}>Not Full Only</button>
        </div>
      </div>

      {/* ── Instructor filters + gender quick-toggles ────────────────── */}
      <div className="enroll-filter-section">
        <div className="enroll-filter-label">Instructor</div>
        <div className="enroll-filter-pills" style={{marginBottom:4}}>
          <button type="button" className={`enroll-pill ${genderMode==='all'?'is-on':''}`} style={genderMode==='all'?{background:'#DBEAFE',borderColor:'#3B82F6',color:'#1E3A8A'}:{}} onClick={()=>setGender('all')}>All</button>
          <button type="button" className={`enroll-pill ${genderMode==='male'?'is-on':''}`} style={genderMode==='male'?{background:'#DBEAFE',borderColor:'#3B82F6',color:'#1E3A8A'}:{}} onClick={()=>setGender('male')}>♂ Male</button>
          <button type="button" className={`enroll-pill ${genderMode==='female'?'is-on':''}`} style={genderMode==='female'?{background:'#FCE7F3',borderColor:'#EC4899',color:'#831843'}:{}} onClick={()=>setGender('female')}>♀ Female</button>
        </div>
        <div className="enroll-filter-pills">
          {(instructors || []).map(inst => {
            const isOn = activeInsts.has(inst.name);
            return <button key={inst.id||inst.name} type="button" className={`enroll-pill ${isOn ? 'is-on' : ''}`} onClick={()=>toggleInst(inst.name)}>{inst.name}</button>;
          })}
        </div>
      </div>
    </div>

    <div className="card">
      <div className="enroll-grid">
        <div className="enroll-grid-corner" />
        {DAYS_S.map((d,di) => {
          const dt = new Date(wb.start); dt.setDate(wb.start.getDate()+di);
          return <div key={'h'+di} className="enroll-grid-dayhead">
            <div className="enroll-grid-dayname">{d}</div>
            <div className="enroll-grid-daydate">{dt.toLocaleDateString(undefined,{month:'short',day:'numeric'})}</div>
          </div>;
        })}
        {hours.map(h => <React.Fragment key={h}>
          <div className="enroll-grid-time">{hourLabel(h)}</div>
          {DAYS_S.map((_,di) => {
            const cellInfos = byDay[di].filter(v => v.s.startMinute >= h && v.s.startMinute < h + 60);
            return <div key={'c'+di+'-'+h} className="enroll-grid-cell">
              {cellInfos.map(info => {
                const c = colorsFor(info.s.type);
                const capLabel = info.cap.max > 0 ? `${info.cap.current}/${info.cap.max}` : `${info.cap.current}`;
                return <div key={info.s.id} className={`enroll-mini ${info.isFull ? 'mini-full' : 'mini-fits'}`} style={{borderLeftColor:c.bd,background:c.bg}} onClick={(e)=>{ e.stopPropagation(); onEnroll(info.s, []); }}>
                  <div className="enroll-mini-top">
                    <span className="enroll-mini-type" style={{color:c.tx}}>{info.s.type}</span>
                    <span className="enroll-mini-cap">{capLabel}</span>
                  </div>
                  <div className="enroll-mini-meta">{minuteToTime(info.s.startMinute)}{info.instName ? ` · ${info.instName}` : ''}</div>
                </div>;
              })}
            </div>;
          })}
        </React.Fragment>)}
      </div>
    </div>
  </>;
}

// Searchable swimmer combobox used in each enrollment slot.
// The dropdown is portalled into document.body and positioned with
// position:fixed so it floats above the modal — never clipped by the
// scrollable modal-body. Auto-flips upward when there isn't enough room
// below; tracks the input on window scroll/resize.
function StudentSelect({ valueId, fallbackLabel, studentById, candidates, onPick, conflict, trialStudentIds, pendingByKey, weekStartDate, lessonTypeId }){
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [popPos, setPopPos] = useState(null);   // { left, top, width, flipUp, maxH }
  const triggerRef = React.useRef(null);
  const sel = valueId ? studentById[valueId] : null;
  const label = sel ? `${sel.name}${sel.age != null ? ` (${sel.age})` : ''}` : (fallbackLabel || '');
  const filtered = (candidates || []).filter(s => !q || (s.name || '').toLowerCase().includes(q.toLowerCase()));
  // Trial flag is context-sensitive: a swimmer's global "trial" status only
  // surfaces here if the current session's lesson type matches one of their
  // enrolled lesson types. A trial LTS swimmer dropped into a Personal-class
  // dropdown reads as a regular candidate, not as "trial".
  function isTrialFor(s){
    if(!(trialStudentIds && trialStudentIds.has(s.id))) return false;
    if(!lessonTypeId) return false;
    return (s.lessonTypeIds || []).includes(lessonTypeId);
  }
  // Sort: pending-replacement first, then context-matching trial, then the
  // rest alphabetical — so flagged candidates surface at the top of the
  // dropdown when scheduler is looking for one.
  const sortedFiltered = filtered.slice().sort((a, b) => {
    const aP = !!(pendingByKey && lessonTypeId && weekStartDate && pendingByKey[`${a.id}:${lessonTypeId}:${weekStartDate}`]);
    const bP = !!(pendingByKey && lessonTypeId && weekStartDate && pendingByKey[`${b.id}:${lessonTypeId}:${weekStartDate}`]);
    if(aP !== bP) return aP ? -1 : 1;
    const aT = isTrialFor(a);
    const bT = isTrialFor(b);
    if(aT !== bT) return aT ? -1 : 1;
    return (a.name || '').localeCompare(b.name || '');
  });
  function choose(s){ onPick(s); setOpen(false); setQ(''); }

  // Recompute popup position from the trigger's bounding rect. Used on
  // open + on resize + on capture-phase scroll so scrolling the modal
  // body keeps the dropdown stuck to the input.
  function recalcPos(){
    const el = triggerRef.current;
    if(!el) return;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const desired = 280; // ideal dropdown height
    const spaceBelow = vh - r.bottom - 12;
    const spaceAbove = r.top - 12;
    const flipUp = spaceBelow < 180 && spaceAbove > spaceBelow;
    const maxH = Math.min(desired, Math.max(140, flipUp ? spaceAbove : spaceBelow));
    setPopPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 260) - 8)),
      top: flipUp ? null : (r.bottom + 5),
      bottom: flipUp ? (vh - r.top + 5) : null,
      width: Math.max(r.width, 260),
      maxH
    });
  }
  React.useEffect(() => {
    if(!open) return;
    recalcPos();
    const onResize = () => recalcPos();
    const onScroll = () => recalcPos();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);  // capture so modal-body scroll also fires
    return () => { window.removeEventListener('resize', onResize); window.removeEventListener('scroll', onScroll, true); };
  }, [open]);

  // The dropdown body — extracted so we can portal it cleanly.
  const dropdown = open && popPos ? <>
    <div className="ssel-backdrop" onClick={()=>{ setOpen(false); setQ(''); }} />
    <div className="ssel-pop ssel-pop-portal" style={{
      position:'fixed',
      left: popPos.left,
      ...(popPos.top != null ? { top: popPos.top } : {}),
      ...(popPos.bottom != null ? { bottom: popPos.bottom } : {}),
      width: popPos.width
    }}>
      <div className="ssel-list" style={{ maxHeight: popPos.maxH }}>
        {sortedFiltered.length ? sortedFiltered.map(s => {
          const isPending = !!(pendingByKey && lessonTypeId && weekStartDate && pendingByKey[`${s.id}:${lessonTypeId}:${weekStartDate}`]);
          const isTrial = isTrialFor(s);
          const pendingInfo = isPending ? pendingByKey[`${s.id}:${lessonTypeId}:${weekStartDate}`] : null;
          return <button key={s.id} type="button" className={`ssel-item ${isPending ? 'ssel-item-pending' : ''} ${isTrial ? 'ssel-item-trial' : ''}`} onClick={()=>choose(s)}>
            <span className="ssel-item-main">
              {isPending ? <span className="ssel-flag ssel-flag-r" title={`Pending replacement from ${pendingInfo.original_session_label}`}>R-pending</span> : null}
              {isTrial ? <span className="ssel-flag ssel-flag-trial" title="Trial swimmer — one-off booking for this lesson type">trial</span> : null}
              <span className="ssel-item-name">{s.name}</span>
            </span>
            <span className="ssel-item-meta">{s.age != null ? `${s.age}y` : ''}{isPending ? ` · from ${pendingInfo.original_session_label}` : (s.package ? ` · ${s.package}` : '')}</span>
          </button>;
        }) : <div className="ssel-empty">No swimmers found</div>}
      </div>
    </div>
  </> : null;

  return <div className="ssel" ref={triggerRef}>
    <div className={`ssel-control ${label ? 'has' : ''}`}>
      <input
        className="ssel-input"
        type="text"
        value={open ? q : label}
        placeholder={label ? '' : 'Type to search swimmer…'}
        onFocus={()=>{ setOpen(true); setQ(''); }}
        onChange={(e)=>{ setQ(e.target.value); if(!open) setOpen(true); }} />
      {label
        ? <span className="ssel-x" title="Clear slot" onMouseDown={(e)=>{ e.preventDefault(); onPick(null); setQ(''); setOpen(false); }}>×</span>
        : <span className="ssel-caret" title="Browse" onMouseDown={(e)=>{ e.preventDefault(); setOpen(o=>!o); setQ(''); }}>▾</span>}
    </div>
    {conflict ? <div className="ssel-warn">⚠ Also booked {conflict} this week</div> : null}
    {dropdown ? ReactDOM.createPortal(dropdown, document.body) : null}
  </div>;
}

// Shared component used by both the register form and the editor — renders
// a list of (Lesson Type, Package) rows with a "+ Add Lessons" button.
// Already-selected lesson types are filtered out of the dropdown for the
// other rows so the unique(student_id, lesson_type_id) constraint is never
// violated by the UI.
function LessonsEditor({ enrollments, setEnrollments, lessonTypes, packages }){
  function update(idx, field, value){
    const next = enrollments.map((e, i) => i === idx ? { ...e, [field]: value, ...(field === 'lessonTypeId' ? { packageId: '' } : {}) } : e);
    setEnrollments(next);
  }
  function add(){ setEnrollments([...enrollments, { lessonTypeId: '', packageId: '' }]); }
  function remove(idx){ setEnrollments(enrollments.filter((_, i) => i !== idx)); }
  return <>
    <div className="lessons-rows">
      {enrollments.map((e, i) => {
        const ltPkgs = e.lessonTypeId ? (packages || []).filter(p => p.lesson_type_id === e.lessonTypeId && p.is_active !== false) : [];
        const usedLtIds = enrollments.map((en, j) => j !== i ? en.lessonTypeId : null).filter(Boolean);
        const availableLts = (lessonTypes || []).filter(lt => !usedLtIds.includes(lt.id));
        return <div key={i} className="lesson-row">
          <select className="select" value={e.lessonTypeId} onChange={ev => update(i, 'lessonTypeId', ev.target.value)}>
            <option value="">— Lesson Type —</option>
            {availableLts.map(lt => <option key={lt.id} value={lt.id}>{lt.name}</option>)}
          </select>
          <select className="select" value={e.packageId || ''} onChange={ev => update(i, 'packageId', ev.target.value)} disabled={!e.lessonTypeId}>
            <option value="">{e.lessonTypeId ? '— Package —' : '← pick type first'}</option>
            {ltPkgs.map(p => <option key={p.id} value={p.id}>{p.name}{p.amount != null ? ` · RM${p.amount}` : ''}{billingText(p.billing_mode, p.billing_count) ? ` · ${billingText(p.billing_mode, p.billing_count)}` : ''}</option>)}
          </select>
          {enrollments.length > 1 ? <button type="button" className="lesson-row-x" onClick={() => remove(i)} title="Remove this lesson">×</button> : <span className="lesson-row-x-spacer" />}
        </div>;
      })}
    </div>
    <button type="button" className="btn btn-ghost lesson-add-btn" onClick={add}>+ Add Lessons</button>
  </>;
}

function StudentEditor({ row, lessonTypes, packages, onSave, hideAccountSections }){
  const [name, setName] = useState(row.name || '');
  const [dob, setDob] = useState(row.dob || '');
  const [gender, setGender] = useState(row.gender || null);
  const [enrollments, setEnrollments] = useState(
    (row.enrollments && row.enrollments.length)
      ? row.enrollments.map(e => ({ lessonTypeId: e.lessonTypeId || '', packageId: e.packageId || '' }))
      : (row.lessonTypeIds && row.lessonTypeIds.length
          ? row.lessonTypeIds.map((ltId, i) => ({ lessonTypeId: ltId, packageId: i === 0 ? (row.packageId || '') : '' }))
          : [{ lessonTypeId: '', packageId: '' }])
  );
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
  function handleSameAsGuardian(v){
    setSameAsGuardian(v);
    if(v){
      setEmergencyName(guardianName);
      setEmergencyPhone(guardianPhone);
      setEmergencyRel('Account Holder');
    }
  }
  // Adult-self: account holder name == swimmer name. Pre-fills swimmer
  // name from the (already typed) account holder name when toggled on,
  // and keeps them in sync while the toggle is active.
  function handleAdultSelf(v){
    setAdultSelf(v);
    if(v){
      if(guardianName) setName(guardianName);
      else if(name) setGuardianName(name);
    }
  }
  const computedAge = dob ? ageFromDob(dob) : null;

  return <div className="lesson-edit">
    {/* Account Holder + Emergency Contact (only in +New Account flow) */}
    {!hideAccountSections && <>
      <div className="account-section">
        <div className="account-section-title">Parent / Guardian (Account Holder)</div>
        <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr 1fr'}}>
          <div className="field"><label>Parent Name</label><input className="input" value={guardianName} onChange={e=>{ setGuardianName(e.target.value); if(adultSelf) setName(e.target.value); if(sameAsGuardian) setEmergencyName(e.target.value); }} placeholder="Full name" /></div>
          <div className="field"><label>Email</label><input className="input" type="email" value={guardianEmail} onChange={e=>setGuardianEmail(e.target.value)} placeholder="email@example.com" /></div>
          <div className="field"><label>Phone</label><input className="input" type="tel" value={guardianPhone} onChange={e=>{ setGuardianPhone(e.target.value); if(sameAsGuardian) setEmergencyPhone(e.target.value); }} placeholder="+60 1X-XXXXXXX" /></div>
        </div>
      </div>
      <div className="account-section">
        <div className="account-section-title">Emergency Contact</div>
        <label className="gb-check" style={{marginBottom:7,display:'inline-flex',gap:6,alignItems:'center'}}><input type="checkbox" checked={sameAsGuardian} onChange={e=>handleSameAsGuardian(e.target.checked)} /> Same as account holder above</label>
        <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr 1fr'}}>
          <div className="field"><label>Emergency Contact Name</label><input className="input" value={sameAsGuardian?guardianName:emergencyName} onChange={e=>setEmergencyName(e.target.value)} disabled={sameAsGuardian} placeholder="Full name" /></div>
          <div className="field"><label>Phone</label><input className="input" type="tel" value={sameAsGuardian?guardianPhone:emergencyPhone} onChange={e=>setEmergencyPhone(e.target.value)} disabled={sameAsGuardian} placeholder="+60 1X-XXXXXXX" /></div>
          <div className="field"><label>Relationship</label><input className="input" value={sameAsGuardian?'Account Holder':emergencyRel} onChange={e=>setEmergencyRel(e.target.value)} disabled={sameAsGuardian} placeholder="e.g. Mother, Father, Spouse, Sibling" /></div>
        </div>
      </div>
    </>}

    {/* Swimmer Details — kept simple: name, DOB, gender, then lessons */}
    <div className="student-form-section">
      <div className="student-form-section-title">Swimmer Details</div>
      <div className="form-grid" style={{gridTemplateColumns:'1.3fr 130px 60px auto'}}>
        <div className="field"><label>Name</label><input className="input" value={name} onChange={e=>{ setName(e.target.value); if(adultSelf) setGuardianName(e.target.value); }} disabled={adultSelf && !!guardianName} /></div>
        <div className="field"><label>Date of Birth</label><input className="input" type="date" value={dob} max={todayStr()} onChange={e=>setDob(e.target.value)} /></div>
        <div className="field"><label>Age</label><div className={`age-display ${computedAge==null?'is-empty':''}`} aria-label="Auto-calculated age">{ageDisplay(computedAge)}</div></div>
        <div className="field"><label>Gender</label>
          <div className="gender-toggle"><button type="button" className={`gender-opt ${gender==='female'?'active':''}`} onClick={()=>setGender(gender==='female'?null:'female')}>♀ F</button><button type="button" className={`gender-opt ${gender==='male'?'active':''}`} onClick={()=>setGender(gender==='male'?null:'male')}>♂ M</button></div>
        </div>
      </div>
    </div>
    <div className="student-form-section">
      <div className="student-form-section-title">Lessons</div>
      <LessonsEditor enrollments={enrollments} setEnrollments={setEnrollments} lessonTypes={lessonTypes} packages={packages} />
    </div>
    {/* Adult-self toggle — sits within the swimmer-details zone since it
        affects swimmer naming. Hidden in nested mode where the account
        relationship is already established. */}
    {!hideAccountSections && <label className="adult-self-toggle gb-check">
      <input type="checkbox" checked={adultSelf} onChange={e=>handleAdultSelf(e.target.checked)} />
      <span>Adult swimmer — I am my own guardian <span className="subtle small">(pre-fill swimmer name with account holder name)</span></span>
    </label>}

    <div style={{display:'flex',justifyContent:'flex-end',marginTop:10}}><button className="btn btn-primary" onClick={()=>{
      const v = name.trim(); if(!v) return;
      // In nested mode (editing a swimmer under an existing account),
      // the patch omits guardian/emergency — those are owned at the
      // account level and propagated separately by ParentContactEditor.
      const patch = { name:v, dateOfBirth: dob || null, gender, enrollments };
      if(!hideAccountSections){
        patch.guardianName = guardianName;
        patch.guardianEmail = guardianEmail;
        patch.guardianPhone = guardianPhone;
        patch.emergencySameAsGuardian = sameAsGuardian;
        patch.emergencyName = sameAsGuardian ? guardianName : emergencyName;
        patch.emergencyPhone = sameAsGuardian ? guardianPhone : emergencyPhone;
        patch.emergencyRelationship = sameAsGuardian ? 'Account Holder' : emergencyRel;
      }
      onSave(patch);
    }}>Save Swimmer</button></div>
  </div>;
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
function BalanceAdjuster({ currentBalance, onApply }){
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState(String(currentBalance));
  function submit(){
    const target = Math.max(0, parseInt(val, 10) || 0);
    if(target === currentBalance){ setOpen(false); return; }
    if(!confirm(`Set balance to ${target}? (Currently ${currentBalance}.)\n\nThis will record a manual adjustment of ${target - currentBalance > 0 ? '+' : ''}${target - currentBalance} credits.`)) return;
    onApply(target, null);
    setOpen(false);
  }
  if(!open){
    return <button className="btn btn-ghost small" title="Manually set balance to a specific value" onClick={()=>{ setVal(String(currentBalance)); setOpen(true); }}>⚖ Adjust</button>;
  }
  return <span className="balance-adjust-form">
    <span className="balance-adjust-label">Set to:</span>
    <input className="input" type="number" min="0" value={val} onChange={e=>setVal(e.target.value)} onKeyDown={e=>{ if(e.key==='Enter') submit(); if(e.key==='Escape') setOpen(false); }} style={{width:60,padding:'3px 6px',fontSize:11}} autoFocus />
    <button className="btn btn-primary small" onClick={submit}>Apply</button>
    <button className="btn btn-ghost small" onClick={()=>setOpen(false)}>Cancel</button>
  </span>;
}

function CreditHistoryPanel({ swimmer, lessonTypes, lessonTypeById, purchases, subscriptions, creditByKey, groupById, membersByGroup, addCreditPurchase, deleteCreditPurchase, addSubscription, cancelSubscription, adjustBalanceTo, onClose }){
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
  Object.values(purchasesByLt).forEach(arr => arr.sort((a,b) => (b.purchase_date || '').localeCompare(a.purchase_date || '') || (b.created_at || '').localeCompare(a.created_at || '')));

  // Lesson types to display — all enrolled types, plus any LT that has
  // purchase history but no current enrollment (so historical records
  // don't vanish when a swimmer un-enrolls).
  const displayLtIds = new Set(swimmerLts.map(lt => lt.id));
  Object.keys(purchasesByLt).forEach(id => displayLtIds.add(id));
  const displayLts = [...displayLtIds].map(id => lessonTypeById(id)).filter(Boolean);

  async function submitPurchase(){
    if(!ltId || !credits) return;
    setBusy(true);
    try{
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
    } finally { setBusy(false); }
  }

  function fmtDate(d){
    if(!d) return '';
    try{ return new Date(d).toLocaleDateString(undefined, { day:'numeric', month:'short', year:'numeric' }); } catch(_){ return d; }
  }
  function sourceLabel(s){
    if(s === 'signup') return '🆕 Sign-up';
    if(s === 'topup') return '💳 Top-up';
    if(s === 'gift') return '🎁 Gift';
    if(s === 'manual') return '✏️ Manual';
    if(s === 'refund') return '↩ Refund';
    return s || '—';
  }

  return <div className="credit-panel">
    <div className="credit-panel-head">
      <div>
        <div className="credit-panel-title">💳 Credit ledger · {swimmer.name}</div>
        <div className="credit-panel-sub">Every purchase recorded with its date. The running balance is purchases minus credits consumed by attendance.</div>
      </div>
      <button className="btn btn-ghost small" onClick={onClose}>Close</button>
    </div>

    {/* Add-purchase form */}
    <div className="credit-add-form">
      <div className="credit-add-row">
        <div className="field"><label>Date</label><input className="input" type="date" value={purchaseDate} onChange={e=>setPurchaseDate(e.target.value)} /></div>
        <div className="field"><label>Lesson Type</label>
          <select className="select" value={ltId} onChange={e=>setLtId(e.target.value)}>
            <option value="">— select —</option>
            {(lessonTypes || []).map(lt => <option key={lt.id} value={lt.id}>{lt.name}</option>)}
          </select>
        </div>
        <div className="field"><label>Credits</label><input className="input" type="number" value={credits} onChange={e=>setCredits(e.target.value)} placeholder="4" /></div>
        <div className="field"><label>Source</label>
          <select className="select" value={source} onChange={e=>setSource(e.target.value)}>
            <option value="signup">Sign-up</option>
            <option value="topup">Top-up</option>
            <option value="gift">Gift</option>
            <option value="manual">Manual adjustment</option>
            <option value="refund">Refund</option>
          </select>
        </div>
        <div className="field" style={{flex:'2 1 240px'}}>
          <label>Notes <span className="subtle" style={{textTransform:'none',letterSpacing:0,fontWeight:600}}>· optional</span></label>
          <input className="input" value={notes} onChange={e=>setNotes(e.target.value)} placeholder="e.g. cash, receipt #1234" />
        </div>
      </div>
      <div style={{display:'flex',justifyContent:'flex-end',marginTop:6,gap:6}}>
        <span className="credit-add-hint">Use negative credits to record a manual deduction (e.g. expiry).</span>
        <button className="btn btn-primary small" onClick={submitPurchase} disabled={busy || !ltId || !Number(credits)}>{busy ? 'Saving…' : '+ Record purchase'}</button>
      </div>
    </div>

    {/* Group context banner */}
    {group ? <div className={`credit-group-banner ${isBoundMember?'credit-group-banner-bound':''}`}>
      {isBoundMember
        ? <>🔗 <strong>{group.name}</strong> · bound group — all subscription changes happen at the group level. Individual purchase records are kept for the audit trail but no manual +/− adjustments are made here.</>
        : <>👪 <strong>{group.name}</strong> · discount group — subscriptions can be added at the group level (adds to all members) and balances can diverge per-swimmer based on attendance.</>}
    </div> : null}

    {/* Per-lesson-type ledgers */}
    {displayLts.length === 0 && <div className="credit-panel-empty">No lesson-type enrolments yet. Add one in Edit, then record a purchase here.</div>}
    {displayLts.map(lt => {
      const bal = creditByKey[`${swimmer.id}:${lt.id}`];
      const list = purchasesByLt[lt.id] || [];
      const totalPurchased = list.reduce((sum,p) => sum + Number(p.credits_added || 0), 0);
      // Subscriptions affecting this swimmer for this LT — either as
      // direct subject (student type) or as member of their family group
      // (group type).
      const subs = (subscriptions || []).filter(s =>
        s.lesson_type_id === lt.id &&
        ((s.subject_type === 'student' && s.subject_id === swimmer.id) ||
         (s.subject_type === 'family_group' && swimmer.familyGroupId && s.subject_id === swimmer.familyGroupId))
      ).slice().sort((a,b) => (b.subscription_date||'').localeCompare(a.subscription_date||''));
      // Subscription-quick-add is shown for individuals and unbound group
      // members (the latter triggers a group-wide subscription). Bound
      // group members must use the Family Groups panel.
      const canQuickSub = !isBoundMember && addSubscription;
      return <div key={lt.id} className="credit-lt-block">
        <div className="credit-lt-head">
          <span className="credit-lt-name" style={{background:lt.bg_color,color:lt.text_color,borderColor:lt.border_color}}>{lt.name}</span>
          <span className="credit-lt-totals">
            {bal
              ? <>
                  <strong className={bal.remaining_balance<=2?'credit-low':''}>{bal.remaining_balance}</strong> remaining of <strong>{bal.initial_balance}</strong> total
                </>
              : <em className="subtle">No balance row yet</em>}
            {list.length > 0 && <span className="credit-lt-aggregate"> · {totalPurchased > 0 ? '+' : ''}{totalPurchased} credits across {list.length} record{list.length===1?'':'s'}</span>}
          </span>
          {/* Manual adjust — direct override that writes a manual purchase
              row for the delta. Use to correct legacy balances that have
              no purchase/subscription record to cancel against. */}
          {adjustBalanceTo && !isBoundMember && <BalanceAdjuster
            currentBalance={bal ? Number(bal.remaining_balance) || 0 : 0}
            onApply={(target, notes) => adjustBalanceTo(swimmer.id, lt.id, target, notes)} />}
        </div>

        {canQuickSub && <div className="credit-sub-quick">
          <span className="credit-sub-quick-label">Quick subscription:</span>
          {[1, 2, 3].map(qty => <button key={qty} className="btn btn-ghost small" title={`Add ${qty}× ${credits || 4}-credit subscription${isUnboundGroupMember ? ` to every member of ${group.name}` : ''}`}
            onClick={()=>addSubscription({
              subjectType: isUnboundGroupMember ? 'family_group' : 'student',
              subjectId: isUnboundGroupMember ? swimmer.familyGroupId : swimmer.id,
              lessonTypeId: lt.id,
              creditsPerSwimmer: 4,
              quantity: qty,
              source: 'subscription',
              notes: `Quick add (${qty}× 4-credit subscription)`
            })}>
            +{qty * 4}
          </button>)}
          {isUnboundGroupMember && <span className="subtle small" style={{fontSize:10}}>· applies to whole group</span>}
        </div>}

        {subs.length > 0 && <div className="credit-sub-list">
          <div className="credit-sub-list-title">Subscription log</div>
          {subs.map(s => <div key={s.id} className={`credit-sub-row ${s.cancelled_at?'is-cancelled':''}`}>
            <span className="credit-sub-date">{fmtDate(s.subscription_date)}</span>
            <span className="credit-sub-amount">+{s.credits_per_swimmer} × {s.swimmer_count}</span>
            <span className="credit-sub-subject">{s.subject_type === 'family_group' ? `👪 ${group?.name || 'group'}` : '👤 individual'}</span>
            <span className="credit-sub-meta subtle">{s.source}{s.amount_paid != null ? ` · RM${s.amount_paid}` : ''}{s.receipt_number ? ` · ${s.receipt_number}` : ''}</span>
            {s.cancelled_at
              ? <span className="credit-sub-cancelled-tag">Cancelled</span>
              : cancelSubscription ? <button className="btn btn-ghost small" title="Cancel this subscription (reverses credits, keeps the record)" onClick={()=>cancelSubscription(s)}>Cancel</button> : null}
          </div>)}
        </div>}

        {list.length === 0
          ? <div className="credit-empty">No purchases recorded for this lesson type.</div>
          : <table className="credit-ledger">
              <thead><tr><th style={{width:120}}>Date</th><th style={{width:90}}>Credits</th><th style={{width:130}}>Source</th><th>Notes</th><th style={{width:36}}></th></tr></thead>
              <tbody>
                {list.map(p => <tr key={p.id} className={p.subscription_id?'is-from-sub':''}>
                  <td style={{fontWeight:600}}>{fmtDate(p.purchase_date)}</td>
                  <td><span className={`credit-delta ${Number(p.credits_added) < 0 ? 'credit-delta-neg' : 'credit-delta-pos'}`}>{Number(p.credits_added) > 0 ? '+' : ''}{p.credits_added}</span></td>
                  <td>{sourceLabel(p.source)}</td>
                  <td className="subtle">{p.notes || '—'}</td>
                  <td>{!isBoundMember && <button className="btn btn-danger small" title="Delete this purchase record" onClick={()=>deleteCreditPurchase(p)}>×</button>}</td>
                </tr>)}
              </tbody>
            </table>
        }
      </div>;
    })}
  </div>;
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
const SWIMMER_ACCENTS = [
  { accent:'#06B6D4', text:'#0E7490' },   // cyan
  { accent:'#8B5CF6', text:'#5B21B6' },   // violet
  { accent:'#F43F5E', text:'#9F1239' },   // rose
  { accent:'#F59E0B', text:'#92400E' },   // amber
  { accent:'#10B981', text:'#065F46' },   // emerald
  { accent:'#3B82F6', text:'#1E40AF' }    // blue
];
function swimmerAccent(idx){ return SWIMMER_ACCENTS[idx % SWIMMER_ACCENTS.length]; }

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
function ParentsView({ parentGroups, lessonTypes, lessonTypeById, packages, packageById, familyGroups, groupById, membersByGroup, creditByKey, subscriptions, addStudent, updateStudent, deleteStudent, addGroup, updateGroup, deleteGroup, setStudentGroup, addStudentToGroup, removeStudentFromGroup, groupIdsByStudent, addSubscription, cancelSubscription, adjustBalanceTo, scheduleByStudent, sessions, poolById, selectedWeekStart, createInvoice, setAdminSection, setView }){
  // ── Sub-view: which Accounts admin pane is showing ──────────────────
  const [adminView, setAdminView] = useState('accounts');
  const [searchQ, setSearchQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('active');
  const [expandedKey, setExpandedKey] = useState(null);
  const [contactEditKey, setContactEditKey] = useState(null);
  const [addingSwimmerFor, setAddingSwimmerFor] = useState(null);
  const [editingSwimmerId, setEditingSwimmerId] = useState(null);
  const [groupPanelKey, setGroupPanelKey] = useState(null);
  const [billingKey, setBillingKey] = useState(null);

  // ── Account printout ────────────────────────────────────────────────
  // Opens a popup with a clean, parent-friendly summary: account holder,
  // family groups, each swimmer's lesson types + packages, and their
  // scheduled class sessions for the viewed week.
  function printAccountSummary(pg){
    const wb = weekBounds(selectedWeekStart || todayStr());
    const weekLabel = `${wb.start.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'})} – ${wb.end.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'})}`;
    const groupsInPlay = [...new Set(pg.swimmers.flatMap(s => s.familyGroupIds || []))].map(gid => groupById?.[gid]).filter(Boolean);
    const groupsHtml = groupsInPlay.length ? groupsInPlay.map(g => {
      const pkg = g.packageId ? packageById?.(g.packageId) : null;
      const lt = pkg?.lesson_type_id ? lessonTypeById?.(pkg.lesson_type_id) : null;
      const members = (membersByGroup?.[g.id] || []).map(m => m.name).join(', ');
      return '<div style="margin-top:4px;font-size:10.5pt">' +
        (g.groupType === 'bound' ? '🔗' : '👪') + ' <strong>' + g.name + '</strong>' +
        (lt && pkg ? ' · ' + lt.name + ' · ' + pkg.name : '') +
        '<div style="font-size:10pt;color:#555;margin-left:18px">Members: ' + (members || 'None') + '</div></div>';
    }).join('') : '<div style="font-size:10pt;color:#999">No family groups</div>';
    const swimmerSections = pg.swimmers.map(sw => {
      const enrolments = sw.enrollments || [];
      // Build per-swimmer schedule from sessions directly (scheduleByStudent
      // doesn't carry weekStartDate or instructor/pool context).
      const weekSessions = (sessions || []).filter(s => s.weekStartDate === (selectedWeekStart || ''));
      const swSessions = weekSessions.filter(s => (s.students || []).some(st => st.studentId === sw.id));
      const slotsByLt = {};
      swSessions.forEach(s => { const k = s.lessonTypeId || '_'; (slotsByLt[k] = slotsByLt[k] || []).push(s); });
      const enrolHtml = enrolments.map(e => {
        const lt = lessonTypeById?.(e.lessonTypeId);
        const pkg = packageById?.(e.packageId);
        const ltSlots = (slotsByLt[e.lessonTypeId] || []).slice().sort((a,b) => a.day - b.day || a.startMinute - b.startMinute);
        const slotLines = ltSlots.map(sl => {
          const pool = sl.poolId && poolById ? poolById(sl.poolId) : null;
          const inst = (sl.instructors && sl.instructors[0] && sl.instructors[0].name) || sl.legacyInstructor || '';
          return '<div style="margin-left:22px;font-size:10pt;color:#333">' +
            DAYS_F[sl.day] + ' ' + minuteToTime(sl.startMinute) + '–' + minuteToTime(sl.startMinute + sl.durationMinutes) +
            (pool ? ' · ' + pool.name : '') +
            (inst ? ' · ' + inst : '') +
            '</div>';
        }).join('');
        return '<div style="margin-top:6px"><div style="font-size:10.5pt;font-weight:600">' +
          (lt?.name || 'Lesson') + ' · ' + (pkg?.name || 'Package') +
          '</div>' + (slotLines || '<div style="margin-left:22px;font-size:10pt;color:#999">No sessions this week</div>') + '</div>';
      }).join('');
      return '<div style="margin-top:14px;padding:10px 12px;border:1px solid #ccc;border-radius:6px">' +
        '<div style="font-size:12pt;font-weight:700">' + sw.name +
        (sw.age != null ? ' · ' + sw.age + 'y' : '') +
        (sw.gender ? ' · ' + (sw.gender === 'male' ? 'M' : sw.gender === 'female' ? 'F' : sw.gender) : '') + '</div>' +
        (enrolHtml || '<div style="font-size:10pt;color:#999;margin-top:4px">No enrolments</div>') + '</div>';
    }).join('');
    const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Account Summary – ' + pg.name + '</title>' +
      '<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Inter,system-ui,-apple-system,sans-serif;color:#111;padding:24px 28px;max-width:720px;margin:0 auto}' +
      '@page{size:A4 portrait;margin:20mm 16mm}@media print{body{padding:0}}' +
      '.hdr{border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:14px}' +
      '.hdr h1{font-size:16pt;font-weight:800;letter-spacing:-.3px}' +
      '.hdr-meta{font-size:10.5pt;color:#444;margin-top:3px}' +
      '.section{margin-top:16px}.section-title{font-size:11pt;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#666;border-bottom:1px solid #ddd;padding-bottom:3px;margin-bottom:6px}</style>' +
      '<script>window.onload=function(){setTimeout(function(){window.print()},400)}<\/script>' +
      '</head><body>' +
      '<div class="hdr"><h1>' + pg.name + '</h1>' +
      '<div class="hdr-meta">' + [pg.email, pg.phone].filter(Boolean).join(' · ') + '</div>' +
      '<div class="hdr-meta" style="margin-top:2px">Week: ' + weekLabel + '</div></div>' +
      '<div class="section"><div class="section-title">Family Groups</div>' + groupsHtml + '</div>' +
      '<div class="section"><div class="section-title">Swimmers & Schedule</div>' + swimmerSections + '</div>' +
      '<div style="margin-top:24px;font-size:9pt;color:#999;border-top:1px solid #ddd;padding-top:8px">Generated ' + new Date().toLocaleDateString(undefined,{dateStyle:'long'}) + ' · Star Swim Sdn Bhd</div>' +
      '</body></html>';
    const w = window.open('', '_blank');
    if(w){ w.document.write(html); w.document.close(); }
  }

  const filtered = (parentGroups || [])
    .filter(pg => {
      if(statusFilter === 'active' && !pg.isActive) return false;
      if(statusFilter === 'archived' && pg.isActive) return false;
      return true;
    })
    .filter(pg => {
      if(!searchQ.trim()) return true;
      const q = searchQ.toLowerCase();
      if((pg.name || '').toLowerCase().includes(q)) return true;
      if((pg.email || '').toLowerCase().includes(q)) return true;
      if((pg.phone || '').toLowerCase().includes(q)) return true;
      return pg.swimmers.some(s => (s.name || '').toLowerCase().includes(q));
    });

  // Cross-filter hits: accounts matching the search query that live in the
  // OTHER status bucket — visible only when a specific filter is active and
  // the search returns no results (or fewer results) from the current view.
  function matchesSearch(pg){
    if(!searchQ.trim()) return false;
    const q = searchQ.toLowerCase();
    if((pg.name || '').toLowerCase().includes(q)) return true;
    if((pg.email || '').toLowerCase().includes(q)) return true;
    if((pg.phone || '').toLowerCase().includes(q)) return true;
    return pg.swimmers.some(s => (s.name || '').toLowerCase().includes(q));
  }
  const archiveHits = searchQ.trim() && statusFilter === 'active'
    ? (parentGroups || []).filter(pg => !pg.isActive && matchesSearch(pg))
    : [];
  const activeHits = searchQ.trim() && statusFilter === 'archived'
    ? (parentGroups || []).filter(pg => pg.isActive && matchesSearch(pg))
    : [];
  const activeCount = (parentGroups || []).filter(p => p.isActive).length;
  const archivedCount = (parentGroups || []).filter(p => !p.isActive).length;
  const totalSwimmers = (parentGroups || []).reduce((sum, p) => sum + p.swimmers.length, 0);
  const totalActiveCredits = Object.values(creditByKey || {}).reduce((sum, b) => sum + (Number(b.remaining_balance) || 0), 0);

  // Propagate parent-level contact + emergency edits to every child's
  // guardian_*/emergency_* fields so the account is the single source of
  // truth for who to call.
  async function saveParentContact(pg, patch){
    for(const s of pg.swimmers){
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
  async function setParentArchived(pg, archived){
    const verb = archived ? 'archive' : 'restore';
    if(!confirm(`${archived ? 'Archive' : 'Restore'} parent "${pg.name}" and all ${pg.swimmers.length} of their swimmer${pg.swimmers.length===1?'':'s'}?`)) return;
    for(const s of pg.swimmers){
      await updateStudent(s.id, { isActive: !archived });
    }
  }

  return <>
    {/* ── Sub-navigation: two children under the Accounts top tab ───── */}
    <div className="admin-subnav">
      <button className={`admin-subnav-btn ${adminView==='accounts'?'is-on':''}`} onClick={()=>setAdminView('accounts')}>👤 Accounts — Administration</button>
      <button className={`admin-subnav-btn ${adminView==='familyGroups'?'is-on':''}`} onClick={()=>setAdminView('familyGroups')}>👪 Family Groups — Administration</button>
    </div>

    {adminView === 'familyGroups' && <FamilyGroupsAdminView
      familyGroups={familyGroups}
      membersByGroup={membersByGroup}
      lessonTypes={lessonTypes}
      lessonTypeById={lessonTypeById}
      packages={packages}
      packageById={packageById}
      deleteGroup={deleteGroup}
    />}

    {adminView === 'accounts' && <>
    <div className="card" style={{marginBottom:12}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12,flexWrap:'wrap',marginBottom:10}}>
        <div>
          <div style={{fontSize:18,fontWeight:800}}>👤 Accounts — Administration</div>
          <div className="small subtle" style={{marginTop:3}}>An account is either a parent registering one or more children, or an adult swimmer registering themselves. Click an account to expand, then edit contact, add or edit swimmers, manage family groups, and adjust credits.</div>
        </div>
        <div style={{display:'flex',gap:14,alignItems:'flex-end',flexWrap:'wrap'}}>
          <div><div className="small subtle">Accounts</div><div style={{fontSize:22,fontWeight:800,color:'var(--primary)'}}>{(parentGroups||[]).length}</div></div>
          <div><div className="small subtle">Swimmers</div><div style={{fontSize:22,fontWeight:800,color:'var(--text)'}}>{totalSwimmers}</div></div>
          <div><div className="small subtle">Active credits</div><div style={{fontSize:22,fontWeight:800,color:'var(--teal)'}}>{totalActiveCredits}</div></div>
        </div>
      </div>
      <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
        <input className="input" style={{flex:1,minWidth:240,maxWidth:420}} placeholder="Search by account name, email, phone, or swimmer name…" value={searchQ} onChange={e=>setSearchQ(e.target.value)} />
        <div className="tabs" style={{gap:2,padding:2}}>
          <button className={`tab ${statusFilter==='active'?'active':''}`} style={{padding:'4px 10px',fontSize:11}} onClick={()=>setStatusFilter('active')}>Active ({activeCount})</button>
          <button className={`tab ${statusFilter==='archived'?'active':''}`} style={{padding:'4px 10px',fontSize:11}} onClick={()=>setStatusFilter('archived')}>Archived ({archivedCount})</button>
          <button className={`tab ${statusFilter==='all'?'active':''}`} style={{padding:'4px 10px',fontSize:11}} onClick={()=>setStatusFilter('all')}>All</button>
        </div>
        {/* + New Account is intentionally absent. New accounts can only
            be opened via the parent intake form (📝 Intake in the header),
            which enforces T&C acceptance as a hard requirement. The legacy
            ability to create an account from this admin panel was removed
            because it bypassed the T&C gate. */}
      </div>
    </div>

    {/* Cross-filter notice — shown when matching accounts exist in the other status bucket */}
    {archiveHits.length > 0 && <div className="cross-filter-notice">
      <span>🗄 {archiveHits.length} {archiveHits.length === 1 ? 'result' : 'results'} found in <strong>Archives</strong>{archiveHits.length === 1 ? `: ${archiveHits[0].name}` : ': ' + archiveHits.map(p => p.name).join(', ')}</span>
      <button className="btn btn-ghost small" onClick={()=>{ setStatusFilter('archived'); if(archiveHits.length === 1) setExpandedKey(archiveHits[0].key); }}>
        {archiveHits.length === 1 ? 'Go to account →' : 'Switch to Archives →'}
      </button>
    </div>}
    {activeHits.length > 0 && <div className="cross-filter-notice">
      <span>👤 {activeHits.length} {activeHits.length === 1 ? 'result' : 'results'} found in <strong>Active accounts</strong>{activeHits.length === 1 ? `: ${activeHits[0].name}` : ': ' + activeHits.map(p => p.name).join(', ')}</span>
      <button className="btn btn-ghost small" onClick={()=>{ setStatusFilter('active'); if(activeHits.length === 1) setExpandedKey(activeHits[0].key); }}>
        {activeHits.length === 1 ? 'Go to account →' : 'Switch to Active →'}
      </button>
    </div>}

    {filtered.length === 0 && <div className="card empty" style={{padding:30}}>No accounts match.</div>}

    {filtered.map(pg => {
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
        if(s.subject_type === 'student' && pg.swimmers.some(sw => sw.id === s.subject_id)) return true;
        if(s.subject_type === 'family_group' && pg.swimmers.some(sw => (sw.familyGroupIds || []).includes(s.subject_id))) return true;
        return false;
      });
      // Distinct family groups that involve this parent's swimmers.
      const parentGroupsInPlay = [...new Set(pg.swimmers.flatMap(s => s.familyGroupIds || []))]
        .map(gid => groupById?.[gid]).filter(Boolean);

      // Session indicator: true when at least one swimmer from this account
      // appears in any session scheduled for the currently-viewed week.
      const swimmerIdSet = new Set(pg.swimmers.map(s => s.id));
      const hasActiveSessions = (sessions || []).some(s =>
        s.weekStartDate === selectedWeekStart &&
        (s.students || []).some(st => st.studentId && swimmerIdSet.has(st.studentId))
      );

      return <div key={pg.key} className={`parent-card ${!pg.isActive?'is-archived':''}`}>
        <div className="parent-head" onClick={(e)=>{ if(e.target.closest('button,input,select')) return; setExpandedKey(isExpanded?null:pg.key); }}>
          <div className="parent-head-main">
            <div className="parent-name">
              {hasActiveSessions && <span className="acct-session-dot" title={`One or more swimmers in this account have sessions scheduled in the week of ${selectedWeekStart}`} />}
              {pg.name}
              {!pg.isActive && <span className="parent-archived-badge" title="All swimmers under this parent are archived">📦 Archived</span>}
            </div>
            <div className="parent-contact subtle small">
              {pg.email ? <span>📧 {pg.email}</span> : null}
              {pg.email && pg.phone ? <span> · </span> : null}
              {pg.phone ? <span>📞 {pg.phone}</span> : null}
              {!pg.email && !pg.phone ? <span>(no contact recorded)</span> : null}
              {(pg.emergencyName || pg.emergencyPhone) && !pg.emergencySameAsGuardian ? <span> · 🚨 {pg.emergencyName || pg.emergencyPhone}{pg.emergencyName && pg.emergencyPhone ? ` ${pg.emergencyPhone}` : ''}{pg.emergencyRelationship ? ` (${pg.emergencyRelationship})` : ''}</span> : null}
              {parentGroupsInPlay.length > 0 && <span> · {parentGroupsInPlay.map(g => {
                const gp = g.packageId && packageById ? packageById(g.packageId) : null;
                return <span key={g.id} className="parent-group-tag" title={gp ? `${gp.name} package` : undefined}>{g.groupType==='bound'?'🔗':'👪'} {g.name}{gp ? ` · ${gp.name}` : ''}</span>;
              })}</span>}
            </div>
          </div>
          <div className="parent-head-stats">
            <span className="parent-stat"><strong>{swimmerCount}</strong> swimmer{swimmerCount===1?'':'s'}</span>
            <span className="parent-stat"><strong className={parentActiveCredits<=2?'credit-low':''}>{parentActiveCredits}</strong> credits total</span>
            {parentSubs.length > 0 && <span className="parent-stat subtle">{parentSubs.length} sub{parentSubs.length===1?'':'s'}</span>}
            {pg.key !== '__unassigned__' && <button
              className={`btn small parent-archive-btn ${pg.isActive ? 'btn-ghost' : 'btn-primary'}`}
              title={pg.isActive ? 'Archive this account and all its swimmers' : 'Restore this account'}
              onClick={(e)=>{ e.stopPropagation(); setParentArchived(pg, pg.isActive); }}>
              {pg.isActive ? '📦' : '↩ Restore'}
            </button>}
            <span className="parent-chev">{isExpanded ? '▴' : '▾'}</span>
          </div>
        </div>
        {isExpanded && <div className="parent-body">
          {/* Parent-level admin toolbar */}
          {pg.key !== '__unassigned__' && <div className="parent-admin-toolbar">
            <button className="btn btn-ghost small" onClick={()=>setContactEditKey(isEditingContact?null:pg.key)}>{isEditingContact?'Close':'✎ Edit Contact'}</button>
            <button className="btn btn-ghost small" onClick={()=>setAddingSwimmerFor(isAddingSwimmer?null:pg.key)}>{isAddingSwimmer?'Close':'+ Add Swimmer'}</button>
            {swimmerCount >= 2 && <button className="btn btn-ghost small" onClick={()=>setGroupPanelKey(isManagingGroup?null:pg.key)}>{isManagingGroup?'Close':'👪 Manage Group'}</button>}
            {/* 💳 Record Purchase removed — billing is now driven from
                🧾 Billing Preview which shows the actual amounts owed and
                records payment against precise line items. The legacy
                Record Purchase form was free-form and let staff record
                purchases that didn't match the swimmers' actual
                enrolments, leading to inconsistencies. */}
            <button className="btn btn-ghost small" onClick={()=>setBillingKey(billingKey===pg.key?null:pg.key)} title="Preview what this account would be billed based on current enrolments + family groups">{billingKey===pg.key?'Close':'🧾 Billing Preview'}</button>
            <button className="btn btn-print small" onClick={()=>printAccountSummary(pg)} title="Print account summary with groups, enrolments, and class schedule">🖨 Print</button>
            <div style={{marginLeft:'auto'}}>
              <button className={`btn small ${pg.isActive?'btn-ghost':'btn-primary'}`} onClick={()=>setParentArchived(pg, pg.isActive)} title={pg.isActive ? 'Archive this parent and all their swimmers' : 'Restore this parent and all their swimmers'}>
                {pg.isActive ? '📦 Archive' : '✓ Restore'}
              </button>
            </div>
          </div>}

          {/* T&C is an ACCOUNT-LEVEL status. Once any swimmer in this
              account has accepted, the whole account is covered — new
              swimmers added under it inherit the same acceptance. The
              intake form enforces T&C as a hard requirement for new
              accounts. Legacy accounts were backfilled. */}
          {pg.key !== '__unassigned__' && (() => {
            const accepted = pg.swimmers.find(sw => sw.tcAcceptedAt);
            return <div className="account-tc-summary">
              <span className="account-tc-label">Terms &amp; Conditions:</span>
              {accepted
                ? <span className="account-tc-badge tc-ok" title={`Accepted ${new Date(accepted.tcAcceptedAt).toLocaleDateString()} · ID ${accepted.tcAcceptanceId} · covers all swimmers in this account`}>✅ Accepted · {new Date(accepted.tcAcceptedAt).toLocaleDateString(undefined,{dateStyle:'medium'})}</span>
                : <span className="account-tc-badge tc-pending" title="No swimmer in this account has T&C acceptance recorded">⚠ Pending</span>}
            </div>;
          })()}

          {/* Billing preview — forward-looking invoice based on current
              enrolments + family group memberships. The user uses this to
              verify the billing logic is computing the right total. */}
          {billingKey === pg.key && <BillingPreviewPanel
            pg={pg}
            lessonTypes={lessonTypes}
            lessonTypeById={lessonTypeById}
            packages={packages}
            packageById={packageById}
            groupById={groupById}
            membersByGroup={membersByGroup}
            subscriptions={subscriptions}
            addSubscription={addSubscription}
            onClose={()=>setBillingKey(null)}
            onGenerateInvoice={async (lines, meta) => {
              const id = await createInvoice({ accountName:pg.name, accountEmail:pg.email, accountPhone:pg.phone, lines, ...meta });
              if(id){ setBillingKey(null); setAdminSection('invoices'); setView('settings'); }
            }}
          />}

          {/* Contact editor */}
          {isEditingContact && <ParentContactEditor pg={pg} onSave={(patch)=>saveParentContact(pg, patch)} onCancel={()=>setContactEditKey(null)} />}

          {/* New-swimmer editor (account holder already known, so hide
              account/guardian/emergency sections — those propagate from
              the parent record automatically). */}
          {isAddingSwimmer && <div className="parent-add-swimmer">
            <div className="parent-sub-log-title">+ New swimmer under {pg.name}</div>
            <StudentEditor
              row={{ guardianName:pg.name, guardianEmail:pg.email, guardianPhone:pg.phone, emergencyName:pg.emergencyName, emergencyPhone:pg.emergencyPhone, emergencyRelationship:pg.emergencyRelationship, emergencySameAsGuardian:pg.emergencySameAsGuardian }}
              lessonTypes={lessonTypes} packages={packages}
              hideAccountSections={true}
              onSave={async (patch)=>{
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
                  // Inherit T&C from the account so the new swimmer is covered immediately
                  tcAcceptedAt: accountTcSwimmer?.tcAcceptedAt || null,
                  tcAcceptanceId: accountTcSwimmer?.tcAcceptanceId || null
                });
                setAddingSwimmerFor(null);
              }}
            />
          </div>}

          {/* Group management panel — package-driven creation flow */}
          {isManagingGroup && <ParentGroupManager
            pg={pg}
            familyGroups={familyGroups}
            groupById={groupById}
            membersByGroup={membersByGroup}
            groupIdsByStudent={groupIdsByStudent}
            lessonTypes={lessonTypes}
            packages={packages}
            packageById={packageById}
            addGroup={addGroup}
            updateGroup={updateGroup}
            deleteGroup={deleteGroup}
            setStudentGroup={setStudentGroup}
            addStudentToGroup={addStudentToGroup}
            removeStudentFromGroup={removeStudentFromGroup}
            onClose={()=>setGroupPanelKey(null)}
          />}

          {/* Swimmers */}
          {pg.swimmers.map((sw, swi) => {
            const grp = sw.familyGroupId && groupById ? groupById[sw.familyGroupId] : null;
            const isBound = !!(grp && grp.groupType === 'bound');
            const isEditingSwimmer = editingSwimmerId === sw.id;
            const acc = swimmerAccent(swi);
            return <div key={sw.id} className="parent-swimmer-section" style={{borderLeftColor:acc.accent}}>
              <div className="parent-swimmer-head">
                <div className="parent-swimmer-name">
                  <span style={{color:acc.accent,fontSize:14}}>●</span> <strong style={{color:acc.text}}>{sw.name}</strong>
                  {sw.age != null ? <span className="subtle"> · {sw.age}y</span> : null}
                  {sw.gender ? <span className="subtle"> · {sw.gender==='female'?'♀':'♂'}</span> : null}
                  {grp ? <span className="subtle"> · {isBound ? '🔗' : '👪'} {grp.name}</span> : null}
                </div>
                <div className="parent-swimmer-actions">
                  <button className="btn btn-ghost small" onClick={()=>setEditingSwimmerId(isEditingSwimmer?null:sw.id)}>{isEditingSwimmer?'Close':'✎ Edit'}</button>
                  <button className="btn btn-danger small" onClick={()=>deleteStudent(sw)}>Del</button>
                </div>
              </div>

              {/* Inline swimmer editor — account/guardian/emergency are
                  hidden because those are owned at the account level. */}
              {isEditingSwimmer && <div style={{margin:'8px 0'}}><StudentEditor
                row={sw} lessonTypes={lessonTypes} packages={packages}
                hideAccountSections={true}
                onSave={async (patch)=>{ await updateStudent(sw.id, patch); setEditingSwimmerId(null); }}
              /></div>}

              {(sw.lessonTypeIds || []).length === 0
                ? <div className="parent-swimmer-empty subtle small">No lesson type enrolments yet — click ✎ Edit to add one.</div>
                : <div className="parent-lt-list">
                    {(sw.lessonTypeIds || []).map(ltId => {
                      const lt = lessonTypeById ? lessonTypeById(ltId) : null;
                      if(!lt) return null;
                      const bal = creditByKey[`${sw.id}:${ltId}`];
                      const remaining = bal ? Number(bal.remaining_balance) || 0 : 0;
                      const initial = bal ? Number(bal.initial_balance) || 0 : 0;
                      const enrol = (sw.enrollments || []).find(e => e.lessonTypeId === ltId);
                      const pkg = enrol?.packageId ? packageById(enrol.packageId) : null;
                      return <div key={ltId} className="parent-lt-row">
                        <span className="parent-lt-name" style={{background:lt.bg_color,color:lt.text_color,borderColor:lt.border_color}}>{lt.name}</span>
                        {pkg ? <span className="stu-pkg-label" title="Enrolled package">{pkg.name}</span> : null}
                        <span className="parent-lt-balance">
                          {bal
                            ? <><strong className={remaining<=2?'credit-low':''}>{remaining}</strong> / {initial} credits</>
                            : <em className="subtle">no balance yet</em>}
                        </span>
                        {!isBound && addSubscription && <div className="parent-lt-actions">
                          <button className="btn btn-ghost small" title="Add 1× 4-credit subscription" onClick={()=>addSubscription({
                            subjectType: (grp && grp.groupType !== 'bound') ? 'family_group' : 'student',
                            subjectId: (grp && grp.groupType !== 'bound') ? grp.id : sw.id,
                            lessonTypeId: ltId, creditsPerSwimmer: 4, quantity: 1,
                            source: 'subscription', notes: 'Quick subscription (parent view)'
                          })}>+4</button>
                          <button className="btn btn-ghost small" title="Add 2× 4-credit subscription" onClick={()=>addSubscription({
                            subjectType: (grp && grp.groupType !== 'bound') ? 'family_group' : 'student',
                            subjectId: (grp && grp.groupType !== 'bound') ? grp.id : sw.id,
                            lessonTypeId: ltId, creditsPerSwimmer: 4, quantity: 2,
                            source: 'subscription', notes: 'Quick subscription (parent view, 2×)'
                          })}>+8</button>
                          {adjustBalanceTo && <BalanceAdjuster
                            currentBalance={remaining}
                            onApply={(target, notes) => adjustBalanceTo(sw.id, ltId, target, notes)} />}
                        </div>}
                        {isBound && <div className="parent-lt-actions"><span className="subtle small">🔗 bound — manage at group level</span></div>}
                      </div>;
                    })}
                  </div>
              }
            </div>;
          })}

          {/* Subscription log for this parent */}
          {parentSubs.length > 0 && <div className="parent-sub-log">
            <div className="parent-sub-log-title">Subscription log ({parentSubs.length})</div>
            <div className="parent-sub-log-list">
              {parentSubs.slice().sort((a,b)=>(b.subscription_date||'').localeCompare(a.subscription_date||'')).map(s => {
                const lt = lessonTypeById ? lessonTypeById(s.lesson_type_id) : null;
                return <div key={s.id} className={`credit-sub-row ${s.cancelled_at?'is-cancelled':''}`}>
                  <span className="credit-sub-date">{s.subscription_date}</span>
                  <span className="credit-sub-amount">+{s.credits_per_swimmer} × {s.swimmer_count}</span>
                  <span className="credit-sub-subject">{lt?.name || '—'}</span>
                  <span className="credit-sub-meta subtle">{s.source}{s.amount_paid != null ? ` · RM${s.amount_paid}` : ''}</span>
                  {s.cancelled_at ? <span className="credit-sub-cancelled-tag">Cancelled</span>
                    : cancelSubscription ? <button className="btn btn-ghost small" onClick={()=>cancelSubscription(s)}>Cancel</button> : null}
                </div>;
              })}
            </div>
          </div>}
        </div>}
      </div>;
    })}
    </>}
  </>;
}

// ============================================================================
// FamilyGroupsAdminView — system-wide family-groups admin panel.
// Lists EVERY family_groups row in the system, with member count, package
// context, member names, and the guardian/account each member belongs to.
// Use to audit and clean up legacy/test data without dropping to SQL.
// ============================================================================
function FamilyGroupsAdminView({ familyGroups, membersByGroup, lessonTypes, lessonTypeById, packages, packageById, deleteGroup }){
  const [searchQ, setSearchQ] = useState('');
  const [filter, setFilter] = useState('all'); // all | empty | configured | misconfigured
  const [bulkBusy, setBulkBusy] = useState(false);

  // Enrich each group with derived signals: package info, member rows, account names
  const enriched = (familyGroups || []).map(g => {
    const members = membersByGroup?.[g.id] || [];
    const pkg = g.packageId ? (typeof packageById === 'function' ? packageById(g.packageId) : packageById?.[g.packageId]) : null;
    const lt = pkg?.lesson_type_id ? (typeof lessonTypeById === 'function' ? lessonTypeById(pkg.lesson_type_id) : lessonTypeById?.[pkg.lesson_type_id]) : null;
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
      isMisconfigured: !pkg  // group exists but no package set
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
    if(filter === 'empty' && !g.isEmpty) return false;
    if(filter === 'configured' && (!g.isConfigured || g.isEmpty)) return false;
    if(filter === 'misconfigured' && !g.isMisconfigured) return false;
    if(!searchQ.trim()) return true;
    const q = searchQ.toLowerCase();
    if(g.name?.toLowerCase().includes(q)) return true;
    if(g.pkgName?.toLowerCase().includes(q)) return true;
    if(g.ltName?.toLowerCase().includes(q)) return true;
    if(g.accountNames.some(n => (n || '').toLowerCase().includes(q))) return true;
    if(g.memberRows.some(m => (m.name || '').toLowerCase().includes(q))) return true;
    return false;
  });
  // Sort: empty first (so cleanup is easy), then by name
  filtered.sort((a, b) => {
    if(a.isEmpty !== b.isEmpty) return a.isEmpty ? -1 : 1;
    return (a.name || '').localeCompare(b.name || '');
  });

  async function bulkDeleteEmpty(){
    const empties = enriched.filter(g => g.isEmpty);
    if(empties.length === 0){ alert('No empty groups to delete.'); return; }
    if(!confirm(`Delete ALL ${empties.length} empty family group${empties.length === 1 ? '' : 's'}? This cannot be undone.\n\nGroups to delete:\n${empties.map(g => `• ${g.name}`).join('\n')}`)) return;
    setBulkBusy(true);
    try{
      for(const g of empties){
        // eslint-disable-next-line no-await-in-loop
        await deleteGroup(g, /*silentConfirm*/ true);
      }
    } finally {
      setBulkBusy(false);
    }
  }

  return <>
    <div className="card" style={{marginBottom:12}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12,flexWrap:'wrap',marginBottom:10}}>
        <div>
          <div style={{fontSize:18,fontWeight:800}}>👪 Family Groups — Administration</div>
          <div className="small subtle" style={{marginTop:3}}>Every family group in the system, with members and package context. Audit legacy or test data here; bulk-clean empty groups in one click.</div>
        </div>
        <div style={{display:'flex',gap:14,alignItems:'flex-end',flexWrap:'wrap'}}>
          <div><div className="small subtle">Total</div><div style={{fontSize:22,fontWeight:800,color:'var(--primary)'}}>{counts.all}</div></div>
          <div><div className="small subtle">Configured</div><div style={{fontSize:22,fontWeight:800,color:'#10B981'}}>{counts.configured}</div></div>
          <div><div className="small subtle">Empty</div><div style={{fontSize:22,fontWeight:800,color:'#94A3B8'}}>{counts.empty}</div></div>
          <div><div className="small subtle">Misconfigured</div><div style={{fontSize:22,fontWeight:800,color:'#F59E0B'}}>{counts.misconfigured}</div></div>
        </div>
      </div>
      <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
        <input className="input" style={{flex:1,minWidth:240,maxWidth:420}} placeholder="Search by group, package, lesson type, account, or member name…" value={searchQ} onChange={e=>setSearchQ(e.target.value)} />
        <div className="tabs" style={{gap:2,padding:2}}>
          <button className={`tab ${filter==='all'?'active':''}`}            style={{padding:'4px 10px',fontSize:11}} onClick={()=>setFilter('all')}>All ({counts.all})</button>
          <button className={`tab ${filter==='configured'?'active':''}`}     style={{padding:'4px 10px',fontSize:11}} onClick={()=>setFilter('configured')}>Configured ({counts.configured})</button>
          <button className={`tab ${filter==='empty'?'active':''}`}          style={{padding:'4px 10px',fontSize:11}} onClick={()=>setFilter('empty')}>Empty ({counts.empty})</button>
          <button className={`tab ${filter==='misconfigured'?'active':''}`}  style={{padding:'4px 10px',fontSize:11}} onClick={()=>setFilter('misconfigured')}>Misconfigured ({counts.misconfigured})</button>
        </div>
        {counts.empty > 0 ? <button className="btn btn-danger small" onClick={bulkDeleteEmpty} disabled={bulkBusy} title={`Delete all ${counts.empty} groups with zero members`}>{bulkBusy ? 'Cleaning…' : `🧹 Clean ${counts.empty} empty`}</button> : null}
      </div>
    </div>

    {filtered.length === 0 ? <div className="card empty" style={{padding:30}}>No family groups match the current filter.</div> : null}

    <div style={{display:'flex',flexDirection:'column',gap:8}}>
      {filtered.map(g => {
        const isBound = g.groupType === 'bound';
        return <div key={g.id} className="fga-card">
          <div className="fga-head">
            <div className="fga-head-main">
              <div className="fga-name">{isBound ? '🔗' : '👪'} {g.name}</div>
              <div className="fga-meta">
                {g.isConfigured
                  ? <span className="fga-pkg-tag">{g.ltName || '?'} · {g.pkgName}</span>
                  : <span className="fga-pkg-tag fga-pkg-warn">⚠ no package set</span>}
                <span className={`fga-count ${g.isEmpty ? 'is-empty' : ''}`}>{g.memberCount} member{g.memberCount === 1 ? '' : 's'}</span>
                {g.accountNames.length > 0 ? <span className="fga-accounts">{g.accountNames.join(', ')}</span> : null}
              </div>
            </div>
            <div className="fga-actions">
              <button className="btn btn-danger small" onClick={()=>deleteGroup(g)}>Delete</button>
            </div>
          </div>
          {g.memberCount > 0 ? <div className="fga-members">
            {g.memberRows.map(m => <span key={m.id} className="fga-member-chip">{m.name}{m.age != null ? ` · ${m.age}y` : ''}</span>)}
          </div> : null}
        </div>;
      })}
    </div>
  </>;
}


// ============================================================================

// Inline editor for an account's contact info + emergency contact.
// Two visually distinct sections — Account Holder (parent or self) on
// top, Emergency Contact below — both propagate to every child swimmer
// when saved. Emergency contact now carries name + phone + relationship
// (name was previously missing).
function ParentContactEditor({ pg, onSave, onCancel }){
  const [name, setName] = useState(pg.name === '— Unassigned —' || pg.name === '— No name —' ? '' : pg.name);
  const [email, setEmail] = useState(pg.email || '');
  const [phone, setPhone] = useState(pg.phone || '');
  const [emergencySame, setEmergencySame] = useState(!!pg.emergencySameAsGuardian);
  const [emergencyName, setEmergencyName] = useState(pg.emergencyName || '');
  const [emergencyPhone, setEmergencyPhone] = useState(pg.emergencyPhone || '');
  const [emergencyRel, setEmergencyRel] = useState(pg.emergencyRelationship || '');
  return <div className="parent-contact-edit">
    <div className="parent-sub-log-title">Edit account &amp; emergency contact (applies to all {pg.swimmers.length} swimmer{pg.swimmers.length===1?'':'s'})</div>

    {/* Account Holder section */}
    <div className="account-section">
      <div className="account-section-title">Parent / Guardian (Account Holder)</div>
      <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr 1fr'}}>
        <div className="field"><label>Parent Name</label><input className="input" value={name} onChange={e=>setName(e.target.value)} placeholder="Full name" /></div>
        <div className="field"><label>Email</label><input className="input" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="email@example.com" /></div>
        <div className="field"><label>Phone</label><input className="input" type="tel" value={phone} onChange={e=>setPhone(e.target.value)} placeholder="+60 1X-XXXXXXX" /></div>
      </div>
    </div>

    {/* Emergency Contact section */}
    <div className="account-section">
      <div className="account-section-title">Emergency Contact</div>
      <label className="gb-check" style={{marginBottom:7,display:'inline-flex',gap:6,alignItems:'center'}}><input type="checkbox" checked={emergencySame} onChange={e=>setEmergencySame(e.target.checked)} /> Same as account holder above</label>
      <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr 1fr'}}>
        <div className="field"><label>Emergency Contact Name</label><input className="input" value={emergencySame ? name : emergencyName} onChange={e=>setEmergencyName(e.target.value)} disabled={emergencySame} placeholder="Full name" /></div>
        <div className="field"><label>Phone</label><input className="input" type="tel" value={emergencySame?phone:emergencyPhone} onChange={e=>setEmergencyPhone(e.target.value)} disabled={emergencySame} placeholder="+60 1X-XXXXXXX" /></div>
        <div className="field"><label>Relationship</label><input className="input" value={emergencySame?'Account Holder':emergencyRel} onChange={e=>setEmergencyRel(e.target.value)} disabled={emergencySame} placeholder="e.g. Mother, Father, Spouse, Sibling" /></div>
      </div>
    </div>

    <div style={{display:'flex',gap:6,justifyContent:'flex-end',marginTop:10}}>
      <button className="btn btn-ghost small" onClick={onCancel}>Cancel</button>
      <button className="btn btn-primary small" onClick={()=>onSave({
        guardianName:name, guardianEmail:email, guardianPhone:phone,
        emergencySameAsGuardian: emergencySame,
        emergencyName: emergencySame ? name : emergencyName,
        emergencyPhone: emergencySame ? phone : emergencyPhone,
        emergencyRelationship: emergencySame ? 'Account Holder' : emergencyRel
      })}>Save</button>
    </div>
  </div>;
}

// Family group management for a parent — pick existing group or create new
// from this parent's children, toggle membership per child, switch type.
// ============================================================================
// BillingPreviewPanel — invoice generator for an account.
// Detects billable items (group bundles + individual lessons).
// Per-line checkboxes let staff exclude any item before generating.
// "Generate Invoice" creates the invoice + lines + navigates to Admin > Invoices.
// The old per-line "💳 Record" flow has been superseded by the invoice path.
// ============================================================================
function BillingPreviewPanel({ pg, lessonTypes, lessonTypeById, packages, packageById, groupById, membersByGroup, subscriptions, addSubscription, onClose, onGenerateInvoice }){
  const ltById = lessonTypeById || ((id) => lessonTypes.find(x => x.id === id));
  const pkgById = packageById || ((id) => packages.find(p => p.id === id));
  function ltName(id){ const lt = typeof ltById === 'function' ? ltById(id) : ltById?.[id]; return lt?.name || 'Lesson'; }

  const [invoiceNotes, setInvoiceNotes] = useState('');
  const [invoiceDueDate, setInvoiceDueDate] = useState('');
  const [checked, setChecked] = useState(new Set());    // initialised after items computed
  const [generating, setGenerating] = useState(false);

  // ── Compute line items ──────────────────────────────────────────────
  const groupItems = [];
  const individualItems = [];
  const unconfiguredGroups = [];

  const accountGroupIds = [...new Set(pg.swimmers.flatMap(s => s.familyGroupIds || []))];
  accountGroupIds.forEach(gid => {
    const g = groupById?.[gid];
    if(!g) return;
    const pkg = g.packageId ? (typeof pkgById === 'function' ? pkgById(g.packageId) : pkgById?.[g.packageId]) : null;
    if(!pkg){ const mems = pg.swimmers.filter(s=>(s.familyGroupIds||[]).includes(gid)); unconfiguredGroups.push({id:gid,name:g.name,groupType:g.groupType,memberCount:mems.length,memberNames:mems.map(m=>m.name).join(', ')}); return; }
    const members = pg.swimmers.filter(s=>(s.familyGroupIds||[]).includes(gid));
    const memberCount = members.length;
    const required = pkg.pax != null ? Number(pkg.pax) : null;
    const bundle = pkg.amount != null ? Number(pkg.amount) : 0;
    const fb = pkg.fallback_per_pax != null ? Number(pkg.fallback_per_pax) : null;
    let amount = bundle;
    if(required != null && memberCount > required && fb != null) amount = bundle + (memberCount-required)*fb;
    groupItems.push({
      key:`group:${gid}`, groupId:gid, groupName:g.name, groupType:g.groupType,
      lessonTypeId:pkg.lesson_type_id, packageId:pkg.id,
      lessonTypeName:ltName(pkg.lesson_type_id), packageName:pkg.name,
      familyGroupId:gid, familyGroupName:g.name,
      memberCount, memberIds:members.map(m=>m.id),
      memberNames:members.map(m=>m.name).join(', '),
      studentIds:members.map(m=>m.id).join(','),
      studentNames:members.map(m=>m.name).join(', '),
      bundle, amount, lineType:'group_bundle',
      billingMode:pkg.billing_mode||'monthly', billingCount:pkg.billing_count,
      creditsPerSwimmer:pkg.billing_count||4,
      description:`${g.groupType==='bound'?'🔗':'👪'} ${g.name} — ${ltName(pkg.lesson_type_id)} · ${pkg.name}`,
    });
  });
  pg.swimmers.forEach(sw => {
    const coveredPkgIds = new Set();
    (sw.familyGroupIds||[]).forEach(gid=>{ const grp=groupById?.[gid]; if(grp?.packageId) coveredPkgIds.add(grp.packageId); });
    (sw.enrollments||[]).forEach(e => {
      if(!e.lessonTypeId || !e.packageId || coveredPkgIds.has(e.packageId)) return;
      const pkg = typeof pkgById === 'function' ? pkgById(e.packageId) : pkgById?.[e.packageId];
      if(!pkg) return;
      individualItems.push({
        key:`ind:${sw.id}:${e.lessonTypeId}:${e.packageId}`,
        swimmerId:sw.id, swimmerName:sw.name,
        lessonTypeId:e.lessonTypeId, packageId:e.packageId,
        lessonTypeName:ltName(e.lessonTypeId), packageName:pkg.name,
        studentIds:sw.id, studentNames:sw.name,
        amount:pkg.amount != null ? Number(pkg.amount) : 0,
        lineType:'individual', billingMode:pkg.billing_mode||'monthly',
        billingCount:pkg.billing_count, creditsPerSwimmer:pkg.billing_count||4,
        description:`${sw.name} — ${ltName(e.lessonTypeId)} · ${pkg.name}`,
      });
    });
  });

  const allItems = [...groupItems, ...individualItems];
  const allKeys = allItems.map(it=>it.key);

  // Initialise checked set when items first load
  React.useEffect(() => { setChecked(new Set(allKeys)); }, [allItems.length]);
  function toggleCheck(key){ setChecked(s=>{ const n=new Set(s); if(n.has(key)) n.delete(key); else n.add(key); return n; }); }
  function toggleAll(){ const c=allKeys.every(k=>checked.has(k)); setChecked(c?new Set():new Set(allKeys)); }

  const checkedItems = allItems.filter(it=>checked.has(it.key));
  const checkedTotal = checkedItems.reduce((s,it)=>s+it.amount,0);
  const hasAny = allItems.length > 0;
  const allChecked = allKeys.length > 0 && allKeys.every(k=>checked.has(k));

  async function handleGenerate(){
    if(checkedItems.length === 0){ alert('Select at least one line to include on the invoice.'); return; }
    setGenerating(true);
    try{ await onGenerateInvoice(checkedItems.map(it=>({...it})), { notes:invoiceNotes, dueDate:invoiceDueDate }); }
    catch(e){ alert(e?.message||'Failed to generate invoice'); }
    finally{ setGenerating(false); }
  }

  return <div className="parent-billing-panel">
    <div className="parent-sub-log-title" style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8}}>
      <span>🧾 Invoice Preview — {pg.name}</span>
      <button className="btn btn-ghost small" onClick={onClose}>Close</button>
    </div>
    <div className="small subtle" style={{marginBottom:10}}>
      Tick the items to include on this invoice. Untick anything not being billed this cycle. Click <strong>Generate Invoice</strong> to create a draft invoice in Admin → Invoices.
    </div>

    {!hasAny && unconfiguredGroups.length===0 && <div className="empty" style={{padding:20}}>No billable items — no swimmers have package enrolments yet.</div>}

    {unconfiguredGroups.length > 0 && <div className="billing-warning-box">
      <div className="billing-warning-title">⚠ {unconfiguredGroups.length} group{unconfiguredGroups.length===1?'':'s'} missing a package</div>
      <div className="billing-warning-body">Open <strong>Manage Group</strong> and set a package on: {unconfiguredGroups.map(u=><strong key={u.id}> {u.name}</strong>)}.</div>
    </div>}

    {hasAny && <>
      <table className="billing-table">
        <thead>
          <tr>
            <th style={{width:32}}>
              <input type="checkbox" checked={allChecked} onChange={toggleAll} title="Select all" />
            </th>
            <th>Description</th>
            <th>Type</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {groupItems.map(it => <tr key={it.key} className={checked.has(it.key)?'':'billing-row-muted'}>
            <td><input type="checkbox" checked={checked.has(it.key)} onChange={()=>toggleCheck(it.key)} /></td>
            <td>
              <div style={{fontWeight:700}}>{it.groupType==='bound'?'🔗':'👪'} {it.groupName}</div>
              <div className="small subtle">{it.lessonTypeName} · {it.packageName}</div>
              <div className="small subtle">{it.memberNames}</div>
            </td>
            <td><span className="billing-type-chip group">Group Bundle</span></td>
            <td className="num"><strong>RM{it.amount.toFixed(2)}</strong></td>
          </tr>)}
          {individualItems.map(it => <tr key={it.key} className={checked.has(it.key)?'':'billing-row-muted'}>
            <td><input type="checkbox" checked={checked.has(it.key)} onChange={()=>toggleCheck(it.key)} /></td>
            <td>
              <div style={{fontWeight:700}}>{it.swimmerName}</div>
              <div className="small subtle">{it.lessonTypeName} · {it.packageName}</div>
            </td>
            <td><span className="billing-type-chip individual">Individual</span></td>
            <td className="num"><strong>RM{it.amount.toFixed(2)}</strong></td>
          </tr>)}
        </tbody>
      </table>

      <div className="billing-total-row">
        <span className="billing-total-label">{checkedItems.length} item{checkedItems.length===1?'':'s'} selected</span>
        <span className="billing-total-value">RM{checkedTotal.toFixed(2)}</span>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'1fr 180px',gap:10,marginTop:12}}>
        <div className="field"><label>Invoice Notes (optional)</label>
          <input className="input" value={invoiceNotes} onChange={e=>setInvoiceNotes(e.target.value)} placeholder="e.g. June 2026 monthly fee" /></div>
        <div className="field"><label>Due Date (optional)</label>
          <input className="input" type="date" value={invoiceDueDate} onChange={e=>setInvoiceDueDate(e.target.value)} /></div>
      </div>

      <div style={{display:'flex',justifyContent:'flex-end',marginTop:12}}>
        <button className="btn btn-primary" onClick={handleGenerate} disabled={generating||checkedItems.length===0}>
          {generating ? 'Generating…' : `🧾 Generate Invoice — RM${checkedTotal.toFixed(2)}`}
        </button>
      </div>
    </>}
  </div>;
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
function ParentGroupManager({ pg, familyGroups, groupById, membersByGroup, groupIdsByStudent, lessonTypes, packages, packageById, addGroup, updateGroup, deleteGroup, setStudentGroup, addStudentToGroup, removeStudentFromGroup, onClose }){
  // ── Eligibility helpers ──────────────────────────────────────────────
  // (1) A swimmer is "package-eligible" for a (lessonTypeId, packageId)
  //     iff they have an enrolment row with that exact pair.
  // (2) But uniqueness also applies: a swimmer can only be in ONE group
  //     per unique (lesson_type, package). So if the swimmer is already
  //     in some OTHER group with the same package, they're not eligible
  //     for THIS one — they'd be hopping, which is what we're patching.
  //     We surface the conflicting group's name so the UI can explain why.
  function eligibleFor(lessonTypeId, packageId){
    if(!lessonTypeId || !packageId) return [];
    return pg.swimmers.filter(s => (s.enrollments || []).some(e => e.lessonTypeId === lessonTypeId && e.packageId === packageId));
  }
  // For a candidate package, return any OTHER group the swimmer is in with
  // the same package_id — null if they're free to join.
  function conflictingGroupFor(swimmerId, packageId, excludeGroupId){
    const ids = groupIdsByStudent?.[swimmerId];
    if(!ids) return null;
    for(const gid of ids){
      if(gid === excludeGroupId) continue;
      const g = familyGroups.find(x => x.id === gid);
      if(g && g.packageId === packageId) return g;
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
  const eligiblePackages = creatingLtId
    ? packages.filter(p => p.lesson_type_id === creatingLtId)
    : [];

  // Live preview of who is eligible right now given the current pick.
  const previewEligible = eligibleFor(creatingLtId, creatingPkgId);

  function toggleMember(id){
    const next = new Set(creatingMemberIds);
    if(next.has(id)) next.delete(id); else next.add(id);
    setCreatingMemberIds(next);
  }
  function selectAllEligible(){ setCreatingMemberIds(new Set(previewEligible.map(s => s.id))); }
  function selectNone(){ setCreatingMemberIds(new Set()); }

  // When lessonType/package changes, default member selection to all
  // FREE eligible swimmers (excludes those already in another group with
  // the same package — they're locked out by the uniqueness rule).
  React.useEffect(() => {
    if(!creatingPkgId){ setCreatingMemberIds(new Set()); return; }
    const free = previewEligible.filter(sw => !conflictingGroupFor(sw.id, creatingPkgId, null));
    setCreatingMemberIds(new Set(free.map(s => s.id)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creatingLtId, creatingPkgId]);

  async function handleCreate(){
    const name = creatingName.trim();
    if(!name){ alert('Group needs a name.'); return; }
    if(!creatingLtId || !creatingPkgId){ alert('Pick a Lesson Type and Package first.'); return; }
    const inserted = await addGroup({ name, packageId: creatingPkgId, groupType: creatingType });
    if(!inserted){ return; }  // addGroup already alerted on failure
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
    for(const sid of creatingMemberIds){
      // eslint-disable-next-line no-await-in-loop
      await addStudentToGroup(sid, inserted.id, targetOverride);
    }
    // Reset create form
    setCreatingName(''); setCreatingLtId(''); setCreatingPkgId(''); setCreatingType('discount'); setCreatingMemberIds(new Set()); setCreatingOpen(false);
  }

  // ── Existing groups touching this family ─────────────────────────────
  // Multi-group: a swimmer may be in several groups, so flatMap over the
  // familyGroupIds array. The Set dedupes.
  const involvedGroupIds = [...new Set(pg.swimmers.flatMap(s => s.familyGroupIds || []))];
  const involvedGroups = involvedGroupIds.map(gid => groupById?.[gid]).filter(Boolean);

  function packageLabel(pkgId){
    if(!pkgId) return null;
    const p = packageById ? packageById(pkgId) : null;
    if(!p) return null;
    const lt = lessonTypes.find(x => x.id === p.lesson_type_id);
    return { ltName: lt?.name || 'Unknown lesson type', pkgName: p.name || 'Package' };
  }

  return <div className="parent-group-panel">
    <div className="parent-sub-log-title">Family group management</div>

    {/* ── Existing groups ──────────────────────────────────────────── */}
    {involvedGroups.length > 0 && <div style={{marginBottom:14}}>
      {involvedGroups.map(g => {
        const isBound = g.groupType === 'bound';
        const pkgInfo = packageLabel(g.packageId);
        // Eligibility: swimmers with the group's exact package. Without
        // a package_id on the group (legacy data) we fall back to "all
        // swimmers in this family" so legacy groups remain editable.
        const eligibleHere = g.packageId ? eligibleFor(pkgInfo ? (packageById?.(g.packageId)?.lesson_type_id) : null, g.packageId) : pg.swimmers;
        // Multi-group: membership comes from the junction-derived Set on each swimmer.
        const memberSetForThisParent = pg.swimmers.filter(s => (s.familyGroupIds || []).includes(g.id));
        const isEditingPkg = editPkgFor === g.id;
        const editPkgChoices = editPkgLtId ? packages.filter(p => p.lesson_type_id === editPkgLtId) : [];
        return <div key={g.id} className="parent-group-block">
          <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',marginBottom:6}}>
            <strong>{isBound ? '🔗' : '👪'} {g.name}</strong>
            {pkgInfo ? <span className="parent-group-tag" title="Group package — only swimmers with this package are eligible">{pkgInfo.ltName} · {pkgInfo.pkgName}</span> : <span className="parent-group-tag" style={{background:'#fef3c7',borderColor:'#fde68a',color:'#854d0e'}}>⚠ no package set</span>}
            <button className="btn btn-ghost small" onClick={()=>{
              if(isEditingPkg){ setEditPkgFor(null); return; }
              // Pre-fill the editor with current selection
              const cur = g.packageId ? packageById?.(g.packageId) : null;
              setEditPkgLtId(cur?.lesson_type_id || '');
              setEditPkgPkgId(g.packageId || '');
              setEditPkgFor(g.id);
            }}>{isEditingPkg ? 'Cancel' : (pkgInfo ? '✎ Change package' : '+ Set package')}</button>
            <button className="btn btn-ghost small" onClick={()=>updateGroup(g.id, { groupType: isBound?'discount':'bound' })}>
              {isBound ? 'Switch to Discount' : 'Switch to Bound'}
            </button>
            <button className="btn btn-danger small" onClick={()=>deleteGroup(g)}>Delete</button>
            <span className="subtle small" style={{marginLeft:'auto'}}>{memberSetForThisParent.length} of {eligibleHere.length} eligible</span>
          </div>

          {/* Inline package editor for this existing group */}
          {isEditingPkg && <div style={{padding:'9px 11px',background:'#F0F9FF',border:'1px solid #BFDBFE',borderRadius:6,marginBottom:8}}>
            <div className="parent-sub-log-title" style={{fontSize:10,marginBottom:6}}>
              {pkgInfo ? 'Change package for this group' : 'Set the package this group is billed under'}
            </div>
            <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr auto'}}>
              <div className="field">
                <label>Lesson Type</label>
                <select className="select" value={editPkgLtId} onChange={e=>{ setEditPkgLtId(e.target.value); setEditPkgPkgId(''); }}>
                  <option value="">— Select lesson type —</option>
                  {lessonTypes.map(lt => <option key={lt.id} value={lt.id}>{lt.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Package</label>
                <select className="select" value={editPkgPkgId} onChange={e=>setEditPkgPkgId(e.target.value)} disabled={!editPkgLtId}>
                  <option value="">{editPkgLtId ? '— Select package —' : 'Pick lesson type first'}</option>
                  {editPkgChoices.map(p => <option key={p.id} value={p.id}>{p.name}{p.amount != null ? ` · RM${p.amount}` : ''}</option>)}
                </select>
              </div>
              <div className="field" style={{justifyContent:'flex-end'}}>
                <button className="btn btn-primary small" disabled={!editPkgPkgId} onClick={async ()=>{
                  await updateGroup(g.id, { packageId: editPkgPkgId });
                  setEditPkgFor(null);
                }}>Save</button>
              </div>
            </div>
            <div className="hint" style={{marginTop:6}}>Setting the package activates bundle billing for this group — all members enrolled in this (lesson type, package) pair are billed once via the group bundle.</div>
          </div>}

          <div className="parent-group-members">
            {eligibleHere.length === 0 ? <span className="subtle small">No swimmers in this family have the matching package.</span> : eligibleHere.map(sw => {
              const inThis = (sw.familyGroupIds || []).includes(g.id);
              // If this swimmer is NOT already in this group but IS in
              // another group with the same package, lock them out — they
              // can't be moved without removing them from the other group
              // first (that's the patched "no hopping" rule).
              const other = !inThis && g.packageId ? conflictingGroupFor(sw.id, g.packageId, g.id) : null;
              const locked = !!other;
              return <label key={sw.id} className="parent-group-member" style={locked ? {opacity:.45} : null} title={locked ? `Already in "${other.name}" — remove from there first` : undefined}>
                <input type="checkbox" checked={inThis} disabled={locked} onChange={(e)=>{
                  if(e.target.checked){ addStudentToGroup(sw.id, g.id); }
                  else { removeStudentFromGroup(sw.id, g.id); }
                }} /> {sw.name}{locked ? <span className="subtle small"> · in {other.name}</span> : null}
              </label>;
            })}
            {/* Show any non-eligible swimmers as muted, so user understands why they can't be added */}
            {g.packageId && pg.swimmers.filter(s => !eligibleHere.includes(s)).map(sw => <label key={sw.id} className="parent-group-member" style={{opacity:.45}} title="Does not have the matching package enrollment"><input type="checkbox" disabled /> {sw.name}</label>)}
          </div>
        </div>;
      })}
    </div>}

    {/* ── Create new group ──────────────────────────────────────────── */}
    <div className="parent-group-create">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:creatingOpen?8:0}}>
        <div className="parent-sub-log-title" style={{margin:0}}>Create a new family group</div>
        <button className={`btn small ${creatingOpen?'btn-ghost':'btn-primary'}`} onClick={()=>setCreatingOpen(o=>!o)}>{creatingOpen?'Cancel':'+ New Group'}</button>
      </div>

      {creatingOpen && <div style={{display:'flex',flexDirection:'column',gap:10,marginTop:8}}>
        {/* Step 1: Lesson Type + Package (the eligibility filter) */}
        <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr'}}>
          <div className="field">
            <label>Lesson Type</label>
            <select className="select" value={creatingLtId} onChange={e=>{ setCreatingLtId(e.target.value); setCreatingPkgId(''); }}>
              <option value="">— Select lesson type —</option>
              {lessonTypes.map(lt => <option key={lt.id} value={lt.id}>{lt.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Package</label>
            <select className="select" value={creatingPkgId} onChange={e=>setCreatingPkgId(e.target.value)} disabled={!creatingLtId}>
              <option value="">{creatingLtId ? '— Select package —' : 'Pick lesson type first'}</option>
              {eligiblePackages.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>

        {/* Step 2: Group name + type */}
        <div className="form-grid" style={{gridTemplateColumns:'1fr auto'}}>
          <div className="field">
            <label>Group Name</label>
            <input className="input" value={creatingName} onChange={e=>setCreatingName(e.target.value)} placeholder={`${pg.name} family · ${eligiblePackages.find(p=>p.id===creatingPkgId)?.name || 'group'}`} />
          </div>
          <div className="field">
            <label>Type</label>
            <div className="tabs" style={{gap:2,padding:2}}>
              <button type="button" className={`tab ${creatingType==='discount'?'active':''}`} style={{padding:'4px 10px',fontSize:11}} onClick={()=>setCreatingType('discount')}>👪 Discount</button>
              <button type="button" className={`tab ${creatingType==='bound'?'active':''}`} style={{padding:'4px 10px',fontSize:11}} onClick={()=>setCreatingType('bound')}>🔗 Bound</button>
            </div>
          </div>
        </div>

        {/* Step 3: Eligible swimmers (filtered by selected package +
             uniqueness check). Three buckets:
               • free       — checkable; package-eligible AND not in another group with same package
               • conflicted — disabled; package-eligible BUT already in another group with same package
               • ineligible — disabled; no matching enrolment */}
        {creatingPkgId && (() => {
          const free = previewEligible.filter(sw => !conflictingGroupFor(sw.id, creatingPkgId, null));
          const conflicted = previewEligible.filter(sw => !!conflictingGroupFor(sw.id, creatingPkgId, null));
          const lacking = pg.swimmers.filter(s => !previewEligible.includes(s));
          return <div className="parent-group-block" style={{background:'#F0F9FF',borderColor:'#BFDBFE'}}>
            <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',marginBottom:6}}>
              <strong>Eligible swimmers</strong>
              <span className="subtle small">{free.length} free · {conflicted.length} already in another group · {lacking.length} no matching enrolment</span>
              <div style={{marginLeft:'auto',display:'flex',gap:4}}>
                <button className="btn btn-ghost small" onClick={()=>setCreatingMemberIds(new Set(free.map(s => s.id)))} disabled={free.length===0}>All</button>
                <button className="btn btn-ghost small" onClick={selectNone} disabled={creatingMemberIds.size===0}>None</button>
              </div>
            </div>
            <div className="parent-group-members">
              {free.length === 0 && conflicted.length === 0 && lacking.length === pg.swimmers.length
                ? <span className="subtle small">No swimmers in this family have the selected package. Add the enrolment to a swimmer first via ✎ Edit on their row.</span>
                : null}
              {free.map(sw => {
                const checked = creatingMemberIds.has(sw.id);
                return <label key={sw.id} className="parent-group-member"><input type="checkbox" checked={checked} onChange={()=>toggleMember(sw.id)} /> {sw.name}</label>;
              })}
              {/* Conflicted: package matches BUT already in another group with same package. Tooltip names the conflicting group. */}
              {conflicted.map(sw => {
                const other = conflictingGroupFor(sw.id, creatingPkgId, null);
                return <label key={sw.id} className="parent-group-member" style={{opacity:.45}} title={`Already in "${other?.name}" with the same package — one group per (lesson type, package) per swimmer`}><input type="checkbox" disabled /> {sw.name} <span className="subtle small">· already in {other?.name}</span></label>;
              })}
              {/* Ineligible: lacks the matching enrolment entirely. */}
              {lacking.map(sw => <label key={sw.id} className="parent-group-member" style={{opacity:.45}} title="Does not have the selected package — add the enrolment to make eligible"><input type="checkbox" disabled /> {sw.name}</label>)}
            </div>
          </div>;
        })()}

        <div style={{display:'flex',justifyContent:'flex-end',gap:6}}>
          <button className="btn btn-primary small" onClick={handleCreate} disabled={!creatingLtId || !creatingPkgId || !creatingName.trim()}>
            + Create &amp; Assign {creatingMemberIds.size > 0 ? `(${creatingMemberIds.size})` : ''}
          </button>
        </div>
      </div>}
    </div>

    <div style={{display:'flex',justifyContent:'flex-end',marginTop:8}}>
      <button className="btn btn-ghost small" onClick={onClose}>Close</button>
    </div>
  </div>;
}

function ReceiptsView({ subscriptions, students, studentById, familyGroups, groupById, lessonTypeById, cancelSubscription }){
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchQ, setSearchQ] = useState('');
  const [printSub, setPrintSub] = useState(null);
  const list = (subscriptions || [])
    .filter(s => statusFilter === 'all' ? true : statusFilter === 'active' ? !s.cancelled_at : !!s.cancelled_at)
    .filter(s => {
      if(!searchQ.trim()) return true;
      const q = searchQ.toLowerCase();
      const subjectName = s.subject_type === 'student' ? (studentById[s.subject_id]?.name || '') : (groupById?.[s.subject_id]?.name || '');
      const lt = lessonTypeById ? lessonTypeById(s.lesson_type_id)?.name || '' : '';
      return (subjectName + ' ' + lt + ' ' + (s.receipt_number || '') + ' ' + (s.notes || '')).toLowerCase().includes(q);
    });
  // Aggregate totals (active only)
  const activeOnly = (subscriptions || []).filter(s => !s.cancelled_at);
  const totalRevenue = activeOnly.reduce((sum, s) => sum + (Number(s.amount_paid) || 0), 0);
  const totalCreditsIssued = activeOnly.reduce((sum, s) => sum + (Number(s.credits_per_swimmer) * Number(s.swimmer_count) || 0), 0);
  function fmtDate(d){ if(!d) return ''; try{ return new Date(d).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}); } catch(_){ return d; } }
  function subjectName(s){
    return s.subject_type === 'student' ? (studentById[s.subject_id]?.name || '— deleted swimmer —') : (groupById?.[s.subject_id]?.name || '— deleted group —');
  }
  function ltName(s){ return lessonTypeById ? lessonTypeById(s.lesson_type_id)?.name || '—' : '—'; }

  return <>
    <div className="card" style={{marginBottom:12}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12,flexWrap:'wrap',marginBottom:10}}>
        <div>
          <div style={{fontSize:18,fontWeight:800}}>💰 Receipts &amp; Subscriptions</div>
          <div className="small subtle" style={{marginTop:3}}>Every subscription added or cancelled, in chronological order. Click a row to print a receipt.</div>
        </div>
        <div style={{display:'flex',gap:14,alignItems:'flex-end',flexWrap:'wrap'}}>
          <div><div className="small subtle">Active revenue</div><div style={{fontSize:22,fontWeight:800,color:'var(--green-tx)'}}>RM{totalRevenue.toFixed(2)}</div></div>
          <div><div className="small subtle">Credits issued (active)</div><div style={{fontSize:22,fontWeight:800,color:'var(--teal)'}}>{totalCreditsIssued}</div></div>
        </div>
      </div>
      <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
        <div className="tabs" style={{gap:2,padding:2}}>
          {['all','active','cancelled'].map(v => <button key={v} className={`tab ${statusFilter===v?'active':''}`} style={{padding:'4px 10px',fontSize:11}} onClick={()=>setStatusFilter(v)}>{v==='all'?'All':v==='active'?'Active':'Cancelled'}</button>)}
        </div>
        <input className="input" style={{flex:1,minWidth:200,maxWidth:360}} placeholder="Search by swimmer, group, lesson type, receipt #, notes…" value={searchQ} onChange={e=>setSearchQ(e.target.value)} />
        <span className="small subtle">{list.length} of {(subscriptions||[]).length}</span>
      </div>
    </div>
    <div className="card" style={{padding:0,overflow:'hidden'}}>
      <div className="table-wrap" style={{border:'none',borderRadius:0,maxHeight:'70vh'}}>
        <table>
          <thead><tr>
            <th style={{width:90}}>Date</th>
            <th>Subject</th>
            <th style={{width:130}}>Lesson Type</th>
            <th style={{width:90}}>Credits</th>
            <th style={{width:100}}>Source</th>
            <th style={{width:100}}>Amount</th>
            <th style={{width:110}}>Receipt #</th>
            <th style={{width:90}}>Status</th>
            <th style={{width:160,textAlign:'right'}}></th>
          </tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={9} className="empty">No subscriptions match.</td></tr>}
            {list.map(s => <tr key={s.id} style={s.cancelled_at?{opacity:0.65}:undefined}>
              <td style={{whiteSpace:'nowrap',fontWeight:600}}>{fmtDate(s.subscription_date)}</td>
              <td>
                <div style={{fontWeight:700}}>{s.subject_type === 'family_group' ? '👪 ' : '👤 '}{subjectName(s)}</div>
                {s.notes ? <div className="subtle" style={{fontSize:11}}>{s.notes}</div> : null}
              </td>
              <td>{ltName(s)}</td>
              <td><span style={{color:'var(--teal)',fontWeight:700}}>+{s.credits_per_swimmer}</span> × {s.swimmer_count}</td>
              <td className="subtle">{s.source || '—'}</td>
              <td>{s.amount_paid != null ? `RM${Number(s.amount_paid).toFixed(2)}` : <span className="subtle">—</span>}</td>
              <td>{s.receipt_number || <span className="subtle">—</span>}</td>
              <td>{s.cancelled_at ? <span className="pill" style={{background:'var(--red-bg)',color:'var(--red-tx)',borderColor:'var(--red-bd)'}}>Cancelled</span> : <span className="pill" style={{background:'var(--green-bg)',color:'var(--green-tx)',borderColor:'var(--green-bd)'}}>Active</span>}</td>
              <td style={{textAlign:'right',whiteSpace:'nowrap'}}>
                <button className="btn btn-ghost small" onClick={()=>setPrintSub(s)}>🖨 Receipt</button>
                {!s.cancelled_at && cancelSubscription ? <button className="btn btn-danger small" style={{marginLeft:4}} onClick={()=>cancelSubscription(s)}>Cancel</button> : null}
              </td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </div>
    {printSub ? <ReceiptModal subscription={printSub} subjectName={subjectName(printSub)} ltName={ltName(printSub)} onClose={()=>setPrintSub(null)} /> : null}
  </>;
}

// Receipt printable popover — simple, prints to A6/A5 cleanly.
function ReceiptModal({ subscription, subjectName, ltName, onClose }){
  function doPrint(){
    document.body.setAttribute('data-print-view', 'receipt');
    window.print();
    setTimeout(()=>document.body.removeAttribute('data-print-view'), 300);
  }
  const totalCredits = Number(subscription.credits_per_swimmer) * Number(subscription.swimmer_count);
  return <div className="modal-backdrop"><div className="modal-card" style={{maxWidth:520}}>
    <div className="modal-head">
      <div style={{fontSize:14,fontWeight:800}}>Receipt Preview</div>
      <button className="btn btn-ghost small" onClick={onClose}>✕</button>
    </div>
    <div className="modal-body">
      <div className="receipt-sheet" id="receipt-sheet">
        <div className="receipt-head">
          <div className="receipt-brand">SSB · Star Swim Sdn Bhd</div>
          <div className="receipt-meta">Receipt</div>
        </div>
        <table className="receipt-table">
          <tbody>
            <tr><th>Date</th><td>{subscription.subscription_date}</td></tr>
            <tr><th>Receipt #</th><td>{subscription.receipt_number || '—'}</td></tr>
            <tr><th>For</th><td>{subjectName}</td></tr>
            <tr><th>Lesson Type</th><td>{ltName}</td></tr>
            <tr><th>Credits</th><td>+{subscription.credits_per_swimmer} × {subscription.swimmer_count} swimmer{subscription.swimmer_count===1?'':'s'} = <strong>{totalCredits}</strong> credits</td></tr>
            <tr><th>Source</th><td>{subscription.source || '—'}</td></tr>
            {subscription.notes ? <tr><th>Notes</th><td>{subscription.notes}</td></tr> : null}
            <tr><th>Amount</th><td><strong>{subscription.amount_paid != null ? `RM ${Number(subscription.amount_paid).toFixed(2)}` : '—'}</strong></td></tr>
            {subscription.cancelled_at ? <tr><th>Status</th><td style={{color:'var(--red-tx)'}}>CANCELLED on {String(subscription.cancelled_at).slice(0,10)}</td></tr> : null}
          </tbody>
        </table>
        <div className="receipt-foot">Thank you.</div>
      </div>
    </div>
    <div className="modal-foot">
      <button className="btn btn-ghost small" onClick={onClose}>Close</button>
      <button className="btn btn-primary" onClick={doPrint}>🖨 Print</button>
    </div>
  </div></div>;
}



function StudentsView({ students, lessonTypes, lessonTypeById, packages, packageById, groupById, familyGroups, membersByGroup, scheduleByStudent, sessions, jumpToWeek, creditByKey, purchasesByStudent, subscriptions, addCreditPurchase, deleteCreditPurchase, addSubscription, cancelSubscription, adjustBalanceTo, addStudent, updateStudent, deleteStudent }){
  const [name, setName] = useState('');
  const [dob, setDob] = useState('');
  const [gender, setGender] = useState(null);
  const [enrollments, setEnrollments] = useState([{ lessonTypeId: '', packageId: '' }]);
  const [guardianName, setGuardianName] = useState('');
  const [guardianEmail, setGuardianEmail] = useState('');
  const [guardianPhone, setGuardianPhone] = useState('');
  const [sameAsGuardian, setSameAsGuardian] = useState(false);
  const [emergencyPhone, setEmergencyPhone] = useState('');
  const [emergencyRel, setEmergencyRel] = useState('');
  const [adultSelf, setAdultSelf] = useState(false);
  const [editId, setEditId] = useState(null);
  const [creditId, setCreditId] = useState(null);
  const [q, setQ] = useState('');
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
    const out = {};   // studentId → lessonTypeId → weekStartDate
    (sessions || []).forEach(s => {
      if(s.cancelledAt) return;                       // skip ghosts
      if(!s.weekStartDate || s.weekStartDate < todayWs) return;
      (s.students || []).forEach(st => {
        const sid = st.studentId; if(!sid) return;
        if(!out[sid]) out[sid] = {};
        const prev = out[sid][s.lessonTypeId];
        if(!prev || s.weekStartDate < prev) out[sid][s.lessonTypeId] = s.weekStartDate;
      });
    });
    return out;
  }, [sessions]);
  function nextWeekFor(studentId, lessonTypeName){
    const ltId = (lessonTypes.find(lt => lt.name === lessonTypeName) || {}).id;
    if(!ltId) return null;
    return (nextScheduledByStudentLt[studentId] || {})[ltId] || null;
  }

  function colorsForId(id){ const t = lessonTypeById(id); return t ? { bg:t.bg_color, bd:t.border_color, tx:t.text_color, name:t.name } : { bg:'#eee', bd:'#ccc', tx:'#333', name:'(removed)' }; }
  function packageLabel(s){
    const g = s.familyGroupId && groupById ? groupById[s.familyGroupId] : null;
    if(g){ const gp = g.packageId ? packageById(g.packageId) : null; return `👪 ${g.name}${gp ? ` · ${gp.name}` : ''}`; }
    const p = s.packageId ? packageById(s.packageId) : null;
    if(p){ const b = billingText(p.billing_mode, p.billing_count); return `${p.name}${p.amount != null ? ` · RM${p.amount}` : ''}${b ? ` · ${b}` : ''}`; }
    return s.package || '—';
  }
  function scheduleLines(id){
    const slots = scheduleByStudent[id] || [];
    if(!slots.length) return null;
    const byType = {};
    slots.forEach(sl => { (byType[sl.type] = byType[sl.type] || []).push(sl); });
    return Object.keys(byType).map(type => ({ type, times: byType[type].map(sl => `${DAYS_S[sl.day]} ${minuteToTime(sl.startMinute)}`) }));
  }
  function creditInfo(s){
    const pkg = s.packageId ? packageById(s.packageId) : null;
    if(!pkg || pkg.billing_mode !== 'credit') return null;
    const ltId = pkg.lesson_type_id;
    if(!ltId || !creditByKey) return null;
    const bal = creditByKey[`${s.id}:${ltId}`];
    if(!bal) return null;
    const scheduled = (scheduleByStudent[s.id] || []).filter(sl => sl.lessonTypeId === ltId).length;
    return { remaining: bal.remaining_balance, initial: bal.initial_balance, scheduled };
  }
  function handleAdultSelf(v){ setAdultSelf(v); if(v) setGuardianName(name); }
  function handleSameAsG(v){ setSameAsGuardian(v); if(v){ setEmergencyPhone(guardianPhone); setEmergencyRel('Parent / Guardian'); } }

  const filtered = students.filter(s => !q || (s.name || '').toLowerCase().includes(q.toLowerCase()));

  const displayList = useMemo(() => {
    if(sortBy === 'name'){
      const byGroup = {}, ungrouped = [];
      filtered.forEach(s => { if(s.familyGroupId){ (byGroup[s.familyGroupId]=byGroup[s.familyGroupId]||[]).push(s); } else ungrouped.push(s); });
      const rows = [];
      Object.entries(byGroup).sort(([aId],[bId])=>(groupById?.[aId]?.name||'').localeCompare(groupById?.[bId]?.name||'')).forEach(([gid,members])=>{
        rows.push({ kind:'group', gid, label:groupById?.[gid]?.name||'Group' });
        members.slice().sort((a,b)=>a.name.localeCompare(b.name)).forEach(s=>rows.push({kind:'swimmer',s}));
      });
      ungrouped.slice().sort((a,b)=>a.name.localeCompare(b.name)).forEach(s=>rows.push({kind:'swimmer',s}));
      return rows;
    }
    return filtered.slice().sort((a,b)=>{
      if(sortBy==='type'){ const tA=(a.lessonTypeIds?.[0]?lessonTypeById(a.lessonTypeIds[0])?.name:'')||''; const tB=(b.lessonTypeIds?.[0]?lessonTypeById(b.lessonTypeIds[0])?.name:'')||''; return tA.localeCompare(tB)||a.name.localeCompare(b.name); }
      if(sortBy==='package'){ const pA=(a.packageId?packageById(a.packageId)?.name:'')||''; const pB=(b.packageId?packageById(b.packageId)?.name:'')||''; return pA.localeCompare(pB)||a.name.localeCompare(b.name); }
      return 0;
    }).map(s=>({kind:'swimmer',s}));
  }, [filtered, sortBy, groupById]);

  const COLS = 9;

  function resetForm(){ setName(''); setDob(''); setGender(null); setEnrollments([{ lessonTypeId: '', packageId: '' }]); setGuardianName(''); setGuardianEmail(''); setGuardianPhone(''); setSameAsGuardian(false); setEmergencyPhone(''); setEmergencyRel(''); setAdultSelf(false); }

  return <>
    <div className="card intake-banner" style={{marginBottom:16}}>
      <div className="intake-banner-inner">
        <div className="intake-banner-icon" aria-hidden="true">🏊</div>
        <div className="intake-banner-text">
          <div className="intake-banner-title">Parent Intake</div>
          <div className="intake-banner-sub">Open the digital form on this tablet for parents to self-register, or print a hard-copy form for walk-ins without a device. To add a swimmer manually or edit any details, use the 👤 Accounts tab.</div>
        </div>
        <div style={{display:'flex',gap:8,flexShrink:0,flexWrap:'wrap'}}>
          <button type="button" className="btn btn-primary intake-banner-btn" onClick={()=>window.open('./intake.html', '_blank', 'noopener,noreferrer')} title="Opens the digital intake form in a new tab">
            Digital Form <span aria-hidden="true" style={{marginLeft:6}}>↗</span>
          </button>
        </div>
      </div>
    </div>

    <div className="card">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,flexWrap:'wrap',marginBottom:12}}>
        <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
          <div style={{fontSize:16,fontWeight:800}}>Swimmer Directory <span className="subtle" style={{fontWeight:600,fontSize:13}}>· {students.length}</span></div>
          <div className="sort-tabs">{[['name','Name'],['type','Lesson Type'],['package','Package']].map(([k,lbl])=><button key={k} className={`sort-tab ${sortBy===k?'active':''}`} onClick={()=>setSortBy(k)} data-key={k}>{lbl}</button>)}</div>
          <span className="subtle small" style={{marginLeft:6}}>Read-only · edit details in 👤 Accounts</span>
        </div>
        <input className="input" style={{maxWidth:220}} placeholder="Search swimmers…" value={q} onChange={e=>setQ(e.target.value)} />
      </div>
      <div className="table-wrap">
        <table><thead><tr>
          <th style={{width:'14%'}}>Name</th>
          <th style={{width:32}}>Age</th>
          <th style={{width:'13%'}}>Parent</th>
          <th style={{width:'10%'}}>Emergency</th>
          <th style={{width:'10%'}}>Lesson Type</th>
          <th style={{width:'17%'}}>Package</th>
          <th style={{width:'9%'}}>Credits</th>
          <th style={{width:'5%'}}>T&amp;C</th>
          <th>Schedule</th>
        </tr></thead>
        <tbody>{displayList.length ? displayList.map((row,ri)=>{
          if(row.kind==='group') return <tr key={`g-${row.gid}`} className="swimmer-group-header"><td colSpan={COLS}><span className="group-header-label">👪 {row.label}</span></td></tr>;
          const s=row.s; const sched=scheduleLines(s.id);
          const tcOk = !!s.tcAcceptedAt;
          // Per-LT credit summary — show each LT's remaining balance as a chip
          const ltCredits = (s.lessonTypeIds || []).map(ltId => {
            const lt = lessonTypeById ? lessonTypeById(ltId) : null;
            const bal = creditByKey[`${s.id}:${ltId}`];
            const rem = bal ? Number(bal.remaining_balance) || 0 : null;
            return { lt, rem };
          });
          // Parent + emergency display
          const parentBits = [s.guardianName, s.guardianPhone].filter(Boolean);
          const emergencyBits = s.emergencySameAsGuardian
            ? <span className="subtle small" title="Same as guardian">↗ as guardian</span>
            : (s.emergencyPhone ? <><span>{s.emergencyPhone}</span>{s.emergencyRelationship ? <><br/><span className="subtle small">{s.emergencyRelationship}</span></> : null}</> : <span className="subtle">—</span>);
          return <React.Fragment key={s.id}>
            <tr className={s.familyGroupId?'swimmer-in-group':''}>
              <td style={{fontWeight:700}}>{s.name}{s.gender?<span style={{marginLeft:4,fontSize:10,color:'var(--text-3)'}}>{s.gender==='female'?'♀':'♂'}</span>:null}</td>
              <td>{s.age!=null?s.age:'—'}</td>
              <td style={{fontSize:11}}>{parentBits.length
                ? <><div style={{fontWeight:600}}>{s.guardianName || '—'}</div>{s.guardianPhone ? <div className="subtle">{s.guardianPhone}</div> : null}</>
                : <span className="subtle">—</span>}</td>
              <td style={{fontSize:11}}>{emergencyBits}</td>
              <td><div style={{display:'flex',flexWrap:'wrap',gap:3}}>{(s.lessonTypeIds||[]).length?s.lessonTypeIds.map(id=>{const c=colorsForId(id);return <span key={id} className="chip" style={{background:c.bg,borderColor:c.bd,color:c.tx,fontSize:10,padding:'2px 7px'}}>{c.name}</span>;}): <span className="subtle">—</span>}</div></td>
              <td style={{fontSize:12}}>{packageLabel(s)}</td>
              <td>{ltCredits.length
                ? <div style={{display:'flex',flexDirection:'column',gap:2}}>{ltCredits.map(({lt, rem}) => lt ? <span key={lt.id} className="swimmer-cred-chip"><span className="subtle" style={{fontSize:9}}>{lt.name.split(' ').slice(0,2).join(' ')}:</span> <strong className={rem!=null && rem<=2?'credit-low':''}>{rem!=null ? rem : '—'}</strong></span> : null)}</div>
                : <span className="subtle">—</span>}</td>
              <td>{tcOk?<span className="tc-badge-ok" title={`Accepted ${new Date(s.tcAcceptedAt).toLocaleDateString()} · ID: ${s.tcAcceptanceId}`}>✅</span>:<span className="tc-badge-pending" title="Terms & Conditions not yet accepted">⚠</span>}</td>
              <td style={{fontSize:11}}>{sched?sched.map((g,gi)=>{
                const targetWeek = jumpToWeek ? nextWeekFor(s.id, g.type) : null;
                const handleJump = (e) => { e.stopPropagation(); if(targetWeek) jumpToWeek(targetWeek, 0); };
                return targetWeek
                  ? <button key={gi} type="button" className="swimmer-sched-link" onClick={handleJump} title={`Jump to week of ${targetWeek}`}>
                      <span style={{fontWeight:700}}>{g.type}:</span> <span className="subtle">{g.times.join(', ')}</span>
                      <span className="swimmer-sched-arrow" aria-hidden="true">↗</span>
                    </button>
                  : <div key={gi} style={{marginBottom:2}}><span style={{fontWeight:700}}>{g.type}:</span> <span className="subtle">{g.times.join(', ')}</span></div>;
              }):<span className="subtle">Not scheduled</span>}</td>
            </tr>
          </React.Fragment>;
        }):<tr><td colSpan={COLS} className="empty">No swimmers registered yet.</td></tr>}
        </tbody></table>
      </div>
    </div>
  </>;
}

// ============================================================================
// TCView — Terms & Conditions page with swimmer selection & email acceptance
// ============================================================================
const TC_COMPANY = 'Star Swim Sdn Bhd';
const TC_CONTENT = [
  { h: '1. Introduction', body: `These Terms and Conditions ("Agreement") govern the enrolment and participation of swimmers in swimming lessons and aquatic programmes offered by ${TC_COMPANY} ("the School", "we", "our"). By accepting this Agreement, the parent, legal guardian, or adult swimmer ("you") acknowledges having read, understood, and agreed to be bound by these terms. This Agreement constitutes a legally binding contract.` },
  { h: '2. Safeguarding & Child Protection', body: `${TC_COMPANY} is committed to providing a safe, inclusive, and supportive aquatic environment for all participants.\n\n2.1 The School adheres to the National Child Protection Principles and Malaysia's Child Act 2001. All instructors undergo background screening and hold current first aid and lifeguard certifications.\n\n2.2 Parents and guardians are required to remain within the facility premises during all sessions involving participants under 12 years of age, unless otherwise agreed in writing.\n\n2.3 Any concerns regarding the welfare of a child, safeguarding issues, or inappropriate conduct should be raised immediately with the School Administrator or reported to: Jabatan Kebajikan Masyarakat (Social Welfare Department) at 1-800-88-3900.\n\n2.4 Photography and video recording of any swimmer — including your own child — are prohibited within pool areas without prior written consent from ${TC_COMPANY} and the relevant guardian of every swimmer present.` },
  { h: '3. Class Cancellation & Attendance Policy', body: `3.1 Advance Notice: Cancellations must be communicated to the School no less than twenty-four (24) hours before the scheduled class start time. Cancellations received within this 24-hour window will be treated as an Absence unless a valid emergency and accompanying proof are provided.\n\n3.2 Medical Cancellation: Absences due to illness or medical conditions will be considered valid cancellations provided the School receives a copy of a certified Medical Certificate (MC) issued by a registered medical practitioner within 48 hours of the missed class. On receipt of a valid MC, the swimmer is entitled to one (1) replacement class.\n\n3.3 Absence (No Replacement): Where a swimmer is absent without valid 24-hour prior notice or a valid MC, the class will be recorded as "provided," credits will be deducted where applicable, and no replacement lesson will be offered.\n\n3.4 Last-Minute Emergencies: Genuine emergencies (e.g. hospitalisation, accident, bereavement) occurring within the 24-hour window may be considered at the School's discretion upon submission of appropriate supporting documentation.` },
  { h: '4. School-Initiated Cancellations', body: `4.1 Weather Conditions: Classes may be suspended or cancelled at the School's sole discretion during adverse weather — including lightning, heavy rainfall, or hazardous pool conditions. Participants will be notified as promptly as possible via WhatsApp or email. Any class cancelled due to weather entitles the swimmer to a full replacement lesson at no additional cost.\n\n4.2 Instructor Cancellation: Should a class be cancelled by ${TC_COMPANY} or by an assigned instructor for reasons within the School's control, all affected swimmers are entitled to a replacement lesson. The replacement will be scheduled within the same billing cycle where possible, or carried forward.` },
  { h: '5. Replacement Class Policy', body: `5.1 Group Classes: Replacement sessions for group classes may be attended in any currently active class of the same lesson type, provided a slot is available. Replacements must be arranged through the School and are subject to availability. Replacement swimmers are marked as "drop-in replacement" and are not carried forward in subsequent weeks.\n\n5.2 Personal & Private Classes (Personal 1, Personal 2, Personal Toddler, Stroke Lab, Premium Personal, Personal Clara): Replacement sessions for personal classes are to be arranged directly between the assigned instructor and the parent or guardian, subject to mutual time availability and pool space. The School will facilitate communication. Replacement credits will be applied and the rescheduled session logged.\n\n5.3 Validity: Replacement lessons must be utilised within 14 calendar days of the missed class, unless otherwise agreed in writing. Unused replacement entitlements expire at the end of the month in which they were granted.` },
  { h: '6. Credit System (Personal & Private Classes)', body: `6.1 Students enrolled in personal or private lesson programmes are allocated a credit balance corresponding to the number of sessions purchased in their package.\n\n6.2 One (1) credit is deducted for each scheduled and attended class. Credits are not deducted for classes cancelled by the School or for classes where a valid MC has been provided.\n\n6.3 Credits are non-refundable and non-transferable to another swimmer. Unused credits at the end of a package cycle are forfeited unless otherwise agreed in writing.\n\n6.4 The School reserves the right to apply a credit deduction when a replacement or rescheduled class is successfully attended.` },
  { h: '7. Fees & Payment', body: `7.1 All fees are due in accordance with the payment schedule indicated in your enrolment confirmation. Late payment may result in suspension from classes.\n\n7.2 Fees are non-refundable once a billing cycle has commenced, except in extraordinary circumstances at the School's discretion.\n\n7.3 The School reserves the right to revise fee structures with a minimum of 30 days' written notice.` },
  { h: '8. Health, Safety & Medical Disclosure', body: `8.1 Good Health Confirmation: You confirm that the swimmer is in good health and is medically fit to participate in aquatic activities.

8.2 Medical & Behavioural Declaration: You further declare that, to the best of your knowledge, the swimmer named in this registration:
  (a) does not have any known medical, physical, or psychological condition that would prevent safe participation in swimming lessons;
  (b) has not been advised by a medical professional to refrain from physical activity or aquatic programmes;
  (c) is not under any medication or treatment that would interfere with swim lesson participation;
  (d) does not require additional support unless previously disclosed.

8.3 Disclosure Obligation: Any pre-existing medical condition, allergy, behavioural consideration, or physical limitation must be disclosed to the School prior to the commencement of classes. If any such conditions exist, you confirm that you have disclosed them during registration or will inform the School's administrators before lessons commence.

8.4 Consequences of Non-Disclosure: You understand that failure to disclose relevant medical or behavioural information may affect the safety and quality of instruction and may result in withdrawal from the programme without refund.

8.5 Liability: The School is not liable for injuries or health events arising from undisclosed medical or behavioural conditions.

8.6 Emergency Authorisation: In the event of a medical emergency, the School is authorised to administer basic first aid and to contact emergency services. All reasonable effort will be made to contact the designated emergency contact immediately.` },
  { h: '9. Liability Waiver', body: `9.1 Participation in aquatic activities carries inherent risks. By accepting this Agreement, you acknowledge these risks and agree that ${TC_COMPANY}, its directors, instructors, and staff shall not be liable for any injury, loss, damage, or claim arising from participation in the School's programmes, except where caused by the School's gross negligence or wilful misconduct.\n\n9.2 The School maintains appropriate public liability insurance.` },
  { h: '10. Photography, Video & Marketing Consent', body: `10.1 By accepting these Terms, you consent to ${TC_COMPANY} taking photographs and video recordings of the swimmer during lessons, classes, and events for the purposes of instructor training, social media, advertising, school newsletters, and other marketing activities undertaken by the School.

10.2 Opt-Out: If you wish to withhold consent for the use of your swimmer's images in marketing materials, please notify the School in writing at the time of registration or thereafter. The School will then take reasonable steps to exclude the swimmer from marketing photography going forward; this opt-out does not retroactively remove already-published materials.

10.3 This School-led photography consent is distinct from the third-party photography restrictions described in clause 2.4. Visitors and other guardians remain prohibited from photographing or recording any swimmer (including their own child within shared pool areas) without prior written consent from ${TC_COMPANY} and the relevant guardians of every swimmer present.` },
  { h: '11. Acceptance & Governing Law', body: `This Agreement is governed by the laws of Malaysia. Any dispute shall be subject to the jurisdiction of the courts of Malaysia. By electronically accepting, you confirm you have read and agree to all clauses above on behalf of yourself and/or the enrolled swimmer.` }
];

function TCView({ students, lessonTypes, lessonTypeById, onSaveAcceptance }){
  const [studentId, setStudentId] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // { acceptanceId, studentName, email }
  const [scrolled, setScrolled] = useState(false);

  const student = students.find(s => s.id === studentId) || null;
  const lt = student?.lessonTypeIds?.[0] ? lessonTypeById(student.lessonTypeIds[0]) : null;
  const alreadySigned = !!student?.tcAcceptedAt;

  function handleScroll(e){ if(e.target.scrollTop + e.target.clientHeight >= e.target.scrollHeight - 40) setScrolled(true); }

  async function handleAccept(){
    if(!student || !agreed || busy) return;
    if(!student.guardianEmail){ alert('No guardian email on file — please add an email address to this swimmer\'s profile before signing the T&C.'); return; }
    try{
      setBusy(true);
      const acceptanceId = await onSaveAcceptance({ studentId: student.id, guardianName: student.guardianName || student.name, guardianEmail: student.guardianEmail, lessonTypeName: lt?.name || '—' });
      const subj = encodeURIComponent(`Swimming Lesson Terms & Conditions — ${student.name} — ${TC_COMPANY}`);
      const dateStr = new Date().toLocaleString('en-MY', { dateStyle:'long', timeStyle:'short' });
      const emailBody = encodeURIComponent(
`Dear ${student.guardianName || student.name},

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
      setDone({ acceptanceId, studentName: student.name, email: student.guardianEmail });
      setAgreed(false); setScrolled(false);
    } catch(e){ alert(e?.message || 'Failed to record acceptance'); }
    finally{ setBusy(false); }
  }

  return <div style={{maxWidth:900,margin:'0 auto'}}>
    <div className="card" style={{marginBottom:16}}>
      <div style={{fontSize:22,fontWeight:800,marginBottom:4}}>Terms &amp; Conditions</div>
      <div className="small subtle">{TC_COMPANY} · Swimming Lesson Enrolment Agreement</div>
      <div style={{marginTop:14,display:'flex',gap:10,alignItems:'flex-end',flexWrap:'wrap'}}>
        <div className="field" style={{margin:0,flex:'1 1 240px'}}>
          <label>Select Swimmer</label>
          <StudentSelect
            valueId={studentId || null}
            fallbackLabel={null}
            studentById={Object.fromEntries(students.map(s=>[s.id,s]))}
            candidates={students.filter(s=>!s.tcAcceptedAt).slice().sort((a,b)=>a.name.localeCompare(b.name))}
            onPick={(stu)=>{ setStudentId(stu?stu.id:''); setAgreed(false); setScrolled(false); setDone(null); }}
            conflict={null}
          />
          <div className="hint" style={{marginTop:4}}>Only swimmers without a signed T&amp;C are shown. Already-signed swimmers are filtered out.</div>
        </div>
        {student && <div className="tc-student-summary">
          <div><span className="small subtle">Guardian:</span> <strong>{student.guardianName||'—'}</strong></div>
          <div><span className="small subtle">Email:</span> <strong>{student.guardianEmail||<span className="tc-warn">⚠ No email — add in Swimmers tab</span>}</strong></div>
          <div><span className="small subtle">Lesson Type:</span> <strong>{lt?.name||'—'}</strong></div>
        </div>}
      </div>
      {alreadySigned && <div className="tc-status-row tc-accepted" style={{marginTop:12}}>
        ✅ T&amp;C already accepted for {student.name} · ID: {student.tcAcceptanceId} · {new Date(student.tcAcceptedAt).toLocaleDateString(undefined,{dateStyle:'long'})}
      </div>}
    </div>

    <div className="card" style={{marginBottom:16}}>
      <div className="tc-doc-scroll" onScroll={handleScroll}>
        <h1 className="tc-h1">{TC_COMPANY}</h1>
        <h2 className="tc-h2">Swimming Lesson Enrolment — Terms &amp; Conditions</h2>
        {TC_CONTENT.map((sec,i)=><div key={i} className="tc-section">
          <h3 className="tc-h3">{sec.h}</h3>
          {sec.body.split('\n\n').map((p,j)=><p key={j} className="tc-para">{p}</p>)}
        </div>)}
        {!scrolled && <div className="tc-scroll-hint">↓ Scroll to the bottom to enable acceptance</div>}
      </div>
    </div>

    {done
      ? <div className="card tc-success">
          <div style={{fontSize:20,fontWeight:800,marginBottom:6}}>✅ Accepted — {done.studentName}</div>
          <div className="small">Acceptance ID: <strong>{done.acceptanceId}</strong></div>
          <div className="small subtle" style={{marginTop:4}}>Your email client has been opened with a confirmation email pre-addressed to <strong>{done.email}</strong>. Please review and click Send. The email instructs them to reply if they do not agree.</div>
          <button className="btn btn-ghost small" style={{marginTop:10}} onClick={()=>setDone(null)}>Sign another swimmer</button>
        </div>
      : <div className="card">
          <label className="gb-check" style={{fontSize:14,display:'flex',gap:10,alignItems:'flex-start',opacity:scrolled?1:0.4,transition:'opacity .2s',cursor:scrolled?'pointer':'default'}}>
            <input type="checkbox" disabled={!scrolled||!student} checked={agreed} onChange={e=>setAgreed(e.target.checked)} style={{marginTop:3,flexShrink:0}} />
            <span>I have read and fully understood the Terms &amp; Conditions of {TC_COMPANY}. I agree to be bound by this Agreement on behalf of myself and/or the enrolled swimmer named above, and confirm all information provided is accurate.</span>
          </label>
          {!scrolled && <div className="small subtle" style={{marginTop:6,marginLeft:28}}>Please scroll through the full document above before accepting.</div>}
          <div style={{display:'flex',justifyContent:'flex-end',marginTop:14}}>
            <button className="btn btn-primary" disabled={!agreed||!student||busy||!student.guardianEmail} onClick={handleAccept} style={{padding:'10px 24px',fontSize:15}}>
              {busy ? 'Processing…' : '✍️ I Accept These Terms'}
            </button>
          </div>
          {student && !student.guardianEmail && <div className="hint" style={{color:'var(--red-tx)',marginTop:6,textAlign:'right'}}>⚠ A guardian email address is required before accepting.</div>}
        </div>}
  </div>;
}

function SessionModal({ modal, setModal, saveBusy, saveSession, deleteSession, openAddAtTime, instructors, lessonTypes, pools, lessonTypeByName, poolById, packageById, students, studentById, weekEnrollments, familyGroups, membersByGroup, groupById, trialStudentIds, trialByLessonType, creditByKey, purchasesByKey, addCreditPurchase, adjustCredit, initCredit, pendingByKey, replacementPending, markForReplacement, forwardClassToNextWeek, startFullClassMove, duplicateSessionForward }){
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [cancelClassOpen, setCancelClassOpen] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [reschedDay, setReschedDay] = useState(0);
  const [reschedMinute, setReschedMinute] = useState(480);
  const [initCreditInput, setInitCreditInput] = useState({});

  const currentLt = lessonTypes.find(t => t.name === modal.form.type);
  const isPersonal = currentLt?.class_type === 'personal';
  const isRescheduled = modal.rescheduledFromDay != null;

  // M2: union of durations — common standards plus every lesson type's default
  // and the currently-selected duration so the dropdown always contains the
  // active value.
  const durationOptions = useMemo(() => {
    const all = new Set([30, 45, 50, 60]);
    lessonTypes.forEach(lt => { if(lt.default_duration_minutes) all.add(Number(lt.default_duration_minutes)); });
    if(modal?.form?.durationMinutes) all.add(Number(modal.form.durationMinutes));
    return [...all].sort((a,b)=>a-b);
  }, [lessonTypes, modal?.form?.durationMinutes]);

  function setForm(patch){ setModal({ ...modal, form: { ...modal.form, ...patch } }); }

  function onTypeChange(name){
    const lt = lessonTypes.find(t => t.name === name);
    const patch = { type: name, lessonTypeId: lt?.id || null };
    if(lt?.default_duration_minutes) patch.durationMinutes = Number(lt.default_duration_minutes);
    if(lt?.default_pool_id) patch.poolId = lt.default_pool_id;
    patch.studentRows = rebuildRowsForCap(modal.form.studentRows, lt?.students_per_instructor);
    setForm(patch);
  }

  function setRow(i, key, val){ const rows = (modal.form.studentRows || []).slice(); rows[i] = { ...rows[i], [key]: val }; setForm({ studentRows: rows }); }
  function addRow(){ setForm({ studentRows: [...(modal.form.studentRows || []), { studentId:null, name:'', age:'', remark:'', attendance:'pending' }] }); }
  function onInstructorChange(id){
    const inst = instructors.find(i => i.id === id);
    setForm({ instructorId: id || null, instructorName: inst?.name || '' });
  }

  // Pick a swimmer into a slot from the registry; snapshot name+age. null clears.
  // Bound-group auto-fill: if the picked swimmer is in a BOUND group whose
  // package matches this session's lesson type, also auto-add every other
  // member of that group that isn't already in the session. Bound members
  // must move through sessions together — this is the add counterpart of
  // the bound-removal guard in removeRow.
  function pickStudent(i, student){
    const rows = (modal.form.studentRows || []).slice();
    const keepRemark = student ? (rows[i]?.remark || '') : '';
    const keepAtt = student ? (rows[i]?.attendance || 'pending') : 'pending';
    rows[i] = student ? { studentId: student.id, name: student.name, age: (student.age === null || student.age === undefined ? '' : String(student.age)), remark: keepRemark, attendance: keepAtt } : { studentId:null, name:'', age:'', remark:'', attendance:'pending' };

    if(student && groupById && membersByGroup){
      const ltId = currentLt?.id;
      const stuFull = studentById[student.id] || student;
      const groupIds = stuFull.familyGroupIds || (stuFull.familyGroupId ? [stuFull.familyGroupId] : []);
      // Find a bound group whose package matches this session's lesson type.
      let boundGrp = null;
      for(const gid of groupIds){
        const g = groupById[gid];
        if(!g || g.groupType !== 'bound') continue;
        const pkg = g.packageId ? packageById?.(g.packageId) : null;
        if(pkg && ltId && pkg.lesson_type_id === ltId){ boundGrp = g; break; }
      }
      if(boundGrp){
        const inSessionIds = new Set(rows.filter(r => r.studentId).map(r => r.studentId));
        const missingMembers = (membersByGroup[boundGrp.id] || []).filter(m => m.id !== student.id && !inSessionIds.has(m.id));
        if(missingMembers.length){
          // Fill empty rows first, then append for any remaining.
          let cursor = 0;
          for(const m of missingMembers){
            // Find next empty slot starting from cursor
            while(cursor < rows.length && rows[cursor].studentId) cursor++;
            const slot = { studentId: m.id, name: m.name, age: (m.age == null ? '' : String(m.age)), remark: '', attendance: 'pending' };
            if(cursor < rows.length){ rows[cursor] = slot; cursor++; }
            else { rows.push(slot); }
          }
        }
      }
    }

    setForm({ studentRows: rows });
  }
  function setRemark(i, val){ const rows = (modal.form.studentRows || []).slice(); rows[i] = { ...rows[i], remark: val }; setForm({ studentRows: rows }); }
  function setAttendance(i, val){ const rows = (modal.form.studentRows || []).slice(); rows[i] = { ...rows[i], attendance: val }; setForm({ studentRows: rows }); }
  function setReplAttendance(i, val){ const rows = (modal.form.replacementRows || []).slice(); rows[i] = { ...rows[i], attendance: val }; setForm({ replacementRows: rows }); }

  // Bind this session to a family group and drop ALL its members into the slots
  // at once (padded to the lesson-type ratio). groupId '' clears the binding.
  // ── quickAddGroup: add all lesson-type-eligible members of a family
  // group to the current session additively — does NOT replace or clear
  // any existing students. For bound groups every member must go in
  // together; the user is warned if the class would go over capacity.
  // For discount groups the add is soft-warned only.
  function quickAddGroup(group){
    const ltId = currentLt?.id || modal?.form?.lessonTypeId;
    const members = ((membersByGroup && membersByGroup[group.id]) || [])
      .filter(m => !ltId || (m.lessonTypeIds || []).includes(ltId));
    if(!members.length){
      alert(`No members of "${group.name}" are enrolled in this lesson type.`);
      return;
    }
    const currentRows = modal.form.studentRows || [];
    const alreadyIn = new Set(currentRows.filter(r => r.studentId).map(r => r.studentId));
    const toAdd = members.filter(m => !alreadyIn.has(m.id));
    if(!toAdd.length){
      alert(`All members of "${group.name}" are already in this session.`);
      return;
    }
    const currentFilled = currentRows.filter(r => r.studentId || (r.name||'').trim()).length;
    const cap = previewMax;
    const isBound = group.groupType === 'bound';
    if(cap > 0 && currentFilled + toAdd.length > cap){
      const msg = isBound
        ? `"${group.name}" is a bound group — all ${toAdd.length} member${toAdd.length===1?'':'s'} must be added together.\n\nThis would put the class over capacity (${currentFilled + toAdd.length}/${cap}). Add anyway?`
        : `Adding ${toAdd.length} member${toAdd.length===1?'':'s'} from "${group.name}" would put the class over capacity (${currentFilled + toAdd.length}/${cap}). Add anyway?`;
      if(!confirm(msg)) return;
    }
    // Fill empty slots first, then append new ones.
    const newRows = [...currentRows];
    const emptyIdx = [];
    newRows.forEach((r, i) => { if(!r.studentId && !(r.name||'').trim()) emptyIdx.push(i); });
    toAdd.forEach(m => {
      const row = { studentId:m.id, name:m.name, age:m.age != null ? String(m.age) : '', attendance:'pending', remark:'' };
      if(emptyIdx.length){ newRows[emptyIdx.shift()] = row; }
      else { newRows.push(row); }
    });
    setModal({ ...modal, form: { ...modal.form, studentRows: newRows } });
  }

  // ── Bound-group removal guard: when the user clears a slot that holds
  // a bound-group member, offer to remove all other members of the same
  // group from the session too. Multi-group aware: a swimmer can be in
  // several groups; we look for ANY bound group whose package matches the
  // current session's lesson type, because that's the group whose members
  // must move together for THIS class.
  function removeRow(i){
    const row = (modal.form.studentRows || [])[i];
    if(row?.studentId && groupById){
      const stu = studentById[row.studentId];
      const groupIds = stu?.familyGroupIds || (stu?.familyGroupId ? [stu.familyGroupId] : []);
      // Find a bound group of this swimmer that matches the session's lesson type
      const ltId = currentLt?.id;
      let boundGrp = null;
      for(const gid of groupIds){
        const g = groupById[gid];
        if(!g || g.groupType !== 'bound') continue;
        const pkg = g.packageId ? packageById?.(g.packageId) : null;
        if(pkg && ltId && pkg.lesson_type_id === ltId){ boundGrp = g; break; }
        // Fallback: if package isn't set or lesson type can't be confirmed,
        // still treat as bound-cascade candidate (defensive for legacy data).
        if(!boundGrp) boundGrp = g;
      }
      if(boundGrp){
        const groupMemberIds = new Set(((membersByGroup && membersByGroup[boundGrp.id]) || []).map(m => m.id));
        const otherBoundInSession = (modal.form.studentRows || []).filter((r, ri) => ri !== i && r.studentId && groupMemberIds.has(r.studentId));
        if(otherBoundInSession.length){
          if(confirm(`"${stu.name}" is in the bound group "${boundGrp.name}". Bound members must move through sessions together — remove all ${otherBoundInSession.length + 1} bound group members from this session?`)){
            const removeIds = new Set([row.studentId, ...otherBoundInSession.map(r => r.studentId)]);
            const newRows = (modal.form.studentRows || []).map(r => removeIds.has(r.studentId) ? { studentId:null, name:'', age:'', attendance:'pending', remark:'' } : r);
            setModal({ ...modal, form: { ...modal.form, studentRows: newRows } });
            return;
          }
        }
      }
    }
    // Default: just clear this one slot.
    const newRows = [...(modal.form.studentRows || [])];
    newRows[i] = { studentId:null, name:'', age:'', attendance:'pending', remark:'' };
    setModal({ ...modal, form: { ...modal.form, studentRows: newRows } });
  }

  // Capacity preview: counts the slots that hold a swimmer, against the
  // lesson type's ratio (assuming one instructor for now — splits come in M3).
  const previewStudents = (modal?.form?.studentRows || []).filter(r => r.studentId || (r.name || '').trim()).length;
  const previewLt = lessonTypeByName(modal?.form?.type);
  const previewMax = previewLt?.students_per_instructor ? Number(previewLt.students_per_instructor) : 0;
  const previewStatus = previewMax > 0
    ? (previewStudents > previewMax ? 'over' : previewStudents === previewMax ? 'full' : previewStudents/previewMax >= 0.8 ? 'tight' : 'open')
    : 'unknown';
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
  const candidates = (inBucket.length ? inBucket : (students || []).filter(s => s.isActive !== false))
    .filter(s => {
      if(!(trialStudentIds && trialStudentIds.has(s.id))) return true;
      // Trial swimmer: only keep if their enrollment matches this lesson type.
      return !!lessonTypeId && (s.lessonTypeIds || []).includes(lessonTypeId);
    });
  const bucketFallback = lessonTypeId && !inBucket.length;
  function rowConflict(row, idx){
    if(!row.studentId) return null;
    if((modal.form.studentRows || []).some((r, j) => j !== idx && r.studentId === row.studentId)) return 'twice in this class';
    const others = (weekEnrollments[row.studentId] || []).filter(e => e.sessionId !== modal.id);
    if(others.length){ const e = others[0]; return `${DAYS_S[e.day]} ${minuteToTime(e.startMinute)}`; }
    return null;
  }

  return <div className="modal-backdrop"><div className="modal-card">
    <div className="modal-head">
      <div style={{minWidth:0,flex:1}}>
        <div style={{fontSize:13,fontWeight:800,lineHeight:1.1}}>{modal.id ? 'Edit' : 'Add'} Session</div>
        <div className="small subtle" style={{fontSize:10.5,marginTop:1}}>{DAYS_S[modal.day]} {minuteToTime(modal.startMinute)}{previewPool ? ` · ${previewPool.name}` : ''}</div>
      </div>
      <button className="btn btn-ghost small" onClick={() => setModal(null)} aria-label="Close" title="Close (Esc)">✕</button>
    </div>
    <div className="modal-body">
      <div className="form-grid">
        <div className="field"><label>Lesson Type</label><select className="select" value={modal.form.type} onChange={(e)=>onTypeChange(e.target.value)}>{lessonTypes.map(x => <option key={x.id} value={x.name}>{x.name}</option>)}</select></div>
        <div className="field"><label>Pool</label><select className="select" value={modal.form.poolId || ''} onChange={(e)=>setForm({ poolId: e.target.value || null })}><option value="">(no pool)</option>{pools.map(p => <option key={p.id} value={p.id}>{p.name} · cap {p.capacity_total}</option>)}</select></div>
        <div className="field"><label>Instructor</label><select className="select" value={modal.form.instructorId || ''} onChange={(e)=>onInstructorChange(e.target.value)}><option value="">(unassigned)</option>{instructors.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
        <div className="field"><label>Duration</label><select className="select" value={String(modal.form.durationMinutes)} onChange={(e)=>setForm({ durationMinutes: Number(e.target.value) })}>{durationOptions.map(d => <option key={d} value={d}>{d} min</option>)}</select></div>
        {/* Plain inline meta line — replaces the boxed Time/Capacity fields. */}
        <div className="modal-meta-strip">
          <span>⏱ <strong>{formatRange(modal.startMinute, modal.form.durationMinutes)}</strong></span>
          {previewMax > 0
            ? <span className={previewStatus==='over'?'meta-warn':''}>👥 <strong>{previewStudents} / {previewMax}</strong>{previewStatus==='over'?' Over':previewStatus==='full'?' Full':previewStatus==='tight'?' Tight':''}</span>
            : <span>👥 <strong>{previewStudents}</strong></span>}
        </div>
        <div className="field" style={{gridColumn:'1 / -1'}}>
          <label>Swimmers</label>
          <div className="stu-list">
            {(modal.form.studentRows || []).map((r, i) => {
              // Trial flag is per-lesson-type — only fires if this swimmer's
              // enrolment includes the current session's lesson type.
              const trialSetForLt = (trialByLessonType && currentLt?.id) ? trialByLessonType[currentLt.id] : null;
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
              if(r.studentId && packageById && currentLt?.id){
                const stu = studentById[r.studentId];
                const enrol = (stu?.enrollments || []).find(e => e.lessonTypeId === currentLt.id);
                const pkg = enrol?.packageId ? packageById(enrol.packageId) : null;
                if(pkg) pkgLabel = pkg.name;
              }
              return <div className="stu-row" key={i}>
                <span className="stu-num">{i+1}</span>
                <div className="stu-fields">
                  <StudentSelect valueId={r.studentId} fallbackLabel={r.studentId ? null : (r.name ? `${r.name}${r.age ? ` (${r.age})` : ''}` : '')} studentById={studentById} candidates={candidates} onPick={(stu)=>pickStudent(i, stu)} conflict={rowConflict(r, i)} trialStudentIds={trialStudentIds}
        trialByLessonType={trialByLessonType} pendingByKey={pendingByKey} weekStartDate={wk} lessonTypeId={ltId} />
                  {pkgLabel && !isTrial ? <span className="stu-pkg-label" title={`Enrolled package for ${currentLt?.name}`}>{pkgLabel}</span> : null}
                  {isTrial ? <span className="trial-pill" title="Trial package — one-off booking.">trial</span> : null}
                  {canMarkReplacement ? <button type="button" className="repl-mark-btn" title="Move this swimmer out for replacement" onClick={async ()=>{
                    const ok = await markForReplacement({ studentId:r.studentId, sessionId:modal.id, weekStartDate:wk, lessonTypeId:ltId, lessonTypeName:currentLt.name, day:modal.day, startMinute:modal.startMinute });
                    if(ok){ setModal(null); }
                  }}>→ R</button> : null}
                  {(r.studentId || (r.name || '').trim()) ? <div className="att-seg" role="group" aria-label="Attendance">
                    <button type="button" className={`att-btn att-pending ${(r.attendance||'pending')==='pending'?'is-on':''}`} onClick={()=>setAttendance(i,'pending')} title="Not yet marked">⏳</button>
                    <button type="button" className={`att-btn att-attended ${r.attendance==='attended'?'is-on':''}`} onClick={()=>setAttendance(i,'attended')} title="Attended — −1 credit on save">✓</button>
                    <button type="button" className={`att-btn att-absent ${r.attendance==='absent'?'is-on':''}`} onClick={()=>setAttendance(i,'absent')} title="Absent — −1 credit on save">✗</button>
                  </div> : null}
                  <input className="input stu-remark" placeholder="Remark" value={r.remark || ''} onChange={(e)=>setRemark(i, e.target.value)} />
                  {(r.studentId || (r.name||'').trim()) ? <button type="button" className="stu-x" title="Clear this slot (bound-group members prompt a group-remove)" onClick={()=>removeRow(i)}>×</button> : null}
                </div>
              </div>;
            })}
          </div>
          {/* ── Quick Add Groups ─────────────────────────────────────
              Show family-group chips below the swimmer list. Two-layer
              filter:
                (a) STRICT IDENTITY — the group's package's lesson_type
                    must equal this session's lesson_type. A group is
                    bound to one (lesson_type, package) by its package_id;
                    that's the identity that decides whether it belongs
                    in this session. Groups without a package_id are
                    hidden (misconfigured — Billing Preview surfaces them).
                (b) NON-EMPTY UTILITY — at least one member must still
                    be addable (enrolled in this lesson type AND not
                    already in this session). Empty groups and groups
                    whose members are all already added produce no
                    useful click, so we hide them.
              Together: a chip only appears when clicking it would
              actually add at least one swimmer. */}
          {(() => {
            const ltId = currentLt?.id;
            if(!ltId) return null;
            const existingIds = new Set((modal.form.studentRows || []).filter(r => r.studentId).map(r => r.studentId));
            const eligibleGroups = (familyGroups || []).filter(g => {
              // (a) Strict package identity
              if(!g.packageId) return false;
              const pkg = packageById?.(g.packageId);
              if(!pkg || pkg.lesson_type_id !== ltId) return false;
              // (b) At least one addable member
              const members = (membersByGroup && membersByGroup[g.id]) || [];
              const addable = members.filter(m => (m.lessonTypeIds || []).includes(ltId) && !existingIds.has(m.id));
              return addable.length > 0;
            });
            if(!eligibleGroups.length) return null;
            return <div className="quick-add-groups">
              <span className="quick-add-label">Quick add group:</span>
              {eligibleGroups.map(g => {
                const members = (membersByGroup && membersByGroup[g.id]) || [];
                const addable = members.filter(m => (m.lessonTypeIds || []).includes(ltId) && !existingIds.has(m.id));
                const isBound = g.groupType === 'bound';
                return <button key={g.id} type="button" className={`group-chip ${isBound?'group-chip-bound':''}`}
                  onClick={() => quickAddGroup(g)}
                  title={isBound ? `Bound group — all ${addable.length} members must attend together` : `Discount group — click to add ${addable.length} member${addable.length===1?'':'s'} not yet in this session`}>
                  {isBound ? '🔗' : '👪'} {g.name} · {addable.length}
                </button>;
              })}
            </div>;
          })()}
        </div>
      </div>

      {/* ── GROUP: drop-in replacement section ── */}
      {!isPersonal && <div className="repl-section">
        <div className="repl-section-head">
          <div>
            <span className="repl-section-title">Replacement Students</span>
          </div>
          <button className="btn btn-ghost small" onClick={()=>{
            const filled = (modal.form.studentRows||[]).filter(r=>r.studentId || (r.name||'').trim()).length;
            const repl = (modal.form.replacementRows||[]).length;
            const cap = sessionCapacity({ students: Array(filled + repl), instructors: currentLt ? [{}] : [] }, currentLt);
            if(cap.max > 0 && (filled + repl) >= cap.max){
              if(!confirm(`Class is full (${filled + repl}/${cap.max}). Add another replacement slot anyway? The class will be over capacity.`)) return;
            }
            setModal({...modal,form:{...modal.form,replacementRows:[...(modal.form.replacementRows||[]),{studentId:null,name:'',age:null,replacementFrom:'',attendance:'pending'}]}});
          }}>+ Add replacement</button>
        </div>
        {(() => {
          // Pending-replacement candidates for THIS lesson type + week, surfaced
          // as a quick-pick row above the manual selector so the scheduler can
          // place them with one click. Trial candidates (any student on a trial
          // package eligible by lesson-type bucket) are also surfaced.
          const wk = modal.weekStartDate;
          const ltId = currentLt?.id;
          if(!ltId) return null;
          const pendingCandidates = (replacementPending || []).filter(p => p.lesson_type_id === ltId && p.week_start_date === wk && !(modal.form.replacementRows || []).some(r => r.studentId === p.student_id));
          const trialCandidates = students.filter(s => trialStudentIds && trialStudentIds.has(s.id) && (s.lessonTypeIds||[]).includes(ltId) && !(modal.form.studentRows || []).some(r => r.studentId === s.id) && !(modal.form.replacementRows || []).some(r => r.studentId === s.id));
          if(!pendingCandidates.length && !trialCandidates.length) return null;
          function addAsReplacement(studentId, fromLabel){
            const stu = studentById[studentId];
            if(!stu) return;
            // Cap check before adding (matches the "+ Add replacement" guard).
            const filled = (modal.form.studentRows||[]).filter(r=>r.studentId || (r.name||'').trim()).length;
            const repl = (modal.form.replacementRows||[]).length;
            const cap = sessionCapacity({ students: Array(filled + repl), instructors: currentLt ? [{}] : [] }, currentLt);
            if(cap.max > 0 && (filled + repl) >= cap.max){
              if(!confirm(`Class is full (${filled + repl}/${cap.max}). Add ${stu.name} as replacement anyway? The class will be over capacity.`)) return;
            }
            const rows = [...(modal.form.replacementRows||[]), { studentId, name:stu.name, age:stu.age, replacementFrom: fromLabel || '', attendance:'pending' }];
            setModal({ ...modal, form:{ ...modal.form, replacementRows: rows } });
          }
          return <div className="repl-quickpick">
            <div className="small subtle" style={{marginBottom:6,fontWeight:700}}>Quick-pick candidates ({pendingCandidates.length + trialCandidates.length})</div>
            <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
              {pendingCandidates.map(p => { const stu = studentById[p.student_id]; if(!stu) return null; return <button key={`p-${p.id}`} type="button" className="quickpick-chip quickpick-rpending" onClick={()=>addAsReplacement(p.student_id, p.original_session_label)} title={`Pending replacement from ${p.original_session_label}`}><span className="qp-tag qp-tag-r">R-pending</span> {stu.name}{stu.age!=null?` (${stu.age})`:''} <span className="qp-meta">· from {p.original_session_label}</span></button>; })}
              {trialCandidates.map(s => <button key={`t-${s.id}`} type="button" className="quickpick-chip quickpick-trial" onClick={()=>addAsReplacement(s.id, '(trial)')} title="Trial swimmer — one-off booking"><span className="qp-tag qp-tag-trial">trial</span> {s.name}{s.age!=null?` (${s.age})`:''}</button>)}
            </div>
          </div>;
        })()}
        {!(modal.form.replacementRows||[]).length && <div className="small subtle" style={{padding:'8px 0'}}>No replacement students this week.</div>}
        {(modal.form.replacementRows||[]).map((r,i) => {
          const wk = modal.weekStartDate;
          const ltId = currentLt?.id;
          const isPending = !!(r.studentId && ltId && pendingByKey && pendingByKey[`${r.studentId}:${ltId}:${wk}`]);
          const trialSetReplLt = (trialByLessonType && ltId) ? trialByLessonType[ltId] : null;
          const isTrialRow = !!(r.studentId && trialSetReplLt && trialSetReplLt.has(r.studentId));
          const replCandidates = students.filter(s => !(modal.form.studentRows || []).some(sr => sr.studentId === s.id) && !(modal.form.replacementRows || []).some((rr,ri) => ri !== i && rr.studentId === s.id));
          return <div key={i} className="repl-row">
            <span className="repl-badge-sm">R</span>
            <div style={{flex:'1.5',minWidth:0,position:'relative'}}>
              <StudentSelect valueId={r.studentId} fallbackLabel={r.name||''} studentById={studentById} candidates={replCandidates} onPick={(stu)=>{
                const rows=[...(modal.form.replacementRows||[])];
                const pendingHit = stu && ltId && pendingByKey && pendingByKey[`${stu.id}:${ltId}:${wk}`];
                rows[i]={ ...rows[i], studentId:stu?.id||null, name:stu?.name||'', age:stu?.age??null, replacementFrom: pendingHit ? pendingHit.original_session_label : (trialStudentIds && stu && trialStudentIds.has(stu.id) ? '(trial)' : rows[i].replacementFrom) };
                setModal({...modal,form:{...modal.form,replacementRows:rows}});
              }} conflict={null} trialStudentIds={trialStudentIds}
        trialByLessonType={trialByLessonType} pendingByKey={pendingByKey} weekStartDate={wk} lessonTypeId={ltId} />
              {isPending ? <span className="qp-tag qp-tag-r" style={{position:'absolute',top:-8,right:6,zIndex:1}}>R-pending</span> : (isTrialRow ? <span className="qp-tag qp-tag-trial" style={{position:'absolute',top:-8,right:6,zIndex:1}}>trial</span> : null)}
            </div>
            <input className="input" style={{flex:1}} placeholder="From class (e.g. Mon 11AM)" value={r.replacementFrom||''} onChange={(e)=>{ const rows=[...(modal.form.replacementRows||[])]; rows[i]={...rows[i],replacementFrom:e.target.value}; setModal({...modal,form:{...modal.form,replacementRows:rows}}); }} />
            {(r.studentId || (r.name||'').trim()) ? <div className="att-seg" role="group" aria-label="Attendance">
              <button type="button" className={`att-btn att-pending ${(r.attendance||'pending')==='pending'?'is-on':''}`} onClick={()=>setReplAttendance(i,'pending')} title="Not yet marked — credit untouched">⏳</button>
              <button type="button" className={`att-btn att-attended ${r.attendance==='attended'?'is-on':''}`} onClick={()=>setReplAttendance(i,'attended')} title="Attended — lesson delivered (−1 credit on save)">✓</button>
              <button type="button" className={`att-btn att-absent ${r.attendance==='absent'?'is-on':''}`} onClick={()=>setReplAttendance(i,'absent')} title="Absent — counts as a delivered lesson, no replacement entitled (−1 credit on save)">✗</button>
            </div> : null}
            <button className="btn btn-ghost small" style={{flexShrink:0}} onClick={()=>{ const rows=(modal.form.replacementRows||[]).filter((_,ri)=>ri!==i); setModal({...modal,form:{...modal.form,replacementRows:rows}}); }}>×</button>
          </div>;
        })}
      </div>}

      {/* ── PERSONAL: reschedule this week only ── */}
      {isPersonal && <div className="repl-section">
        {isRescheduled && <div className="reschedule-notice">
          <span className="reschedule-from-badge">⇄ Rescheduled this week — was originally {DAYS_F[modal.rescheduledFromDay]} at {minuteToTime(modal.rescheduledFromStartMinute)}</span>
          <button className="btn btn-ghost small" onClick={()=>setModal({...modal,day:modal.rescheduledFromDay,startMinute:modal.rescheduledFromStartMinute,rescheduledFromDay:null,rescheduledFromStartMinute:null})}>Restore original slot</button>
        </div>}
        <div className="reschedule-head">
          <span className="repl-section-title">⇄ Reschedule this week only</span>
          <button className="btn btn-ghost small" onClick={()=>{ setReschedDay(modal.day); setReschedMinute(modal.startMinute); setRescheduleOpen(o=>!o); }}>{rescheduleOpen?'Cancel':'Change slot'}</button>
        </div>
        {rescheduleOpen && <div className="reschedule-form">
          <div className="field" style={{margin:0}}><label>New day</label>
            <select className="select" value={reschedDay} onChange={(e)=>setReschedDay(Number(e.target.value))}>
              {DAYS_F.map((d,i)=><option key={i} value={i}>{d}</option>)}
            </select>
          </div>
          <div className="field" style={{margin:0}}><label>New start time</label>
            <select className="select" value={reschedMinute} onChange={(e)=>setReschedMinute(Number(e.target.value))}>
              {Array.from({length:25},(_,i)=>480+i*30).map(m=><option key={m} value={m}>{minuteToTime(m)}</option>)}
            </select>
          </div>
          <button className="btn btn-primary small" style={{alignSelf:'flex-end'}} onClick={()=>{
            setModal(prev=>({ ...prev,
              rescheduledFromDay: prev.rescheduledFromDay ?? prev.day,
              rescheduledFromStartMinute: prev.rescheduledFromStartMinute ?? prev.startMinute,
              day: reschedDay,
              startMinute: reschedMinute
            }));
            setRescheduleOpen(false);
          }}>Apply reschedule</button>
          <div className="hint" style={{gridColumn:'1/-1',marginTop:0}}>Returns to canonical slot from next week.</div>
        </div>}
      </div>}

      {/* ── ALL CLASS TYPES: Credit Balances ──────────────────────────────
          Every lesson type is credit-based now. Each enrolled swimmer who
          has been placed in the session shows their remaining balance for
          this lesson type; if they don't yet have a balance row, the seed
          UI lets you set the initial count (defaults to 4 = one lesson per
          week × four weeks of the month). */}
      {(modal.form.studentRows||[]).some(r=>r.studentId) && <div className="repl-section">
        <div className="repl-section-title" style={{marginBottom:6}}>Credit Balances</div>
        {(modal.form.studentRows||[]).filter(r=>r.studentId).map((r,i)=>{
          const bal = creditByKey && creditByKey[`${r.studentId}:${currentLt?.id}`];
          // Most recent purchase for this (swimmer, lesson type), used
          // to surface "purchased on" info inline so the scheduler can
          // confirm which batch the balance was seeded from.
          const purchases = purchasesByKey && currentLt?.id ? (purchasesByKey[`${r.studentId}:${currentLt.id}`] || []) : [];
          const lastPurchase = purchases[0] || null;
          const lastPurchaseLabel = lastPurchase
            ? `${Number(lastPurchase.credits_added) > 0 ? '+' : ''}${lastPurchase.credits_added} on ${lastPurchase.purchase_date}`
            : null;
          return <div key={r.studentId||i} className="credit-row">
            <span className="credit-row-name">{r.name || 'Student'}{lastPurchaseLabel ? <span className="credit-row-last"> · last {lastPurchaseLabel}</span> : null}</span>
            {bal
              ? <div className="credit-controls">
                  <span className={`credit-count ${bal.remaining_balance<=2?'credit-low':''}`}>{bal.remaining_balance} / {bal.initial_balance} credits</span>
                  <button className="credit-btn" title="Deduct 1 credit (class attended)" onClick={()=>adjustCredit(r.studentId,currentLt.id,-1)}>−</button>
                  <button className="credit-btn" title="Add 1 credit (credit returned)" onClick={()=>adjustCredit(r.studentId,currentLt.id,+1)}>+</button>
                </div>
              : <div className="credit-init">
                  <input className="input" style={{width:64,fontSize:12}} type="number" min="1" placeholder="Credits" value={initCreditInput[r.studentId]||4} onChange={(e)=>setInitCreditInput(prev=>({...prev,[r.studentId]:e.target.value}))} />
                  <button className="btn btn-ghost small" title="Record this as a purchase (with today's date) and set the initial balance" onClick={async ()=>{
                    const n = Number(initCreditInput[r.studentId]||4);
                    if(!n || !currentLt?.id) return;
                    // Prefer addCreditPurchase so the seed shows up in the
                    // swimmer's purchase ledger with today's date. Falls
                    // back to initCredit if the purchases backend isn't
                    // available yet (e.g. migration not run).
                    if(addCreditPurchase){
                      await addCreditPurchase({
                        studentId: r.studentId, lessonTypeId: currentLt.id,
                        purchaseDate: toDateStr(new Date()), creditsAdded: n,
                        source: 'signup', notes: 'Seeded from session editor'
                      });
                    } else {
                      initCredit(r.studentId, currentLt.id, n);
                    }
                  }}>Record purchase</button>
                </div>
            }
          </div>;
        })}
      </div>}

      {/* ── Full Class Replacement (entire-class cancel) ────────────────
          Visible only on existing sessions (modal.id), since cancelling a
          new unsaved session isn't a meaningful action. Two routes — see
          App.forwardClassToNextWeek / App.startFullClassMove for the
          business logic. */}
      {modal.id && <div className="cancel-class-panel">
        <button type="button" className={`cancel-class-toggle ${cancelClassOpen?'is-open':''}`} onClick={()=>setCancelClassOpen(o=>!o)}>
          <span>🚫 Cancel entire class for this week</span>
          <span className="cancel-class-chev">{cancelClassOpen ? '▴' : '▾'}</span>
        </button>
        {cancelClassOpen && <div className="cancel-class-options">
          <div className="cancel-class-hint">All swimmers in this session are affected. Their credits will not be consumed for this cancellation.</div>
          <div className="cancel-class-buttons">
            <button type="button" className="cancel-class-opt" onClick={()=>{
              const label = `${currentLt?.name || modal.form.type} on ${DAYS_F[modal.day]} ${minuteToTime(modal.startMinute)}`;
              forwardClassToNextWeek && forwardClassToNextWeek(modal.id, label);
            }}>
              <div className="cancel-class-opt-title">⏭ Forward to next week</div>
              <div className="cancel-class-opt-sub">Cancels this week's run and recreates the same class next week (same day, time, swimmers). Any credits already consumed this week are refunded. If next week already has this class, it merges in instead of duplicating.</div>
            </button>
            <button type="button" className="cancel-class-opt" onClick={()=>{
              const label = `${DAYS_F[modal.day]} ${minuteToTime(modal.startMinute)}`;
              const swimmerCount = (modal.form.studentRows||[]).filter(r=>r.studentId || (r.name||'').trim()).length + (modal.form.replacementRows||[]).filter(r=>r.studentId || (r.name||'').trim()).length;
              startFullClassMove && startFullClassMove({
                sessionId: modal.id,
                sourceLabel: label,
                lessonTypeName: currentLt?.name || modal.form.type,
                weekStartDate: modal.weekStartDate,
                originalDay: modal.day,
                originalStartMinute: modal.startMinute,
                swimmerCount
              });
            }}>
              <div className="cancel-class-opt-title">📅 Reschedule to another slot</div>
              <div className="cancel-class-opt-sub">Pick a day &amp; time on the weekly grid. Same swimmers, same instructor, same pool — just a different slot this week.</div>
            </button>
          </div>
        </div>}
      </div>}

      {/* ── Duplicate Forward — clone this session into N future weeks ──
          at the same slot. The session-wide complement to the existing
          week-wide "Duplicate Previous Week". Same swimmers, instructor,
          pool. Attendance resets per clone. Skips weeks that already
          have a matching session at the same slot. */}
      {modal.id && duplicateSessionForward && <div className="cancel-class-panel">
        <button type="button" className={`cancel-class-toggle ${dupOpen?'is-open':''}`} onClick={()=>setDupOpen(o=>!o)} style={{background:'#EFF6FF',borderColor:'#BFDBFE',color:'#1E40AF'}}>
          <span>⏩ Duplicate this session to future weeks</span>
          <span className="cancel-class-chev" style={{color:'#1E40AF'}}>{dupOpen ? '▴' : '▾'}</span>
        </button>
        {dupOpen && <div className="cancel-class-options" style={{background:'#EFF6FF',borderColor:'#BFDBFE'}}>
          <div className="cancel-class-hint" style={{color:'#1E40AF'}}>Clones this session into the next N weeks at the same day &amp; time, with the same swimmers, instructor, and pool. Existing matching sessions at those slots will be skipped.</div>
          <div className="dup-buttons">
            {[1, 2, 3, 4, 8, 12].map(n => <button key={n} type="button" className="dup-btn" onClick={()=>duplicateSessionForward(modal.id, n)}>
              {n === 1 ? 'Next week' : `Next ${n} weeks`}
            </button>)}
            <button type="button" className="dup-btn" onClick={()=>{
              const v = prompt('How many weeks ahead to duplicate? (1–52)', '4');
              const n = Math.max(1, Math.min(52, parseInt(v, 10) || 0));
              if(n > 0) duplicateSessionForward(modal.id, n);
            }}>Custom…</button>
          </div>
        </div>}
      </div>}
    </div>
    <div className="modal-foot">
      <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
        {modal.id ? <button className="btn btn-danger small" onClick={deleteSession}>Delete</button> : null}
        <button className="btn btn-ghost small" onClick={() => openAddAtTime(modal.day, modal.startMinute, modal.form.poolId)}>+ Same Time</button>
      </div>
      <button className="btn btn-primary" onClick={saveSession}>{saveBusy ? 'Saving…' : 'Save Session'}</button>
    </div>
  </div></div>;
}

// ============================================================================
// PrintWeeklyTableSection (M2: pool labels per session in cells)
// ============================================================================

function PrintWeeklyTableSection({ weekBlocksAllPools, wb, selectedWeekStart, gridSlots, gridBounds, slotToMinute, poolById }){
  const dayHeaders = DAYS_F.map((d, di) => {
    const dateObj = new Date(wb.start);
    dateObj.setDate(wb.start.getDate() + di);
    return { label: d, dateStr: dateObj.toLocaleDateString(undefined, { day:'2-digit', month:'2-digit', year:'numeric' }) };
  });

  // Each day is already a packed array of all-pool blocks; attach pool name.
  const flatBlocksByDay = Array.from({length:7}, (_, di) => {
    return (weekBlocksAllPools[di] || []).map(b => ({ ...b, _poolName: (poolById(b.poolId)?.name) || '' }));
  });

  const startMap = {};
  const coveredMap = {};
  flatBlocksByDay.forEach((dayBlocks, di) => {
    dayBlocks.forEach(block => {
      const sk = `${di}-${block.startMinute}`;
      if(!startMap[sk]) startMap[sk] = [];
      startMap[sk].push(block);
      for(let m = block.startMinute + SLOT_MIN; m < block.startMinute + block.durationMinutes; m += SLOT_MIN){
        coveredMap[`${di}-${m}`] = true;
      }
    });
  });

  const rows = Array.from({ length: gridSlots }, (_, si) => {
    const slotMin = slotToMinute(si);
    const isHour = slotMin % 60 === 0;
    return (
      <tr key={si} className={isHour ? 'wt-row wt-hour-row' : 'wt-row wt-half-row'}>
        <td className="wt-time-cell">{isHour ? <strong>{minuteToTime(slotMin)}</strong> : <span className="wt-half-label">{minuteToTime(slotMin)}</span>}</td>
        {Array.from({ length: 7 }, (_, di) => {
          const k = `${di}-${slotMin}`;
          const starts = startMap[k];
          const isCovered = coveredMap[k];
          if(starts && starts.length){
            return <td key={di} className="wt-cell wt-session-cell">
              {starts.map((block, idx) => (
                <div key={block.id} className={idx > 0 ? 'wt-sess wt-sess-sep' : 'wt-sess'}>
                  <div className="wt-sess-type">{block.type}</div>
                  <div className="wt-sess-meta">{(block.instructors[0]?.name) || block.legacyInstructor || '—'} &middot; {block.durationMinutes}&thinsp;min{block._poolName ? ` · ${block._poolName}` : ''}</div>
                  {block.students.length > 0 ? <div className="wt-sess-students">{block.students.map(studentLabel).join(', ')}</div> : null}
                </div>
              ))}
            </td>;
          }
          if(isCovered){
            return <td key={di} className="wt-cell wt-cont-cell"><span className="wt-cont-bar">|</span></td>;
          }
          return <td key={di} className="wt-cell wt-empty-cell"></td>;
        })}
      </tr>
    );
  });

  return <div className="print-weekly-table">
    <div className="wt-header">
      <div className="wt-title">Weekly Schedule</div>
      <div className="wt-meta">Week of {selectedWeekStart} &nbsp;&middot;&nbsp; {wb.start.toLocaleDateString(undefined,{weekday:'long',year:'numeric',month:'long',day:'numeric'})} &ndash; {wb.end.toLocaleDateString(undefined,{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</div>
    </div>
    <table className="wt-table">
      <thead>
        <tr>
          <th className="wt-th-time">Time</th>
          {dayHeaders.map((dh, i) => (
            <th key={i} className="wt-th-day">
              <div className="wt-th-dayname">{dh.label}</div>
              <div className="wt-th-daydate">{dh.dateStr}</div>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows}
        <tr className="wt-row wt-hour-row">
          <td className="wt-time-cell"><strong>{minuteToTime(gridBounds.endMin)}</strong></td>
          {Array.from({length:7},(_,di) => <td key={di} className="wt-cell wt-empty-cell"></td>)}
        </tr>
      </tbody>
    </table>
  </div>;
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

function showDiagnosticError(label, detail){
  const root = document.getElementById('root');
  if(!root) return;
  const block = document.createElement('div');
  block.style.cssText = 'padding:24px 18px;max-width:880px;margin:24px auto;font-family:Inter,system-ui,sans-serif';
  block.innerHTML = `
    <div style="background:#FEE2E2;border:1px solid #FCA5A5;color:#7F1D1D;padding:20px 22px;border-radius:14px;box-shadow:0 4px 16px rgba(0,0,0,.08)">
      <div style="font-size:18px;font-weight:800;margin-bottom:6px">⚠ ${label}</div>
      <div style="font-size:13px;margin-bottom:14px;color:#9B2B2B">The app caught an error. Please screenshot or copy the details below and share them.</div>
      <pre style="white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #FECACA;border-radius:10px;padding:12px 14px;font-size:12px;font-family:'SF Mono',Menlo,Consolas,monospace;color:#7F1D1D;max-height:280px;overflow:auto">${detail.replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</pre>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button id="err-copy" style="background:#7F1D1D;color:#fff;border:none;padding:9px 16px;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer">Copy details</button>
        <button id="err-reload" style="background:#fff;color:#7F1D1D;border:1px solid #FCA5A5;padding:9px 16px;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer">Reload</button>
      </div>
    </div>`;
  root.innerHTML = '';
  root.appendChild(block);
  const copyBtn = document.getElementById('err-copy');
  if(copyBtn) copyBtn.onclick = () => { try{ navigator.clipboard.writeText(`${label}\n\n${detail}`); copyBtn.textContent = 'Copied'; }catch(_){} };
  const reloadBtn = document.getElementById('err-reload');
  if(reloadBtn) reloadBtn.onclick = () => location.reload();
}
function formatErrEvent(ev){
  const lines = [];
  if(ev.error){
    lines.push(`Message: ${ev.error.message || '(none)'}`);
    if(ev.error.stack) lines.push(`\nStack:\n${ev.error.stack}`);
  } else {
    lines.push(`Message: ${ev.message || '(none)'}`);
  }
  if(ev.filename) lines.push(`\nSource: ${ev.filename}:${ev.lineno}:${ev.colno}`);
  if(navigator.userAgent) lines.push(`\nUA: ${navigator.userAgent}`);
  return lines.join('\n');
}
window.addEventListener('error', (ev) => { try{ console.error('[ssb] window error:', ev.error || ev); showDiagnosticError('App error', formatErrEvent(ev)); }catch(_){} });
window.addEventListener('unhandledrejection', (ev) => { try{
  const reason = ev.reason;
  const detail = (reason && reason.stack) ? `Message: ${reason.message || reason}\n\nStack:\n${reason.stack}` : String(reason);
  console.error('[ssb] unhandled promise rejection:', reason);
  showDiagnosticError('Async error', detail);
}catch(_){} });

// React Error Boundary — catches errors thrown during render or in
// lifecycle methods (event handlers still bubble to window.onerror).
class ErrorBoundary extends React.Component {
  constructor(props){ super(props); this.state = { err: null, info: null }; }
  static getDerivedStateFromError(err){ return { err }; }
  componentDidCatch(err, info){ console.error('[ssb] render error:', err, info); this.setState({ info }); }
  render(){
    if(this.state.err){
      const lines = [`Message: ${this.state.err.message || this.state.err}`];
      if(this.state.err.stack) lines.push(`\nStack:\n${this.state.err.stack}`);
      if(this.state.info && this.state.info.componentStack) lines.push(`\nComponent stack:${this.state.info.componentStack}`);
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
function invoiceStatusLabel(s){ return({draft:'Draft',sent:'Sent',partial:'Part Paid',paid:'Paid',void:'Void'})[s]||s; }
function invoiceStatusColor(s){ return({draft:'#94A3B8',sent:'#3B82F6',partial:'#F59E0B',paid:'#10B981',void:'#EF4444'})[s]||'#94A3B8'; }
function methodLabel(m){ return({cash:'Cash',bank_transfer:'Bank Transfer',duitnow:'DuitNow',card:'Card',cheque:'Cheque',other:'Other'})[m]||m; }

function printInvoice(invoice, lines){
  const billable=lines.filter(l=>l.is_billable);
  const outstanding=Math.max(0,Number(invoice.total_amount)-Number(invoice.amount_paid));
  const linesHtml=billable.map(l=>`<tr>
    <td style="padding:7px 10px;border-bottom:1px solid #eee;font-size:11pt">${l.description||''}</td>
    <td style="padding:7px 10px;border-bottom:1px solid #eee;font-size:10pt;color:#555">${l.line_type==='group_bundle'?'Group Bundle':'Individual'}</td>
    <td style="padding:7px 10px;border-bottom:1px solid #eee;text-align:right;font-size:11pt;font-weight:600">RM${Number(l.amount).toFixed(2)}</td>
  </tr>`).join('');
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Invoice ${invoice.invoice_number}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Inter,system-ui,-apple-system,sans-serif;color:#111;padding:0;background:#fff}
.page{max-width:740px;margin:0 auto;padding:32px 36px}
@page{size:A4 portrait;margin:18mm 16mm}
@media print{.page{padding:0}}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:16px;border-bottom:2.5px solid #111}
.brand{font-size:18pt;font-weight:800;letter-spacing:-.3px}
.brand-sub{font-size:10pt;color:#555;margin-top:3px}
.inv-title{font-size:22pt;font-weight:800;color:#111}
.inv-meta{font-size:10pt;color:#555;margin-top:4px;line-height:1.6}
.status-pill{display:inline-block;padding:3px 10px;border-radius:4px;font-size:10pt;font-weight:700}
.status-draft{background:#F1F5F9;color:#475569}
.status-sent{background:#DBEAFE;color:#1D4ED8}
.status-partial{background:#FEF3C7;color:#92400E}
.status-paid{background:#D1FAE5;color:#065F46}
.status-void{background:#FEE2E2;color:#7F1D1D}
.bill-to{background:#F8FAFC;border-radius:8px;padding:12px 16px;margin-bottom:20px}
.bill-to-label{font-size:9pt;text-transform:uppercase;letter-spacing:.6px;color:#888;font-weight:700;margin-bottom:4px}
.bill-to-name{font-size:13pt;font-weight:800}
.bill-to-contact{font-size:10pt;color:#555;margin-top:2px}
table{width:100%;border-collapse:collapse;margin-bottom:16px}
thead th{background:#111;color:#fff;padding:8px 10px;font-size:10pt;text-align:left;font-weight:700}
thead th:last-child{text-align:right}
.total-section{border-top:2px solid #111;padding-top:10px}
.total-row{display:flex;justify-content:space-between;padding:4px 0;font-size:11pt}
.total-row.grand{font-size:14pt;font-weight:800;padding-top:8px;border-top:1px solid #ccc;margin-top:4px}
.total-row.paid{color:#10B981}
.total-row.outstanding{color:#F59E0B;font-weight:800}
.settled{color:#10B981;font-weight:800}
.notes-box{margin-top:16px;padding:10px 14px;background:#F8FAFC;border-radius:6px;font-size:10pt;color:#555}
.footer{margin-top:28px;padding-top:10px;border-top:1px solid #ddd;font-size:9pt;color:#999;text-align:center;line-height:1.5}
</style>
<script>window.onload=function(){setTimeout(function(){window.print()},400)}<\/script>
</head><body><div class="page">
<div class="hdr">
  <div>
    <div class="brand">Star Swim Sdn Bhd</div>
    <div class="brand-sub">Professional Swimming Instruction</div>
  </div>
  <div style="text-align:right">
    <div class="inv-title">${invoice.invoice_number}</div>
    <div class="inv-meta">
      Issued: ${invoice.issue_date||''}${invoice.due_date?`<br>Due: ${invoice.due_date}`:''}<br>
      <span class="status-pill status-${invoice.status}">${invoiceStatusLabel(invoice.status)}</span>
    </div>
  </div>
</div>
<div class="bill-to">
  <div class="bill-to-label">Bill To</div>
  <div class="bill-to-name">${invoice.account_name}</div>
  ${invoice.account_email||invoice.account_phone?`<div class="bill-to-contact">${[invoice.account_email,invoice.account_phone].filter(Boolean).join(' · ')}</div>`:''}
</div>
${invoice.notes?`<div class="notes-box">📝 ${invoice.notes}</div>`:''}
<table style="margin-top:${invoice.notes?'14px':'4px'}">
  <thead><tr>
    <th style="width:60%">Description</th>
    <th style="width:20%">Type</th>
    <th style="width:20%;text-align:right">Amount</th>
  </tr></thead>
  <tbody>${linesHtml}</tbody>
</table>
<div class="total-section" style="max-width:260px;margin-left:auto">
  <div class="total-row"><span>Subtotal</span><span>RM${Number(invoice.total_amount).toFixed(2)}</span></div>
  ${Number(invoice.amount_paid)>0?`<div class="total-row paid"><span>Paid</span><span>- RM${Number(invoice.amount_paid).toFixed(2)}</span></div>`:''}
  <div class="total-row grand ${outstanding<=0?'settled':'outstanding'}">
    <span>${outstanding<=0?'Settled ✓':'Outstanding'}</span>
    <span>${outstanding<=0?'RM 0.00':'RM'+outstanding.toFixed(2)}</span>
  </div>
</div>
<div class="footer">Thank you for choosing Star Swim Sdn Bhd · Please retain this invoice for your records<br>Generated ${new Date().toLocaleDateString(undefined,{dateStyle:'long'})}</div>
</div></body></html>`;
  const w=window.open('','_blank'); if(w){w.document.write(html);w.document.close();}
}

function printReceipt(pmt, invoice){
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Receipt ${pmt.receipt_number}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Inter,system-ui,sans-serif;color:#111;padding:28px;max-width:480px;margin:0 auto}
@page{size:A5;margin:12mm}@media print{body{padding:0}}
.rct-box{border:1.5px solid #111;border-radius:8px;padding:20px 22px}
h1{font-size:15pt;font-weight:800;margin-bottom:4px}.sub{font-size:10pt;color:#555;margin-bottom:14px}
.row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #eee;font-size:11pt}
.row:last-child{border-bottom:none}.amount-row{font-size:14pt;font-weight:800;margin-top:10px;padding-top:10px;border-top:2px solid #111}
.footer{margin-top:16px;font-size:9pt;color:#888;text-align:center}</style>
<script>window.onload=function(){setTimeout(function(){window.print()},400)}<\/script>
</head><body><div class="rct-box">
<h1>Receipt</h1><div class="sub">Star Swim Sdn Bhd</div>
<div class="row"><span>Receipt #</span><span>${pmt.receipt_number}</span></div>
<div class="row"><span>Invoice</span><span>${invoice.invoice_number}</span></div>
<div class="row"><span>Account</span><span>${invoice.account_name}</span></div>
<div class="row"><span>Date</span><span>${pmt.payment_date||''}</span></div>
<div class="row"><span>Method</span><span>${methodLabel(pmt.payment_method)}</span></div>
${pmt.reference_number?`<div class="row"><span>Reference</span><span>${pmt.reference_number}</span></div>`:''}
${pmt.notes?`<div class="row"><span>Notes</span><span>${pmt.notes}</span></div>`:''}
<div class="row amount-row"><span>Amount Paid</span><span>RM${Number(pmt.amount).toFixed(2)}</span></div>
</div><div class="footer">Thank you · Generated ${new Date().toLocaleDateString(undefined,{dateStyle:'long'})}</div>
</body></html>`;
  const w=window.open('','_blank'); if(w){w.document.write(html);w.document.close();}
}

// ============================================================================
// InvoicesView — Phase 2: bulk select, overdue badges, batch actions
// ============================================================================
function InvoicesView({ invoices, invoiceLines, pmts, pendingCredits, lessonTypeById, packageById, studentById, invoiceSettings, onSaveSettings, formatInvoiceNumber, formatReceiptNumber, onVoid, onUpdateStatus, onRecordPayment, onConfirmCredit, onReverseCredit, onAddLine, onUpdateLine, onDeleteLine }){
  const [statusFilter,setStatusFilter]=useState('all');
  const [searchQ,setSearchQ]=useState('');
  const [expandedId,setExpandedId]=useState(null);
  const [selectedIds,setSelectedIds]=useState(new Set());
  const [showSettings,setShowSettings]=useState(false);
  const today=todayStr();

  function isOverdue(inv){ return inv.due_date && inv.due_date < today && inv.status !== 'paid' && inv.status !== 'void'; }

  const counts=useMemo(()=>{
    const c={all:invoices.length,draft:0,sent:0,partial:0,paid:0,void:0,overdue:0};
    invoices.forEach(i=>{ if(c[i.status]!=null)c[i.status]++; if(isOverdue(i))c.overdue++; });
    return c;
  },[invoices,today]);

  const outstanding=useMemo(()=>invoices.filter(i=>i.status!=='void'&&i.status!=='paid').reduce((s,i)=>s+Math.max(0,Number(i.total_amount)-Number(i.amount_paid)),0),[invoices]);
  const collectedMonth=useMemo(()=>{const ym=new Date().toISOString().slice(0,7);return pmts.filter(p=>(p.payment_date||'').startsWith(ym)).reduce((s,p)=>s+Number(p.amount),0);},[pmts]);

  const filtered=invoices.filter(i=>{
    if(statusFilter==='overdue') return isOverdue(i);
    if(statusFilter!=='all'&&i.status!==statusFilter)return false;
    if(searchQ){const q=searchQ.toLowerCase();if(!i.invoice_number.toLowerCase().includes(q)&&!i.account_name.toLowerCase().includes(q))return false;}
    return true;
  });

  // Bulk actions
  function toggleSelect(id){ setSelectedIds(s=>{const n=new Set(s);n.has(id)?n.delete(id):n.add(id);return n;}); }
  function toggleAll(){ setSelectedIds(selectedIds.size===filtered.length?new Set():new Set(filtered.map(i=>i.id))); }
  async function bulkMarkSent(){
    const targets=filtered.filter(i=>selectedIds.has(i.id)&&i.status==='draft');
    for(const inv of targets) await onUpdateStatus(inv.id,'sent');
    setSelectedIds(new Set());
  }
  function bulkPrint(){
    const targets=filtered.filter(i=>selectedIds.has(i.id));
    targets.forEach(inv=>{ const lines=invoiceLines.filter(l=>l.invoice_id===inv.id); printInvoice(inv,lines); });
  }

  const selCount=selectedIds.size;
  const selDraft=filtered.filter(i=>selectedIds.has(i.id)&&i.status==='draft').length;

  return <>
    <div className="card" style={{marginBottom:12}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12,flexWrap:'wrap',marginBottom:10}}>
        <div><div style={{fontSize:18,fontWeight:800}}>🧾 Invoices</div><div className="small subtle">Generated invoices. Click a row to expand — edit lines, record payment, print.</div></div>
        <div style={{display:'flex',gap:18,alignItems:'flex-end',flexWrap:'wrap'}}>
          {counts.overdue>0&&<div><div className="small subtle">Overdue</div><div style={{fontSize:20,fontWeight:800,color:'#EF4444'}}>{counts.overdue}</div></div>}
          <div><div className="small subtle">Outstanding</div><div style={{fontSize:20,fontWeight:800,color:'#F59E0B'}}>RM{outstanding.toFixed(2)}</div></div>
          <div><div className="small subtle">Collected this month</div><div style={{fontSize:20,fontWeight:800,color:'#10B981'}}>RM{collectedMonth.toFixed(2)}</div></div>
          <button className={`btn btn-ghost small ${showSettings?'active':''}`} onClick={()=>setShowSettings(v=>!v)} title="Invoice number settings">⚙ Numbering</button>
        </div>
      </div>
      {showSettings && <InvoiceSettingsPanel settings={invoiceSettings} onSave={onSaveSettings} formatInvoiceNumber={formatInvoiceNumber} formatReceiptNumber={formatReceiptNumber} />}
      <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center',marginBottom:selCount>0?8:0}}>
        <input className="input" style={{flex:1,minWidth:200,maxWidth:300}} placeholder="Search invoice # or account…" value={searchQ} onChange={e=>setSearchQ(e.target.value)} />
        <div style={{display:'flex',gap:3,flexWrap:'wrap'}}>
          {['all','draft','sent','partial','paid','void','overdue'].map(s=><button key={s} className={`tab ${statusFilter===s?'active':''}`} style={{padding:'5px 10px',fontSize:11,borderRadius:7,background:s==='overdue'&&statusFilter!==s?'#2a0a0a':''}} onClick={()=>setStatusFilter(s)}>
            {s==='all'?`All (${counts.all})`:s==='overdue'?`⚠ Overdue (${counts.overdue})`:invoiceStatusLabel(s)+` (${counts[s]||0})`}
          </button>)}
        </div>
      </div>
      {selCount>0&&<div className="inv-bulk-bar">
        <span style={{fontWeight:700}}>{selCount} selected</span>
        {selDraft>0&&<button className="btn btn-primary small" onClick={bulkMarkSent}>Mark {selDraft} Sent</button>}
        <button className="btn btn-ghost small" onClick={bulkPrint}>🖨 Print {selCount}</button>
        <button className="btn btn-ghost small" onClick={()=>setSelectedIds(new Set())}>Clear</button>
      </div>}
    </div>

    {filtered.length===0&&<div className="card empty" style={{padding:28}}>No invoices match this filter.</div>}

    {/* Column header */}
    {filtered.length>0&&<div className="inv-col-head">
      <div style={{width:36}}><input type="checkbox" checked={selCount===filtered.length&&filtered.length>0} onChange={toggleAll} /></div>
      <div style={{width:140,fontWeight:700}}>Invoice #</div>
      <div style={{flex:1,fontWeight:700}}>Account</div>
      <div style={{width:90,textAlign:'right',fontWeight:700}}>Total</div>
      <div style={{width:90,textAlign:'right',fontWeight:700}}>Paid</div>
      <div style={{width:100,textAlign:'right',fontWeight:700}}>Outstanding</div>
      <div style={{width:120,fontWeight:700}}>Status</div>
    </div>}

    <div style={{display:'flex',flexDirection:'column',gap:4}}>
      {filtered.map(inv=>{
        const invLines=invoiceLines.filter(l=>l.invoice_id===inv.id);
        const invPmts=pmts.filter(p=>p.invoice_id===inv.id);
        const invPcs=pendingCredits.filter(pc=>pc.invoice_id===inv.id);
        const owed=Math.max(0,Number(inv.total_amount)-Number(inv.amount_paid));
        const overdue=isOverdue(inv);
        const isExpanded=expandedId===inv.id;
        const isSelected=selectedIds.has(inv.id);
        return <div key={inv.id} className={`inv-card${isExpanded?' is-expanded':''}${overdue?' is-overdue':''}`}>
          <div className="inv-row" onClick={(e)=>{ if(e.target.type==='checkbox')return; setExpandedId(isExpanded?null:inv.id); }}>
            <div style={{width:36,flexShrink:0}} onClick={e=>e.stopPropagation()}>
              <input type="checkbox" checked={isSelected} onChange={()=>toggleSelect(inv.id)} />
            </div>
            <div style={{width:140,flexShrink:0}}>
              <div style={{fontWeight:800,fontFamily:'monospace',fontSize:12}}>{inv.invoice_number}</div>
              <div className="small subtle">{inv.issue_date}</div>
            </div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:700}}>{inv.account_name}</div>
              {overdue&&<div style={{fontSize:10,color:'#EF4444',fontWeight:800}}>⚠ OVERDUE{inv.due_date?` since ${inv.due_date}`:''}</div>}
              {!overdue&&inv.due_date&&inv.status!=='paid'&&<div className="small subtle">Due {inv.due_date}</div>}
            </div>
            <div style={{width:90,textAlign:'right',flexShrink:0}}>RM{Number(inv.total_amount).toFixed(2)}</div>
            <div style={{width:90,textAlign:'right',color:'#10B981',fontWeight:700,flexShrink:0}}>RM{Number(inv.amount_paid).toFixed(2)}</div>
            <div style={{width:100,textAlign:'right',fontWeight:800,color:owed>0?overdue?'#EF4444':'#F59E0B':'#10B981',flexShrink:0}}>{owed>0?`RM${owed.toFixed(2)}`:'✓'}</div>
            <div style={{width:120,flexShrink:0,display:'flex',alignItems:'center',gap:5}}>
              <span className="inv-status-chip" style={{background:invoiceStatusColor(inv.status)+'22',color:invoiceStatusColor(inv.status),borderColor:invoiceStatusColor(inv.status)+'55'}}>{invoiceStatusLabel(inv.status)}</span>
              <span style={{fontSize:10,color:'var(--text-3)'}}>{isExpanded?'▲':'▼'}</span>
            </div>
          </div>
          {isExpanded&&<InvoiceDetailPanel
            invoice={inv} lines={invLines} pmts={invPmts} pendingCredits={invPcs}
            isOverdue={overdue}
            onVoid={()=>onVoid(inv.id)}
            onUpdateStatus={(s)=>onUpdateStatus(inv.id,s)}
            onRecordPayment={(data)=>onRecordPayment({invoiceId:inv.id,...data})}
            onConfirmCredit={onConfirmCredit}
            onReverseCredit={onReverseCredit}
            onAddLine={(data)=>onAddLine(inv.id,data)}
            onUpdateLine={onUpdateLine}
            onDeleteLine={onDeleteLine}
          />}
        </div>;
      })}
    </div>
  </>;
}

// ============================================================================
// InvoiceDetailPanel — Phase 2: inline line editing + add custom line
// ============================================================================
function InvoiceDetailPanel({ invoice, lines, pmts, pendingCredits, isOverdue, onVoid, onUpdateStatus, onRecordPayment, onConfirmCredit, onReverseCredit, onAddLine, onUpdateLine, onDeleteLine }){
  const [showPayForm,setShowPayForm]=useState(false);
  const [lastReceipt,setLastReceipt]=useState(null);
  const [editingLineId,setEditingLineId]=useState(null);
  const [lineEdits,setLineEdits]=useState({});
  const [showAddLine,setShowAddLine]=useState(false);
  const [newLine,setNewLine]=useState({description:'',amount:'',lineType:'other'});
  const outstanding=Math.max(0,Number(invoice.total_amount)-Number(invoice.amount_paid));

  function startEdit(line){ setEditingLineId(line.id); setLineEdits({description:line.description,amount:String(line.amount)}); }
  function cancelEdit(){ setEditingLineId(null); }
  async function saveEdit(line){
    await onUpdateLine(line.id,{description:lineEdits.description,amount:Number(lineEdits.amount)||0});
    setEditingLineId(null);
  }
  async function handleAddLine(){
    if(!newLine.description.trim()){ alert('Enter a description.'); return; }
    if(!Number(newLine.amount)){ alert('Enter a valid amount.'); return; }
    await onAddLine(newLine);
    setNewLine({description:'',amount:'',lineType:'other'}); setShowAddLine(false);
  }

  return <div className="inv-detail">
    {isOverdue&&<div className="inv-overdue-banner">⚠ This invoice is overdue — due date {invoice.due_date} has passed. Outstanding: RM{outstanding.toFixed(2)}</div>}

    {/* Metadata */}
    <div className="inv-detail-meta">
      <div><span className="small subtle">Invoice #</span><div style={{fontWeight:800}}>{invoice.invoice_number}</div></div>
      <div><span className="small subtle">Account</span><div>{invoice.account_name}</div></div>
      <div><span className="small subtle">Issued</span><div>{invoice.issue_date}</div></div>
      {invoice.due_date&&<div><span className="small subtle">Due</span><div style={{color:isOverdue?'#EF4444':'inherit',fontWeight:isOverdue?700:400}}>{invoice.due_date}</div></div>}
      <div><span className="small subtle">Total</span><div style={{fontWeight:800}}>RM{Number(invoice.total_amount).toFixed(2)}</div></div>
      <div><span className="small subtle">Paid</span><div style={{color:'#10B981',fontWeight:700}}>RM{Number(invoice.amount_paid).toFixed(2)}</div></div>
      <div><span className="small subtle">Outstanding</span><div style={{fontWeight:800,color:outstanding>0?isOverdue?'#EF4444':'#F59E0B':'#10B981'}}>{outstanding>0?`RM${outstanding.toFixed(2)}`:'✓ Settled'}</div></div>
    </div>
    {invoice.notes&&<div className="small subtle" style={{margin:'0 0 12px',padding:'6px 10px',background:'var(--surface-2)',borderRadius:6}}>{invoice.notes}</div>}

    {/* Line Items — editable */}
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
      <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'.5px',color:'var(--text-3)'}}>Line Items ({lines.length})</div>
      <button className="btn btn-ghost small" style={{fontSize:10}} onClick={()=>setShowAddLine(v=>!v)}>{showAddLine?'Cancel':'+ Add Line'}</button>
    </div>

    <table className="billing-table" style={{marginBottom:8}}>
      <thead><tr><th style={{width:'50%'}}>Description</th><th>Type</th><th className="num">Amount</th><th style={{width:64}}></th></tr></thead>
      <tbody>
        {lines.map(l=><React.Fragment key={l.id}>
          <tr style={{opacity:l.is_billable?1:.4}}>
            {editingLineId===l.id ? <>
              <td><input className="input" style={{fontSize:12,padding:'4px 7px'}} value={lineEdits.description} onChange={e=>setLineEdits(x=>({...x,description:e.target.value}))} /></td>
              <td><span className={`billing-type-chip ${l.line_type==='group_bundle'?'group':'individual'}`}>{l.line_type==='group_bundle'?'Group Bundle':l.line_type==='individual'?'Individual':'Other'}</span></td>
              <td className="num"><input className="input" type="number" style={{width:90,fontSize:12,padding:'4px 7px',textAlign:'right'}} value={lineEdits.amount} onChange={e=>setLineEdits(x=>({...x,amount:e.target.value}))} /></td>
              <td style={{whiteSpace:'nowrap'}}>
                <button className="btn btn-primary small" style={{fontSize:10,padding:'3px 7px'}} onClick={()=>saveEdit(l)}>✓</button>
                <button className="btn btn-ghost small" style={{fontSize:10,padding:'3px 7px',marginLeft:3}} onClick={cancelEdit}>✗</button>
              </td>
            </> : <>
              <td><div>{l.description}</div>{l.student_names&&<div className="small subtle">{l.student_names}</div>}</td>
              <td><span className={`billing-type-chip ${l.line_type==='group_bundle'?'group':l.line_type==='individual'?'individual':'other'}`}>{l.line_type==='group_bundle'?'Group Bundle':l.line_type==='individual'?'Individual':'Other'}</span></td>
              <td className="num">RM{Number(l.amount).toFixed(2)}</td>
              <td style={{whiteSpace:'nowrap'}}>
                <button className="btn btn-ghost small" style={{fontSize:10,padding:'3px 7px'}} onClick={()=>startEdit(l)} title="Edit line">✏</button>
                <button className="btn btn-danger small" style={{fontSize:10,padding:'3px 7px',marginLeft:3}} onClick={()=>onDeleteLine(l.id)} title="Remove line">✗</button>
              </td>
            </>}
          </tr>
        </React.Fragment>)}
      </tbody>
    </table>

    {showAddLine&&<div className="add-line-form">
      <div style={{fontWeight:700,marginBottom:8,fontSize:12}}>Add Custom Line</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 130px 120px',gap:8,alignItems:'flex-end'}}>
        <div className="field"><label>Description</label><input className="input" value={newLine.description} onChange={e=>setNewLine(x=>({...x,description:e.target.value}))} placeholder="e.g. Registration fee, late charge…" /></div>
        <div className="field"><label>Amount (RM)</label><input className="input" type="number" min="0" step="0.01" value={newLine.amount} onChange={e=>setNewLine(x=>({...x,amount:e.target.value}))} /></div>
        <div style={{display:'flex',gap:5}}>
          <button className="btn btn-primary small" onClick={handleAddLine}>Add</button>
          <button className="btn btn-ghost small" onClick={()=>setShowAddLine(false)}>Cancel</button>
        </div>
      </div>
    </div>}

    {/* Pending credits */}
    {pendingCredits.length>0&&<div style={{marginBottom:12}}>
      <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'.5px',color:'var(--text-3)',marginBottom:5}}>Pending Credits ({pendingCredits.filter(p=>p.status==='pending').length} awaiting)</div>
      <div style={{display:'flex',flexDirection:'column',gap:4}}>
        {pendingCredits.map(pc=><div key={pc.id} className={`pc-row status-${pc.status}`}>
          <div style={{flex:1}}><div style={{fontWeight:700,fontSize:12}}>{pc.description||'Credit'}</div><div className="small subtle">{pc.credits_per_swimmer} credit{pc.credits_per_swimmer===1?'':'s'} · {pc.status}</div></div>
          {pc.status==='pending'&&<div style={{display:'flex',gap:5}}>
            <button className="btn btn-primary small" onClick={()=>onConfirmCredit(pc)}>✓ Confirm</button>
            <button className="btn btn-danger small" onClick={()=>onReverseCredit(pc)}>✗ Reverse</button>
          </div>}
          {pc.status==='confirmed'&&<span style={{color:'#10B981',fontSize:11,fontWeight:700}}>✓ Confirmed</span>}
          {pc.status==='reversed'&&<span style={{color:'#EF4444',fontSize:11,fontWeight:700}}>✗ Reversed</span>}
        </div>)}
      </div>
    </div>}

    {/* Payments */}
    {pmts.length>0&&<div style={{marginBottom:12}}>
      <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'.5px',color:'var(--text-3)',marginBottom:5}}>Payments Recorded</div>
      <div style={{display:'flex',flexDirection:'column',gap:4}}>
        {pmts.map(p=><div key={p.id} className="pmt-row">
          <div style={{flex:1}}><div style={{fontWeight:700}}>{p.receipt_number}</div><div className="small subtle">{p.payment_date} · {methodLabel(p.payment_method)}{p.reference_number?' · Ref: '+p.reference_number:''}{p.notes?' · '+p.notes:''}</div></div>
          <div style={{fontWeight:800,fontSize:14,marginRight:8}}>RM{Number(p.amount).toFixed(2)}</div>
          <button className="btn btn-print small" onClick={()=>printReceipt(p,invoice)}>🖨 Receipt</button>
        </div>)}
      </div>
    </div>}

    {lastReceipt&&<div style={{padding:'8px 12px',background:'#D1FAE5',borderRadius:6,marginBottom:10,fontSize:12,color:'#065F46',fontWeight:700}}>
      ✓ Payment recorded — Receipt {lastReceipt} · Go to <strong>⏳ Pending Credits</strong> to confirm credit allocation.
    </div>}

    {showPayForm&&<RecordPaymentForm outstanding={outstanding} onSubmit={async(data)=>{ const r=await onRecordPayment(data); if(r?.receiptNumber){setLastReceipt(r.receiptNumber);setShowPayForm(false);} }} onCancel={()=>setShowPayForm(false)} />}

    {/* Actions */}
    <div className="inv-actions">
      {invoice.status==='draft'&&<button className="btn btn-primary small" onClick={()=>onUpdateStatus('sent')}>✉ Mark Sent</button>}
      {(invoice.status==='sent'||invoice.status==='partial')&&outstanding>0&&!showPayForm&&<button className="btn btn-primary small" onClick={()=>setShowPayForm(true)}>💳 Record Payment</button>}
      {showPayForm&&<button className="btn btn-ghost small" onClick={()=>setShowPayForm(false)}>Cancel Payment</button>}
      <button className="btn btn-ghost small" onClick={()=>printInvoice(invoice,lines)}>🖨 Print Invoice</button>
      {invoice.status!=='void'&&invoice.status!=='paid'&&<button className="btn btn-danger small" onClick={onVoid}>Void</button>}
    </div>
  </div>;
}

// ============================================================================
// RecordPaymentForm
// ============================================================================
function RecordPaymentForm({ outstanding, onSubmit, onCancel }){
  const [form,setForm]=useState({ amount:outstanding>0?outstanding.toFixed(2):'', paymentDate:new Date().toISOString().slice(0,10), paymentMethod:'cash', referenceNumber:'', notes:'' });
  const [busy,setBusy]=useState(false);
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  async function handle(){
    const amt=Number(form.amount);
    if(!isFinite(amt)||amt<=0){alert('Enter a valid amount.');return;}
    setBusy(true);
    try{ const r=await onSubmit(form); }
    catch(e){alert(e?.message||'Payment failed');}
    finally{setBusy(false);}
  }
  return <div className="pay-form">
    <div style={{fontWeight:800,marginBottom:8}}>💳 Record Payment</div>
    <div className="pay-form-grid">
      <div className="field"><label>Amount (RM)</label><input className="input" type="number" min="0" step="0.01" value={form.amount} onChange={e=>set('amount',e.target.value)} /></div>
      <div className="field"><label>Date</label><input className="input" type="date" value={form.paymentDate} onChange={e=>set('paymentDate',e.target.value)} /></div>
      <div className="field"><label>Method</label>
        <select className="select" value={form.paymentMethod} onChange={e=>set('paymentMethod',e.target.value)}>
          <option value="cash">Cash</option>
          <option value="bank_transfer">Bank Transfer</option>
          <option value="duitnow">DuitNow</option>
          <option value="card">Card</option>
          <option value="cheque">Cheque</option>
          <option value="other">Other</option>
        </select>
      </div>
      <div className="field"><label>Reference #</label><input className="input" value={form.referenceNumber} onChange={e=>set('referenceNumber',e.target.value)} placeholder="optional" /></div>
    </div>
    <div className="field" style={{marginBottom:10}}><label>Notes</label><input className="input" value={form.notes} onChange={e=>set('notes',e.target.value)} placeholder="optional" /></div>
    <div style={{display:'flex',gap:6,justifyContent:'flex-end'}}>
      <button className="btn btn-ghost small" onClick={onCancel} disabled={busy}>Cancel</button>
      <button className="btn btn-primary small" onClick={handle} disabled={busy}>{busy?'Recording…':'✓ Confirm Payment'}</button>
    </div>
  </div>;
}

// ============================================================================
// PendingCreditsView
// ============================================================================
function PendingCreditsView({ pendingCredits, invoices, studentById, familyGroups, groupById, lessonTypeById, packageById, onConfirm, onReverse }){
  const [statusFilter,setStatusFilter]=useState('pending');
  const pendingCount=pendingCredits.filter(p=>p.status==='pending').length;
  const invById=useMemo(()=>Object.fromEntries((invoices||[]).map(i=>[i.id,i])),[invoices]);

  const filtered=pendingCredits.filter(pc=>statusFilter==='all'||pc.status===statusFilter);

  return <>
    <div className="card" style={{marginBottom:12}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12,flexWrap:'wrap',marginBottom:10}}>
        <div>
          <div style={{fontSize:18,fontWeight:800}}>⏳ Pending Credits</div>
          <div className="small subtle">Credits held in escrow after payment is recorded. Confirm to allocate lesson credits to the account. Reverse to reject (e.g. bounced payment).</div>
        </div>
        {pendingCount>0&&<div style={{fontSize:20,fontWeight:800,color:'#F59E0B'}}>{pendingCount} awaiting confirmation</div>}
      </div>
      <div style={{display:'flex',gap:3}}>
        {['pending','confirmed','reversed','all'].map(s=><button key={s} className={`tab ${statusFilter===s?'active':''}`} style={{padding:'5px 10px',fontSize:11,borderRadius:7}} onClick={()=>setStatusFilter(s)}>
          {s==='all'?`All (${pendingCredits.length})`:s.charAt(0).toUpperCase()+s.slice(1)+` (${pendingCredits.filter(p=>p.status===s).length})`}
        </button>)}
      </div>
    </div>

    {filtered.length===0&&<div className="card empty" style={{padding:28}}>No credits in this status.</div>}

    <div style={{display:'flex',flexDirection:'column',gap:6}}>
      {filtered.map(pc=>{
        const inv=invById[pc.invoice_id];
        const lt=pc.lesson_type_id&&lessonTypeById?lessonTypeById(pc.lesson_type_id):null;
        const pkg=pc.package_id&&packageById?packageById(pc.package_id):null;
        const grp=pc.family_group_id&&groupById?groupById(pc.family_group_id):null;
        const stu=pc.student_id&&studentById?studentById[pc.student_id]:null;
        return <div key={pc.id} className={`pc-card status-${pc.status}`}>
          <div className="pc-card-body">
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:700}}>{pc.description||'Credit Allocation'}</div>
              <div className="small subtle">
                {grp?`👪 ${grp.name}`:stu?`👤 ${stu.name}`:'Unknown recipient'}
                {lt?` · ${lt.name}`:''}
                {pkg?` · ${pkg.name}`:''}
              </div>
              <div className="small subtle">{pc.credits_per_swimmer} credit{pc.credits_per_swimmer===1?'':'s'} per swimmer{inv?` · ${inv.invoice_number}`:''}{inv?` · ${inv.account_name}`:''}</div>
              <div className="small subtle">{new Date(pc.created_at).toLocaleDateString(undefined,{dateStyle:'medium'})}</div>
            </div>
            <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:5}}>
              <span className={`pc-status-chip status-${pc.status}`}>{pc.status==='pending'?'⏳ Pending':pc.status==='confirmed'?'✓ Confirmed':'✗ Reversed'}</span>
              {pc.status==='pending'&&<div style={{display:'flex',gap:5}}>
                <button className="btn btn-primary small" onClick={()=>onConfirm(pc)}>✓ Confirm Credits</button>
                <button className="btn btn-danger small" onClick={()=>onReverse(pc)}>✗ Reverse</button>
              </div>}
            </div>
          </div>
        </div>;
      })}
    </div>
  </>;
}

// ============================================================================
// InvoiceSettingsPanel — number format + sequence control
// ============================================================================

// ============================================================================
// InvoiceSettingsPanel — number format + sequence control
// ============================================================================
function InvoiceSettingsPanel({ settings, onSave, formatInvoiceNumber, formatReceiptNumber }){
  const [form,setForm]=useState({
    invoice_prefix: settings.invoice_prefix||'INV',
    receipt_prefix: settings.receipt_prefix||'RCT',
    next_invoice_seq: String(settings.next_invoice_seq||1),
    next_receipt_seq: String(settings.next_receipt_seq||1),
    leading_zeros: String(settings.leading_zeros||3),
    include_date: settings.include_date !== false,
    date_format: settings.date_format||'YYYYMM',
  });
  const [saving,setSaving]=useState(false);
  const [saved,setSaved]=useState(false);
  const [showResetWarning,setShowResetWarning]=useState(false);

  React.useEffect(()=>{
    setForm({
      invoice_prefix: settings.invoice_prefix||'INV',
      receipt_prefix: settings.receipt_prefix||'RCT',
      next_invoice_seq: String(settings.next_invoice_seq||1),
      next_receipt_seq: String(settings.next_receipt_seq||1),
      leading_zeros: String(settings.leading_zeros||3),
      include_date: settings.include_date !== false,
      date_format: settings.date_format||'YYYYMM',
    });
  },[settings]);

  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const draftSettings={...form,leading_zeros:Number(form.leading_zeros)||3,include_date:!!form.include_date};
  const invPreview = formatInvoiceNumber ? formatInvoiceNumber(draftSettings, Number(form.next_invoice_seq)||1) : '—';
  const rctPreview = formatReceiptNumber ? formatReceiptNumber(draftSettings, Number(form.next_receipt_seq)||1) : '—';

  async function handleSave(){
    setSaving(true); setSaved(false);
    await onSave({
      invoice_prefix: form.invoice_prefix.trim()||'INV',
      receipt_prefix: form.receipt_prefix.trim()||'RCT',
      next_invoice_seq: Math.max(1,Number(form.next_invoice_seq)||1),
      next_receipt_seq: Math.max(1,Number(form.next_receipt_seq)||1),
      leading_zeros: Math.min(8,Math.max(1,Number(form.leading_zeros)||3)),
      include_date: !!form.include_date,
      date_format: form.date_format,
    });
    setSaving(false); setSaved(true);
    setTimeout(()=>setSaved(false),2000);
  }

  function doReset(){
    set('next_invoice_seq','1');
    set('next_receipt_seq','1');
    setShowResetWarning(false);
  }

  return <div className="inv-settings-panel">

    {/* Reset confirmation overlay */}
    {showResetWarning && <div className="reset-warn-backdrop">
      <div className="reset-warn-box">
        <div className="reset-warn-icon">⚠</div>
        <div className="reset-warn-title">Reset Invoice Counter?</div>
        <div className="reset-warn-body">
          Invoice numbers must <strong>not</strong> be reset in production — duplicate numbers cannot be issued to clients.<br /><br />
          This should only be done during <strong>testing</strong>. Existing invoice and receipt numbers are not affected; only the next number generated will restart from 001.
        </div>
        <div className="reset-warn-actions">
          <button className="btn btn-ghost" onClick={()=>setShowResetWarning(false)}>Cancel — Keep Current Numbers</button>
          <button className="btn btn-danger" onClick={doReset}>Continue Reset</button>
        </div>
      </div>
    </div>}

    <div className="inv-settings-header">
      <div className="inv-settings-title">⚙ Invoice Numbering</div>
      <div style={{display:'flex',gap:8,alignItems:'center'}}>
        <button className="btn btn-danger small" onClick={()=>setShowResetWarning(true)}>↺ Reset Counters</button>
        <button className="btn btn-primary small" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Settings'}
        </button>
      </div>
    </div>

    <div className="inv-settings-grid">
      <div className="field">
        <label>Invoice Prefix</label>
        <input className="input" value={form.invoice_prefix} onChange={e=>set('invoice_prefix',e.target.value.replace(/\s/g,''))} placeholder="INV" maxLength={12} />
        <div className="hint">No spaces — e.g. INV, SSB-INV, SWIM</div>
      </div>
      <div className="field">
        <label>Receipt Prefix</label>
        <input className="input" value={form.receipt_prefix} onChange={e=>set('receipt_prefix',e.target.value.replace(/\s/g,''))} placeholder="RCT" maxLength={12} />
        <div className="hint">No spaces — e.g. RCT, RCPT, PAY</div>
      </div>
      <div className="field">
        <label>Date Segment</label>
        <select className="select" value={form.include_date ? form.date_format : 'none'} onChange={e=>{
          if(e.target.value==='none'){set('include_date',false);}
          else{set('include_date',true);set('date_format',e.target.value);}
        }}>
          <option value="YYYYMM">Year + Month  (202606)</option>
          <option value="MMYY">Month + Year short  (0626)</option>
          <option value="YYYY">Year only  (2026)</option>
          <option value="MM">Month only  (06)</option>
          <option value="none">None — sequence only</option>
        </select>
      </div>
      <div className="field">
        <label>Leading Zeros</label>
        <select className="select" value={form.leading_zeros} onChange={e=>set('leading_zeros',e.target.value)}>
          {[1,2,3,4,5].map(n=><option key={n} value={n}>{n} digit{n===1?'':'s'} — {String(1).padStart(n,'0')}, {String(42).padStart(n,'0')}, {String(999).padStart(n,'0')}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Next Invoice Sequence</label>
        <input className="input" type="number" min="1" value={form.next_invoice_seq} onChange={e=>set('next_invoice_seq',e.target.value)} />
        <div className="hint">Integer for the next invoice generated</div>
      </div>
      <div className="field">
        <label>Next Receipt Sequence</label>
        <input className="input" type="number" min="1" value={form.next_receipt_seq} onChange={e=>set('next_receipt_seq',e.target.value)} />
        <div className="hint">Integer for the next receipt generated</div>
      </div>
    </div>

    <div className="inv-settings-preview">
      <div className="inv-settings-preview-label">Live Preview — next numbers generated</div>
      <div style={{display:'flex',gap:36,flexWrap:'wrap',marginBottom:10}}>
        <div>
          <div style={{fontSize:10,textTransform:'uppercase',letterSpacing:'.6px',color:'#64748B',marginBottom:4,fontWeight:700}}>Invoice</div>
          <div className="inv-settings-preview-num">{invPreview}</div>
        </div>
        <div>
          <div style={{fontSize:10,textTransform:'uppercase',letterSpacing:'.6px',color:'#64748B',marginBottom:4,fontWeight:700}}>Receipt</div>
          <div className="inv-settings-preview-num">{rctPreview}</div>
        </div>
      </div>
      <div className="hint" style={{lineHeight:1.6}}>
        Click <strong style={{color:'#CBD5E1'}}>Save Settings</strong> to apply. Existing numbers are never modified.
      </div>
    </div>
  </div>;
}

// ============================================================================
// AgingReportView — per-account outstanding balance aging
// ============================================================================
function AgingReportView({ invoices, pmts }){
  const [sortBy,setSortBy]=useState('outstanding'); // outstanding | account | oldest
  const today=todayStr();
  const todayMs=new Date(today).getTime();

  // Group by account_name
  const accountMap={};
  invoices.forEach(inv=>{
    const key=inv.account_name;
    if(!accountMap[key]) accountMap[key]={ account:key, invoices:[], totalInvoiced:0, totalPaid:0 };
    accountMap[key].invoices.push(inv);
    accountMap[key].totalInvoiced+=Number(inv.total_amount||0);
    accountMap[key].totalPaid+=Number(inv.amount_paid||0);
  });

  const rows=Object.values(accountMap).map(a=>{
    const outstanding=Math.max(0,a.totalInvoiced-a.totalPaid);
    // Age unpaid invoices
    let current=0,d1_30=0,d31_60=0,d60plus=0;
    a.invoices.forEach(inv=>{
      if(inv.status==='paid'||inv.status==='void') return;
      const owed=Math.max(0,Number(inv.total_amount)-Number(inv.amount_paid));
      if(!owed) return;
      if(!inv.due_date){ current+=owed; return; }
      const age=Math.floor((todayMs-new Date(inv.due_date).getTime())/(86400000));
      if(age<=0) current+=owed;
      else if(age<=30) d1_30+=owed;
      else if(age<=60) d31_60+=owed;
      else d60plus+=owed;
    });
    const openInvs=a.invoices.filter(i=>i.status!=='paid'&&i.status!=='void');
    const oldestDue=openInvs.map(i=>i.due_date).filter(Boolean).sort()[0]||null;
    const isOverdue=d1_30>0||d31_60>0||d60plus>0;
    return { account:a.account, totalInvoiced:a.totalInvoiced, totalPaid:a.totalPaid, outstanding, current, d1_30, d31_60, d60plus, openCount:openInvs.length, oldestDue, isOverdue };
  }).filter(r=>r.totalInvoiced>0);

  rows.sort((a,b)=>{
    if(sortBy==='outstanding') return b.outstanding-a.outstanding;
    if(sortBy==='account') return a.account.localeCompare(b.account);
    if(sortBy==='oldest') return (a.oldestDue||'9999')>(b.oldestDue||'9999')?1:-1;
    return 0;
  });

  const totals=rows.reduce((s,r)=>({ invoiced:s.invoiced+r.totalInvoiced, paid:s.paid+r.totalPaid, outstanding:s.outstanding+r.outstanding, current:s.current+r.current, d1_30:s.d1_30+r.d1_30, d31_60:s.d31_60+r.d31_60, d60plus:s.d60plus+r.d60plus }),{ invoiced:0,paid:0,outstanding:0,current:0,d1_30:0,d31_60:0,d60plus:0 });

  const rm=(v)=>`RM${v.toFixed(2)}`;

  return <>
    <div className="card" style={{marginBottom:12}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12,flexWrap:'wrap',marginBottom:10}}>
        <div><div style={{fontSize:18,fontWeight:800}}>📈 Aging Report</div><div className="small subtle">Outstanding balances by account with age buckets based on invoice due dates. As of {today}.</div></div>
        <div style={{display:'flex',gap:16,flexWrap:'wrap'}}>
          <div><div className="small subtle">Total Outstanding</div><div style={{fontSize:20,fontWeight:800,color:'#F59E0B'}}>{rm(totals.outstanding)}</div></div>
          <div><div className="small subtle" style={{color:'#EF4444'}}>60+ Days</div><div style={{fontSize:20,fontWeight:800,color:'#EF4444'}}>{rm(totals.d60plus)}</div></div>
        </div>
      </div>
      <div style={{display:'flex',gap:6}}>
        <span className="small subtle" style={{marginRight:4}}>Sort:</span>
        {[['outstanding','By Outstanding'],['account','By Account'],['oldest','By Oldest Due']].map(([k,l])=><button key={k} className={`tab ${sortBy===k?'active':''}`} style={{padding:'4px 10px',fontSize:11,borderRadius:6}} onClick={()=>setSortBy(k)} data-key={k}>{l}</button>)}
      </div>
    </div>

    {rows.length===0&&<div className="card empty" style={{padding:28}}>No invoiced accounts yet.</div>}

    {rows.length>0&&<div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Account</th>
            <th className="num">Invoiced</th>
            <th className="num">Paid</th>
            <th className="num">Outstanding</th>
            <th className="num" title="Not yet due">Current</th>
            <th className="num" style={{color:'#F59E0B'}}>1–30d</th>
            <th className="num" style={{color:'#F97316'}}>31–60d</th>
            <th className="num" style={{color:'#EF4444'}}>60+d</th>
            <th className="num">Open Inv.</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r=><tr key={r.account} style={{background:r.d60plus>0?'rgba(239,68,68,.06)':r.d31_60>0?'rgba(249,115,22,.04)':''}}>
            <td>
              <div style={{fontWeight:700}}>{r.account}</div>
              {r.isOverdue&&r.oldestDue&&<div style={{fontSize:10,color:'#EF4444'}}>Overdue since {r.oldestDue}</div>}
            </td>
            <td className="num">{rm(r.totalInvoiced)}</td>
            <td className="num" style={{color:'#10B981'}}>{rm(r.totalPaid)}</td>
            <td className="num" style={{fontWeight:800,color:r.outstanding>0?'#F59E0B':'#10B981'}}>{r.outstanding>0?rm(r.outstanding):'✓'}</td>
            <td className="num">{r.current>0?rm(r.current):'-'}</td>
            <td className="num" style={{color:r.d1_30>0?'#F59E0B':''}}>{r.d1_30>0?rm(r.d1_30):'-'}</td>
            <td className="num" style={{color:r.d31_60>0?'#F97316':''}}>{r.d31_60>0?rm(r.d31_60):'-'}</td>
            <td className="num" style={{fontWeight:r.d60plus>0?800:400,color:r.d60plus>0?'#EF4444':''}}>{r.d60plus>0?rm(r.d60plus):'-'}</td>
            <td className="num">{r.openCount}</td>
          </tr>)}
        </tbody>
        <tfoot>
          <tr style={{borderTop:'2px solid var(--border)',fontWeight:800}}>
            <td>Totals ({rows.length} accounts)</td>
            <td className="num">{rm(totals.invoiced)}</td>
            <td className="num" style={{color:'#10B981'}}>{rm(totals.paid)}</td>
            <td className="num" style={{color:'#F59E0B'}}>{rm(totals.outstanding)}</td>
            <td className="num">{totals.current>0?rm(totals.current):'-'}</td>
            <td className="num" style={{color:totals.d1_30>0?'#F59E0B':''}}>{totals.d1_30>0?rm(totals.d1_30):'-'}</td>
            <td className="num" style={{color:totals.d31_60>0?'#F97316':''}}>{totals.d31_60>0?rm(totals.d31_60):'-'}</td>
            <td className="num" style={{fontWeight:800,color:totals.d60plus>0?'#EF4444':''}}>{totals.d60plus>0?rm(totals.d60plus):'-'}</td>
            <td className="num"></td>
          </tr>
        </tfoot>
      </table>
    </div>}

    <div className="small subtle" style={{marginTop:10}}>
      Age buckets are calculated from invoice due dates. Invoices without a due date are counted as Current. Paid and voided invoices are excluded.
    </div>
  </>;
}

ReactDOM.createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>);
