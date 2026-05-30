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
function shortName(name){ const parts = String(name || '').trim().split(/\s+/).filter(Boolean); return parts.slice(0, 2).join(' '); }
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
  const [loading,setLoading] = useState(true);
  const [status,setStatus] = useState('');
  const [error,setError] = useState('');
  const [sessions,setSessions] = useState([]);
  const [students,setStudents] = useState([]);
  const [familyGroups,setFamilyGroups] = useState([]);
  const [creditBalances,setCreditBalances] = useState([]);
  const [replacementPending,setReplacementPending] = useState([]);
  const [tcAcceptances,setTcAcceptances] = useState([]);
  const [remarks,setRemarks] = useState({});
  const [options,setOptions] = useState({ instructors:[], durations:[], lessonTypes:[], pools:[], operatingHours:[], packages:[] });
  const [monthCursor,setMonthCursor] = useState(new Date());
  const [selectedDate,setSelectedDate] = useState(todayStr());
  const [selectedPoolId,setSelectedPoolId] = useState(null);  // M2: null = all pools
  const [enabledTypes,setEnabledTypes] = useState(null);      // null = all lesson types shown
  const [selectedInstructors,setSelectedInstructors] = useState(new Set()); // empty = no instructor filter
  const [modal,setModal] = useState(null);
  const [saveBusy,setSaveBusy] = useState(false);
  const [remarkDraft,setRemarkDraft] = useState('');

  useEffect(() => { boot(); }, []);
  useEffect(() => { if(cfg.supabaseUrl && cfg.supabaseAnonKey) loadRemarks(monthCursor).catch(handleErr); }, [monthCursor]);
  useEffect(() => { setRemarkDraft(remarks[selectedDate] || ''); }, [selectedDate, remarks]);

  function handleErr(err){ console.error(err); setError(err?.message || String(err)); setStatus('Error'); }

  async function boot(){
    if(!cfg.supabaseUrl || !cfg.supabaseAnonKey){ setError('Missing config.js values.'); setLoading(false); return; }
    try{
      setLoading(true); setError('');
      await loadOptions();
      await Promise.all([loadSessions(), loadStudents(), loadGroups(), loadCreditBalances(), loadReplacementPending(), loadTcAcceptances(), loadRemarks(monthCursor)]);
      setStatus('Connected');
    } catch(err){ handleErr(err); }
    finally{ setLoading(false); }
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
      setFamilyGroups((rows || []).map(r => ({ id:r.id, name:r.name || '', packageId:r.package_id || null })));
    } catch(e){ console.warn('Family groups not available yet (run the family groups migration):', e?.message || e); setFamilyGroups([]); }
  }

  async function loadCreditBalances(){
    try{
      const rows = await selectRows('student_credit_balances', '*');
      setCreditBalances(rows || []);
    } catch(e){ console.warn('Credit balances not available (run the replacement+credits migration):', e?.message || e); setCreditBalances([]); }
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
    if(!confirm(`Cancel ${sourceLabel} for this week and forward to next week?\n\nSwimmers' credits will NOT be consumed for this week. Make sure next week's session exists (use Duplicate Previous Week from there if it doesn't).`)) return;
    try{
      await deleteRows('weekly_session_students', { session_id: sessionId });
      await deleteRows('session_instructors', { session_id: sessionId });
      await deleteRows('weekly_sessions', { id: sessionId });
      await loadSessions();
      setModal(null);
      setStatus(`Cancelled ${sourceLabel} for this week — credits preserved.`);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to cancel class'); }
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
    const targetLabel = `${DAYS_F[targetDay]} ${minuteToTime(targetStartMinute)}`;
    if(!confirm(`Move ${pendingMove.lessonTypeName} (${pendingMove.swimmerCount} swimmer${pendingMove.swimmerCount===1?'':'s'}) from ${pendingMove.sourceLabel} to ${targetLabel}?`)) return;
    try{
      await patchRows('weekly_sessions', { id: pendingMove.sessionId }, {
        weekday: targetDay + 1,
        start_minute: targetStartMinute,
        // Mark as moved so Duplicate Previous Week can restore the
        // canonical slot in the next duplication.
        rescheduled_from_day: pendingMove.originalDay + 1,
        rescheduled_from_start_minute: pendingMove.originalStartMinute
      });
      await loadSessions();
      setPendingMove(null);
      setStatus(`Moved ${pendingMove.lessonTypeName} to ${targetLabel}.`);
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
    weekSessions.forEach(s => {
      const excluded = excludeFromStudentTotals(s.type);
      const count = excluded ? 0 : s.students.length;
      byType[s.type] = (byType[s.type] || 0) + count;
      const pool = poolById(s.poolId);
      if(pool) byPool[pool.name] = (byPool[pool.name] || 0) + count;
      s.instructors.forEach(inst => { byInst[inst.name] = (byInst[inst.name] || 0) + count; });
      totalStudents += count;
    });
    return { byType, byInst, byPool, totalStudents, totalSessions: weekSessions.length };
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
        family_group_id: modal.form.familyGroupId || null,
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
  async function addStudent({ name, dateOfBirth, gender, enrollments, guardianName, guardianEmail, guardianPhone, emergencyPhone, emergencyRelationship, emergencySameAsGuardian }){
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
        emergency_phone: sameAsG ? (guardianPhone || null) : (emergencyPhone || null),
        emergency_relationship: sameAsG ? 'Parent / Guardian' : (emergencyRelationship || null),
        emergency_same_as_guardian: sameAsG
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
      if('emergencyRelationship' in patch) body.emergency_relationship = patch.emergencyRelationship || null;
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
  async function addGroup({ name, packageId }){
    try{ setError(''); await insertRows('family_groups', { name, package_id: packageId || null }); await loadGroups(); }
    catch(err){ handleErr(err); alert(err.message || 'Failed to create family group'); }
  }
  async function updateGroup(id, patch){
    try{
      setError('');
      const body = {};
      if('name' in patch) body.name = patch.name;
      if('packageId' in patch) body.package_id = patch.packageId || null;
      await patchRows('family_groups', { id }, body);
      await loadGroups();
    } catch(err){ handleErr(err); alert(err.message || 'Failed to update family group'); }
  }
  async function deleteGroup(row){
    const members = students.filter(s => s.familyGroupId === row.id).length;
    if(!confirm(members > 0
      ? `Delete family group "${row.name}"? Its ${members} member${members===1?'':'s'} stay in the swimmer registry but will no longer be billed as a group.`
      : `Delete family group "${row.name}"?`)) return;
    try{ setError(''); await deleteRows('family_groups', { id: row.id }); await loadGroups(); await loadStudents(); }
    catch(err){ handleErr(err); alert(err.message || 'Failed to delete family group'); }
  }
  // Add or remove a swimmer from a group (groupId null = remove).
  async function setStudentGroup(studentId, groupId){
    try{ setError(''); await patchRows('students', { id: studentId }, { family_group_id: groupId || null }); await loadStudents(); }
    catch(err){ handleErr(err); alert(err.message || 'Failed to update group membership'); }
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

  async function duplicatePreviousWeek(){
    try{
      if(!isFutureSelectedWeek){ alert('Week duplication is only available for a future week.'); return; }
      const prevWeekStart = addDays(selectedWeekStart, -7);
      const sourceSessions = sessions.filter(s => s.weekStartDate === prevWeekStart).sort((a,b) => a.day - b.day || a.startMinute - b.startMinute);
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

  const studentById = useMemo(() => { const m = {}; students.forEach(s => m[s.id] = s); return m; }, [students]);
  // Set of swimmer IDs currently on a "trial" package (one-off bookings). Drives
  // the trial annotation in the modal/cards and the duplicate-week skip rule.
  const trialStudentIds = useMemo(() => {
    const trialPkgIds = new Set((options.packages || []).filter(p => (p.name || '').toLowerCase().includes('trial')).map(p => p.id));
    const ids = new Set();
    students.forEach(s => { if(s.packageId && trialPkgIds.has(s.packageId)) ids.add(s.id); });
    return ids;
  }, [students, options.packages]);
  const groupById = useMemo(() => { const m = {}; familyGroups.forEach(g => m[g.id] = g); return m; }, [familyGroups]);
  const membersByGroup = useMemo(() => { const m = {}; students.forEach(s => { if(s.familyGroupId){ (m[s.familyGroupId] = m[s.familyGroupId] || []).push(s); } }); return m; }, [students]);

  // Which sessions (in the selected week) each swimmer is already in — drives the
  // double-booking warning in the enrollment modal.
  const weekEnrollments = useMemo(() => {
    const m = {};
    weekSessions.forEach(s => s.students.forEach(st => {
      if(!st.studentId) return;
      (m[st.studentId] = m[st.studentId] || []).push({ day:s.day, startMinute:s.startMinute, type:s.type, sessionId:s.id });
    }));
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
          {['day','week','month','students','enroll'].map(v => <button key={v} className={`tab ${view===v?'active':''}`} onClick={() => setView(v)}>{v==='week'?'📅 Weekly':v==='day'?'📋 Daily':v==='month'?'🗓️ Monthly':v==='students'?'👥 Swimmers':'🎯 Enroll'}</button>)}
          {/* Intake is special — it opens the parent-facing intake.html in a new tab/window rather than switching view in this app. Placed inside the left tabs group, immediately before the Summary/Settings group. */}
          <button type="button" className="tab tab-link" onClick={() => window.open('./intake.html', '_blank', 'noopener,noreferrer')} title="Open the parent intake form in a new tab — hand the tablet over and tap 'Register Another Family' when done">📝 Intake <span aria-hidden="true" style={{marginLeft:3,opacity:.6,fontSize:11}}>↗</span></button>
        </div>
        <div className="tabs tabs-right">
          {['summary','settings'].map(v => <button key={v} className={`tab ${view===v?'active':''}`} onClick={() => setView(v)}>{v==='summary'?'📊 Summary':'⚙️ Settings'}</button>)}
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
        creditByKey={creditByKey}
      />}

      {!loading && view==='month' && <MonthView
        monthCursor={monthCursor} setMonthCursor={setMonthCursor}
        selectedDate={selectedDate} setSelectedDate={setSelectedDate}
        monthDates={monthDates} sessionsForDate={sessionsForDate} colorsFor={colorsFor}
        remarks={remarks} remarkDraft={remarkDraft} setRemarkDraft={setRemarkDraft} saveRemark={saveRemark}
        selectedItems={selectedItems}
      />}

      {!loading && view==='students' && <>
        <StudentsView
          students={students}
          lessonTypes={activeLessonTypes()}
          lessonTypeById={lessonTypeById}
          packages={activePackages()}
          packageById={packageById}
          groupById={groupById}
          scheduleByStudent={scheduleByStudent}
          creditByKey={creditByKey}
          addStudent={addStudent}
          updateStudent={updateStudent}
          deleteStudent={deleteStudent}
        />
        <FamilyGroupsPanel
          groups={familyGroups}
          students={students}
          groupPackages={options.packages.filter(p => p.is_active !== false)}
          lessonTypes={activeLessonTypes()}
          packageById={packageById}
          membersByGroup={membersByGroup}
          scheduleByStudent={scheduleByStudent}
          addGroup={addGroup}
          updateGroup={updateGroup}
          deleteGroup={deleteGroup}
          setStudentGroup={setStudentGroup}
        />
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
        initialWeekStart={selectedWeekStart}
        onEnroll={openEnroll}
        onCreate={openCreateFor}
      />}
      {!loading && view==='summary' && <SummaryView summary={summary} pools={activePools()} />}
      {/* T&C view removed from the menu — parents now sign T&C inside intake.html. */}

      {!loading && view==='settings' && <SettingsView
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
      />}
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
      students={students}
      studentById={studentById}
      weekEnrollments={weekEnrollments}
      familyGroups={familyGroups}
      membersByGroup={membersByGroup}
      trialStudentIds={trialStudentIds}
      creditByKey={creditByKey}
      adjustCredit={adjustCredit}
      initCredit={initCredit}
      pendingByKey={pendingByKey}
      replacementPending={replacementPending}
      markForReplacement={markForReplacement}
      forwardClassToNextWeek={forwardClassToNextWeek}
      startFullClassMove={startFullClassMove}
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
          trialStudentIds, creditByKey } = props;

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
            {cell.map(block => <AgendaCard key={block.id} block={block} colorsFor={colorsFor} lessonTypeByName={lessonTypeByName} poolById={poolById} showPoolBadge={showPoolBadge} onEdit={onEdit} trialStudentIds={trialStudentIds} creditByKey={creditByKey} />)}
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
function AgendaCard({ block, colorsFor, lessonTypeByName, poolById, showPoolBadge, onEdit, trialStudentIds, creditByKey }){
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
          const isTrial = !!(s.studentId && trialStudentIds && trialStudentIds.has(s.studentId));
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

function DailyView({ selectedDate, setSelectedDate, sessionsForDate, colorsFor, lessonTypeByName, poolById, onAddAtTime, onEdit, selectedWeekStart, currentWeekStart, onPrevWeek, onNextWeek, onThisWeek, onExportExcel, activeLessonTypes, isTypeEnabled, onToggleType, onToggleAllTypes, allTypesShown, activeInstructors, isInstructorActive, onToggleInstructor, onClearInstructors, instructorFilterActive, trialStudentIds, creditByKey }){
  const wb = weekBounds(selectedDate);
  const weekDays = Array.from({length:7}, (_,i) => { const d = new Date(wb.start); d.setDate(wb.start.getDate()+i); return { date:d, ds:toDateStr(d), idx:i }; });
  const items = sessionsForDate(selectedDate);
  const hourStarts = Array.from({length:13}, (_,i) => 480 + i*60);
  return <div className="grid">
    <div className="card">
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
                          ? <div className="daily-event-students">{it.students.map((s, si) => {
                              const isTrial = !!(s.studentId && trialStudentIds && trialStudentIds.has(s.studentId));
                              const isRepl = s.isReplacement;
                              const bal = isPersonalIt && s.studentId && creditByKey ? creditByKey[`${s.studentId}:${it.lessonTypeId}`] : null;
                              return <span key={s.id || si} className={`daily-event-stu ${isRepl?'daily-stu-repl':''}`} title={isRepl?`Replacement from ${s.replacementFrom||'?'}`:undefined}>{isRepl?<span className="repl-mark-sm">R</span>:null}{s.name + ageSuffix(s)}{isTrial ? <span className="trial-mark"> (trial)</span> : null}{bal ? <span className={`credit-mark ${bal.remaining_balance<=2?'credit-low':''}`}> · {bal.remaining_balance}cr</span> : null}</span>;
                            })}</div>
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
      <div className="print-title">Daily Schedule</div>
      <div className="print-meta">{longDate(selectedDate)}</div>
      <table className="print-daily-table">
        <thead>
          <tr><th style={{width:'16%'}}>Time</th><th>Session Details</th></tr>
        </thead>
        <tbody>
          {hourStarts.map(start => {
            const rowItems = items.filter(it => it.startMinute >= start && it.startMinute < start + 60);
            return <tr key={`p-${start}`}>
              <td className="print-time-cell">{minuteToTime(start)}</td>
              <td>
                {rowItems.length ? <div className="print-day-cols">
                  {rowItems.map(it => {
                    const pool = poolById(it.poolId);
                    const inst = it.instructors.map(i=>i.name).join(', ') || it.legacyInstructor || 'No Instructor';
                    return <div key={it.id} className="print-day-col">
                      <div className="print-session-head">{formatRange(it.startMinute, it.durationMinutes)} · {it.type}</div>
                      <div className="print-session-head" style={{fontWeight:400}}>{pool ? `${pool.name} · ` : ''}{inst} · {it.students.length} student{it.students.length===1?'':'s'}</div>
                      <div className="print-session-students">{it.students.length ? it.students.map(studentLabel).join(', ') : 'No students listed'}</div>
                    </div>;
                  })}
                </div> : <div>No sessions</div>}
              </td>
            </tr>;
          })}
          <tr><td>{minuteToTime(1260)}</td><td>Day end</td></tr>
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

// Live billing for a family group. The discount is NEVER stored per head: when
// the group is at its required size it costs the bundled total; the moment it
// drops below, it reverts to the standard per-pax rate — so a removed member
// can't leave a stale discounted rate behind.
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
  // Family discount bundle: price holds at full size, reverts to per-pax below.
  let status = 'unknown', total = null;
  if(required != null && bundle != null){
    if(n === required){ status = 'qualified'; total = bundle; }
    else if(n < required){ status = 'under'; total = (fb != null ? n * fb : null); }
    else { status = 'over'; total = (fb != null ? bundle + (n - required) * fb : bundle); }
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

function SettingsView({ options, status, addOption, toggleOption, deleteOption, deleteInstructor, patchOption, reorderOption, moveOption, saveLessonType, deleteLessonType, lessonTypeCounts }){
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
    {/* Single status + settings band */}
    <div className="card" style={{marginBottom:16,display:'flex',alignItems:'center',gap:20,flexWrap:'wrap'}}>
      <div style={{display:'flex',alignItems:'center',gap:11}}>
        <span style={{width:9,height:9,borderRadius:999,background:'var(--teal)',boxShadow:'0 0 0 4px rgba(31,169,143,0.16)',flexShrink:0}}></span>
        <div><div style={{fontSize:10,textTransform:'uppercase',letterSpacing:'.7px',color:'var(--text-2)',fontWeight:700}}>Status</div><div style={{fontSize:15,fontWeight:800}}>{status || 'Connected'}</div></div>
      </div>
      <div style={{width:1,alignSelf:'stretch',background:'var(--border)'}}></div>
      <div style={{flex:'1 1 240px',minWidth:0}}>
        <div style={{fontSize:15,fontWeight:800}}>Settings</div>
        <div className="small subtle" style={{marginTop:2}}>Edit pools, operating hours, instructors, and lesson types. These changes do not reset your schedule data.</div>
      </div>
    </div>

    {/* Pools / Operating Hours / Instructors — three across */}
    <div className="settings-cols">
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

      <div className="card">
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
      </div>
    </div>

    {/* Lesson types — full width (packages now nested under each lesson type) */}
    <div className="card" style={{marginTop:16}}>
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
  </>;
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
function EnrollView({ sessions, students, studentById, lessonTypes, lessonTypeById, lessonTypeByName, poolById, colorsFor, gridBounds, packages, initialWeekStart, onEnroll, onCreate }){
  const [weekStart, setWeekStart] = useState(initialWeekStart);
  const [slotIds, setSlotIds] = useState([null]); // up to 3 swimmer ids

  function setSlotAt(idx, id){ setSlotIds(s => s.map((x,i)=>i===idx?id:x)); }
  function addSlot(){ setSlotIds(s => s.length < 3 ? [...s, null] : s); }
  function removeSlotAt(idx){ setSlotIds(s => s.length > 1 ? s.filter((_,i)=>i!==idx) : [null]); }

  const selectedSwimmers = slotIds.map(id => id ? studentById[id] : null).filter(Boolean);
  const selectedCount = selectedSwimmers.length;
  const selectedIdSet = new Set(slotIds.filter(Boolean));

  // Union of lesson types — used to show classes that ANY of the selected
  // swimmers could attend (broader visibility, no blank screen if their types
  // diverge). Intersection ("sharedLtIds") marks the prime targets where ALL
  // selected swimmers could join the same class.
  const unionLtIds = useMemo(() => {
    const s = new Set();
    selectedSwimmers.forEach(sw => (sw.lessonTypeIds || []).forEach(id => s.add(id)));
    return s;
  }, [selectedSwimmers]);

  const sharedLtIds = useMemo(() => {
    if(selectedCount === 0) return new Set();
    const sets = selectedSwimmers.map(s => new Set(s.lessonTypeIds || []));
    const out = new Set();
    sets[0].forEach(id => { if(sets.every(s => s.has(id))) out.add(id); });
    return out;
  }, [selectedSwimmers, selectedCount]);

  // Analyze each session in the visible week. The downstream renderer uses
  // these flags to paint the grid: fitsAll → prime target, hasRoom →
  // enrollable, splittable → opportunity to reorganize.
  const analyzed = useMemo(() => {
    const ws = sessions.filter(s => s.weekStartDate === weekStart);
    return ws.map(s => {
      const lt = (s.lessonTypeId && lessonTypeById(s.lessonTypeId)) || lessonTypeByName(s.type);
      const cap = sessionCapacity(s, lt);
      const hasRoom = cap.max === 0 || cap.current < cap.max;
      const ltId = lt?.id;
      const compatible = ltId ? selectedSwimmers.filter(sw => (sw.lessonTypeIds || []).includes(ltId)) : [];
      const alreadyIn = new Set((s.students || []).map(st => st.studentId).filter(Boolean));
      const enrollable = compatible.filter(sw => !alreadyIn.has(sw.id));
      const allCompatible = selectedCount > 0 && enrollable.length === selectedCount;
      const fitsAll = allCompatible && hasRoom && (cap.max === 0 || cap.current + enrollable.length <= cap.max);
      const wouldOverflow = !hasRoom && enrollable.length > 0;
      // Splittable: full + adding the new swimmers would yield ≥6 total (so
      // a 4/4 or 5/3 split into two sustainable groups is possible).
      const splittable = wouldOverflow && (cap.current + enrollable.length) >= 6;
      return { s, lt, ltId, cap, hasRoom, compatible, enrollable, allCompatible, fitsAll, wouldOverflow, splittable };
    });
  }, [sessions, weekStart, selectedSwimmers, selectedCount, lessonTypeById, lessonTypeByName]);

  // Filter logic: when no swimmer selected, show all (calendar-week parity).
  // When swimmers selected, narrow to classes serving at least one of them.
  const visible = selectedCount === 0 ? analyzed : analyzed.filter(a => a.compatible.length > 0);

  const stats = useMemo(() => {
    const total = visible.length;
    const fitsAll = visible.filter(v => v.fitsAll).length;
    const partial = visible.filter(v => v.hasRoom && v.enrollable.length > 0 && !v.fitsAll).length;
    const full = visible.filter(v => !v.hasRoom).length;
    const splittable = visible.filter(v => v.splittable).length;
    return { total, fitsAll, partial, full, splittable };
  }, [visible]);

  const byDay = useMemo(() => Array.from({length:7}, (_,di) => visible.filter(v => v.s.day === di).sort((a,b)=>a.s.startMinute - b.s.startMinute)), [visible]);

  const startHour = Math.floor(gridBounds.startMin / 60) * 60;
  const hours = []; for(let h = startHour; h < gridBounds.endMin; h += 60) hours.push(h);
  const wb = weekBounds(weekStart);

  function handleEnroll(info){
    if(!info.s) return;
    onEnroll(info.s, info.enrollable);
  }
  function handleOpenNew(day, startMinute){
    let lt = null;
    if(sharedLtIds.size > 0) lt = lessonTypeById([...sharedLtIds][0]);
    else if(unionLtIds.size > 0) lt = lessonTypeById([...unionLtIds][0]);
    onCreate(weekStart, day, startMinute, lt, selectedSwimmers);
  }

  return <>
    <div className="card" style={{marginBottom:16}}>
      <div className="view-head">
        <div>
          <div className="view-title">Enroll Swimmers</div>
          <div className="small subtle">Pick up to 3 swimmers — the weekly grid below narrows to classes any of them can join. Green-outlined classes can take all selected swimmers. Empty slots show opportunities to open a new class.</div>
        </div>
      </div>
      <PeriodNav rangeLabel={weekRangeLabel(weekStart)} onPrev={()=>setWeekStart(addDays(weekStart,-7))} onNext={()=>setWeekStart(addDays(weekStart,7))} onToday={()=>setWeekStart(initialWeekStart)} isCurrent={weekStart===initialWeekStart} />

      <div className="enroll-slots">
        {slotIds.map((id, i) => {
          const candidates = students.filter(s => !selectedIdSet.has(s.id) || s.id === id);
          const sw = id ? studentById[id] : null;
          return <div key={i} className="enroll-slot">
            <span className="enroll-slot-num">{i+1}</span>
            <div className="enroll-slot-pick">
              <StudentSelect valueId={id} fallbackLabel={null} studentById={studentById} candidates={candidates} onPick={(stu)=>setSlotAt(i, stu?stu.id:null)} conflict={null} />
            </div>
            <div className="enroll-slot-tags">
              {sw ? (sw.lessonTypeIds || []).map(ltId => {
                const t = lessonTypeById(ltId);
                if(!t) return null;
                const isShared = sharedLtIds.has(ltId);
                return <span key={ltId} className="chip" style={{background:t.bg_color,borderColor:t.border_color,color:t.text_color,fontSize:10,padding:'2px 7px',outline:isShared&&selectedCount>1?'2px solid var(--primary)':'none',outlineOffset:isShared&&selectedCount>1?'1px':'0'}}>{t.name}{isShared&&selectedCount>1?' ✓':''}</span>;
              }) : null}
            </div>
            <button type="button" className="enroll-slot-x" onClick={()=>removeSlotAt(i)} title="Clear slot">×</button>
          </div>;
        })}
        {slotIds.length < 3 ? <button type="button" className="enroll-slot-add" onClick={addSlot}>+ Add another swimmer ({slotIds.length}/3)</button> : <div className="small subtle" style={{padding:'6px 2px'}}>Maximum 3 swimmers — clear a slot to swap.</div>}
      </div>

      {selectedCount > 0 && <div className="enroll-summary">
        <strong>{selectedCount}</strong> swimmer{selectedCount===1?'':'s'} selected
        {selectedCount > 1 && sharedLtIds.size > 0 && <span className="enroll-summary-shared"> · Shared lesson types: {[...sharedLtIds].map(id => lessonTypeById(id)?.name).filter(Boolean).join(', ')}</span>}
        {selectedCount > 1 && sharedLtIds.size === 0 && <span className="enroll-summary-warn"> · ⚠ No shared lesson types — these swimmers can only enroll into separate classes</span>}
      </div>}

      {selectedCount > 0 && <div className="enroll-stats">
        <span className="enroll-stat fits">{stats.fitsAll} fits all</span>
        <span className="enroll-stat partial">{stats.partial} partial</span>
        <span className="enroll-stat full">{stats.full} full{stats.splittable ? ` · ${stats.splittable} splittable` : ''}</span>
      </div>}
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
            const isEmpty = cellInfos.length === 0;
            // Opportunity: an empty slot where the selected swimmers could
            // anchor a new class. Gold = all selected share a lesson type AND
            // we have ≥3 swimmers (sustainable new group threshold).
            const isOpportunity = isEmpty && selectedCount >= 1 && (sharedLtIds.size > 0 || unionLtIds.size > 0);
            const isGold = isOpportunity && selectedCount >= 3 && sharedLtIds.size > 0;
            return <div
              key={'c'+di+'-'+h}
              className={`enroll-grid-cell ${isOpportunity?'is-opportunity':''} ${isGold?'is-gold':''}`}
              onClick={isEmpty ? () => handleOpenNew(di, h) : undefined}
              title={isOpportunity ? `Open a new class at ${DAYS_F[di]} ${hourLabel(h)}` : ''}
            >
              {cellInfos.map(info => {
                const c = colorsFor(info.s.type);
                const inst = (info.s.instructors[0] && info.s.instructors[0].name) || info.s.legacyInstructor || '';
                let cls = 'enroll-mini';
                if(selectedCount > 0){
                  if(info.fitsAll) cls += ' mini-fits';
                  else if(info.hasRoom && info.enrollable.length > 0) cls += ' mini-partial';
                  else if(info.splittable) cls += ' mini-split';
                  else if(!info.hasRoom) cls += ' mini-full';
                }
                const capLabel = info.cap.max > 0 ? `${info.cap.current}/${info.cap.max}` : `${info.cap.current}`;
                return <div key={info.s.id} className={cls} style={{borderLeftColor:c.bd,background:c.bg}} onClick={(e)=>{ e.stopPropagation(); handleEnroll(info); }}>
                  <div className="enroll-mini-top">
                    <span className="enroll-mini-type" style={{color:c.tx}}>{info.s.type}</span>
                    <span className="enroll-mini-cap">{capLabel}</span>
                  </div>
                  <div className="enroll-mini-meta">{minuteToTime(info.s.startMinute)}{inst?` · ${inst}`:''}</div>
                  {selectedCount > 0 && info.fitsAll && <div className="enroll-mini-cta cta-fits">Enroll {info.enrollable.length} ✓</div>}
                  {selectedCount > 0 && info.hasRoom && !info.fitsAll && info.enrollable.length > 0 && <div className="enroll-mini-cta cta-partial">Enroll {info.enrollable.length} of {selectedCount}</div>}
                  {selectedCount > 0 && !info.hasRoom && info.splittable && <div className="enroll-mini-cta cta-split">Splittable</div>}
                  {selectedCount > 0 && !info.hasRoom && !info.splittable && <div className="enroll-mini-cta cta-full">FULL</div>}
                </div>;
              })}
              {isOpportunity && <div className="enroll-cell-hint">{isGold ? '+ Open new class' : '+'}</div>}
            </div>;
          })}
        </React.Fragment>)}
      </div>
      <div className="enroll-legend">
        <span><i className="enroll-swatch swatch-fits" />Fits all selected</span>
        <span><i className="enroll-swatch swatch-partial" />Some swimmers can join</span>
        <span><i className="enroll-swatch swatch-split" />Full · splittable opportunity</span>
        <span><i className="enroll-swatch swatch-full" />Full</span>
        <span><i className="enroll-swatch swatch-gold" />Gold slot · open a new class</span>
        <span className="small subtle" style={{marginLeft:'auto'}}>Click a class to enroll · click an empty cell to open a new one · splits = parallel sessions, not replacements</span>
      </div>
    </div>
  </>;
}

// Searchable swimmer combobox used in each enrollment slot.
function StudentSelect({ valueId, fallbackLabel, studentById, candidates, onPick, conflict, trialStudentIds, pendingByKey, weekStartDate, lessonTypeId }){
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const sel = valueId ? studentById[valueId] : null;
  const label = sel ? `${sel.name}${sel.age != null ? ` (${sel.age})` : ''}` : (fallbackLabel || '');
  const filtered = (candidates || []).filter(s => !q || (s.name || '').toLowerCase().includes(q.toLowerCase()));
  // Sort: pending-replacement first, then trial, then the rest alphabetical —
  // so flagged candidates surface at the top of the dropdown when scheduler
  // is looking for one.
  const sortedFiltered = filtered.slice().sort((a, b) => {
    const aP = !!(pendingByKey && lessonTypeId && weekStartDate && pendingByKey[`${a.id}:${lessonTypeId}:${weekStartDate}`]);
    const bP = !!(pendingByKey && lessonTypeId && weekStartDate && pendingByKey[`${b.id}:${lessonTypeId}:${weekStartDate}`]);
    if(aP !== bP) return aP ? -1 : 1;
    const aT = !!(trialStudentIds && trialStudentIds.has(a.id));
    const bT = !!(trialStudentIds && trialStudentIds.has(b.id));
    if(aT !== bT) return aT ? -1 : 1;
    return (a.name || '').localeCompare(b.name || '');
  });
  function choose(s){ onPick(s); setOpen(false); setQ(''); }
  return <div className="ssel">
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
    {open ? <>
      <div className="ssel-backdrop" onClick={()=>{ setOpen(false); setQ(''); }} />
      <div className="ssel-pop">
        <div className="ssel-list">
          {sortedFiltered.length ? sortedFiltered.map(s => {
            const isPending = !!(pendingByKey && lessonTypeId && weekStartDate && pendingByKey[`${s.id}:${lessonTypeId}:${weekStartDate}`]);
            const isTrial = !!(trialStudentIds && trialStudentIds.has(s.id));
            const pendingInfo = isPending ? pendingByKey[`${s.id}:${lessonTypeId}:${weekStartDate}`] : null;
            return <button key={s.id} type="button" className={`ssel-item ${isPending ? 'ssel-item-pending' : ''} ${isTrial ? 'ssel-item-trial' : ''}`} onClick={()=>choose(s)}>
              <span className="ssel-item-main">
                {isPending ? <span className="ssel-flag ssel-flag-r" title={`Pending replacement from ${pendingInfo.original_session_label}`}>R-pending</span> : null}
                {isTrial ? <span className="ssel-flag ssel-flag-trial" title="Trial swimmer — one-off booking">trial</span> : null}
                <span className="ssel-item-name">{s.name}</span>
              </span>
              <span className="ssel-item-meta">{s.age != null ? `${s.age}y` : ''}{isPending ? ` · from ${pendingInfo.original_session_label}` : (s.package ? ` · ${s.package}` : '')}</span>
            </button>;
          }) : <div className="ssel-empty">No swimmers found</div>}
        </div>
      </div>
    </> : null}
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

function StudentEditor({ row, lessonTypes, packages, onSave }){
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
  const [adultSelf, setAdultSelf] = useState(false);
  function handleSameAsGuardian(v){ setSameAsGuardian(v); if(v){ setEmergencyPhone(guardianPhone); setEmergencyRel('Parent / Guardian'); } }
  function handleAdultSelf(v){ setAdultSelf(v); if(v) setGuardianName(name); }
  const computedAge = dob ? ageFromDob(dob) : null;

  return <div className="lesson-edit">
    <div className="student-form-section">
      <div className="student-form-section-title">Swimmer Details</div>
      <div className="form-grid" style={{gridTemplateColumns:'1.3fr auto 84px auto'}}>
        <div className="field"><label>Name</label><input className="input" value={name} onChange={e=>{ setName(e.target.value); if(adultSelf) setGuardianName(e.target.value); }} /></div>
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
    <div className="student-form-section">
      <div className="student-form-section-title">Parent / Guardian</div>
      <label className="gb-check" style={{marginBottom:8}}><input type="checkbox" checked={adultSelf} onChange={e=>handleAdultSelf(e.target.checked)} /> Adult swimmer — I am my own guardian (pre-fill with my name)</label>
      <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr 1fr'}}>
        <div className="field"><label>Guardian Name</label><input className="input" value={guardianName} onChange={e=>setGuardianName(e.target.value)} placeholder="Full name" /></div>
        <div className="field"><label>Email</label><input className="input" type="email" value={guardianEmail} onChange={e=>setGuardianEmail(e.target.value)} placeholder="email@example.com" /></div>
        <div className="field"><label>Phone</label><input className="input" type="tel" value={guardianPhone} onChange={e=>{ setGuardianPhone(e.target.value); if(sameAsGuardian) setEmergencyPhone(e.target.value); }} placeholder="+60 1X-XXXXXXX" /></div>
      </div>
    </div>
    <div className="student-form-section">
      <div className="student-form-section-title">Emergency Contact</div>
      <label className="gb-check" style={{marginBottom:8}}><input type="checkbox" checked={sameAsGuardian} onChange={e=>handleSameAsGuardian(e.target.checked)} /> Same as Parent / Guardian</label>
      <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr'}}>
        <div className="field"><label>Phone</label><input className="input" type="tel" value={sameAsGuardian?guardianPhone:emergencyPhone} onChange={e=>setEmergencyPhone(e.target.value)} disabled={sameAsGuardian} placeholder="+60 1X-XXXXXXX" /></div>
        <div className="field"><label>Relationship</label><input className="input" value={sameAsGuardian?'Parent / Guardian':emergencyRel} onChange={e=>setEmergencyRel(e.target.value)} disabled={sameAsGuardian} placeholder="e.g. Mother, Father, Spouse" /></div>
      </div>
    </div>
    {row.tcAcceptedAt && <div className="tc-status-row tc-accepted">
      <span>✅ T&amp;C Accepted</span>
      <span className="small subtle">ID: {row.tcAcceptanceId} · {new Date(row.tcAcceptedAt).toLocaleDateString(undefined,{dateStyle:'medium'})}</span>
    </div>}
    {!row.tcAcceptedAt && <div className="tc-status-row tc-pending">⚠ Terms &amp; Conditions not yet accepted — go to the T&amp;C tab to send for signature.</div>}
    <div style={{display:'flex',justifyContent:'flex-end',marginTop:10}}><button className="btn btn-primary" onClick={()=>{
      const v = name.trim(); if(!v) return;
      onSave({ name:v, dateOfBirth: dob || null, gender, enrollments, guardianName, guardianEmail, guardianPhone, emergencySameAsGuardian:sameAsGuardian, emergencyPhone: sameAsGuardian?guardianPhone:emergencyPhone, emergencyRelationship: sameAsGuardian?'Parent / Guardian':emergencyRel });
    }}>Save Swimmer</button></div>
  </div>;
}

function FamilyGroupsPanel({ groups, students, groupPackages, lessonTypes, packageById, membersByGroup, scheduleByStudent, addGroup, updateGroup, deleteGroup, setStudentGroup }){
  const [name, setName] = useState('');
  const [pkgId, setPkgId] = useState('');
  const [editId, setEditId] = useState(null);

  function statusChip(b){
    if(b.status === 'qualified') return { cls:'gb-ok', text:`Qualified · RM${fmtMoney(b.total)}${b.perHead != null ? ` (RM${fmtMoney(b.perHead)}/child)` : ''}` };
    if(b.status === 'under')     return { cls:'gb-warn', text:`⚠ Under-enrolled ${b.n}/${b.required} · discount void → RM${fmtMoney(b.total)}${b.fb != null ? ` (${b.n} × RM${fmtMoney(b.fb)})` : ''}` };
    if(b.status === 'over')      return { cls:'gb-amber', text:`⚠ ${b.n} members — package is for ${b.required}. Move to a ${b.n}-pax family package.` };
    if(b.status === 'flat')      return { cls:'gb-ok', text:`RM${fmtMoney(b.total)} for the group${b.mode === 'credit' && b.credits != null ? ` · ${b.credits} credits` : ''} · ${b.n} member${b.n===1?'':'s'}${b.required != null ? ` · up to ${b.required}` : ''}` };
    if(b.status === 'under_soft')return { cls:'gb-ok', text:`RM${fmtMoney(b.total)} for the group${b.mode === 'credit' && b.credits != null ? ` · ${b.credits} credits` : ''} · ${b.n} member${b.n===1?'':'s'}` };
    if(b.status === 'over_soft') return { cls:'gb-amber', text:`⚠ ${b.n} members — package max is ${b.required}` };
    return { cls:'gb-dim', text:'Set amount (and required pax) on the package.' };
  }

  return <div className="card" style={{marginTop:16}}>
    <div style={{fontSize:18,fontWeight:800}}>Family Groups</div>
    <div className="small subtle" style={{marginTop:4}}>A family group is one paying unit sharing a package — use it for a discounted family bundle, or to keep a private class (Duo, Premium Clara) booked together. When you enroll, you can drop the whole group into a class at once.</div>

    <div style={{display:'flex',gap:10,alignItems:'flex-end',marginTop:14,flexWrap:'wrap'}}>
      <div className="field" style={{margin:0,minWidth:200,flex:1}}><label>New group name</label><input className="input" placeholder="e.g. Tan Family" value={name} onChange={e=>setName(e.target.value)} /></div>
      <div className="field" style={{margin:0,minWidth:220}}><label>Package</label><select className="select" value={pkgId} onChange={e=>setPkgId(e.target.value)}><option value="">Select a package…</option>{packageOptionGroups(groupPackages.filter(p=>p.pax>1), lessonTypes)}</select></div>
      <button className="btn btn-primary" disabled={!groupPackages.length} onClick={()=>{ const v=name.trim(); if(!v||!pkgId) return; addGroup({ name:v, packageId:pkgId }); setName(''); setPkgId(''); }}>Create Group</button>
    </div>
    {groupPackages.length ? null : <div className="hint" style={{marginTop:8}}>No packages yet. Add one in Settings → Packages first.</div>}

    <div style={{display:'flex',flexDirection:'column',gap:12,marginTop:16}}>
      {groups.length ? groups.map(g => {
        const pkg = g.packageId ? packageById(g.packageId) : null;
        const members = membersByGroup[g.id] || [];
        const b = groupBilling(pkg, members.length);
        const chip = statusChip(b);
        const candidates = students.filter(s => !s.familyGroupId);
        return <div className="gb-card" key={g.id}>
          <div className="gb-head">
            <div style={{minWidth:0}}>
              <div style={{fontWeight:800,fontSize:15}}>👪 {g.name}</div>
              <div className="small subtle">{pkg ? (pkg.is_group
                ? `${pkg.name}${pkg.pax!=null?` · needs ${pkg.pax} pax`:''}${pkg.amount!=null?` · RM${pkg.amount} bundle`:''}${pkg.fallback_per_pax!=null?` · RM${pkg.fallback_per_pax}/pax standard`:''}`
                : `${pkg.name}${pkg.pax!=null?` · up to ${pkg.pax} pax`:''}${pkg.amount!=null?` · RM${pkg.amount}`:''}${(pkg.billing_mode==='credit'&&pkg.billing_count!=null)?` · ${pkg.billing_count} credits`:''}`) : 'No package linked'}</div>
            </div>
            <div style={{display:'flex',gap:6,flexShrink:0}}>
              <button className="btn btn-ghost small" onClick={()=>setEditId(editId===g.id?null:g.id)}>{editId===g.id?'Close':'Edit'}</button>
              <button className="btn btn-danger small" onClick={()=>deleteGroup(g)}>Delete</button>
            </div>
          </div>

          <div className={`gb-status ${chip.cls}`}>{chip.text}</div>

          {editId===g.id ? <div className="gb-edit">
            <div style={{display:'flex',gap:10,alignItems:'flex-end',flexWrap:'wrap'}}>
              <div className="field" style={{margin:0,flex:1,minWidth:180}}><label>Group name</label><input className="input" defaultValue={g.name} onBlur={e=>{ const v=e.target.value.trim(); if(v && v!==g.name) updateGroup(g.id,{name:v}); }} /></div>
              <div className="field" style={{margin:0,minWidth:180}}><label>Package</label><select className="select" value={g.packageId||''} onChange={e=>updateGroup(g.id,{packageId:e.target.value||null})}><option value="">(none)</option>{packageOptionGroups(groupPackages.filter(p=>p.pax>1), lessonTypes)}</select></div>
            </div>
            <div className="hint" style={{marginTop:6}}>Group name saves when you click away.</div>
          </div> : null}

          <div className="gb-members">
            {members.length ? members.map(m => { const classes = (scheduleByStudent[m.id]||[]).length; return <div className="gb-member" key={m.id}>
              <div style={{minWidth:0}}><span style={{fontWeight:700}}>{m.name}</span>{m.age!=null?<span className="subtle"> · {m.age}y</span>:null} <span className={classes? 'subtle small':'gb-noclass'}>{classes ? `· in ${classes} class${classes===1?'':'es'}` : '· ⚠ not in any class'}</span></div>
              <button className="btn btn-ghost small" onClick={()=>setStudentGroup(m.id, null)}>Remove</button>
            </div>; }) : <div className="subtle small" style={{padding:'4px 0'}}>No members yet.</div>}
          </div>

          <div className="gb-add">
            <span className="small subtle">Add member:</span>
            <div style={{flex:1,minWidth:180}}>
              <StudentSelect valueId={null} fallbackLabel={null} studentById={{}} candidates={candidates} onPick={(stu)=>{ if(stu) setStudentGroup(stu.id, g.id); }} conflict={null} />
            </div>
          </div>
        </div>;
      }) : <div className="empty">No family groups yet.</div>}
    </div>
  </div>;
}

function StudentsView({ students, lessonTypes, lessonTypeById, packages, packageById, groupById, scheduleByStudent, creditByKey, addStudent, updateStudent, deleteStudent }){
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
  const [q, setQ] = useState('');
  const [sortBy, setSortBy] = useState('name');
  const [formExpanded, setFormExpanded] = useState(false);

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

  const COLS = 8;

  function resetForm(){ setName(''); setDob(''); setGender(null); setEnrollments([{ lessonTypeId: '', packageId: '' }]); setGuardianName(''); setGuardianEmail(''); setGuardianPhone(''); setSameAsGuardian(false); setEmergencyPhone(''); setEmergencyRel(''); setAdultSelf(false); }

  return <>
    <div className="card intake-banner" style={{marginBottom:16}}>
      <div className="intake-banner-inner">
        <div className="intake-banner-icon" aria-hidden="true">🏊</div>
        <div className="intake-banner-text">
          <div className="intake-banner-title">Parent Intake Form</div>
          <div className="intake-banner-sub">Open a clean registration page on this tablet for parents to fill in their own details. Submitted swimmers appear here automatically.</div>
        </div>
        <button type="button" className="btn btn-primary intake-banner-btn" onClick={()=>window.open('./intake.html', '_blank', 'noopener,noreferrer')} title="Opens the parent intake form in a new tab — hand the tablet over and tap 'Register Another Family' when done">
          Open Form <span aria-hidden="true" style={{marginLeft:6}}>↗</span>
        </button>
      </div>
    </div>
    <div className={`card register-card ${formExpanded ? 'is-open' : 'is-closed'}`} style={{marginBottom:16}}>
      <button type="button" className="register-header" onClick={()=>setFormExpanded(v=>!v)} aria-expanded={formExpanded}>
        <div className="register-header-left">
          <span className="register-header-icon" aria-hidden="true">{formExpanded ? '✕' : '+'}</span>
          <span className="register-header-title">Register Swimmer</span>
          {!formExpanded && <span className="small subtle register-header-hint">Click to expand the registration form</span>}
        </div>
        <span className="register-header-chev" aria-hidden="true">{formExpanded ? '▴' : '▾'}</span>
      </button>
      {formExpanded && <div className="register-body">
        <div className="small subtle" style={{marginBottom:16}}>Complete the swimmer's profile. All information is treated in strict confidence and used solely for class administration and emergency purposes.</div>

        <div className="student-form-section">
          <div className="student-form-section-title">Swimmer Details</div>
          <div className="form-grid" style={{gridTemplateColumns:'1.3fr auto 84px auto'}}>
            <div className="field" style={{margin:0}}><label>Full Name</label><input className="input" value={name} onChange={e=>{ setName(e.target.value); if(adultSelf) setGuardianName(e.target.value); }} placeholder="Swimmer's full name" /></div>
            <div className="field" style={{margin:0}}><label>Date of Birth</label><input className="input" type="date" value={dob} max={todayStr()} onChange={e=>setDob(e.target.value)} /></div>
            <div className="field" style={{margin:0}}><label>Age</label><div className={`age-display ${dob?'':'is-empty'}`} aria-label="Auto-calculated age">{ageDisplay(dob ? ageFromDob(dob) : null)}</div></div>
            <div className="field" style={{margin:0}}>
              <label>Gender</label>
              <div className="gender-toggle"><button type="button" className={`gender-opt ${gender==='female'?'active':''}`} onClick={()=>setGender(gender==='female'?null:'female')}>♀ F</button><button type="button" className={`gender-opt ${gender==='male'?'active':''}`} onClick={()=>setGender(gender==='male'?null:'male')}>♂ M</button></div>
            </div>
          </div>
        </div>

        <div className="student-form-section">
          <div className="student-form-section-title">Lessons</div>
          <LessonsEditor enrollments={enrollments} setEnrollments={setEnrollments} lessonTypes={lessonTypes} packages={packages} />
        </div>

        <div className="student-form-section">
          <div className="student-form-section-title">Parent / Guardian</div>
          <label className="gb-check" style={{marginBottom:10,display:'inline-flex',gap:8,alignItems:'center'}}><input type="checkbox" checked={adultSelf} onChange={e=>handleAdultSelf(e.target.checked)} /> Adult swimmer — I am my own guardian</label>
          <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr 1fr'}}>
            <div className="field" style={{margin:0}}><label>Guardian Name</label><input className="input" value={guardianName} onChange={e=>setGuardianName(e.target.value)} placeholder="Full name" /></div>
            <div className="field" style={{margin:0}}><label>Email</label><input className="input" type="email" value={guardianEmail} onChange={e=>setGuardianEmail(e.target.value)} placeholder="email@example.com" /></div>
            <div className="field" style={{margin:0}}><label>Phone</label><input className="input" type="tel" value={guardianPhone} onChange={e=>{ setGuardianPhone(e.target.value); if(sameAsGuardian) setEmergencyPhone(e.target.value); }} placeholder="+60 1X-XXXXXXX" /></div>
          </div>
        </div>

        <div className="student-form-section">
          <div className="student-form-section-title">Emergency Contact</div>
          <label className="gb-check" style={{marginBottom:10,display:'inline-flex',gap:8,alignItems:'center'}}><input type="checkbox" checked={sameAsGuardian} onChange={e=>handleSameAsG(e.target.checked)} /> Same as Parent / Guardian</label>
          <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr'}}>
            <div className="field" style={{margin:0}}><label>Phone</label><input className="input" type="tel" value={sameAsGuardian?guardianPhone:emergencyPhone} onChange={e=>setEmergencyPhone(e.target.value)} disabled={sameAsGuardian} placeholder="+60 1X-XXXXXXX" /></div>
            <div className="field" style={{margin:0}}><label>Relationship</label><input className="input" value={sameAsGuardian?'Parent / Guardian':emergencyRel} onChange={e=>setEmergencyRel(e.target.value)} disabled={sameAsGuardian} placeholder="e.g. Mother, Father, Spouse" /></div>
          </div>
        </div>

        <div style={{display:'flex',justifyContent:'flex-end',gap:8,marginTop:8}}>
          <button className="btn btn-ghost" onClick={resetForm}>Clear</button>
          <button className="btn btn-primary" onClick={()=>{
            const v = name.trim(); if(!v) return;
            addStudent({ name:v, dateOfBirth: dob || null, gender, enrollments, guardianName, guardianEmail, guardianPhone, emergencySameAsGuardian:sameAsGuardian, emergencyPhone:sameAsGuardian?guardianPhone:emergencyPhone, emergencyRelationship:sameAsGuardian?'Parent / Guardian':emergencyRel });
            resetForm();
            setFormExpanded(false);
          }}>Register Swimmer</button>
        </div>
      </div>}
    </div>

    <div className="card">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,flexWrap:'wrap',marginBottom:12}}>
        <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
          <div style={{fontSize:16,fontWeight:800}}>Registered Swimmers <span className="subtle" style={{fontWeight:600,fontSize:13}}>· {students.length}</span></div>
          <div className="sort-tabs">{[['name','Name'],['type','Lesson Type'],['package','Package']].map(([k,lbl])=><button key={k} className={`sort-tab ${sortBy===k?'active':''}`} onClick={()=>setSortBy(k)}>{lbl}</button>)}</div>
        </div>
        <input className="input" style={{maxWidth:220}} placeholder="Search swimmers…" value={q} onChange={e=>setQ(e.target.value)} />
      </div>
      <div className="table-wrap">
        <table><thead><tr>
          <th style={{width:'17%'}}>Name</th><th style={{width:40}}>Age</th><th style={{width:'15%'}}>Lesson Type</th><th style={{width:'15%'}}>Package</th><th style={{width:'8%'}}>Credits</th><th style={{width:'8%'}}>T&amp;C</th><th>Schedule</th><th style={{width:112}}></th>
        </tr></thead>
        <tbody>{displayList.length ? displayList.map((row,ri)=>{
          if(row.kind==='group') return <tr key={`g-${row.gid}`} className="swimmer-group-header"><td colSpan={COLS}><span className="group-header-label">👪 {row.label}</span></td></tr>;
          const s=row.s; const sched=scheduleLines(s.id); const cr=creditInfo(s); const afterWeek=cr?Math.max(0,cr.remaining-cr.scheduled):null;
          const tcOk = !!s.tcAcceptedAt;
          return <React.Fragment key={s.id}>
            <tr className={s.familyGroupId?'swimmer-in-group':''}>
              <td style={{fontWeight:700}}>{s.name}{s.gender?<span style={{marginLeft:4,fontSize:10,color:'var(--text-3)'}}>{s.gender==='female'?'♀':'♂'}</span>:null}</td>
              <td>{s.age!=null?s.age:'—'}</td>
              <td><div style={{display:'flex',flexWrap:'wrap',gap:3}}>{(s.lessonTypeIds||[]).length?s.lessonTypeIds.map(id=>{const c=colorsForId(id);return <span key={id} className="chip" style={{background:c.bg,borderColor:c.bd,color:c.tx,fontSize:10,padding:'2px 7px'}}>{c.name}</span>;}): <span className="subtle">—</span>}</div></td>
              <td style={{fontSize:12}}>{packageLabel(s)}</td>
              <td>{cr?<div className="credit-cell"><span className={`credit-cell-num ${afterWeek<=2?'credit-low':''}`}>{afterWeek}</span><span className="credit-cell-sub">{cr.remaining}/{cr.initial}{cr.scheduled>0?<> · <span style={{color:'var(--amber-tx)'}}>−{cr.scheduled} wk</span></>:null}</span></div>:<span className="subtle">—</span>}</td>
              <td>{tcOk?<span className="tc-badge-ok" title={`Accepted ${new Date(s.tcAcceptedAt).toLocaleDateString()} · ID: ${s.tcAcceptanceId}`}>✅ Signed</span>:<span className="tc-badge-pending" title="Terms & Conditions not yet accepted">⚠ Pending</span>}</td>
              <td style={{fontSize:11}}>{sched?sched.map((g,gi)=><div key={gi} style={{marginBottom:2}}><span style={{fontWeight:700}}>{g.type}:</span> <span className="subtle">{g.times.join(', ')}</span></div>):<span className="subtle">Not scheduled</span>}</td>
              <td><div style={{display:'flex',gap:6,justifyContent:'flex-end'}}><button className="btn btn-ghost small" onClick={()=>setEditId(editId===s.id?null:s.id)}>{editId===s.id?'Close':'Edit'}</button><button className="btn btn-danger small" onClick={()=>deleteStudent(s)}>Delete</button></div></td>
            </tr>
            {editId===s.id?<tr><td colSpan={COLS} style={{padding:0}}><StudentEditor row={s} lessonTypes={lessonTypes} packages={packages} onSave={(patch)=>{updateStudent(s.id,patch);setEditId(null);}}/></td></tr>:null}
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
  { h: '8. Health, Safety & Medical Disclosure', body: `8.1 You confirm that the swimmer is in good health and is medically fit to participate in aquatic activities. Any pre-existing medical condition, allergy, or physical limitation must be disclosed to the School prior to the commencement of classes.\n\n8.2 The School is not liable for injuries or health events arising from undisclosed medical conditions.\n\n8.3 In the event of a medical emergency, the School is authorised to administer basic first aid and to contact emergency services. All reasonable effort will be made to contact the designated emergency contact immediately.` },
  { h: '9. Liability Waiver', body: `9.1 Participation in aquatic activities carries inherent risks. By accepting this Agreement, you acknowledge these risks and agree that ${TC_COMPANY}, its directors, instructors, and staff shall not be liable for any injury, loss, damage, or claim arising from participation in the School's programmes, except where caused by the School's gross negligence or wilful misconduct.\n\n9.2 The School maintains appropriate public liability insurance.` },
  { h: '10. Acceptance & Governing Law', body: `This Agreement is governed by the laws of Malaysia. Any dispute shall be subject to the jurisdiction of the courts of Malaysia. By electronically accepting, you confirm you have read and agree to all clauses above on behalf of yourself and/or the enrolled swimmer.` }
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

function SessionModal({ modal, setModal, saveBusy, saveSession, deleteSession, openAddAtTime, instructors, lessonTypes, pools, lessonTypeByName, poolById, students, studentById, weekEnrollments, familyGroups, membersByGroup, trialStudentIds, creditByKey, adjustCredit, initCredit, pendingByKey, replacementPending, markForReplacement, forwardClassToNextWeek, startFullClassMove }){
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [cancelClassOpen, setCancelClassOpen] = useState(false);
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
  function removeRow(i){ const rows = (modal.form.studentRows || []).slice(); rows.splice(i, 1); if(!rows.length) rows.push({ studentId:null, name:'', age:'', remark:'', attendance:'pending' }); setForm({ studentRows: rows }); }

  function onInstructorChange(id){
    const inst = instructors.find(i => i.id === id);
    setForm({ instructorId: id || null, instructorName: inst?.name || '' });
  }

  // Pick a swimmer into a slot from the registry; snapshot name+age. null clears.
  function pickStudent(i, student){
    const rows = (modal.form.studentRows || []).slice();
    const keepRemark = student ? (rows[i]?.remark || '') : '';
    const keepAtt = student ? (rows[i]?.attendance || 'pending') : 'pending';
    rows[i] = student ? { studentId: student.id, name: student.name, age: (student.age === null || student.age === undefined ? '' : String(student.age)), remark: keepRemark, attendance: keepAtt } : { studentId:null, name:'', age:'', remark:'', attendance:'pending' };
    setForm({ studentRows: rows });
  }
  function setRemark(i, val){ const rows = (modal.form.studentRows || []).slice(); rows[i] = { ...rows[i], remark: val }; setForm({ studentRows: rows }); }
  function setAttendance(i, val){ const rows = (modal.form.studentRows || []).slice(); rows[i] = { ...rows[i], attendance: val }; setForm({ studentRows: rows }); }
  function setReplAttendance(i, val){ const rows = (modal.form.replacementRows || []).slice(); rows[i] = { ...rows[i], attendance: val }; setForm({ replacementRows: rows }); }

  // Bind this session to a family group and drop ALL its members into the slots
  // at once (padded to the lesson-type ratio). groupId '' clears the binding.
  function chooseGroup(groupId){
    if(!groupId){ setForm({ familyGroupId: null }); return; }
    const members = (membersByGroup && membersByGroup[groupId]) || [];
    const cap = previewLt?.students_per_instructor ? Number(previewLt.students_per_instructor) : 0;
    const rows = members.map(m => ({ studentId:m.id, name:m.name, age:(m.age === null || m.age === undefined ? '' : String(m.age)) }));
    const target = Math.max(cap || 0, rows.length, 1);
    while(rows.length < target) rows.push({ studentId:null, name:'', age:'' });
    setForm({ familyGroupId: groupId, studentRows: rows });
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
  const lessonTypeId = previewLt?.id || modal?.form?.lessonTypeId || null;
  const inBucket = (students || []).filter(s => s.isActive !== false && lessonTypeId && (s.lessonTypeIds || []).includes(lessonTypeId));
  const candidates = inBucket.length ? inBucket : (students || []).filter(s => s.isActive !== false);
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
      <div>
        <div style={{fontSize:18,fontWeight:800}}>{modal.id ? 'Edit' : 'Add'} Scheduled Session</div>
        <div className="small subtle">{modal.weekStartDate} · {DAYS_F[modal.day]} · {minuteToTime(modal.startMinute)}{previewPool ? ` · ${previewPool.name}` : ''}</div>
      </div>
      <button className="btn btn-ghost" onClick={() => setModal(null)}>Close</button>
    </div>
    <div className="modal-body">
      <div className="form-grid">
        <div className="field"><label>Lesson Type</label><select className="select" value={modal.form.type} onChange={(e)=>onTypeChange(e.target.value)}>{lessonTypes.map(x => <option key={x.id} value={x.name}>{x.name}</option>)}</select></div>
        <div className="field"><label>Pool</label><select className="select" value={modal.form.poolId || ''} onChange={(e)=>setForm({ poolId: e.target.value || null })}><option value="">(no pool)</option>{pools.map(p => <option key={p.id} value={p.id}>{p.name} · cap {p.capacity_total}</option>)}</select></div>
        <div className="field"><label>Instructor</label><select className="select" value={modal.form.instructorId || ''} onChange={(e)=>onInstructorChange(e.target.value)}><option value="">(unassigned)</option>{instructors.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
        <div className="field"><label>Duration (minutes)</label><select className="select" value={String(modal.form.durationMinutes)} onChange={(e)=>setForm({ durationMinutes: Number(e.target.value) })}>{durationOptions.map(d => <option key={d} value={d}>{d} min</option>)}</select></div>
        <div className="field"><label>Time Slot</label><input className="input" value={formatRange(modal.startMinute, modal.form.durationMinutes)} readOnly /></div>
        <div className="field"><label>Capacity Preview</label><div className="cap-preview"><span className="cap-chip cap-chip-lg" style={{background:previewChip.bg,color:previewChip.tx,borderColor:previewChip.bd}}>{previewStudents}{previewMax > 0 ? ` / ${previewMax}` : ''}</span><span className="small subtle">{previewMax > 0 ? (previewStatus==='over'?'Over capacity — Module 3 will block or prompt for a split.':previewStatus==='full'?'At capacity.':previewStatus==='tight'?'Near capacity.':'Has room.') : 'Lesson type has no ratio set.'}</span></div></div>
        <div className="field" style={{gridColumn:'1 / -1'}}>
          <label>Family group <span className="subtle" style={{textTransform:'none',letterSpacing:0,fontWeight:600}}>· optional — fills all members into this class</span></label>
          <select className="select" value={modal.form.familyGroupId || ''} onChange={(e)=>chooseGroup(e.target.value)}>
            <option value="">No group (enroll individually)</option>
            {(familyGroups || []).map(g => <option key={g.id} value={g.id}>{g.name}{(membersByGroup && membersByGroup[g.id]) ? ` · ${membersByGroup[g.id].length} member${membersByGroup[g.id].length===1?'':'s'}` : ''}</option>)}
          </select>
          {modal.form.familyGroupId ? <div className="hint" style={{marginTop:5}}>👪 Bound to this group. Its members are placed below — change a slot to override, or set “No group” to unbind.</div> : null}
        </div>
        <div className="field" style={{gridColumn:'1 / -1'}}>
          <label>Swimmers {previewMax > 0 ? `· ${previewMax} slots (max for this type)` : ''}</label>
          <div className="stu-list">
            {(modal.form.studentRows || []).map((r, i) => {
              const isTrial = !!(r.studentId && trialStudentIds && trialStudentIds.has(r.studentId));
              const wk = modal.weekStartDate;
              const ltId = currentLt?.id;
              const isPending = !!(r.studentId && ltId && pendingByKey && pendingByKey[`${r.studentId}:${ltId}:${wk}`]);
              const canMarkReplacement = !isPersonal && r.studentId && modal.id && currentLt && !isPending;
              return <div className="stu-row" key={i}>
                <span className="stu-num">{i+1}</span>
                <div className="stu-fields">
                  <StudentSelect valueId={r.studentId} fallbackLabel={r.studentId ? null : (r.name ? `${r.name}${r.age ? ` (${r.age})` : ''}` : '')} studentById={studentById} candidates={candidates} onPick={(stu)=>pickStudent(i, stu)} conflict={rowConflict(r, i)} trialStudentIds={trialStudentIds} pendingByKey={pendingByKey} weekStartDate={wk} lessonTypeId={ltId} />
                  {isTrial ? <span className="trial-pill" title="This swimmer is on a Trial package — one-off booking that won't carry over when duplicating weeks.">trial</span> : null}
                  {canMarkReplacement ? <button type="button" className="repl-mark-btn" title="Move this swimmer out for replacement — they will become a candidate in other same-type classes this week" onClick={async ()=>{
                    const ok = await markForReplacement({ studentId:r.studentId, sessionId:modal.id, weekStartDate:wk, lessonTypeId:ltId, lessonTypeName:currentLt.name, day:modal.day, startMinute:modal.startMinute });
                    if(ok){ /* row is gone from DB after loadSessions; close modal so user sees fresh data */ setModal(null); }
                  }}>→ R</button> : null}
                  {(r.studentId || (r.name || '').trim()) ? <div className="att-seg" role="group" aria-label="Attendance">
                    <button type="button" className={`att-btn att-pending ${(r.attendance||'pending')==='pending'?'is-on':''}`} onClick={()=>setAttendance(i,'pending')} title="Not yet marked — credit untouched">⏳</button>
                    <button type="button" className={`att-btn att-attended ${r.attendance==='attended'?'is-on':''}`} onClick={()=>setAttendance(i,'attended')} title="Attended — lesson delivered (−1 credit on save)">✓</button>
                    <button type="button" className={`att-btn att-absent ${r.attendance==='absent'?'is-on':''}`} onClick={()=>setAttendance(i,'absent')} title="Absent — counts as a delivered lesson, no replacement entitled (−1 credit on save)">✗</button>
                  </div> : null}
                  <input className="input stu-remark" placeholder="Remark (optional)" value={r.remark || ''} onChange={(e)=>setRemark(i, e.target.value)} />
                </div>
              </div>;
            })}
          </div>
          <div className="hint" style={{marginTop:8}}>{bucketFallback ? 'No swimmers tagged for this lesson type yet — showing all. Tag them in the Swimmers tab.' : 'Slots are fixed to the lesson type’s maximum. Leave a slot empty to skip it, or clear a slot with its ×.'}</div>
        </div>
      </div>
      <div className="student-box"><div className="small subtle" style={{marginBottom:6}}>Parallel sessions and splits</div><div className="small">Multiple sessions can run at the same day and time. Each is one row in <b>weekly_sessions</b>; pools are independent.</div></div>

      {/* ── GROUP: drop-in replacement section ── */}
      {!isPersonal && <div className="repl-section">
        <div className="repl-section-head">
          <div>
            <span className="repl-section-title">Replacement Students</span>
            <span className="small subtle" style={{marginLeft:8}}>One-off this week — not carried forward on duplicate</span>
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
          const isTrialRow = !!(r.studentId && trialStudentIds && trialStudentIds.has(r.studentId));
          const replCandidates = students.filter(s => !(modal.form.studentRows || []).some(sr => sr.studentId === s.id) && !(modal.form.replacementRows || []).some((rr,ri) => ri !== i && rr.studentId === s.id));
          return <div key={i} className="repl-row">
            <span className="repl-badge-sm">R</span>
            <div style={{flex:'1.5',minWidth:0,position:'relative'}}>
              <StudentSelect valueId={r.studentId} fallbackLabel={r.name||''} studentById={studentById} candidates={replCandidates} onPick={(stu)=>{
                const rows=[...(modal.form.replacementRows||[])];
                const pendingHit = stu && ltId && pendingByKey && pendingByKey[`${stu.id}:${ltId}:${wk}`];
                rows[i]={ ...rows[i], studentId:stu?.id||null, name:stu?.name||'', age:stu?.age??null, replacementFrom: pendingHit ? pendingHit.original_session_label : (trialStudentIds && stu && trialStudentIds.has(stu.id) ? '(trial)' : rows[i].replacementFrom) };
                setModal({...modal,form:{...modal.form,replacementRows:rows}});
              }} conflict={null} trialStudentIds={trialStudentIds} pendingByKey={pendingByKey} weekStartDate={wk} lessonTypeId={ltId} />
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
          <div className="hint" style={{gridColumn:'1/-1',marginTop:0}}>The class returns to its original slot from next week onwards. Any duplicate of this week will restore the canonical schedule.</div>
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
          return <div key={r.studentId||i} className="credit-row">
            <span className="credit-row-name">{r.name || 'Student'}</span>
            {bal
              ? <div className="credit-controls">
                  <span className={`credit-count ${bal.remaining_balance<=2?'credit-low':''}`}>{bal.remaining_balance} / {bal.initial_balance} credits</span>
                  <button className="credit-btn" title="Deduct 1 credit (class attended)" onClick={()=>adjustCredit(r.studentId,currentLt.id,-1)}>−</button>
                  <button className="credit-btn" title="Add 1 credit (credit returned)" onClick={()=>adjustCredit(r.studentId,currentLt.id,+1)}>+</button>
                </div>
              : <div className="credit-init">
                  <input className="input" style={{width:80,fontSize:12}} type="number" min="1" placeholder="Credits" value={initCreditInput[r.studentId]||4} onChange={(e)=>setInitCreditInput(prev=>({...prev,[r.studentId]:e.target.value}))} />
                  <button className="btn btn-ghost small" onClick={()=>{ const n=initCreditInput[r.studentId]||4; if(n) initCredit(r.studentId,currentLt?.id,n); }}>Set initial</button>
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
              <div className="cancel-class-opt-sub">Cancel this week's session entirely. Swimmers attend the same slot next week as usual. Credits preserved.</div>
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

      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:16,gap:12,flexWrap:'wrap'}}>
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          {modal.id ? <button className="btn btn-danger" onClick={deleteSession}>Delete Session</button> : null}
          <button className="btn btn-ghost" onClick={() => openAddAtTime(modal.day, modal.startMinute, modal.form.poolId)}>+ Add Another Session Same Time</button>
        </div>
        <button className="btn btn-primary" onClick={saveSession}>{saveBusy ? 'Saving...' : 'Save Session'}</button>
      </div>
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

ReactDOM.createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>);
