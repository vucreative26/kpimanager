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
const types={Kpi:'kpis',SubTask:'subTasks',CheckItem:'checkItems',UrgentTask:'urgentTasks',Leave:'leaves',ResourceLink:'resourceLinks'};
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
export const backend={
  async initialize(onSession){
    if(!/^https:\/\//.test(config.supabaseUrl)||config.supabaseUrl.includes('YOUR_PROJECT')||!config.supabaseKey||config.supabaseKey.includes('YOUR_'))throw Error('Chưa cấu hình Supabase. Mở config.js và điền Project URL cùng publishable key, sau đó tải lại trang.');
    const {createClient}=await import('https://esm.sh/@supabase/supabase-js@2.57.4');
    client=createClient(config.supabaseUrl,config.supabaseKey);
    function update(session){const next=session?.user.id||null;if(next===userId)return;userId=next;generation++;snapshot=null;setTimeout(()=>{Promise.resolve(onSession(session)).catch(error=>console.error(error));},0);}
    client.auth.onAuthStateChange((_event,session)=>update(session));
    const {data,error}=await client.auth.getSession();if(error)throw error;update(data.session);
  },
  async signIn(email,password){const {error}=await client.auth.signInWithPassword({email:email.trim(),password});if(error)throw error;},
  async signOut(){const {error}=await client.auth.signOut({scope:'local'});if(error)throw error;},
  async changed(){return snapshot&&String(await rpc('flow_revision'))!==String(snapshot.revision);},
  async call(name,args,period){
    if(name.includes('Gemini'))return gemini(name,args);
    if(name==='getSystemData')return load(period);
    if(name==='apiToggleCheckItem')return mutate('checkItems','update',args[0],{done:args[1]},period);
    if(name==='apiSaveDailyNote')return mutate('dailyNotes','upsert',args[0],{date:args[0],content:args[1]},period);
    const match=/^api(Add|Update|Delete)(Kpi|SubTask|CheckItem|UrgentTask|Leave|ResourceLink)$/.exec(name);
    if(!match)throw Error('Thao tác chưa được hỗ trợ: '+name);
    const [,action,type]=match;let patch=args[1],id=args[0];
    if(action==='Add'){
      id=null;
      patch=type==='Kpi'?{title:args[0],period:args[1],weight:Number(args[2])}:type==='SubTask'?{kpiId:args[0],title:args[1],dueDate:args[2]}:type==='CheckItem'?{subTaskId:args[0],title:args[1],dueDate:args[2]}:args[0];
    }
    return mutate(types[type],action.toLowerCase(),id,patch,period);
  }
};
