// Display-only: shorten a full name to its first two words ("Ashton Ang Zi Yang" → "Ashton Ang"). Full name is untouched in the database.
function shortName(name){ const parts = String(name || '').trim().split(/\s+/).filter(Boolean); return parts.slice(0, 3).join(' '); }
// clip20: truncate name to 20 chars max (with ellipsis) for tight weekly grid cells
function clip22(name){ const n = shortName(name); return n.length > 20 ? n.slice(0, 19) + '…' : n; }
function clip22(name){ const n = shortName(name); return n.length > 18 ? n.slice(0, 17) + '…' : n; }
// toTitleCase: capitalize first letter of every word; used to auto-correct name inputs
function toTitleCase(s){ return (s||'').replace(/\b\w/g, c => c.toUpperCase()); }
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
