import {Schema} from 'prosemirror-model';
import {EditorState,Plugin,TextSelection} from 'prosemirror-state';
import {EditorView,Decoration,DecorationSet} from 'prosemirror-view';
import {history,undo,redo,closeHistory} from 'prosemirror-history';
import {keymap} from 'prosemirror-keymap';
import {baseKeymap} from 'prosemirror-commands';

// The document is always the original plain prompt. Chips are decorations, so
// catalog updates and composition never rewrite text or remap its undo history.
const schema=new Schema({nodes:{doc:{content:'text*',whitespace:'pre'},text:{}}});
export function install(textarea){
  if(!textarea||textarea.tagName!=='TEXTAREA')return;
  const editor=document.createElement('div');
  for(const {name,value} of textarea.attributes)if(!['rows','placeholder'].includes(name))editor.setAttribute(name,value);
  editor.setAttribute('role','textbox');editor.setAttribute('aria-multiline','true');editor.setAttribute('aria-labelledby',textarea.labels?.[0]?.id||'new-tab-prompt-label');
  editor.dataset.placeholder=textarea.placeholder;textarea.replaceWith(editor);
  let skills=new Map(),agent='',renderChip,disabled=textarea.disabled,view,compositionFrom=0;
  function tokens(doc,currentSelection=view?.state.selection){
    const result=[];
    // Backtick spans and fences stay ordinary text, including any $ inside them.
    for(const match of doc.textContent.matchAll(/(`{1,3})[\s\S]*?\1|(^|\s)([$/])([a-zA-Z0-9][\w:.-]*)(?=\s|$)/g)){
      if(match[1]||match[3]==='/'&&agent!=='claude')continue;
      const skill=skills.get(match[4]);if(!skill)continue;
      const from=match.index+match[2].length,raw=match[3]+match[4];
      if(view?.composing&&from<=Math.max(compositionFrom,currentSelection.head)&&from+raw.length>=Math.min(compositionFrom,currentSelection.from))continue;
      result.push({from,to:from+raw.length,raw,skill,label:skill.displayName?.trim()||skill.name.split(':').pop()});
    }return result;
  }
  function selection(doc,anchor,head=anchor){
    anchor=Math.max(0,Math.min(anchor,doc.content.size));head=Math.max(0,Math.min(head,doc.content.size));
    let from=Math.min(anchor,head),to=Math.max(anchor,head);
    for(const token of tokens(doc,{from,head:to})){
      if(from===to&&from>token.from&&from<token.to){from=to=from-token.from<(token.to-token.from)/2?token.from:token.to;}
      else{if(from>token.from&&from<token.to)from=token.from;if(to>token.from&&to<token.to)to=token.to;}
    }return TextSelection.create(doc,anchor<=head?from:to,anchor<=head?to:from);
  }
  const mentions=new Plugin({
    props:{decorations(state){return DecorationSet.create(state.doc,tokens(state.doc,state.selection).flatMap(token=>[
      Decoration.widget(token.from,()=>{const chip=renderChip(token.skill,token.raw);chip.tabIndex=-1;chip.classList.toggle('ProseMirror-selectednode',state.selection.from<=token.from&&state.selection.to>=token.to);return chip;},{side:1,key:JSON.stringify([token.raw,token.label,token.skill.description,state.selection.from<=token.from&&state.selection.to>=token.to]),stopEvent:event=>event.type==='click'}),
      // Keep normal font metrics for the native caret, but give each ASCII source
      // character zero advance. Only the chip is visible; the text stays editable.
      Decoration.inline(token.from,token.to,{class:'skill-editor-source',style:'font-family:monospace;letter-spacing:-1ch;color:transparent;caret-color:var(--nt-text)','aria-hidden':'true'}),
    ]));}},
    appendTransaction(transactions,old,state){const next=selection(state.doc,state.selection.anchor,state.selection.head);return next.eq(state.selection)?null:state.tr.setSelection(next);},
  });
  const newline=(state,dispatch)=>{dispatch?.(state.tr.insertText('\n').scrollIntoView());return true;};
  const deleteSkill=backward=>(state,dispatch)=>{
    if(!state.selection.empty)return false;
    const token=tokens(state.doc).find(token=>(backward?token.to:token.from)===state.selection.from);if(!token)return false;
    dispatch?.(closeHistory(state.tr).delete(token.from,token.to));return true;
  };
  const moveSkill=(backward,extend)=>(state,dispatch)=>{
    if(!extend&&!state.selection.empty)return false;
    const token=tokens(state.doc).find(token=>(backward?token.to:token.from)===state.selection.head);if(!token)return false;
    const pos=backward?token.from:token.to;dispatch?.(state.tr.setSelection(TextSelection.create(state.doc,extend?state.selection.anchor:pos,pos)));return true;
  };
  const plugins=[mentions,history(),keymap({'Mod-z':undo,'Shift-Mod-z':redo,'Mod-y':redo,'Enter':newline,'Shift-Enter':newline,
    'Backspace':deleteSkill(true),'Delete':deleteSkill(false),'ArrowLeft':moveSkill(true,false),'ArrowRight':moveSkill(false,false),
    'Shift-ArrowLeft':moveSkill(true,true),'Shift-ArrowRight':moveSkill(false,true)}),keymap(baseKeymap)];
  const stateFor=text=>EditorState.create({schema,doc:schema.nodes.doc.create(null,text?schema.text(text):null),plugins});
  function placeholder(){editor.dataset.empty=String(!view.state.doc.content.size);}
  view=new EditorView({mount:editor},{state:stateFor(textarea.value),editable:()=>!disabled,
    handleDOMEvents:{
      // Let the completion menu, popover and containing dialog handle Escape.
      keydown:(view,event)=>event.key==='Escape',
      compositionstart(view){compositionFrom=view.state.selection.from;return false;},
    },
    clipboardTextSerializer:slice=>slice.content.textBetween(0,slice.content.size),
    handlePaste(view,event){if(event.clipboardData?.files.length)return false;const text=event.clipboardData?.getData('text/plain');if(text===undefined)return false;view.dispatch(closeHistory(view.state.tr).insertText(text.replace(/\r\n?/g,'\n')).scrollIntoView());return true;},
    // The form owns file drops. Suppress ProseMirror's text/URL insertion first.
    handleDrop:(view,event)=>!!event.dataTransfer?.files.length,
    dispatchTransaction(tr){if(tr.getMeta('uiEvent')==='cut')closeHistory(tr);const previous=view.state.doc;view.updateState(view.state.apply(tr));placeholder();if(!previous.eq(view.state.doc))editor.dispatchEvent(new Event('input',{bubbles:true}));},
  });
  Object.defineProperties(editor,{
    value:{get:()=>view.state.doc.textContent,set:value=>{view.updateState(stateFor(String(value??'').replace(/\r\n?/g,'\n')));placeholder();}},
    selectionStart:{get:()=>view.state.selection.from},selectionEnd:{get:()=>view.state.selection.to},
    disabled:{get:()=>disabled,set:value=>{disabled=!!value;view.setProps({editable:()=>!disabled});editor.setAttribute('aria-disabled',String(disabled));}},
    placeholder:{get:()=>editor.dataset.placeholder,set:value=>{editor.dataset.placeholder=value;}},
  });
  editor.setSelectionRange=(start,end=start)=>view.dispatch(view.state.tr.setSelection(selection(view.state.doc,start,end)));
  editor.select=()=>editor.setSelectionRange(0,editor.value.length);
  editor.setRangeText=(text,start=editor.selectionStart,end=editor.selectionEnd,mode='preserve')=>{
    const oldStart=editor.selectionStart,oldEnd=editor.selectionEnd,tr=closeHistory(view.state.tr).insertText(text,start,end);
    const a=mode==='end'?start+text.length:mode==='start'||mode==='select'?start:oldStart,
      b=mode==='select'||mode==='end'?start+text.length:mode==='start'?start:oldEnd;
    tr.setSelection(selection(tr.doc,a,b));view.dispatch(tr);
  };
  editor.setSkillCatalog=(items,provider,render)=>{
    const next=new Map(items.map(item=>[item.name,item]));
    if(agent===provider&&next.size===skills.size&&[...next].every(([name,item])=>skills.get(name)===item))return;
    skills=next;agent=provider;renderChip=render;view.dispatch(view.state.tr.setMeta('addToHistory',false));
  };
  editor.addEventListener('compositionend',()=>setTimeout(()=>view.dispatch(view.state.tr.setMeta('addToHistory',false)),0));
  placeholder();return editor;
}
