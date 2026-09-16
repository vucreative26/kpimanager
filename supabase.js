import { config } from './config.js';

const keys = ['kpis','subTasks','checkItems','urgentTasks','dailyNotes','leaves','resourceLinks'];
let client, userId, snapshot, generation=0;
const empty = () => Object.fromEntries(keys.map(key=>[key,[]]));
const clone = value => JSON.parse(JSON.stringify(value));
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
async function load(period){snapshot=normalize(await rpc('flow_period',{p_period:period}));return clone(snapshot);}
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
const types={Kpi:'kpis',SubTask:'subTasks',CheckItem:'checkItems',UrgentTask:'urgentTasks',Leave:'leaves',ResourceLink:'resourceLinks',DailyNote:'dailyNotes'};
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
      { id: 'kpi-1', title: '01/ ĐÀO TẠO ĐẠI LÝ', period: currentPeriod, weight: 40, progress: 20, note: '', driveLink: '' },
      { id: 'kpi-2', title: '02/ ĐÀO TẠO NỘI BỘ', period: currentPeriod, weight: 30, progress: 0, note: '', driveLink: '' },
      { id: 'kpi-3', title: '03/ TRAINER LAMOUR', period: currentPeriod, weight: 30, progress: 0, note: '', driveLink: '' }
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
      { id: 'lea-1', type: 'Nghỉ phép', startDate: currentDate, endDate: currentDate, startTime: '08:30', endTime: '12:00', note: '[08:30 - 12:00] Nghỉ cá nhân buổi sáng' }
    ],
    resourceLinks: [
      { id: 'lnk-1', entityType: 'KPI', entityId: 'kpi-1', label: 'Tài liệu Mesotherapy', url: 'https://drive.google.com' }
    ]
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

  async verifyPassword(password) {
    if (!password) throw new Error('Vui lòng nhập mật khẩu xác nhận.');
    if (isDemoMode) {
      if (password !== 'demo' && password !== '123456') {
        throw new Error('Mật khẩu không chính xác! (Mật khẩu demo là: demo)');
      }
      return true;
    }
    if (!client) throw new Error('Chưa kết nối Supabase.');
    const { data: { user } } = await client.auth.getUser();
    if (!user || !user.email) throw new Error('Không tìm thấy thông tin tài khoản đăng nhập.');
    const { error } = await client.auth.signInWithPassword({
      email: user.email,
      password: password
    });
    if (error) throw new Error('Mật khẩu xác nhận không chính xác! Thao tác bị hủy.');
    return true;
  },

  async exportAllData() {
    if (isDemoMode) {
      return clone(loadDemoData());
    }
    if (!client || !userId) throw new Error('Vui lòng đăng nhập để xuất dữ liệu.');
    const [kpis, subTasks, checkItems, urgentTasks, dailyNotes, leaves, resourceLinks] = await Promise.all([
      client.from('flow_kpis').select('*').order('period', { ascending: false }),
      client.from('flow_sub_tasks').select('*'),
      client.from('flow_check_items').select('*'),
      client.from('flow_urgent_tasks').select('*').order('createdAt', { ascending: false }),
      client.from('flow_daily_notes').select('*').order('date', { ascending: false }),
      client.from('flow_leaves').select('*').order('startDate', { ascending: false }),
      client.from('flow_resource_links').select('*')
    ]);
    const err = kpis.error || subTasks.error || checkItems.error || urgentTasks.error || dailyNotes.error || leaves.error || resourceLinks.error;
    if (err) throw new Error(err.message);
    return {
      kpis: kpis.data || [],
      subTasks: subTasks.data || [],
      checkItems: checkItems.data || [],
      urgentTasks: urgentTasks.data || [],
      dailyNotes: dailyNotes.data || [],
      leaves: leaves.data || [],
      resourceLinks: resourceLinks.data || []
    };
  },

  async deleteScope(scope, target, period) {
    if (isDemoMode) {
      const data = loadDemoData();
      if (scope === 'month') {
        const m = target;
        const kpiIdsToDelete = data.kpis.filter(k => k.period === m).map(k => k.id);
        const subIdsToDelete = data.subTasks.filter(s => kpiIdsToDelete.includes(s.kpiId)).map(s => s.id);
        data.kpis = data.kpis.filter(k => k.period !== m);
        data.subTasks = data.subTasks.filter(s => !kpiIdsToDelete.includes(s.kpiId));
        data.checkItems = data.checkItems.filter(c => !subIdsToDelete.includes(c.subTaskId));
        data.urgentTasks = data.urgentTasks.filter(u => !(u.dueDate && u.dueDate.startsWith(m)));
        data.dailyNotes = data.dailyNotes.filter(n => !(n.date && n.date.startsWith(m)));
        data.leaves = data.leaves.filter(l => !(l.startDate && l.startDate.slice(0, 7) <= m && l.endDate && l.endDate.slice(0, 7) >= m));
      } else if (scope === 'day') {
        const d = target;
        data.dailyNotes = data.dailyNotes.filter(n => n.date !== d);
        data.urgentTasks = data.urgentTasks.filter(u => u.dueDate !== d);
        data.leaves = data.leaves.filter(l => !(l.startDate <= d && l.endDate >= d));
        data.checkItems = data.checkItems.filter(c => c.dueDate !== d);
      }
      demoData = data;
      saveDemoData();
      data.period = period;
      return clone(data);
    }
    
    if (!client || !userId) throw new Error('Vui lòng đăng nhập.');
    if (scope === 'month') {
      const m = target;
      const { data: kpis } = await client.from('flow_kpis').select('id').eq('period', m);
      for (const k of (kpis || [])) {
        await mutate('kpis', 'delete', k.id, {}, period);
      }
      const { data: notes } = await client.from('flow_daily_notes').select('id,date').gte('date', m + '-01').lt('date', m + '-32');
      for (const n of (notes || [])) {
        await mutate('dailyNotes', 'delete', n.id, {}, period);
      }
      const { data: urgents } = await client.from('flow_urgent_tasks').select('id,dueDate').gte('dueDate', m + '-01').lt('dueDate', m + '-32');
      for (const u of (urgents || [])) {
        await mutate('urgentTasks', 'delete', u.id, {}, period);
      }
      const { data: leaves } = await client.from('flow_leaves').select('id,startDate,endDate').lte('startDate', m + '-31').gte('endDate', m + '-01');
      for (const l of (leaves || [])) {
        await mutate('leaves', 'delete', l.id, {}, period);
      }
    } else if (scope === 'day') {
      const d = target;
      const { data: notes } = await client.from('flow_daily_notes').select('id').eq('date', d);
      for (const n of (notes || [])) {
        await mutate('dailyNotes', 'delete', n.id, {}, period);
      }
      const { data: urgents } = await client.from('flow_urgent_tasks').select('id').eq('dueDate', d);
      for (const u of (urgents || [])) {
        await mutate('urgentTasks', 'delete', u.id, {}, period);
      }
      const { data: leaves } = await client.from('flow_leaves').select('id').lte('startDate', d).gte('endDate', d);
      for (const l of (leaves || [])) {
        await mutate('leaves', 'delete', l.id, {}, period);
      }
      const { data: checks } = await client.from('flow_check_items').select('id').eq('dueDate', d);
      for (const c of (checks || [])) {
        await mutate('checkItems', 'delete', c.id, {}, period);
      }
    }
    return load(period);
  },

  async changed() {
    if (isDemoMode) return false;
    return snapshot && String(await rpc('flow_revision')) !== String(snapshot.revision);
  },

  async call(name, args, period) {
    if (name.includes('Gemini')) return gemini(name, args);
    
    if (isDemoMode) {
      const data = loadDemoData();
      if (name === 'getSystemData') {
        data.period = period;
        return clone(data);
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
        data.kpis.push({ id: 'kpi-' + Date.now(), title: args[0], period: args[1], weight: Number(args[2]) || 0, progress: 0, note: '', driveLink: '' });
      } else if (name === 'apiAddSubTask') {
        data.subTasks.push({ id: 'sub-' + Date.now(), kpiId: args[0], title: args[1], dueDate: args[2], progress: 0, status: 'Chưa làm', driveLink: '' });
      } else if (name === 'apiAddCheckItem') {
        data.checkItems.push({ id: 'chk-' + Date.now(), subTaskId: args[0], title: args[1], dueDate: args[2], done: false, note: '' });
      } else if (name === 'apiAddUrgentTask') {
        data.urgentTasks.push({ id: 'urg-' + Date.now(), title: args[0].title, dueDate: args[0].dueDate, kpiGroup: args[0].kpiGroup || 'Đột xuất', status: 'Chưa làm' });
      } else if (name === 'apiAddLeave') {
        data.leaves.push({ id: 'lea-' + Date.now(), ...args[0] });
      } else if (name.startsWith('apiUpdate')) {
        const type = name.replace('apiUpdate', '');
        const tableKey = types[type] || (type === 'Leave' ? 'leaves' : null);
        if (tableKey && data[tableKey]) {
          const item = data[tableKey].find(x => x.id === args[0]);
          if (item) Object.assign(item, args[1]);
        }
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
        }
      }
      demoData = data;
      saveDemoData();
      data.period = period;
      return clone(data);
    }

    if (name === 'getSystemData') return load(period);
    if (name === 'apiToggleCheckItem') return mutate('checkItems', 'update', args[0], { done: args[1] }, period);
    if (name === 'apiSaveDailyNote') return mutate('dailyNotes', 'upsert', args[0], { date: args[0], content: args[1] }, period);
    const match = /^api(Add|Update|Delete)(Kpi|SubTask|CheckItem|UrgentTask|Leave|ResourceLink)$/.exec(name);
    if (!match) throw Error('Thao tác chưa được hỗ trợ: ' + name);
    const [, action, type] = match;
    let patch = args[1], id = args[0];
    if (action === 'Add') {
      id = null;
      patch = type === 'Kpi' ? { title: args[0], period: args[1], weight: Number(args[2]) } : type === 'SubTask' ? { kpiId: args[0], title: args[1], dueDate: args[2] } : type === 'CheckItem' ? { subTaskId: args[0], title: args[1], dueDate: args[2] } : args[0];
    }
    return mutate(types[type], action.toLowerCase(), id, patch, period);
  }
};
