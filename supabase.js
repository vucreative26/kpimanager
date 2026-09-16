import { config } from './config.js';

const keys = ['kpis','subTasks','checkItems','urgentTasks','dailyNotes','leaves','resourceLinks','salaryRules','salaryBonuses','payrolls','payrollItems'];
let client, userId, snapshot, generation=0;
const empty = () => Object.fromEntries(keys.map(key=>[key,[]]));
const clone = value => JSON.parse(JSON.stringify(value));
const defaultSalaryRules = [
  { title: 'Lương cơ bản', keyword: '', amount: 10000000, type: 'base', active: true },
  { title: 'Lớp Online', keyword: 'lớp online', amount: 100000, type: 'keyword', active: true },
  { title: 'Lớp Offline theo lịch', keyword: 'offline theo lịch', amount: 300000, type: 'keyword', active: true },
  { title: 'Lớp offline khách hàng book', keyword: 'khách hàng book', amount: 300000, type: 'keyword', active: true },
  { title: 'Nghiên cứu sản phẩm mới', keyword: 'nghiên cứu sản phẩm mới', amount: 200000, type: 'keyword', active: true }
];
function normalize(data) {
  for (const key of keys) data[key]=(data[key]||[]).map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v===null?'':v])));
  return data;
}
async function rpc(name,params={}) {
  if(!client||!userId)throw Error('Vui lòng đăng nhập.');
  const epoch=generation;
  const {data,error}=await client.rpc(name,params);
  if(epoch!==generation)throw Error('Phiên đăng nhập đã thay đổi.');
  if(error)throw Error(error.message);
  return data;
}
async function load(period){
  snapshot=normalize(await rpc('flow_period',{p_period:period}));
  if (!isDemoMode && snapshot.salaryRules.length === 0) {
    try {
      for (const rule of defaultSalaryRules) await rpc('flow_mutate', { p_table: 'salaryRules', p_action: 'add', p_id: null, p_patch: rule });
      snapshot=normalize(await rpc('flow_period',{p_period:period}));
    } catch {}
  }
  return clone(snapshot);
}
function restrict(data,period){
  data.kpis=data.kpis.filter(k=>k.period===period);
  const kids=new Set(data.kpis.map(k=>k.id));
  data.subTasks=data.subTasks.filter(s=>kids.has(s.kpiId));
  const sids=new Set(data.subTasks.map(s=>s.id));
  data.checkItems=data.checkItems.filter(c=>sids.has(c.subTaskId));
  const cids=new Set(data.checkItems.map(c=>c.id));
  data.resourceLinks=data.resourceLinks.filter(l=>({KPI:kids,SUBTASK:sids,CHECK:cids})[l.entityType]?.has(l.entityId));
  data.dailyNotes=data.dailyNotes.filter(n=>n.date.slice(0,7)===period);
  data.leaves=data.leaves.filter(l=>l.startDate.slice(0,7)<=period&&l.endDate.slice(0,7)>=period);
  data.urgentTasks=data.urgentTasks.filter(t=>t.status!=='Hoàn thành'||String(t.dueDate||t.createdAt).slice(0,7)===period);
  data.salaryRules=data.salaryRules.filter(r=>r.active!==false);
  data.salaryBonuses=data.salaryBonuses.filter(b=>b.period===period);
  data.payrolls=data.payrolls.filter(p=>p.period===period);
  const payrollIds=new Set(data.payrolls.map(p=>p.id));
  data.payrollItems=data.payrollItems.filter(i=>payrollIds.has(i.payrollId));
  return data;
}
async function mutate(table,action,id,patch,period){
  const delta=await rpc('flow_mutate',{p_table:table,p_action:action,p_id:id||null,p_patch:patch||{}});
  // A different device may have written since our last snapshot. Fetch once to catch it.
  if(!snapshot||snapshot.period!==period||String(snapshot.revision)!==String(delta.previousRevision))return load(period);
  for(const key of keys){
    const rows=new Map(snapshot[key].map(row=>[row.id,row]));
    if(delta.deleted?.table===key)rows.delete(delta.deleted.id);
    for(const row of delta.upserts[key]||[])rows.set(row.id,row);
    snapshot[key]=[...rows.values()];
  }
  snapshot.revision=delta.revision;
  snapshot=restrict(normalize(snapshot),period);
  return clone(snapshot);
}
const types={Kpi:'kpis',SubTask:'subTasks',CheckItem:'checkItems',UrgentTask:'urgentTasks',Leave:'leaves',ResourceLink:'resourceLinks',SalaryRule:'salaryRules',SalaryBonus:'salaryBonuses',Payroll:'payrolls',PayrollItem:'payrollItems'};
function geminiSettings(){try{return JSON.parse(localStorage.getItem('flow-gemini:'+userId)||'{}');}catch{return {};}}
async function gemini(name,args){
  let settings=geminiSettings();
  if(name==='apiSaveGeminiSettings'){
    if(!String(args[0]||'').trim())throw Error('API key không được để trống.');
    settings={key:args[0].trim(),model:String(args[1]||'gemini-2.5-flash').trim()};
    localStorage.setItem('flow-gemini:'+userId,JSON.stringify(settings));
  }
  if(name!=='apiAskGemini')return {configured:!!settings.key,model:settings.model||'gemini-2.5-flash'};
  if(!settings.key)throw Error('Bấm Cài API để nhập Gemini key trên thiết bị này.');
  const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(settings.model)+':generateContent',{
    method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':settings.key},signal:AbortSignal.timeout(60000),
    body:JSON.stringify({system_instruction:{parts:[{text:'Bạn là trợ lý quản lý công việc. Trả lời tiếng Việt, ngắn gọn và thực tế. Khi gợi ý checklist, viết 4–6 đầu mục hành động.'}]},contents:[{role:'user',parts:[{text:(args[1]||'')+'\n'+args[0]}]}],generationConfig:{temperature:0.25,maxOutputTokens:1500}})
  });
  const result=await response.json();if(!response.ok)throw Error(result.error?.message||'Gemini không phản hồi.');
  const answer=result.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('');
  if(!answer)throw Error('Gemini chưa trả về nội dung.');return {answer};
}
function getInitialDemoData() {
  const currentPeriod = new Date().toISOString().slice(0, 7);
  const currentDate = new Date().toISOString().slice(0, 10);
  return {
    kpis: [
      { id: 'kpi-1', title: '01/ ĐÀO TẠO ĐẠI LÝ', period: currentPeriod, weight: 0, progress: 20, note: '', driveLink: '', salaryEnabled: false, salaryAmount: 0 },
      { id: 'kpi-2', title: '02/ ĐÀO TẠO NỘI BỘ', period: currentPeriod, weight: 0, progress: 0, note: '', driveLink: '', salaryEnabled: false, salaryAmount: 0 },
      { id: 'kpi-3', title: '03/ TRAINER LAMOUR', period: currentPeriod, weight: 0, progress: 0, note: '', driveLink: '', salaryEnabled: true, salaryAmount: 1000000 }
    ],
    subTasks: [
      { id: 'sub-1', kpiId: 'kpi-1', title: 'Ứng dụng Liệu trình Mesotherapy không kim MesoFiller Pro trẻ hóa da toàn diện vùng mặt & Liệu trình TEG Some kết hợp Laser ánh sáng điều trị mụn', dueDate: currentDate, progress: 20, status: 'Đang làm', driveLink: '' }
    ],
    checkItems: [
      { id: 'chk-1', subTaskId: 'sub-1', title: 'Chuẩn bị tài liệu', dueDate: currentDate, done: true, note: '' },
      { id: 'chk-2', subTaskId: 'sub-1', title: 'Sale báo số lượng khách', dueDate: currentDate, done: false, note: '' },
      { id: 'chk-3', subTaskId: 'sub-1', title: 'Đào tạo lớp Online', dueDate: currentDate, done: false, note: '' },
      { id: 'chk-4', subTaskId: 'sub-1', title: 'Ghi nhận số lượng khách', dueDate: currentDate, done: false, note: '' },
      { id: 'chk-5', subTaskId: 'sub-1', title: 'Upload video lên Kho dữ liệu', dueDate: currentDate, done: false, note: '' }
    ],
    urgentTasks: [
      { id: 'urg-1', title: 'Chuẩn bị tài liệu họp ban điều hành', dueDate: currentDate, kpiGroup: 'Đào tạo', status: 'Đang làm' },
      { id: 'urg-2', title: 'Hỗ trợ kỹ thuật sự kiện ra mắt', dueDate: currentDate, kpiGroup: 'Đột xuất', status: 'Chưa làm' }
    ],
    dailyNotes: [
      { date: currentDate, content: 'Kiểm tra lại toàn bộ slide và giáo án đào tạo online.' }
    ],
    leaves: [
      { id: 'lea-1', type: 'Nghỉ phép', startDate: currentDate, endDate: currentDate, note: 'Nghỉ cá nhân' }
    ],
    resourceLinks: [
      { id: 'lnk-1', entityType: 'KPI', entityId: 'kpi-1', label: 'Tài liệu Mesotherapy', url: 'https://drive.google.com' }
    ],
    salaryRules: defaultSalaryRules.map((rule, index) => ({ id: 'sal-' + index, ...rule })),
    salaryBonuses: [
      { id: 'bonus-demo', period: currentPeriod, title: 'Đào tạo Trainer Lamour', amount: 1000000, done: false, note: 'Khoản KPI riêng có thể bật khi hoàn thành.' }
    ],
    payrolls: [],
    payrollItems: []
  };
}

let isDemoMode = false;
let demoData = null;
let sessionCallback = null;

function loadDemoData() {
  if (!demoData) {
    try {
      const stored = localStorage.getItem('flow_demo_data');
      demoData = stored ? JSON.parse(stored) : getInitialDemoData();
    } catch {
      demoData = getInitialDemoData();
    }
  }
  const defaults = getInitialDemoData();
  for (const key of keys) {
    if (!Array.isArray(demoData[key])) demoData[key] = clone(defaults[key] || []);
  }
  return clone(demoData);
}

function saveDemoData() {
  try {
    localStorage.setItem('flow_demo_data', JSON.stringify(demoData));
  } catch {}
}

export const backend = {
  async initialize(onSession) {
    sessionCallback = onSession;
    const isConfigured = /^https:\/\//.test(config.supabaseUrl) && !config.supabaseUrl.includes('YOUR_PROJECT') && config.supabaseKey && !config.supabaseKey.includes('YOUR_');
    
    if (localStorage.getItem('flow_demo_user') === '1' || !isConfigured) {
      if (localStorage.getItem('flow_demo_user') === '1') {
        isDemoMode = true;
        userId = 'demo-user-id';
        demoData = loadDemoData();
        setTimeout(() => onSession({ user: { id: userId, email: 'demo@flowkpi.local' } }), 0);
      } else {
        setTimeout(() => onSession(null), 0);
      }
      return;
    }

    try {
      const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.57.4');
      client = createClient(config.supabaseUrl, config.supabaseKey);
      function update(session) {
        const next = session?.user.id || null;
        if (next === userId) return;
        userId = next;
        generation++;
        snapshot = null;
        setTimeout(() => { Promise.resolve(onSession(session)).catch(err => console.error(err)); }, 0);
      }
      client.auth.onAuthStateChange((_event, session) => update(session));
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      update(data.session);
    } catch (err) {
      console.warn('Lỗi kết nối Supabase, chuyển sang chế độ dự phòng:', err.message);
      onSession(null);
    }
  },

  async signIn(email, password) {
    const isConfigured = client && /^https:\/\//.test(config.supabaseUrl) && !config.supabaseUrl.includes('YOUR_PROJECT');
    if (!isConfigured || email.includes('demo') || email === 'test@example.com') {
      isDemoMode = true;
      userId = 'demo-user-id';
      demoData = loadDemoData();
      localStorage.setItem('flow_demo_user', '1');
      if (sessionCallback) sessionCallback({ user: { id: userId, email: email || 'demo@flowkpi.local' } });
      return;
    }
    const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
    if (error) throw error;
  },

  async signOut() {
    if (isDemoMode) {
      isDemoMode = false;
      userId = null;
      localStorage.removeItem('flow_demo_user');
      if (sessionCallback) sessionCallback(null);
      return;
    }
    if (client) {
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error) throw error;
    }
  },

  async changed() {
    if (isDemoMode) return false;
    return snapshot && String(await rpc('flow_revision')) !== String(snapshot.revision);
  },

  async call(name, args, period) {
    if (name.includes('Gemini')) return gemini(name, args);
    if (isDemoMode && name === 'apiExportData') {
      const data = loadDemoData();
      return {
        flow_kpis: data.kpis || [],
        flow_sub_tasks: data.subTasks || [],
        flow_check_items: data.checkItems || [],
        flow_urgent_tasks: data.urgentTasks || [],
        flow_daily_notes: data.dailyNotes || [],
        flow_leaves: data.leaves || [],
        flow_resource_links: data.resourceLinks || [],
        flow_salary_rules: data.salaryRules || [],
        flow_salary_bonuses: data.salaryBonuses || [],
        flow_payrolls: data.payrolls || [],
        flow_payroll_items: data.payrollItems || []
      };
    }
    if (isDemoMode && name === 'apiSalaryYear') {
      const year = String(args[0] || '').slice(0, 4);
      const data = loadDemoData();
      data.payrolls = data.payrolls || [];
      data.payrollItems = data.payrollItems || [];
      const doneChecks = data.checkItems.filter(c => c.done && String(c.dueDate || '').slice(0, 4) === year).length;
      const tripDays = data.leaves.filter(l => l.type === 'Đi công tác' && String(l.startDate).slice(0, 4) === year).length;
      const leaveDays = data.leaves.filter(l => l.type === 'Nghỉ phép' && String(l.startDate).slice(0, 4) === year).length;
      const payrollIds = new Set(data.payrolls.filter(p => String(p.period).slice(0, 4) === year).map(p => p.id));
      const totalSalary = data.payrollItems.filter(i => payrollIds.has(i.payrollId)).reduce((sum, i) => sum + (Number(i.amount) || 0), 0);
      return { doneSubTasks: doneChecks, tripDays, leaveDays, totalSalary };
    }
    if (name === 'apiSalaryYear') return rpc('flow_salary_year', { p_year: args[0] });
    if (name === 'apiExportData') {
      if (isDemoMode) throw Error('Export database chỉ dùng khi đăng nhập tài khoản Supabase thật.');
      const opts = args?.[0] || {};
      try { return await rpc('flow_export', { p_scope: opts.scope || 'all', p_period: opts.period || null, p_year: opts.year || null, p_tables: opts.tables || null }); }
      catch (error) {
        if (!/flow_export|schema cache|Could not find/i.test(error.message)) throw error;
        const current = await rpc('flow_period', { p_period: period });
        return {
          flow_kpis: current.kpis || [],
          flow_sub_tasks: current.subTasks || [],
          flow_check_items: current.checkItems || [],
          flow_urgent_tasks: current.urgentTasks || [],
          flow_daily_notes: current.dailyNotes || [],
          flow_leaves: current.leaves || [],
          flow_resource_links: current.resourceLinks || [],
          flow_salary_rules: current.salaryRules || [],
          flow_salary_bonuses: current.salaryBonuses || [],
          flow_payrolls: current.payrolls || [],
          flow_payroll_items: current.payrollItems || []
        };
      }
    }
    if (name === 'apiDeleteData') {
      if (isDemoMode) throw Error('Xóa theo kỳ cần tài khoản Supabase thật để xác thực mật khẩu.');
      await rpc('flow_delete_data', {p_scope:args[0].scope, p_value:args[0].value, p_password:args[0].password});
      snapshot = null;
      return load(period);
    }
    
    if (isDemoMode) {
      const data = loadDemoData();
      if (name === 'getSystemData') {
        data.salaryRules = data.salaryRules || getInitialDemoData().salaryRules;
        data.salaryBonuses = data.salaryBonuses || [];
        data.payrolls = data.payrolls || [];
        data.payrollItems = data.payrollItems || [];
        data.period = period;
        return restrict(clone(data), period);
      }
      if (name === 'apiSavePayroll') {
        const draft = args[0];
        data.payrolls = data.payrolls || [];
        data.payrollItems = data.payrollItems || [];
        const id = draft.id || 'pay-' + Date.now();
        let payroll = data.payrolls.find(p => p.id === id);
        if (!payroll) {
          payroll = { id, period: draft.period, title: draft.title, note: draft.note || '' };
          data.payrolls.push(payroll);
        } else {
          Object.assign(payroll, { period: draft.period, title: draft.title, note: draft.note || '' });
        }
        data.payrollItems = data.payrollItems.filter(i => i.payrollId !== id);
        draft.items.forEach((item, index) => data.payrollItems.push({ id: 'payitem-' + Date.now() + '-' + index, payrollId: id, sourceType: item.sourceType, sourceId: item.sourceId || '', title: item.title, amount: Number(item.amount) || 0 }));
        demoData = data;
        saveDemoData();
        data.period = period;
        return restrict(clone(data), period);
      }
      if (name === 'apiToggleCheckItem') {
        const item = data.checkItems.find(c => c.id === args[0]);
        if (item) item.done = args[1];
        // Recalculate progress for subtask and kpi
        const sub = data.subTasks.find(s => s.id === item?.subTaskId);
        if (sub) {
          const checks = data.checkItems.filter(c => c.subTaskId === sub.id);
          sub.progress = checks.length ? Math.round((checks.filter(c => c.done).length / checks.length) * 100) : sub.progress;
          const kpi = data.kpis.find(k => k.id === sub.kpiId);
          if (kpi) {
            const subs = data.subTasks.filter(s => s.kpiId === kpi.id);
            kpi.progress = subs.length ? Math.round(subs.reduce((acc, s) => acc + (s.progress || 0), 0) / subs.length) : kpi.progress;
          }
        }
        demoData = data;
        saveDemoData();
        data.period = period;
        return clone(data);
      }
      if (name === 'apiSaveDailyNote') {
        const note = data.dailyNotes.find(n => n.date === args[0]);
        if (note) note.content = args[1];
        else data.dailyNotes.push({ date: args[0], content: args[1] });
        demoData = data;
        saveDemoData();
        data.period = period;
        return clone(data);
      }
      if (name === 'apiAddKpi') {
        data.kpis.push({ id: 'kpi-' + Date.now(), title: args[0].title, period: args[0].period, weight: 0, progress: 0, note: '', driveLink: '', salaryEnabled: !!args[0].salaryEnabled, salaryAmount: Number(args[0].salaryAmount) || 0 });
      } else if (name === 'apiAddSubTask') {
        data.subTasks.push({ id: 'sub-' + Date.now(), kpiId: args[0], title: args[1], dueDate: args[2], progress: 0, status: 'Chưa làm', driveLink: '' });
      } else if (name === 'apiAddCheckItem') {
        data.checkItems.push({ id: 'chk-' + Date.now(), subTaskId: args[0], title: args[1], dueDate: args[2], done: false, note: '' });
      } else if (name === 'apiAddUrgentTask') {
        data.urgentTasks.push({ id: 'urg-' + Date.now(), title: args[0].title, dueDate: args[0].dueDate, kpiGroup: args[0].kpiGroup || 'Đột xuất', status: 'Chưa làm' });
      } else if (name === 'apiAddLeave') {
        data.leaves.push({ id: 'lea-' + Date.now(), ...args[0] });
      } else if (name === 'apiAddSalaryRule') {
        data.salaryRules.push({ id: 'rule-' + Date.now(), ...args[0], amount: Number(args[0].amount) || 0, active: true });
      } else if (name === 'apiAddSalaryBonus') {
        data.salaryBonuses.push({ id: 'bonus-' + Date.now(), ...args[0], amount: Number(args[0].amount) || 0, done: !!args[0].done });
      } else if (name.startsWith('apiUpdate')) {
        const table = types[name.slice('apiUpdate'.length)];
        const item = data[table]?.find(row => row.id === args[0]);
        if (!item) throw Error('Không tìm thấy mục cần sửa.');
        Object.assign(item, args[1]);
      } else if (name.startsWith('apiDelete')) {
        const id = args[0];
        if (name === 'apiDeleteKpi') {
          data.kpis = data.kpis.filter(k => k.id !== id);
          const subs = data.subTasks.filter(s => s.kpiId === id).map(s => s.id);
          data.subTasks = data.subTasks.filter(s => s.kpiId !== id);
          data.checkItems = data.checkItems.filter(c => !subs.includes(c.subTaskId));
        } else if (name === 'apiDeleteSubTask') {
          data.subTasks = data.subTasks.filter(s => s.id !== id);
          data.checkItems = data.checkItems.filter(c => c.subTaskId !== id);
        } else if (name === 'apiDeleteCheckItem') {
          data.checkItems = data.checkItems.filter(c => c.id !== id);
        } else if (name === 'apiDeleteUrgentTask') {
          data.urgentTasks = data.urgentTasks.filter(t => t.id !== id);
        } else if (name === 'apiDeleteLeave') {
          data.leaves = data.leaves.filter(l => l.id !== id);
        } else if (name === 'apiDeleteSalaryRule') {
          data.salaryRules = data.salaryRules.filter(r => r.id !== id);
        } else if (name === 'apiDeleteSalaryBonus') {
          data.salaryBonuses = data.salaryBonuses.filter(b => b.id !== id);
        } else if (name === 'apiDeletePayroll') {
          data.payrolls = data.payrolls.filter(p => p.id !== id);
          data.payrollItems = data.payrollItems.filter(i => i.payrollId !== id);
        }
      }
      demoData = data;
      saveDemoData();
      data.period = period;
      return clone(data);
    }

    if (name === 'getSystemData') return load(period);
    if (name === 'apiSavePayroll') {
      const draft = args[0];
      const id = draft.id || null;
      let saved;
      try {
        saved = await rpc('flow_mutate', { p_table: 'payrolls', p_action: id ? 'update' : 'add', p_id: id, p_patch: { title: draft.title, period: draft.period, note: draft.note || '' } });
      } catch (error) {
        if (/Bảng không hợp lệ/i.test(error.message)) throw Error('Supabase đang dùng SQL cũ nên chưa hỗ trợ bảng lương. Hãy chạy lại toàn bộ file schema.sql mới trong SQL Editor rồi thử lại.');
        throw error;
      }
      const payrollId = id || saved.upserts?.payrolls?.[0]?.id;
      const existing = (snapshot?.payrollItems || []).filter(i => i.payrollId === payrollId);
      for (const item of existing) await rpc('flow_mutate', { p_table: 'payrollItems', p_action: 'delete', p_id: item.id, p_patch: {} });
      for (const item of draft.items) await rpc('flow_mutate', { p_table: 'payrollItems', p_action: 'add', p_id: null, p_patch: { payrollId, sourceType: item.sourceType, sourceId: item.sourceId || '', title: item.title, amount: Number(item.amount) || 0 } });
      snapshot = null;
      return load(period);
    }
    if (name === 'apiToggleCheckItem') return mutate('checkItems', 'update', args[0], { done: args[1] }, period);
    if (name === 'apiSaveDailyNote') return mutate('dailyNotes', 'upsert', args[0], { date: args[0], content: args[1] }, period);
    const match = /^api(Add|Update|Delete)(Kpi|SubTask|CheckItem|UrgentTask|Leave|ResourceLink)$/.exec(name);
    if (!match) throw Error('Thao tác chưa được hỗ trợ: ' + name);
    const [, action, type] = match;
    let patch = args[1], id = args[0];
    if (action === 'Add') {
      id = null;
      patch = type === 'Kpi' ? args[0] : type === 'SubTask' ? { kpiId: args[0], title: args[1], dueDate: args[2] } : type === 'CheckItem' ? { subTaskId: args[0], title: args[1], dueDate: args[2] } : args[0];
    }
    return mutate(types[type], action.toLowerCase(), id, patch, period);
  }
};
