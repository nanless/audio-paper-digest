// Build the read-only index after it becomes visible. WebKit can retain ignored
// accessibility descendants moved from the initially hidden notes template.
// This index contains no editor; original note/annotation content stays in its
// existing store and the existing openPaper path owns opening a note.
export function renderNotesIndex({previous,personal,papers,formatTime,openNote}) {
 if(!previous?.isConnected)return null;
 const pane=document.createElement('section');
 pane.id='notes-view';pane.className=previous.className;
 pane.setAttribute('role','region');pane.setAttribute('aria-label','我的笔记');
 const header=document.createElement('header');header.className='page-heading';
 const headingGroup=document.createElement('div');
 const eyebrow=document.createElement('span');eyebrow.className='eyebrow';eyebrow.textContent='个人研究';
 const heading=document.createElement('h1');heading.textContent='我的笔记';heading.tabIndex=-1;
 const introduction=document.createElement('p');introduction.textContent='从读过的论文中，找回自己的问题和判断。';
 headingGroup.append(eyebrow,heading,introduction);header.append(headingGroup);
 const list=document.createElement('div');list.id='all-notes';pane.append(header,list);
 const notes=personal.notes||{},marks=personal.annotations||{};
 const ids=[...new Set([...Object.keys(notes),...Object.keys(marks)])].filter(id=>notes[id]?.text?.trim()||marks[id]?.length);
 ids.sort((a,b)=>(notes[b]?.updatedAt||marks[b]?.at(-1)?.updatedAt||'').localeCompare(notes[a]?.updatedAt||marks[a]?.at(-1)?.updatedAt||''));
 for(const id of ids){
  const paper=papers.find(p=>p.id===id)||personal.personalPapers?.[id],note=notes[id]||{},annotations=marks[id]||[];
  const row=document.createElement('section');row.className='task-row';
  const content=document.createElement('div'),title=document.createElement('strong'),metadata=document.createElement('p'),preview=document.createElement('p');
  title.textContent=paper?.titleZh||paper?.title||id;
  metadata.textContent=formatTime(note.updatedAt||annotations.at(-1)?.updatedAt)+' · '+annotations.length+' 处原文摘录';
  preview.textContent=(note.text||annotations[0]?.comment||annotations[0]?.text||'').slice(0,180);
  content.append(title,metadata,preview);
  const button=document.createElement('button');button.type='button';button.dataset.noteOpen=id;button.textContent='打开笔记';
  button.onclick=()=>openNote(id);row.append(content,button);list.append(row);
 }
 if(!ids.length){const empty=document.createElement('div');empty.className='empty-state';const title=document.createElement('h2'),message=document.createElement('p');title.textContent='留住你的思考';message.textContent='研究笔记、原文摘录和个人批注会按论文汇集在这里。';empty.append(title,message);list.append(empty);}
 const scroll=previous.scrollTop;previous.replaceWith(pane);pane.scrollTop=scroll;
 requestAnimationFrame(()=>{if(pane.isConnected&&!pane.hidden&&!pane.closest('[hidden],[inert]'))heading.focus({preventScroll:true});});
 return pane;
}
