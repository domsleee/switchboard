// Shows the image and video paths on screen as thumbnails, without a hover. Zellij owns every
// row, so a thumbnail sits over the blank cells to the right of its path and never covers text.
(() => {
  const minRows=3,minCols=12,gap=2;
  // As tall as half the terminal allows, so a screenshot is readable at a glance.
  const maxRows=rows=>Math.min(24,Math.max(8,Math.floor(rows/2)));
  // Settings → Terminal thumbnails, off by default.
  const setting='switchboard-media-thumbnails';
  const enabled=()=>{try{return localStorage.getItem(setting)==='true';}catch{return false;}};
  // The cells a row's text uses, ignoring a pane frame's right edge.
  const used=text=>text.replace(/\s+$/,'').replace(/[│┃║]$/,'').replace(/\s+$/,'').length;
  const aspects=new Map(),failed=new Map(),located=new Map();
  const retryMs=10000;

  // Where each media path on screen ends, as {path, relative, row}, in screen order.
  function pathsOnScreen(rows,wrapped,cols,media){
    const found=[],seen=new Set();
    for(let row=0;row<rows.length;){
      let end=row+1;
      while(end<rows.length&&wrapped[end])end++;
      // Wrapped rows join at full width so a match index maps back to its row.
      const line=end>row+1?rows.slice(row,end).map(text=>text.padEnd(cols).slice(0,cols)).join(''):rows[row];
      for(const match of media.paths(line)){
        if(seen.has(match.text))continue;
        seen.add(match.text);
        found.push({path:match.text,relative:!!match.relative,row:row+Math.floor((match.index+match.text.length-1)/cols)});
      }
      row=end;
    }
    return found;
  }

  // Thumbnails for paths on consecutive rows share a band to the right of all of them.
  // Returns [{path, row, col, rows, cols}] in cells; paths with no room are left to hover.
  function layout(paths,rows,cols,cell,aspectOf){
    const ends=rows.map(used),limit=cols-2,boxes=[];
    let band=null;
    for(const {path,row} of paths){
      const aspect=aspectOf(path)||1.6;
      const want=height=>Math.max(minCols,Math.ceil(height*cell.height*aspect/cell.width));
      if(band&&row<band.row+band.rows){
        const col=band.next;
        if(col+minCols>limit)continue;
        const width=Math.min(want(band.rows),limit-col);
        boxes.push({path,row:band.row,col,rows:band.rows,cols:width});
        band.next=col+width+1;
        continue;
      }
      let height=0,col=0;
      while(height<maxRows(rows.length)&&row+height<rows.length){
        const next=Math.max(col,ends[row+height]+gap);
        if(next+minCols>limit)break;
        col=next;height++;
      }
      if(height<minRows)continue;
      const width=Math.min(want(height),limit-col);
      boxes.push({path,row,col,rows:height,cols:width});
      band={row,rows:height,next:col+width+1};
    }
    return boxes;
  }

  function start(term,media){
    const screen=term.element?.querySelector('.xterm-screen');
    if(!screen)return false;
    const layer=document.createElement('div');
    layer.className='switchboard-thumbnails';
    layer.style.cssText='position:absolute;inset:0;pointer-events:none;z-index:5;overflow:hidden';
    screen.append(layer);
    const shown=new Map();
    let frame=0;
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(()=>{frame=0;update();});};

    // A relative path is shown once the relay finds it in one of this session's pane folders.
    function resolve(entry){
      if(!entry.relative)return entry.path;
      const known=located.get(entry.path);
      if(known?.path!==undefined&&(known.path||Date.now()-known.at<retryMs))return known.path;
      if(!known?.pending){
        located.set(entry.path,{pending:true,path:known?.path});
        media.locate(entry.path).then(found=>{located.set(entry.path,{path:found,at:Date.now()});schedule();});
      }
      return known?.path||null;
    }

    function element(path){
      const box=document.createElement('div'),video=media.isVideo(path);
      const item=document.createElement(video?'video':'img');
      if(video)Object.assign(item,{muted:true,autoplay:true,loop:true,playsInline:true});else item.alt=path;
      item.style.cssText='display:block;width:100%;height:100%;object-fit:contain;object-position:left top';
      box.title=path;
      box.style.cssText='position:absolute;pointer-events:auto;cursor:pointer;border-radius:4px;overflow:hidden';
      const loaded=()=>{
        const width=item.naturalWidth||item.videoWidth,height=item.naturalHeight||item.videoHeight;
        if(width&&height&&aspects.get(path)!==width/height){aspects.set(path,width/height);schedule();}
      };
      item.addEventListener(video?'loadedmetadata':'load',loaded);
      item.onerror=()=>{failed.set(path,Date.now());schedule();};
      item.src=media.url(path);
      // The click belongs to the thumbnail, not to Zellij or a text selection under it.
      for(const type of ['mousedown','mouseup','pointerdown','pointerup'])box.addEventListener(type,event=>event.stopPropagation());
      box.addEventListener('click',event=>{event.stopPropagation();event.preventDefault();media.open(path);});
      box.append(item);
      return box;
    }

    function update(){
      const cell=term._core?._renderService?.dimensions?.css?.cell;
      let boxes=[];
      if(enabled()&&cell?.width&&cell?.height){
        const buffer=term.buffer.active,rows=[],wrapped=[];
        for(let row=0;row<term.rows;row++){
          const line=buffer.getLine(buffer.viewportY+row);
          rows.push(line?.translateToString(true)||'');wrapped.push(!!line?.isWrapped&&row>0);
        }
        const paths=[];
        for(const entry of pathsOnScreen(rows,wrapped,term.cols,media)){
          const path=resolve(entry);
          if(!path)continue;
          const failedAt=failed.get(path);
          if(failedAt&&Date.now()-failedAt<retryMs)continue;
          failed.delete(path);
          paths.push({path,row:entry.row});
        }
        boxes=layout(paths,rows,term.cols,cell,path=>aspects.get(path));
      }
      const keep=new Set(boxes.map(box=>box.path));
      for(const [path,box] of shown)if(!keep.has(path)){box.remove();shown.delete(path);}
      for(const box of boxes){
        let node=shown.get(box.path);
        if(!node){node=element(box.path);shown.set(box.path,node);layer.append(node);}
        Object.assign(node.style,{left:`${box.col*cell.width}px`,top:`${box.row*cell.height}px`,
          width:`${box.cols*cell.width}px`,height:`${box.rows*cell.height}px`});
      }
    }
    term.onRender?.(schedule);term.onScroll?.(schedule);term.onResize?.(schedule);
    // The Settings toggle lives in the Switchboard page, which shares this frame's storage.
    window.addEventListener('storage',event=>{if(event.key===setting)schedule();});
    schedule();
    return true;
  }

  const timer=setInterval(()=>{
    const term=window.term,media=window.__switchboardMedia;
    if(term&&media&&start(term,media))clearInterval(timer);
  },25);
  window.__switchboardThumbnails={pathsOnScreen,layout};
})();
