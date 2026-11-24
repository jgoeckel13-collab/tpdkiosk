/**
 * Tisbury PD kiosk - email sending service (Google Apps Script web app)
 *
 * The lobby kiosk (tpdkiosk on GitHub Pages) posts here to:
 *   - email a completed form to the assisting officer(s)   (kind "officer")
 *   - email a visitor a copy of their own form             (kind "self")
 *   - send a test message from Staff setup                 (kind "test")
 *
 * Safety rules built in:
 *   - Every request must carry the secret KEY (kept in Script properties, never in this file).
 *   - Officer emails go only to allowed department addresses, and the script writes the subject
 *     and message itself. Only a real form name is used, so nobody can send their own words or a link.
 *   - Visitor copies: one address, fixed wording, replies not accepted, and limits per address and per hour.
 *   - At most 3 PDF attachments, each must really be a PDF, 15 MB total.
 *   - Nothing is stored: no PDFs or visitor addresses are kept (only counters for the limits, for a few hours).
 *
 * Setup: see SETUP.txt next to this file.
 */

// Script properties (Project Settings > Script properties):
//   KEY          required. Long random key; the same key goes in the kiosk's Staff setup > Email sending.
//   ALLOWED_TO   optional. Who officer emails may go to. Default "@tisburyma.gov" (whole domain).
//                Space-separated list of full addresses and/or @domains.
//   CC           optional. Department address copied on every officer email (e.g. TPDExec@tisburyma.gov).
//   SENDER_NAME  optional. Shown as the sender's name. Default "Tisbury PD Kiosk".
//   SELF_ON      optional. "false" turns off visitor copies.
//   EXTRA_FORMS  optional. Names of forms you imported on the kiosk, separated by | (without .pdf).

var BUILT_IN_FORMS = [
  'Lost Property Report', 'Found Property Report', 'Trespass Notice', 'Voluntary Statement',
  'Detail Request Form', 'Request for Information', 'Vehicle Lockout Request',
  'Relatório de Objeto Perdido', 'Relatório de Objeto Encontrado', 'Aviso de Proibição de Entrada',
  'Solicitação de Informações', 'Declaração Voluntária', 'Assistência para Veículo Trancado'
];
var LIMITS = {
  officerPer10Min: 30,   // officer emails, all kiosks together
  selfPer10Min: 12,      // visitor copies, all kiosks together
  selfPerAddressHour: 3, // visitor copies to one address
  testPerHour: 5,
  recipientsPerDay: 90   // stays under Google's daily sending quota for a free account (100 recipients a day)
};
var MAX_PDF_BYTES = 15 * 1024 * 1024;

function doPost(e) {
  try {
    var b = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var props = PropertiesService.getScriptProperties();
    var key = props.getProperty('KEY') || '';
    if (key.length < 16) return out({ error: 'The sending service is not set up yet (no KEY).' });
    if (!sameText(String(b.key || ''), key)) {
      if (overLimit('badkey', 20, 3600)) return out({ error: 'Too many attempts.' });
      return out({ error: 'Wrong key. Check Staff setup > Email sending.' });
    }

    var senderName = props.getProperty('SENDER_NAME') || 'Tisbury PD Kiosk';
    if (b.kind === 'officer') return out(sendOfficer(b, props, senderName));
    if (b.kind === 'self') return out(sendSelf(b, props, senderName));
    if (b.kind === 'test') return out(sendTest(b, props, senderName));
    return out({ error: 'Unknown request' });
  } catch (x) {
    console.error(x);
    return out({ error: 'The email could not be sent: ' + String(x && x.message || x).slice(0, 200) });
  }
}

function doGet() {
  return out({ ok: true, service: 'Tisbury PD kiosk email' });
}

function sendOfficer(b, props, senderName) {
  var to = (Array.isArray(b.to) ? b.to : []).map(function (x) { return String(x).trim().toLowerCase(); })
    .filter(function (x) { return okEmail(x); });
  if (!to.length) return { error: 'The selected officer(s) have no email address.' };
  if (to.length > 10) return { error: 'Too many recipients.' };
  var bad = to.filter(function (a) { return !allowedTo(a, props); });
  if (bad.length) return { error: 'Not an allowed officer address: ' + bad.join(', ') };
  var cc = String(props.getProperty('CC') || '').trim();
  if (!dayOk(to.length + (cc ? 1 : 0))) return { error: 'Daily email limit reached. Try again tomorrow.' };
  if (overLimit('officer', LIMITS.officerPer10Min, 600)) return { error: 'Too many emails. Try again later.' };
  var files = pdfs(b);
  var name = formLabel(b.name, props), dt = String(b.dt || '').replace(/[^0-9\/\-]/g, '').slice(0, 10);
  var subject = 'Completed form: ' + name + (dt ? ' (' + dt + ')' : '') + (files.length > 1 ? ' - English copy' : '');
  var body = 'Completed form "' + name + '"' + (dt ? ' dated ' + dt : '') + ' from the lobby kiosk. ' +
    (files.length > 1 ? 'Attached: the Portuguese original and the English copy.' : 'The PDF is attached.') +
    '\n\nThis message was sent automatically by the Tisbury PD kiosk.\n';
  var opts = { name: senderName, attachments: files };
  if (cc && okEmail(cc)) opts.cc = cc;
  MailApp.sendEmail(to.join(','), subject, body, opts);
  dayAdd(to.length + (opts.cc ? 1 : 0));
  console.log('officer email: ' + to.join(', ') + ' | ' + subject);
  return { ok: true };
}

function sendSelf(b, props, senderName) {
  if (String(props.getProperty('SELF_ON') || 'true').toLowerCase() === 'false')
    return { error: 'Email copies are turned off. Ask at the front desk.' };
  var to = String(b.self || '').trim();
  if (to.length > 200 || !/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]{2,}$/.test(to)) return { error: 'Enter a valid email address.' };
  if (!dayOk(1)) return { error: 'Daily email limit reached. Ask at the front desk.' };
  if (overLimit('self', LIMITS.selfPer10Min, 600) || overLimit('selfto:' + to.toLowerCase(), LIMITS.selfPerAddressHour, 3600))
    return { error: 'Too many emails. Ask at the front desk.' };
  var files = pdfs(b), pt = b.lang === 'pt', name = formLabel(b.name, props);
  var subject = (pt ? 'Sua cópia: ' : 'Your copy: ') + (name === 'form' ? (pt ? 'formulário' : 'form') : name) + ' - Tisbury Police';
  var body = pt
    ? 'Em anexo está a cópia do formulário que você preencheu no Departamento de Polícia de Tisbury.\n\nEsta é uma mensagem automática. Respostas a este e-mail não são recebidas. Para falar com o departamento, ligue ou visite a recepção.\n'
    : 'Attached is a copy of the form you completed at the Tisbury Police Department.\n\nThis is an automated message. Replies to this email are not received. To contact the department, call or visit the front desk.\n';
  MailApp.sendEmail(to, subject, body, { name: senderName, attachments: files, replyTo: 'no-reply@no-reply.invalid' });
  dayAdd(1);
  console.log('visitor copy sent | ' + subject);   // the visitor's address is not logged
  return { ok: true };
}

function sendTest(b, props, senderName) {
  var to = String((b.to || [''])[0] || '').trim().toLowerCase();
  if (!okEmail(to)) return { error: 'Enter a valid address for the test.' };
  if (!allowedTo(to, props)) return { error: 'Test emails can only go to a department address.' };
  if (!dayOk(1)) return { error: 'Daily email limit reached. Try again tomorrow.' };
  if (overLimit('test', LIMITS.testPerHour, 3600)) return { error: 'Too many test emails. Try again later.' };
  MailApp.sendEmail(to, 'Test email from the Tisbury PD kiosk',
    'This is a test. If you can read it, automatic email from the kiosk is set up correctly.\n', { name: senderName });
  dayAdd(1);
  return { ok: true };
}

/* ---------- helpers ---------- */
function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function sameText(a, b) {   // compare without leaking how much matched
  var d = a.length ^ b.length;
  for (var i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

function okEmail(e) {
  return e.length <= 200 && /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(e);
}

function allowedTo(addr, props) {
  var list = String(props.getProperty('ALLOWED_TO') || '@tisburyma.gov').toLowerCase().split(/[\s,;]+/).filter(String);
  addr = addr.toLowerCase();
  return list.some(function (x) { return x.charAt(0) === '@' ? addr.slice(-x.length) === x && addr.indexOf('@') === addr.length - x.length : addr === x; });
}

function formLabel(n, props) {
  n = String(n || '').trim();
  var known = BUILT_IN_FORMS.concat(String(props.getProperty('EXTRA_FORMS') || '').split('|').map(function (x) { return x.trim(); }).filter(String));
  if (known.indexOf(n) >= 0) return n;
  var m = /^(.+?) \(Portuguese form: (.+)\)$/.exec(n);   // Portuguese form shown with its English title
  if (m && known.indexOf(m[1]) >= 0 && known.indexOf(m[2]) >= 0) return n;
  return 'form';
}

function pdfs(b) {
  var list = Array.isArray(b.pdfs) ? b.pdfs.slice(0, 3) : [], files = [], total = 0;
  list.forEach(function (f) {
    var bytes = Utilities.base64Decode(String((f && f.pdf) || ''));
    total += bytes.length;
    if (bytes.length < 8 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]) !== '%PDF-') throw new Error('Invalid PDF');
    var fn = String((f && f.filename) || 'form.pdf').replace(/[^\w\-. ]+/g, '_').slice(0, 120);
    if (!/\.pdf$/i.test(fn)) fn += '.pdf';
    files.push(Utilities.newBlob(bytes, 'application/pdf', fn));
  });
  if (!files.length) throw new Error('No PDF attached');
  if (total > MAX_PDF_BYTES) throw new Error('The PDF is too large');
  return files;
}

function dayKey() { return 'sent:' + Utilities.formatDate(new Date(), 'America/New_York', 'yyyy-MM-dd'); }
function dayOk(n) {        // would n more recipients stay under today's limit?
  var used = Number(PropertiesService.getScriptProperties().getProperty(dayKey()) || 0);
  return used + n <= LIMITS.recipientsPerDay;
}
function dayAdd(n) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var p = PropertiesService.getScriptProperties(), k = dayKey(), all = p.getProperties();
    p.setProperty(k, String(Number(all[k] || 0) + n));
    Object.keys(all).forEach(function (x) { if (x.indexOf('sent:') === 0 && x !== k) p.deleteProperty(x); });   // forget earlier days
  } finally {
    lock.releaseLock();
  }
}

function overLimit(name, max, seconds) {   // true when this request goes over the limit
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var c = CacheService.getScriptCache(), now = Date.now(), k = 'lim:' + name;
    var a = JSON.parse(c.get(k) || '[]').filter(function (t) { return now - t < seconds * 1000; });
    if (a.length >= max) return true;
    a.push(now);
    c.put(k, JSON.stringify(a), Math.min(21600, seconds + 60));
    return false;
  } finally {
    lock.releaseLock();
  }
}
