/** A local first-run reminder. Mounting never reads credentials or connects to a service. */
export function mountSetup(app){
 const key='paperdigest.connections-introduction.v1';
 let dismissed=false;try{dismissed=localStorage.getItem(key)==='dismissed';}catch{}
 const card=document.createElement('section');card.className='connection-introduction';card.setAttribute('aria-label','首次连接提醒');
 card.innerHTML='<h2>先连接你的资料</h2><p>备份笔记，或把论文存入 Zotero。两项可分别设置，阅读无需配置。</p><button type="button" data-connect="cloud">配置 WebDAV 备份</button><button type="button" data-connect="zotero">连接 Zotero</button><button type="button" data-dismiss-setup>以后设置</button>';
 const style=document.createElement('style');style.textContent='.connection-introduction{margin:2px 0 18px;padding:12px;border:1px solid var(--line);border-radius:9px;background:var(--surface)}.connection-introduction h2{padding:0!important;margin:0 0 7px!important;font-size:13px!important;letter-spacing:0!important;color:var(--ink)!important}.connection-introduction p{font-size:11px;line-height:1.7;color:var(--muted);margin:6px 0}.connection-introduction button{display:block;padding:5px 0;font-size:12px;color:var(--accent);width:100%;text-align:left}.connection-introduction [data-dismiss-setup]{color:var(--muted);font-size:11px}';document.head.append(style);
 card.hidden=dismissed;document.querySelector('.sidebar-content').prepend(card);
 for(const button of card.querySelectorAll('[data-connect]'))button.onclick=()=>app.call('settings.open',{pane:button.dataset.connect}).catch(app.error);
 card.querySelector('[data-dismiss-setup]').onclick=()=>{card.hidden=true;try{localStorage.setItem(key,'dismissed');}catch{}};
 return {show(){card.hidden=false;card.querySelector('[data-connect]').focus();}};
}
