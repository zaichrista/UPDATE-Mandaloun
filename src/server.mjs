import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { db, id, audit } from './database.mjs';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const allowedOrigins = new Set((process.env.CORS_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean));
const MAX_BODY = 32 * 1024;
const limits = new Map();
const json = (res, status, data, extra = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(JSON.stringify(data));
};
const fail = (res, status, code, message, fields) => json(res, status, { error: { code, message, ...(fields ? { fields } : {}) } });
const safeEqual = (a, b) => { const aa = Buffer.from(a), bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); };
function rateLimited(req) {
  const ip = req.socket.remoteAddress || 'unknown'; const t = Date.now();
  const v = limits.get(ip) || { start: t, count: 0 };
  if (t - v.start > 60_000) { v.start = t; v.count = 0; }
  v.count++; limits.set(ip, v);
  if (limits.size > 5000) for (const [key, value] of limits) if (t - value.start > 120_000) limits.delete(key);
  return v.count > 30;
}
async function body(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw Object.assign(new Error('Request body is too large.'), { status: 413 }); chunks.push(chunk); }
  if (!size) return {};
  if (!(req.headers['content-type'] || '').includes('application/json')) throw Object.assign(new Error('Content-Type must be application/json.'), { status: 415 });
  try { const data = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error(); return data; }
  catch { throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }); }
}
const clean = value => typeof value === 'string' ? value.trim() : '';
const emailOk = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
const timeOk = value => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
function requiredString(input, key, errors, max = 500) {
  const value = clean(input[key]);
  if (!value) errors[key] = 'This field is required.';
  else if (value.length > max) errors[key] = `Must be ${max} characters or fewer.`;
  return value;
}
function admin(req, res) {
  const key = process.env.ADMIN_API_KEY || '';
  if (key.length < 32 || !req.headers.authorization?.startsWith('Bearer ') || !safeEqual(req.headers.authorization.slice(7), key)) {
    fail(res, 401, 'unauthorized', 'A valid admin bearer token is required.'); return false;
  }
  return true;
}
function pagination(url) {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  return { limit, offset };
}
function rowWithArrays(row) {
  return { ...row, dietary_tags: JSON.parse(row.dietary_tags), allergens: JSON.parse(row.allergens), available: Boolean(row.available) };
}
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y,m,d] = value.split('-').map(Number); const check = new Date(Date.UTC(y,m-1,d));
  return check.getUTCFullYear()===y && check.getUTCMonth()===m-1 && check.getUTCDate()===d;
}
const londonToday = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());

async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) { res.setHeader('access-control-allow-origin', origin); res.setHeader('vary', 'Origin'); res.setHeader('access-control-allow-headers', 'Content-Type, Authorization, Idempotency-Key'); res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS'); }
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  if (origin && !allowedOrigins.has(origin)) return fail(res, 403, 'origin_not_allowed', 'This website origin is not allowed.');
  if (rateLimited(req)) { res.setHeader('retry-after', '60'); return fail(res, 429, 'rate_limited', 'Too many requests. Please try again in a minute.'); }
  let url; try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); } catch { return fail(res, 400, 'bad_url', 'Invalid request URL.'); }
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (req.method === 'GET' && path === '/health') return json(res, 200, { status: 'ok', service: 'mandaloun-api', time: new Date().toISOString() });
  if (req.method === 'GET' && path === '/api/v1/restaurant') return json(res, 200, { name: 'Mandaloun Westfield', cuisine: ['Lebanese', 'Mediterranean'], phone: '+442087498845', email: 'info@mandaloun.com', address: { street: '1 Ariel Way, Westfield Shopping Centre', locality: 'Shepherds Bush, London', postcode: 'W12 7SL', country: 'GB' }, hours: { monday: ['11:00','00:00'], tuesday: ['11:00','00:00'], wednesday: ['11:00','00:00'], thursday: ['11:00','00:00'], friday: ['11:00','00:00'], saturday: ['11:00','00:00'], sunday: ['11:00','23:00'] }, privateEvents: { seatedCapacity: 130, indoorCapacity: 90, terraceCapacity: 40 } });
  if (req.method === 'GET' && path === '/api/v1/menu') {
    const categories = db.prepare('SELECT id,name,description,position FROM menu_categories WHERE active=1 ORDER BY position,name').all();
    const items = db.prepare('SELECT id,category_id,name,description,price_pence,price_label,dietary_tags,allergens,position FROM menu_items WHERE available=1 ORDER BY position,name').all().map(rowWithArrays);
    return json(res, 200, { categories: categories.map(c => ({ ...c, items: items.filter(i => i.category_id === c.id) })) });
  }
  if (req.method === 'POST' && path === '/api/v1/reservations') {
    let b; try { b = await body(req); } catch (e) { return fail(res, e.status || 400, 'invalid_body', e.message); }
    const errors = {}; const name = requiredString(b,'name',errors,120), email = requiredString(b,'email',errors,254).toLowerCase(), phone = requiredString(b,'phone',errors,40);
    const date = requiredString(b,'date',errors,10), time = requiredString(b,'time',errors,5);
    const party = Number(b.partySize); if (!Number.isInteger(party) || party < 1 || party > 20) errors.partySize = 'Party size must be between 1 and 20. For larger parties, use the private events enquiry.';
    if (email && !emailOk(email)) errors.email = 'Enter a valid email address.';
    if (date && !validDate(date)) errors.date = 'Use a valid date in YYYY-MM-DD format.';
    else if (date && date < londonToday()) errors.date = 'Choose today or a future date.';
    if (time && !timeOk(time)) errors.time = 'Use 24-hour HH:MM time.';
    if (Object.keys(errors).length) return fail(res, 422, 'validation_error', 'Please correct the highlighted fields.', errors);
    const key = clean(req.headers['idempotency-key'] || b.idempotencyKey).slice(0,128) || null;
    if (key) { const prior = db.prepare('SELECT id,status,created_at FROM reservations WHERE idempotency_key=?').get(key); if (prior) return json(res, 200, { reservation: prior, message: 'Your request was already received.' }); }
    const rid = id();
    try { db.prepare('INSERT INTO reservations(id,name,email,phone,date,time,party_size,occasion,notes,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?)').run(rid,name,email,phone,date,time,party,clean(b.occasion).slice(0,100),clean(b.notes).slice(0,2000),key); }
    catch (e) { if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') { const prior = db.prepare('SELECT id,status,created_at FROM reservations WHERE idempotency_key=?').get(key); return json(res, 200, { reservation: prior }); } throw e; }
    return json(res, 201, { reservation: { id: rid, status: 'pending', date, time, partySize: party }, message: 'Your table request has been received. The restaurant will contact you to confirm.' });
  }
  if (req.method === 'POST' && path === '/api/v1/event-enquiries') {
    let b; try { b = await body(req); } catch (e) { return fail(res, e.status || 400, 'invalid_body', e.message); }
    const errors = {}; const name = requiredString(b,'name',errors,120), email = requiredString(b,'email',errors,254).toLowerCase(), phone = clean(b.phone).slice(0,40), eventType = requiredString(b,'eventType',errors,100), service = clean(b.service).slice(0,100), budget = clean(b.budget).slice(0,100), notes = clean(b.notes).slice(0,3000);
    const guests = Number(b.guestCount); if (!Number.isInteger(guests) || guests < 1 || guests > 500) errors.guestCount = 'Guest count must be between 1 and 500.';
    const date = clean(b.eventDate); if (date && !validDate(date)) errors.eventDate = 'Use a valid date in YYYY-MM-DD format.'; if (email && !emailOk(email)) errors.email = 'Enter a valid email address.';
    if (Object.keys(errors).length) return fail(res, 422, 'validation_error', 'Please correct the highlighted fields.', errors);
    const eid=id(); db.prepare('INSERT INTO event_enquiries(id,name,email,phone,event_type,event_date,guest_count,service,budget,notes) VALUES(?,?,?,?,?,?,?,?,?,?)').run(eid,name,email,phone,eventType,date||null,guests,service,budget,notes);
    return json(res,201,{ enquiry:{id:eid,status:'new'},message:'Your event enquiry has been received. The team will be in touch.' });
  }
  if (req.method === 'POST' && path === '/api/v1/contact') {
    let b; try { b = await body(req); } catch(e) { return fail(res,e.status||400,'invalid_body',e.message); }
    const errors={}; const name=requiredString(b,'name',errors,120), email=requiredString(b,'email',errors,254).toLowerCase(), phone=clean(b.phone).slice(0,40), subject=clean(b.subject).slice(0,160), message=requiredString(b,'message',errors,5000);
    if(email&&!emailOk(email)) errors.email='Enter a valid email address.'; if(Object.keys(errors).length) return fail(res,422,'validation_error','Please correct the highlighted fields.',errors);
    const mid=id(); db.prepare('INSERT INTO contact_messages(id,name,email,phone,subject,message) VALUES(?,?,?,?,?,?)').run(mid,name,email,phone,subject,message);
    return json(res,201,{message:{id:mid,status:'new'},messageText:'Your message has been received. Thank you.'});
  }
  if (req.method === 'POST' && path === '/api/v1/newsletter') {
    let b; try { b=await body(req); } catch(e) { return fail(res,e.status||400,'invalid_body',e.message); }
    const email=clean(b.email).toLowerCase(); if(!emailOk(email)) return fail(res,422,'validation_error','Enter a valid email address.',{email:'Enter a valid email address.'});
    if(b.consent !== true) return fail(res,422,'consent_required','Please confirm you agree to receive email updates.');
    db.prepare('INSERT INTO newsletter_subscribers(id,email,source) VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET unsubscribed_at=NULL,consent_at=datetime(\'now\')').run(id(),email,clean(b.source).slice(0,80)||'website');
    return json(res,201,{message:'You are subscribed.'});
  }

  if (path.startsWith('/api/v1/admin/')) {
    if (!admin(req,res)) return;
    const parts=path.split('/').filter(Boolean); const resource=parts[3]; const rid=parts[4];
    if (req.method==='GET' && ['menu-categories','menu-items'].includes(resource)) {
      const {limit,offset}=pagination(url); const table=resource==='menu-categories'?'menu_categories':'menu_items';
      const total=db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
      let rows=db.prepare(`SELECT * FROM ${table} ORDER BY position,name LIMIT ? OFFSET ?`).all(limit,offset);
      if(resource==='menu-items') rows=rows.map(rowWithArrays);
      else rows=rows.map(row=>({...row,active:Boolean(row.active)}));
      return json(res,200,{data:rows,pagination:{limit,offset,total}});
    }
    if (req.method==='GET' && ['reservations','event-enquiries','contact-messages','newsletter','audit-log'].includes(resource)) {
      const {limit,offset}=pagination(url); const tables={reservations:'reservations', 'event-enquiries':'event_enquiries', 'contact-messages':'contact_messages', newsletter:'newsletter_subscribers', 'audit-log':'audit_log'}; const table=tables[resource];
      let where=''; let args=[];
      if(resource==='reservations' && url.searchParams.get('status')) { where=' WHERE status=?'; args.push(url.searchParams.get('status')); }
      const total=db.prepare(`SELECT count(*) AS n FROM ${table}${where}`).get(...args).n;
      const rows=db.prepare(`SELECT * FROM ${table}${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...args,limit,offset);
      return json(res,200,{data:rows,pagination:{limit,offset,total}});
    }
    if (req.method==='PATCH' && rid && ['reservations','event-enquiries','contact-messages'].includes(resource)) {
      let b; try{b=await body(req);}catch(e){return fail(res,e.status||400,'invalid_body',e.message);}
      const defs={reservations:['reservations',['pending','confirmed','declined','cancelled','completed']], 'event-enquiries':['event_enquiries',['new','contacted','quoted','booked','closed']], 'contact-messages':['contact_messages',['new','read','replied','closed']]};
      const [table,states]=defs[resource]; if(!states.includes(b.status)) return fail(res,422,'validation_error','Invalid status.',{status:`Choose one of: ${states.join(', ')}.`});
      const result=db.prepare(`UPDATE ${table} SET status=?,updated_at=datetime('now') WHERE id=?`).run(b.status,rid); if(!result.changes) return fail(res,404,'not_found','Record not found.'); audit('status_changed',resource,rid,{status:b.status}); return json(res,200,{id:rid,status:b.status});
    }
    if (req.method==='POST' && resource==='menu-categories') {
      let b; try{b=await body(req);}catch(e){return fail(res,e.status||400,'invalid_body',e.message);}
      const errors={}; const name=requiredString(b,'name',errors,120); if(Object.keys(errors).length)return fail(res,422,'validation_error','Please correct the highlighted fields.',errors);
      const cid=id(); db.prepare('INSERT INTO menu_categories(id,name,description,position,active) VALUES(?,?,?,?,?)').run(cid,name,clean(b.description).slice(0,500),Number(b.position)||0,b.active===false?0:1); audit('created','menu_category',cid); return json(res,201,{id:cid,name});
    }
    if (req.method==='POST' && resource==='menu-items') {
      let b; try{b=await body(req);}catch(e){return fail(res,e.status||400,'invalid_body',e.message);}
      const errors={}; const name=requiredString(b,'name',errors,160), categoryId=requiredString(b,'categoryId',errors,80); const price=b.pricePence===undefined||b.pricePence===null?null:Number(b.pricePence);
      if(price!==null&&(!Number.isInteger(price)||price<0||price>1000000)) errors.pricePence='Price must be non-negative pence.';
      if(!db.prepare('SELECT id FROM menu_categories WHERE id=?').get(categoryId)) errors.categoryId='Menu category not found.';
      if(Object.keys(errors).length)return fail(res,422,'validation_error','Please correct the highlighted fields.',errors);
      const itemId=id(); const tags=Array.isArray(b.dietaryTags)?b.dietaryTags.map(String).slice(0,20):[], allergens=Array.isArray(b.allergens)?b.allergens.map(String).slice(0,30):[];
      db.prepare('INSERT INTO menu_items(id,category_id,name,description,price_pence,price_label,dietary_tags,allergens,position,available) VALUES(?,?,?,?,?,?,?,?,?,?)').run(itemId,categoryId,name,clean(b.description).slice(0,1000),price,clean(b.priceLabel).slice(0,100),JSON.stringify(tags),JSON.stringify(allergens),Number(b.position)||0,b.available===false?0:1);
      audit('created','menu_item',itemId); return json(res,201,{id:itemId,name,categoryId});
    }
    if (req.method==='PATCH' && rid && resource==='menu-items') {
      let b; try{b=await body(req);}catch(e){return fail(res,e.status||400,'invalid_body',e.message);}
      const current=db.prepare('SELECT * FROM menu_items WHERE id=?').get(rid); if(!current)return fail(res,404,'not_found','Menu item not found.');
      const name=b.name===undefined?current.name:clean(b.name), desc=b.description===undefined?current.description:clean(b.description), price=b.pricePence===undefined?current.price_pence:(b.pricePence===null?null:Number(b.pricePence)), priceLabel=b.priceLabel===undefined?current.price_label:clean(b.priceLabel), available=b.available===undefined?current.available:(b.available?1:0), position=b.position===undefined?current.position:Number(b.position), categoryId=b.categoryId===undefined?current.category_id:clean(b.categoryId), tags=b.dietaryTags===undefined?current.dietary_tags:JSON.stringify(b.dietaryTags), allergens=b.allergens===undefined?current.allergens:JSON.stringify(b.allergens);
      if(!name||name.length>160|| (price!==null&&(!Number.isInteger(price)||price<0)) || !db.prepare('SELECT id FROM menu_categories WHERE id=?').get(categoryId)) return fail(res,422,'validation_error','Menu item fields are invalid.');
      db.prepare("UPDATE menu_items SET name=?,description=?,price_pence=?,price_label=?,available=?,position=?,category_id=?,dietary_tags=?,allergens=?,updated_at=datetime('now') WHERE id=?").run(name,desc,price,priceLabel,available,position,categoryId,tags,allergens,rid); audit('updated','menu_item',rid); return json(res,200,{id:rid,updated:true});
    }
    if (req.method==='PATCH' && rid && resource==='menu-categories') {
      let b; try{b=await body(req);}catch(e){return fail(res,e.status||400,'invalid_body',e.message);}
      const row=db.prepare('SELECT * FROM menu_categories WHERE id=?').get(rid); if(!row)return fail(res,404,'not_found','Menu category not found.');
      db.prepare("UPDATE menu_categories SET name=?,description=?,position=?,active=?,updated_at=datetime('now') WHERE id=?").run(b.name===undefined?row.name:clean(b.name),b.description===undefined?row.description:clean(b.description),b.position===undefined?row.position:Number(b.position),b.active===undefined?row.active:(b.active?1:0),rid); audit('updated','menu_category',rid); return json(res,200,{id:rid,updated:true});
    }
    if (req.method==='DELETE' && rid && ['menu-items','menu-categories'].includes(resource)) {
      const table=resource==='menu-items'?'menu_items':'menu_categories'; const r=db.prepare(`DELETE FROM ${table} WHERE id=?`).run(rid); if(!r.changes)return fail(res,404,'not_found','Record not found.'); audit('deleted',resource,rid); return json(res,200,{id:rid,deleted:true});
    }
    return fail(res,404,'route_not_found','Admin route not found.');
  }
  return fail(res,404,'route_not_found','Route not found.');
}

const server=createServer(async(req,res)=>{
  res.setHeader('x-frame-options','DENY'); res.setHeader('referrer-policy','no-referrer'); res.setHeader('permissions-policy','camera=(), microphone=(), geolocation=()');
  try { await handler(req,res); }
  catch(error) { console.error('Request failed:',error); if(!res.headersSent) fail(res,500,'internal_error','The server could not complete this request.'); else res.destroy(); }
});
server.listen(PORT,HOST,()=>console.log(`Mandaloun API listening on http://${HOST}:${PORT}`));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close(()=>{db.close();process.exit(0);}));
