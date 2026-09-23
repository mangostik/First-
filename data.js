const DATA_KEYS=['products','users','counterparties','companies','receivings','processing','timeEntries','orders','stockAdjustments','lots','movements','payments','returns','audit','recipes'];
const EDITABLE_KEYS=[...DATA_KEYS.slice(0,9),'recipes'];
const MUTATION_REFRESH={
 products:['products'],users:['users'],counterparties:['counterparties'],companies:['companies'],
 receivings:['receivings','lots','movements'],processing:['processing','lots','movements'],
 timeEntries:['timeEntries'],orders:['orders','lots','movements','payments','returns'],
 stockAdjustments:['stockAdjustments','lots','movements'],recipes:['recipes'],
 payments:['orders','payments'],returns:['orders','returns','lots','movements']
};
function emptyData(){return {...Object.fromEntries(DATA_KEYS.map(k=>[k,[]])),orderHistory:[],processingAvailability:[]};}
let snapshot=emptyData(),saving=false,pendingRequest=null;
function prepareCommand(args){
 // A failed create may already be committed. The form may generate a new UUID
 // on retry; retain both the request UUID and original entity UUID in that case.
 const logical=JSON.stringify(args.expected_version===0?{...args,entity_id:null,payload:{...args.payload,id:null}}:args);
 if(pendingRequest?.logical===logical){
   if(args.expected_version===0){args.entity_id=pendingRequest.entityId;args.payload={...args.payload,id:pendingRequest.entityId};}
 }else pendingRequest={logical,id:crypto.randomUUID(),entityId:args.entity_id};
 return {...args,request_id:pendingRequest.id};
}
async function fetchDataset(kind){
 const rows=[];
 for(let offset=0;;offset+=500){
   const page=await rpc('crm_list',{kind,offset_rows:offset,page_size:500});rows.push(...page);
   if(page.length<500)break;
 }
 return rows;
}
async function fetchOrderHistory(){
 const rows=[];
 for(let offset=0;;offset+=500){
   const page=await rpc('crm_order_history',{offset_rows:offset,page_size:500});rows.push(...page);
   if(page.length<500)break;
 }
 return rows;
}
async function fetchProcessingAvailability(){
 return rpc('crm_processing_availability');
}
async function fetchAllData(){
 const result=emptyData(),[datasets,availability]=await Promise.all([
   Promise.all(DATA_KEYS.map(fetchDataset)),fetchProcessingAvailability()
 ]);
 DATA_KEYS.forEach((kind,index)=>result[kind]=datasets[index]);
 result.processingAvailability=availability;
 result.orderHistory=await fetchOrderHistory();
 snapshot=structuredClone(result); return result;
}
async function refreshAfterMutation(kind){
 const keys=[...new Set(MUTATION_REFRESH[kind]||[kind])];
 const affectsStock=['receivings','processing','orders','stockAdjustments','returns'].includes(kind);
 const [datasets,availability]=await Promise.all([
   Promise.all(keys.map(fetchDataset)),affectsStock?fetchProcessingAvailability():Promise.resolve(null)
 ]);
 keys.forEach((key,index)=>{DB[key]=datasets[index];snapshot[key]=structuredClone(datasets[index]);});
 if(availability){DB.processingAvailability=availability;snapshot.processingAvailability=structuredClone(availability);}
 return DB;
}
async function loadData(){return fetchAllData();}
async function saveData(data){
 if(saving){showToast('Дождитесь завершения сохранения');return false;}
 const changes=[];
 for(const kind of EDITABLE_KEYS){
   const before=new Map(snapshot[kind].map(r=>[r.id,r]));
   for(const row of data[kind]){
     const old=before.get(row.id);before.delete(row.id);
     if(JSON.stringify(row)!==JSON.stringify(old))changes.push({kind,row,old,action:'save'});
   }
   for(const old of before.values())changes.push({kind,row:old,old,action:['products','users','counterparties','companies'].includes(kind)?'archive':'cancel'});
 }
 if(!changes.length)return true;
 if(changes.length!==1){DB=structuredClone(snapshot);showToast('Сохраняйте по одной записи. Обновите страницу.');return false;}
 saving=true;document.body.classList.add('saving');
 try{
   const {kind,row,old,action}=changes[0];
   const args={kind,entity_id:row.id,expected_version:old?.version||0,payload:row,action};
   await rpc('crm_command',prepareCommand(args));
   // Commit acknowledgment is separate from refreshing. Retain retry identity until refresh succeeds.
   await refreshAfterMutation(kind);pendingRequest=null;return true;
 }catch(e){DB=structuredClone(snapshot);showToast(e.message+' Если связь прервалась, повторите то же действие.');return false;}
 finally{saving=false;document.body.classList.remove('saving');}
}
async function directCommand(kind,row,action,payload=row){
 if(saving)return false;
 saving=true;document.body.classList.add('saving');
 const args={kind,entity_id:row.id,expected_version:row.version,payload,action};
 try{await rpc('crm_command',prepareCommand(args));await refreshAfterMutation(kind);pendingRequest=null;closeModal();render();showToast('Сохранено');return true;}
 catch(e){showToast(e.message);return false;}
 finally{saving=false;document.body.classList.remove('saving');}
}
async function saveAndPostStockAdjustment(row){
 DB.stockAdjustments.push(row);
 if(!await saveData(DB))return false;
 const saved=DB.stockAdjustments.find(item=>item.id===row.id);
 if(!saved){showToast('Корректировка сохранена, но не найдена после обновления');return false;}
 return directCommand('stockAdjustments',saved,'post');
}
async function closeWorkerShift(row,checkoutDate,checkoutTime){
 if(saving)return null;
 saving=true;document.body.classList.add('saving');
 const logical=JSON.stringify({entity_id:row.id,expected_version:row.version,checkout_date:checkoutDate,checkout_time:checkoutTime,action:'close_shift'});
 if(pendingRequest?.logical!==logical)pendingRequest={logical,id:crypto.randomUUID(),entityId:row.id};
 try{
  const result=await rpc('crm_close_shift',{request_id:pendingRequest.id,entity_id:row.id,expected_version:row.version,checkout_date:checkoutDate,checkout_time:checkoutTime});
  await refreshAfterMutation('timeEntries');pendingRequest=null;return result;
 }catch(e){showToast(e.message);return null;}
 finally{saving=false;document.body.classList.remove('saving');}
}
async function manageShift(row,action,payload={}){
 if(saving)return false;
 saving=true;document.body.classList.add('saving');
 const logical=JSON.stringify({entity_id:row.id,expected_version:row.version,action,payload});
 if(pendingRequest?.logical!==logical)pendingRequest={logical,id:crypto.randomUUID(),entityId:row.id};
 try{
  await rpc('crm_manage_shift',{request_id:pendingRequest.id,entity_id:row.id,expected_version:row.version,action,payload});
  await refreshAfterMutation('timeEntries');pendingRequest=null;closeModal();render();showToast(action==='archive'?'Смена удалена из журнала':'Смена сохранена');return true;
 }catch(e){showToast(e.message);return false;}
 finally{saving=false;document.body.classList.remove('saving');}
}
async function fulfillOrder(row){
 if(saving)return false;
 saving=true;document.body.classList.add('saving');
 const logical=JSON.stringify({entity_id:row.id,expected_version:row.version,action:'fulfill_order'});
 if(pendingRequest?.logical!==logical)pendingRequest={logical,id:crypto.randomUUID(),entityId:row.id};
 try{
  await rpc('crm_fulfill_order',{request_id:pendingRequest.id,entity_id:row.id,expected_version:row.version});
  await refreshAfterMutation('orders');pendingRequest=null;render();showToast('Заказ исполнен, остатки списаны');return true;
 }catch(e){render();openModal(`<h2>Заказ не исполнен</h2><p>${esc(e.message)}</p><div class="modal-actions"><button type="button" class="btn-primary" id="fulfillErrorOk">Понятно</button></div>`);document.getElementById('fulfillErrorOk').onclick=closeModal;return false;}
 finally{saving=false;document.body.classList.remove('saving');}
}
async function reverseDocument(kind,row,reason){
 if(saving)return;
 saving=true;document.body.classList.add('saving');
 const logical=JSON.stringify({kind,entity_id:row.id,expected_version:row.version,reason,action:'reverse'});
 if(pendingRequest?.logical!==logical)pendingRequest={logical,id:crypto.randomUUID(),entityId:row.id};
 try{
   await rpc('crm_reverse_document',{request_id:pendingRequest.id,kind,entity_id:row.id,expected_version:row.version,reason});
   await refreshAfterMutation(kind);pendingRequest=null;closeModal();render();showToast('Проведение отменено, склад восстановлен');
 }catch(e){showToast(e.message);}
 finally{saving=false;document.body.classList.remove('saving');}
}
async function archiveDocument(kind,row,reason='Ошибочная запись удалена владельцем'){
 if(saving)return;
 saving=true;document.body.classList.add('saving');
 const logical=JSON.stringify({kind,entity_id:row.id,expected_version:row.version,reason,action:'archive_document'});
 if(pendingRequest?.logical!==logical)pendingRequest={logical,id:crypto.randomUUID(),entityId:row.id};
 try{
   await rpc('crm_archive_document',{request_id:pendingRequest.id,kind,entity_id:row.id,expected_version:row.version,reason});
   await refreshAfterMutation(kind);
   if(kind==='orders'){DB.orderHistory=await fetchOrderHistory();snapshot.orderHistory=structuredClone(DB.orderHistory);}
   pendingRequest=null;closeModal();render();showToast('Ошибочная запись удалена из списка');
 }catch(e){showToast(e.message);}
 finally{saving=false;document.body.classList.remove('saving');}
}
const VIEW_ROLES={
 owner:['dashboard','receiving','processing','warehouse','workers','counterparties','orders','productReport','marketing','products','audit','recipes'],
 partner:['dashboard','receiving','processing','warehouse','workers','counterparties','orders','productReport','marketing','products','audit','recipes'],
 manager:['dashboard','counterparties','orders','productReport','warehouse'],
 worker:['workerMenu','receiving','clock','myReceivings','myWallet','processingWorker']
};
function canView(view){return VIEW_ROLES[getUser(session.userId)?.role]?.includes(view);}
function isPosted(o){return ['posted','completed'].includes(o.status);}
function receivedPayment(o){return DB.payments.filter(p=>p.order_id===o.id).reduce((s,p)=>s+Number(p.amount),0);}
function returnedValue(o){return DB.returns.filter(r=>r.order_id===o.id).reduce((s,r)=>s+Number(r.net_amount)+Number(r.vat_amount),0);}
function debt(o){if(!isPosted(o))return 0;return Math.max(0,orderGrandTotal(o)-returnedValue(o)-receivedPayment(o));}
