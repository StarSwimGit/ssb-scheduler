const { useState } = React;

// ── Supabase REST helpers (mirrors app.js — kept self-contained so this
// page can be served independently of the admin SPA) ──
const cfg = window.APP_CONFIG || {};
const BASE_HEADERS = {
  apikey: cfg.supabaseAnonKey || '',
  Authorization: `Bearer ${cfg.supabaseAnonKey || ''}`,
  'Content-Type': 'application/json'
};
async function rest(path, opts = {}){
  const merged = { ...BASE_HEADERS, ...(opts.headers || {}) };
  const res = await fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, { ...opts, headers: merged });
  const txt = await res.text();
  if(!res.ok) throw new Error(txt || `HTTP ${res.status}`);
  return txt ? JSON.parse(txt) : null;
}
async function insertRows(table, payload){
  return rest(`${table}?select=*`, { method:'POST', headers:{ Prefer:'return=representation' }, body: JSON.stringify(Array.isArray(payload)?payload:[payload]) });
}
async function patchRows(table, match, payload){
  const q = Object.entries(match).map(([k,v]) => `&${encodeURIComponent(k)}=eq.${encodeURIComponent(v)}`).join('');
  return rest(`${table}?select=*${q}`, { method:'PATCH', headers:{ Prefer:'return=representation' }, body: JSON.stringify(payload) });
}

// ── Date / age helpers (must match app.js logic so the admin app sees
// the same computed age that's shown on this form) ──
function fromDateStr(s){ const [y,m,d] = (s||'').split('-').map(Number); return new Date(y,(m||1)-1,d||1); }
function todayStr(){ const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function ageMonthsFromDob(dob){
  if(!dob) return null;
  try{
    const d = fromDateStr(dob);
    const now = new Date();
    let m = (now.getFullYear()-d.getFullYear())*12 + (now.getMonth()-d.getMonth());
    if(now.getDate() < d.getDate()) m--;
    return Math.max(0, m);
  } catch(_){ return null; }
}
function ageFromDob(dob){
  const m = ageMonthsFromDob(dob);
  if(m == null) return null;
  if(m < 60) return Math.floor(m/6)/2;
  return Math.floor(m/12);
}
function ageDisplay(age){
  if(age === null || age === undefined || age === '') return '—';
  return `${age}y`;
}

// ── Terms & Conditions content — mirror of app.js's TC_CONTENT. Kept in
// sync manually; both files import nothing else, so duplication is the
// simplest dependency-free choice for a static-hosted page. ──
const TC_COMPANY = 'Star Swim Sdn Bhd';
const TC_CONTENT = [
  { h: '1. Introduction', body: `These Terms and Conditions ("Agreement") govern the enrolment and participation of swimmers in swimming lessons and aquatic programmes offered by ${TC_COMPANY} ("the School", "we", "our"). By accepting this Agreement, the parent, legal guardian, or adult swimmer ("you") acknowledges having read, understood, and agreed to be bound by these terms.` },
  { h: '2. Safeguarding & Child Protection', body: `${TC_COMPANY} is committed to providing a safe, inclusive, and supportive aquatic environment for all participants.\n\n2.1 The School adheres to the National Child Protection Principles and Malaysia's Child Act 2001. All instructors undergo background screening and hold current first aid and lifeguard certifications.\n\n2.2 Parents and guardians are required to remain within the facility premises during all sessions involving participants under 12 years of age, unless otherwise agreed in writing.\n\n2.3 Any concerns regarding the welfare of a child, safeguarding issues, or inappropriate conduct should be raised immediately with the School Administrator or reported to: Jabatan Kebajikan Masyarakat (Social Welfare Department) at 1-800-88-3900.\n\n2.4 Photography and video recording of any swimmer — including your own child — are prohibited within pool areas without prior written consent from ${TC_COMPANY} and the relevant guardian of every swimmer present.` },
  { h: '3. Class Cancellation & Attendance Policy', body: `3.1 Advance Notice: Cancellations must be communicated to the School no less than twenty-four (24) hours before the scheduled class start time. Cancellations received within this 24-hour window will be treated as an Absence unless a valid emergency and accompanying proof are provided.\n\n3.2 Medical Cancellation: Absences due to illness or medical conditions will be considered valid cancellations provided the School receives a copy of a certified Medical Certificate (MC) issued by a registered medical practitioner within 48 hours of the missed class. On receipt of a valid MC, the swimmer is entitled to one (1) replacement class.\n\n3.3 Absence (No Replacement): Where a swimmer is absent without valid 24-hour prior notice or a valid MC, the class will be recorded as "provided," credits will be deducted where applicable, and no replacement lesson will be offered.` },
  { h: '4. School-Initiated Cancellations', body: `4.1 Weather Conditions: Classes may be suspended or cancelled at the School's sole discretion during adverse weather. Participants will be notified as promptly as possible. Any class cancelled due to weather entitles the swimmer to a full replacement lesson at no additional cost.\n\n4.2 Instructor Cancellation: Should a class be cancelled by ${TC_COMPANY} or by an assigned instructor for reasons within the School's control, all affected swimmers are entitled to a replacement lesson.` },
  { h: '5. Replacement Class Policy', body: `5.1 Group Classes: Replacement sessions for group classes may be attended in any currently active class of the same lesson type, provided a slot is available.\n\n5.2 Personal & Private Classes: Replacement sessions for personal classes are to be arranged directly between the assigned instructor and the parent or guardian, subject to mutual time availability and pool space.\n\n5.3 Validity: Replacement lessons must be utilised within 14 calendar days of the missed class, unless otherwise agreed in writing.` },
  { h: '6. Credit System', body: `6.1 Students enrolled in personal or private lesson programmes are allocated a credit balance corresponding to the number of sessions purchased in their package.\n\n6.2 One (1) credit is deducted for each scheduled and attended class. Credits are not deducted for classes cancelled by the School or for classes where a valid MC has been provided.\n\n6.3 Credits are non-refundable and non-transferable to another swimmer. Unused credits at the end of a package cycle are forfeited unless otherwise agreed in writing.` },
  { h: '7. Health, Safety & Medical Disclosure', body: `7.1 You confirm that the swimmer is in good health and is medically fit to participate in aquatic activities. Any pre-existing medical condition, allergy, or physical limitation must be disclosed to the School prior to the commencement of classes.\n\n7.2 In the event of a medical emergency, the School is authorised to administer basic first aid and to contact emergency services. All reasonable effort will be made to contact the designated emergency contact immediately.` },
  { h: '8. Liability Waiver', body: `8.1 Participation in aquatic activities carries inherent risks. By accepting this Agreement, you acknowledge these risks and agree that ${TC_COMPANY}, its directors, instructors, and staff shall not be liable for any injury, loss, damage, or claim arising from participation in the School's programmes, except where caused by the School's gross negligence or wilful misconduct.` },
  { h: '9. Acceptance & Governing Law', body: `This Agreement is governed by the laws of Malaysia. By electronically accepting, you confirm you have read and agree to all clauses above on behalf of yourself and/or the enrolled swimmer.` }
];

function IntakeForm(){
  // Parent / guardian (shared across all children registered in this submission)
  const [gName, setGName] = useState('');
  const [gEmail, setGEmail] = useState('');
  const [gPhone, setGPhone] = useState('');

  // Children — array of { name, dob, gender }. Always at least one row.
  const [children, setChildren] = useState([{ name:'', dob:'', gender:null }]);

  // Emergency contact — when sameAsGuardian, the three fields below are
  // disabled and the form submits the guardian's name/phone instead.
  const [sameAsGuardian, setSameAsGuardian] = useState(false);
  const [eName, setEName] = useState('');
  const [ePhone, setEPhone] = useState('');
  const [eRel, setERel] = useState('');

  const [tcOpen, setTcOpen] = useState(false);
  const [tcAccepted, setTcAccepted] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null); // { guardianName, children: [...] }

  function setChildAt(i, field, val){ setChildren(cs => cs.map((c,j) => j===i?{...c,[field]:val}:c)); }
  function addChild(){ setChildren(cs => [...cs, { name:'', dob:'', gender:null }]); }
  function removeChild(i){ setChildren(cs => cs.length>1 ? cs.filter((_,j)=>j!==i) : cs); }

  function validate(){
    if(!gName.trim()) return 'Please enter the parent or guardian name.';
    if(!gEmail.trim() || !/^\S+@\S+\.\S+$/.test(gEmail.trim())) return 'Please enter a valid email address.';
    if(!gPhone.trim()) return 'Please enter a phone number for the parent or guardian.';
    for(let i=0;i<children.length;i++){
      const c = children[i];
      if(!c.name.trim()) return `Please enter swimmer ${i+1}'s full name.`;
      if(!c.dob) return `Please enter swimmer ${i+1}'s date of birth.`;
      if(!c.gender) return `Please pick swimmer ${i+1}'s gender.`;
    }
    if(!sameAsGuardian){
      if(!eName.trim()) return 'Please enter an emergency contact name (or check "Same as Parent/Guardian").';
      if(!ePhone.trim()) return 'Please enter an emergency contact phone (or check "Same as Parent/Guardian").';
      if(!eRel.trim()) return 'Please enter the emergency contact relationship (or check "Same as Parent/Guardian").';
    }
    if(!tcAccepted) return 'Please read and accept the Terms & Conditions to submit.';
    return null;
  }

  async function handleSubmit(){
    const errMsg = validate();
    if(errMsg){ setErr(errMsg); return; }
    if(submitting) return;
    if(!cfg.supabaseUrl || !cfg.supabaseAnonKey){ setErr('Server not configured — please contact the school administrator.'); return; }
    setErr(''); setSubmitting(true);
    try{
      const emergencyName  = sameAsGuardian ? gName.trim() : eName.trim();
      const emergencyPhone = sameAsGuardian ? gPhone.trim() : ePhone.trim();
      const emergencyRel   = sameAsGuardian ? 'Parent / Guardian' : eRel.trim();

      const registered = [];
      for(const c of children){
        const dob = c.dob || null;
        const computedAge = dob ? ageFromDob(dob) : null;
        const inserted = await insertRows('students', {
          name: c.name.trim(),
          date_of_birth: dob,
          age: computedAge,
          gender: c.gender,
          is_active: true,
          guardian_name: gName.trim(),
          guardian_email: gEmail.trim(),
          guardian_phone: gPhone.trim(),
          emergency_name: emergencyName,
          emergency_phone: emergencyPhone,
          emergency_relationship: emergencyRel,
          emergency_same_as_guardian: !!sameAsGuardian,
          lesson_type_ids: []
        });
        const studentId = inserted?.[0]?.id;
        // Lock in T&C acceptance per student — one row per swimmer keyed to a
        // unique acceptance ID. Mirrors the existing TCView flow.
        if(studentId){
          const acceptanceId = `TC-${Date.now().toString(36).toUpperCase().slice(-7)}`;
          const acceptedAt = new Date().toISOString();
          try{
            await rest('tc_acceptances?on_conflict=student_id', {
              method:'POST',
              headers:{ Prefer:'return=representation,resolution=merge-duplicates' },
              body: JSON.stringify([{ student_id: studentId, acceptance_id: acceptanceId, accepted_at: acceptedAt, guardian_name: gName.trim(), guardian_email: gEmail.trim(), lesson_type_name: null }])
            });
            await patchRows('students', { id: studentId }, { tc_accepted_at: acceptedAt, tc_acceptance_id: acceptanceId });
          } catch(e){ console.warn('TC acceptance failed for', c.name, e); }
          registered.push({ name: c.name.trim(), age: computedAge, acceptanceId });
        }
      }
      setDone({ guardianName: gName.trim(), email: gEmail.trim(), children: registered });
      window.scrollTo({ top:0, behavior:'smooth' });
    } catch(e){
      setErr(e?.message || 'Submission failed. Please try again or hand the tablet back to the school administrator.');
    } finally {
      setSubmitting(false);
    }
  }

  function resetForm(){
    setGName(''); setGEmail(''); setGPhone('');
    setChildren([{ name:'', dob:'', gender:null }]);
    setSameAsGuardian(false); setEName(''); setEPhone(''); setERel('');
    setTcAccepted(false); setTcOpen(false);
    setErr(''); setDone(null);
    window.scrollTo({ top:0, behavior:'smooth' });
  }

  if(done){
    return <div className="page">
      <div className="success-card">
        <div className="success-icon">✅</div>
        <div className="success-title">Thank you, {done.guardianName}!</div>
        <div className="success-sub">We've received your registration. Star Swim will be in touch on <strong>{done.email}</strong> shortly to confirm your first lesson.</div>
        <div className="success-list">
          {done.children.map((c, i) => <div key={i} className="success-list-item">• {c.name} — {ageDisplay(c.age)} · T&C signed (ID: {c.acceptanceId})</div>)}
        </div>
        <div>
          <button className="success-reset" onClick={resetForm}>Register Another Family</button>
        </div>
      </div>
      <div className="footer-note">{TC_COMPANY} · Swimmer Registration</div>
    </div>;
  }

  return <div className="page">
    <div className="brand-card">
      <img src="./logo.png" alt="Star Swim Sdn Bhd" className="brand-logo" />
      <div className="brand-title">Swimmer Registration</div>
      <div className="brand-sub">{TC_COMPANY} · Welcome — please fill in your details below</div>
    </div>

    {err ? <div className="err-banner">⚠ {err}</div> : null}

    <div className="card">
      <div className="section-title">Parent / Guardian</div>
      <div className="field"><label>Full Name<span className="req">*</span></label><input className="input" value={gName} onChange={e=>setGName(e.target.value)} placeholder="Your full name" autoComplete="name" /></div>
      <div className="field-row">
        <div className="field"><label>Email<span className="req">*</span></label><input className="input" type="email" value={gEmail} onChange={e=>setGEmail(e.target.value)} placeholder="email@example.com" autoComplete="email" inputMode="email" /></div>
        <div className="field"><label>Phone<span className="req">*</span></label><input className="input" type="tel" value={gPhone} onChange={e=>setGPhone(e.target.value)} placeholder="+60 1X-XXX XXXX" autoComplete="tel" inputMode="tel" /></div>
      </div>
    </div>

    <div className="card">
      <div className="section-title">Swimmer(s)</div>
      {children.map((c, i) => <div key={i} className="child-card">
        <div className="child-card-head">
          <div className="child-label"><span className="child-num">{i+1}</span> Swimmer {i+1}</div>
          {children.length > 1 ? <button type="button" className="child-remove" onClick={()=>removeChild(i)} title="Remove this swimmer">×</button> : null}
        </div>
        <div className="field"><label>Full Name<span className="req">*</span></label><input className="input" value={c.name} onChange={e=>setChildAt(i,'name',e.target.value)} placeholder="Swimmer's full name" /></div>
        <div className="field-row-3">
          <div className="field" style={{marginBottom:0}}><label>Date of Birth<span className="req">*</span></label><input className="input" type="date" value={c.dob} max={todayStr()} onChange={e=>setChildAt(i,'dob',e.target.value)} /></div>
          <div className="field" style={{marginBottom:0}}><label>Age</label><div className={`age-display ${c.dob?'':'is-empty'}`}>{ageDisplay(c.dob ? ageFromDob(c.dob) : null)}</div></div>
          <div className="field" style={{marginBottom:0}}>
            <label>Gender<span className="req">*</span></label>
            <div className="gender-toggle">
              <button type="button" className={`gender-opt ${c.gender==='female'?'active':''}`} onClick={()=>setChildAt(i,'gender',c.gender==='female'?null:'female')}>♀ F</button>
              <button type="button" className={`gender-opt ${c.gender==='male'?'active':''}`} onClick={()=>setChildAt(i,'gender',c.gender==='male'?null:'male')}>♂ M</button>
            </div>
          </div>
        </div>
      </div>)}
      <button type="button" className="add-child-btn" onClick={addChild}>+ Add Another Swimmer</button>
    </div>

    <div className="card">
      <div className="section-title">Emergency Contact</div>
      <label className={`check-row ${sameAsGuardian?'is-on':''}`}>
        <input type="checkbox" checked={sameAsGuardian} onChange={e=>setSameAsGuardian(e.target.checked)} />
        <span className="check-row-text"><strong>Same as Parent / Guardian</strong> — use the contact details above (you won't need to re-enter them)</span>
      </label>
      <div className="field"><label>Emergency Contact Name{sameAsGuardian?'':<span className="req">*</span>}</label><input className="input" value={sameAsGuardian ? gName : eName} onChange={e=>setEName(e.target.value)} disabled={sameAsGuardian} placeholder="Full name" /></div>
      <div className="field-row">
        <div className="field"><label>Phone Number{sameAsGuardian?'':<span className="req">*</span>}</label><input className="input" type="tel" value={sameAsGuardian ? gPhone : ePhone} onChange={e=>setEPhone(e.target.value)} disabled={sameAsGuardian} placeholder="+60 1X-XXX XXXX" inputMode="tel" /></div>
        <div className="field"><label>Relationship to Swimmer{sameAsGuardian?'':<span className="req">*</span>}</label><input className="input" value={sameAsGuardian ? 'Parent / Guardian' : eRel} onChange={e=>setERel(e.target.value)} disabled={sameAsGuardian} placeholder="e.g. Grandparent, Aunt" /></div>
      </div>
    </div>

    <div className="card">
      <div className="section-title">Terms &amp; Conditions</div>
      <button type="button" className="tc-toggle" onClick={()=>setTcOpen(o=>!o)} aria-expanded={tcOpen}>
        <span>{tcOpen ? 'Hide full Terms & Conditions' : 'Read full Terms & Conditions'}</span>
        <span className="tc-chev">{tcOpen ? '▴' : '▾'}</span>
      </button>
      {tcOpen && <div className="tc-doc" tabIndex={0}>
        <h1>{TC_COMPANY}</h1>
        <h2>Swimming Lesson Enrolment — Terms &amp; Conditions</h2>
        {TC_CONTENT.map((sec, si) => <div key={si} style={{marginBottom:14}}>
          <h3>{sec.h}</h3>
          {sec.body.split('\n\n').map((p, pi) => <p key={pi}>{p}</p>)}
        </div>)}
      </div>}
      <label className={`check-row ${tcAccepted?'is-on':''}`}>
        <input type="checkbox" checked={tcAccepted} onChange={e=>setTcAccepted(e.target.checked)} />
        <span className="check-row-text">I have read and fully understood the Terms &amp; Conditions of <strong>{TC_COMPANY}</strong>. I agree to be bound by this Agreement on behalf of myself and/or the enrolled swimmer(s) above, and confirm all information provided is accurate.</span>
      </label>
    </div>

    <button type="button" className="submit-btn" onClick={handleSubmit} disabled={submitting}>
      {submitting ? 'Submitting…' : 'Submit Registration'}
    </button>

    <div className="footer-note">{TC_COMPANY} · Information you provide is used solely for class administration and emergency purposes.</div>

    <div className="print-pdf-row">
      <button type="button" className="print-pdf-link" onClick={()=>{
        const w = window.open('./form.html', '_blank', 'noopener,noreferrer,width=800,height=900');
        // form.html auto-triggers window.print() on load — the user sees
        // the print dialog immediately without needing to click again.
      }}>
        🖨 Print PDF version of this form
      </button>
      <span className="print-pdf-hint">Hard-copy registration · opens print dialog automatically</span>
    </div>
  </div>;
}

window.addEventListener('error', (ev) => {
  const root = document.getElementById('root');
  if(root){ root.innerHTML = `<div class="page"><div class="err-banner">⚠ ${(ev.error && ev.error.message) || ev.message || 'Unknown error'}</div></div>`; }
});

ReactDOM.createRoot(document.getElementById('root')).render(<IntakeForm />);
