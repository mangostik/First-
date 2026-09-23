'use strict';
function getAuthLinkType() {
 if (typeof location === 'undefined') return '';
 const source=`${location.search||''}&${String(location.hash||'').replace(/^#/,'')}`;
 const match=source.match(/(?:^|[?&#])type=([^&#]+)/);
 try { return match ? decodeURIComponent(match[1]) : ''; } catch { return ''; }
}
window.FISHCRM_AUTH_LINK_TYPE=getAuthLinkType();
function stockSaleValue(product, quantity) {
 const factor=Number(product.packageFactor);
 return Number.isFinite(factor)&&factor>0 ? Number(quantity)/factor*Number(product.sellPrice||0) : null;
}
function esc(value) { return String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function safeHTML(value) { return DOMPurify.sanitize(String(value ?? ''), {FORBID_TAGS:['script','iframe','object','embed'],FORBID_ATTR:['srcdoc']}); }
function safeImage(value) { try { const u=new URL(value); return u.protocol==='https:' ? u.href : ''; } catch { return ''; } }
function makeClient() {
 const c=window.FISHCRM_CONFIG;
 if (!c?.supabaseUrl || !c?.publishableKey) return null;
 return window.supabase.createClient(c.supabaseUrl,c.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
}
async function rpc(name,args={}) {
 if (!sb) throw new Error('Укажите настройки подключения в config.js');
 const {data,error}=await sb.rpc(name,args);
 if(error) { let message=error.message; try { const detail=JSON.parse(message); message=detail.message; } catch {} throw new Error(message||'Не удалось выполнить операцию'); }
 return data;
}
