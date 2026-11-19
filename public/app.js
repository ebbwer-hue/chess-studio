const $=id=>document.getElementById(id);
const symbols={w:{k:'♚',q:'♛',r:'♜',b:'♝',n:'♞',p:'♟'},b:{k:'♚',q:'♛',r:'♜',b:'♝',n:'♞',p:'♟'}};
let state,history=[],start=null,verbose=[],selected=null,flipped=false,mode='play',side='w',busy=false,revision=0,analysing=false,analysisPending=false,lastBest=null;
let reviewSource=null,reviewResults=[],reviewRun=0,reviewRunning=false,replayToken=0,profileTimer;
const analysisOptions=()=>({elo:$('analysisFull').checked?null:Number($('analysisEloNumber').value),style:$('analysisStyle').value,human:$('analysisHuman').value});
async function api(endpoint,data={}){const r=await fetch('/api/'+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const json=await r.json();if(!r.ok)throw Error(json.error||'Ошибка сервера');return json;}
const payload=()=>({start,history:[...history]});
function toast(message){$('toast').textContent=message;$('toast').style.display='block';clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').style.display='none',4500);}
function fail(e){toast(e.message);}
function drawBestArrow(force=false){
  const visible=lastBest&&!state.over&&($('showArrow').checked||force);
  $('bestArrow').toggleAttribute('hidden',!visible);
  $('bestMoveLabel').textContent=lastBest?lastBest.slice(0,2)+' → '+lastBest.slice(2,4):'Ждём анализ';
  if(!visible)return;
  const point=sq=>{let file=sq.charCodeAt(0)-97,rank=8-Number(sq[1]);if(flipped){file=7-file;rank=7-rank;}return [file*100+50,rank*100+50];};
  const a=point(lastBest.slice(0,2)),b=point(lastBest.slice(2,4));
  const piece=state.pieces.find(p=>p.square===lastBest.slice(0,2));
  const d=piece?.type==='n'?`M${a[0]},${a[1]} L${a[0]},${b[1]} L${b[0]},${b[1]}`:`M${a[0]},${a[1]} L${b[0]},${b[1]}`;
  $('arrowPath').setAttribute('d',d);$('bestArrow').setAttribute('aria-label','Лучший ход '+$('bestMoveLabel').textContent);
}
function render(){
  const board=$('board');board.replaceChildren();
  const files=flipped?'hgfedcba':'abcdefgh';const ranks=flipped?'12345678':'87654321';
  const legal=state.moves.filter(m=>m.from===selected).map(m=>m.to);
  for(let row=0;row<8;row++)for(let col=0;col<8;col++){
    const sq=files[col]+ranks[row],piece=state.pieces.find(p=>p.square===sq),btn=document.createElement('button');
    btn.className='square'+((files.charCodeAt(col)-97+Number(ranks[row]))%2===1?' dark':'');
    btn.dataset.square=sq;btn.setAttribute('role','gridcell');
    const names={k:'король',q:'ферзь',r:'ладья',b:'слон',n:'конь',p:'пешка'};
    btn.setAttribute('aria-label',sq+(piece?' '+(piece.color==='w'?'белые, ':'чёрные, ')+names[piece.type]:''));
    if(verbose.length&&[verbose.at(-1).from,verbose.at(-1).to].includes(sq))btn.classList.add('last');
    if(sq===selected)btn.classList.add('selected');if(legal.includes(sq))btn.classList.add('legal');
    if(piece?.type==='k'&&piece.color===state.turn&&state.check)btn.classList.add('check');
    if(piece){const span=document.createElement('span');span.className='piece '+(piece.color==='w'?'white':'black');span.textContent=symbols[piece.color][piece.type];btn.append(span);}
    if(col===0){const span=document.createElement('span');span.className='coordinate rank';span.textContent=ranks[row];btn.append(span);}
    if(row===7){const span=document.createElement('span');span.className='coordinate file';span.textContent=files[col];btn.append(span);}
    btn.onclick=()=>clickSquare(sq);board.append(btn);
  }
  $('status').textContent=state.status;$('fen').value=state.fen;
  const opponentName=$('style').value==='tal'?'В стиле Таля':'Stockfish';
  $('thinking').textContent=busy?opponentName+' думает…':state.over?'Партия завершена':mode==='analysis'?'Режим разбора':'Готов к игре';
  $('undo').disabled=busy||!history.length;$('new').disabled=busy;$('side').disabled=busy;
  const topColor=flipped?'w':'b',topIsPlayer=topColor===side;
  $('topName').textContent=mode==='analysis'?(topColor==='w'?'Белые':'Чёрные'):topIsPlayer?'Вы':opponentName;
  $('bottomName').textContent=mode==='analysis'?(topColor==='w'?'Чёрные':'Белые'):topIsPlayer?opponentName:'Вы';
  $('topSub').textContent=mode==='analysis'?'Свободный разбор':topIsPlayer?'Ваши фигуры':'Соперник · '+$('elo').value+' Elo';
  $('bottomSub').textContent=mode==='analysis'?'Свободный разбор':topIsPlayer?'Соперник · '+$('elo').value+' Elo':side==='w'?'Белые фигуры':'Чёрные фигуры';
  $('history').replaceChildren();
  if(!history.length){const p=document.createElement('p');p.className='muted empty';p.textContent='Ваша история начнётся с первого хода.';$('history').append(p);}
  let row;
  (reviewSource?.verbose||verbose).forEach((move,i)=>{
    if(move.color==='w'||i===0){row=document.createElement('div');row.className='history-line';const n=document.createElement('span');n.textContent=move.before.split(' ')[5]+'.';row.append(n);if(move.color==='b'){row.append(document.createElement('b'));}$('history').append(row);}
    const text=document.createElement('button');text.className='history-move';text.textContent=move.san;if(i===history.length-1)text.classList.add('latest');text.onclick=()=>navigateReview(i+1).catch(fail);row.append(text);
  });
  $('history').scrollTop=$('history').scrollHeight;$('moveCount').textContent=history.length+' полуходов';
  drawBestArrow();
  renderReviewNavigation();
}
function stopReview(){reviewRun++;reviewRunning=false;$('stopReview').hidden=true;$('reviewGame').disabled=false;$('reviewProgress').textContent=reviewResults.length?'Остановлено':'Готов';}
function invalidateReview(){stopReview();reviewSource=null;reviewResults=[];renderReviewResults();}
function renderReviewNavigation(){const total=reviewSource?.history.length||history.length;$('reviewPosition').textContent=history.length+' / '+total;$('reviewStart').disabled=$('reviewPrev').disabled=busy||!history.length;$('reviewNext').disabled=$('reviewEnd').disabled=busy||history.length>=total;}
function renderReviewResults(){
  $('reviewList').replaceChildren();
  const counts={blunder:0,mistake:0,inaccuracy:0};for(const r of reviewResults)if(r.grade.key in counts)counts[r.grade.key]++;
  $('reviewSummary').textContent=reviewResults.length?`Проверено: ${reviewResults.length} · Неточностей: ${counts.inaccuracy} · Ошибок: ${counts.mistake} · Грубых: ${counts.blunder}`:'';
  reviewResults.forEach((r,i)=>{const button=document.createElement('button');button.className='review-item '+r.grade.key+(reviewSource&&history.length===i?' current':'');const move=document.createElement('b');move.textContent=(r.fen.split(' ')[5])+(r.color==='w'?'. ':'… ')+r.san;const grade=document.createElement('span');grade.textContent=r.grade.label;const detail=document.createElement('small');detail.textContent='Потеря оценки: '+(r.loss/100).toFixed(2)+(r.suggestion?' · Совет: '+r.suggestion.moves[0]:'')+(r.reason?' · '+r.reason.join(', '):'');button.append(move,grade,detail);button.onclick=()=>navigateReview(i).catch(fail);$('reviewList').append(button);});
}
async function navigateReview(index){
  if(busy)return;
  if(!reviewSource)reviewSource={...payload(),verbose:[...verbose]};
  const target=Math.max(0,Math.min(reviewSource.history.length,index)),token=++replayToken;
  const snapshot=reviewSource;const result=await api('state',{start:snapshot.start,history:snapshot.history.slice(0,target)});
  if(token!==replayToken||snapshot!==reviewSource)return;
  history=snapshot.history.slice(0,target);verbose=snapshot.verbose.slice(0,target);state=result;selected=null;
  setMode('analysis');positionChanged();renderReviewResults();
}
async function reviewWholeGame(){
  if(busy||reviewRunning)return;
  if(!reviewSource)reviewSource={...payload(),verbose:[...verbose]};
  if(!reviewSource.history.length){toast('Сначала сыграйте партию или откройте PGN.');return;}
  const source=reviewSource,token=++reviewRun,options=analysisOptions();reviewResults=[];reviewRunning=true;$('reviewGame').disabled=true;$('stopReview').hidden=false;renderReviewResults();
  try{for(let i=0;i<source.history.length;i++){
    if(token!==reviewRun)break;$('reviewProgress').textContent=(i+1)+' / '+source.history.length;
    const result=await api('review-move',{start:source.start,history:source.history.slice(0,i),move:source.history[i],...options,time:450});
    if(token!==reviewRun)break;reviewResults.push(result);renderReviewResults();
  }
  if(token===reviewRun)$('reviewProgress').textContent='Готово · '+reviewResults.length+' ходов';
  }catch(e){if(token===reviewRun){$('reviewProgress').textContent='Ошибка';fail(e);}}finally{if(token===reviewRun){reviewRunning=false;$('stopReview').hidden=true;$('reviewGame').disabled=false;}}
}
async function promote(color){const dlg=$('promotion');$('promotionChoices').replaceChildren();return new Promise(resolve=>{let settled=false;function finish(v){if(settled)return;settled=true;dlg.close();resolve(v);}for(const type of ['q','r','b','n']){const b=document.createElement('button');b.textContent=symbols[color][type];b.setAttribute('aria-label',({q:'Ферзь',r:'Ладья',b:'Слон',n:'Конь'})[type]);b.onclick=()=>finish(type);$('promotionChoices').append(b);}dlg.oncancel=e=>{e.preventDefault();finish(null);};dlg.showModal();});}
async function clickSquare(square){
  if(busy||state.over||(mode==='play'&&state.turn!==side))return;
  if(selected&&state.moves.some(m=>m.from===selected&&m.to===square)){
    const from=selected;let promotion;
    if(state.moves.some(m=>m.from===from&&m.to===square&&m.promotion)){promotion=await promote(state.turn);if(!promotion)return;}
    busy=true;render();
    try{const result=await api('move',{...payload(),move:{from,to:square,promotion}});invalidateReview();history.push(result.move.san);verbose.push(result.move);state=result;selected=null;positionChanged();}catch(e){fail(e);}finally{busy=false;render();}
    await maybeComputer();return;
  }
  const piece=state.pieces.find(p=>p.square===square);selected=piece?.color===state.turn?(selected===square?null:square):null;render();
}
function resetEvaluation(){lastBest=null;$('score').textContent='…';$('advantage').textContent='Оценка ожидает анализа';$('depth').textContent='Ожидание';$('evalnumber').textContent='—';$('variations').replaceChildren();}
function positionChanged(){revision++;resetEvaluation();render();if($('auto').checked)analyse();}
async function maybeComputer(){
  if(mode!=='play'||state.over||state.turn===side||busy)return;
  if(reviewSource)invalidateReview();
  busy=true;render();
  try{
    const began=performance.now();
    const result=await api('play',{...payload(),elo:Number($('elo').value),style:$('style').value,human:$('human').value,humanTiming:$('humanTiming').checked});
    const pause=Math.max(0,(result.thinkMs||0)-(performance.now()-began));
    if(pause)await new Promise(resolve=>setTimeout(resolve,pause));
    state=result;if(result.move){history.push(result.move.san);verbose.push(result.move);}
    $('styleReason').hidden=!result.styleInfo;if(result.styleInfo)$('styleReason').textContent=result.move.san+' · '+result.styleInfo.reasons.join(', ');
    $('humanReason').hidden=!result.humanInfo;if(result.humanInfo)$('humanReason').textContent='Живой соперник: '+result.humanInfo.reason.toLowerCase()+'.';
    positionChanged();
  }catch(e){fail(e);}finally{busy=false;render();}
}
function scoreText(line){return line.type==='mate'?(line.value>=0?'+M':'−M')+Math.abs(line.value):(line.value>=0?'+':'')+(line.value/100).toFixed(2);}
async function analyse(){
  if(analysing){analysisPending=true;return;}
  const rev=revision;analysing=true;analysisPending=false;$('analyse').disabled=true;$('depth').textContent='Считает…';
  try{
    const result=await api('analyse',{fen:state.fen,time:Number($('time').value),...analysisOptions()});
    if(rev!==revision){analysisPending=analysisPending||$('auto').checked;return;}
    const first=result.lines[0];$('variations').replaceChildren();
    if(first){
      lastBest=result.best||first.uci;drawBestArrow();$('score').textContent=scoreText(first);$('evalnumber').textContent=scoreText(first);$('depth').textContent='Глубина '+first.depth;
      $('advantage').textContent=first.type==='mate'?'Матовая последовательность':Math.abs(first.value)<25?'Примерное равенство':first.value>0?'Преимущество белых':'Преимущество чёрных';
      const value=first.type==='mate'?(first.value>0?10000:-10000):first.value;$('evalfill').style.height=(50+46*Math.tanh(value/500))+'%';
      for(const [i,line] of result.lines.entries()){const div=document.createElement('div');div.className='variation';const score=document.createElement('b');score.textContent=scoreText(line);const moves=document.createElement('span');moves.textContent=(i===0?'Совет: ':'Вариант: ')+line.moves.join('  ');div.append(score,moves);$('variations').append(div);}
      if(result.reason){const p=document.createElement('p');p.className='tiny';p.textContent='В стиле Таля: '+result.reason.join(', ');$('variations').append(p);}
      if(result.humanInfo){const p=document.createElement('p');p.className='tiny';p.textContent='Очеловечивание: '+result.humanInfo.reason.toLowerCase()+'.';$('variations').append(p);}
      $('elo').min=result.min;$('elo').max=result.max;$('minElo').textContent=result.min;$('maxElo').textContent=result.max;
    }else{$('score').textContent=state.check?'Мат':'0.00';$('advantage').textContent=state.status;$('depth').textContent='Конец партии';}
  }catch(e){if(rev===revision)$('depth').textContent='Ошибка';fail(e);}finally{analysing=false;$('analyse').disabled=false;if(analysisPending){analysisPending=false;analyse();}}
}
async function newGame(){if(busy)return;if((history.length||reviewSource?.history.length)&&!confirm('Начать новую партию? Текущую можно сохранить в PGN.'))return;invalidateReview();history=[];verbose=[];start=null;selected=null;side=$('side').value;flipped=side==='b';state=await api('state',payload());positionChanged();await maybeComputer();}
$('new').onclick=()=>newGame().catch(fail);
$('undo').onclick=async()=>{if(busy||!history.length)return;if(mode==='analysis'){await navigateReview(history.length-1);return;}invalidateReview();const count=state.turn===side&&history.length>=2?2:1;history.splice(-count);verbose.splice(-count);selected=null;state=await api('state',payload());positionChanged();};
$('flip').onclick=()=>{flipped=!flipped;render();};
$('analyse').onclick=analyse;
$('hint').onclick=async()=>{if(!lastBest){await analyse();}if(lastBest){drawBestArrow(true);toast('Лучший ход: '+lastBest.slice(0,2)+' → '+lastBest.slice(2,4));}};
$('showArrow').onchange=()=>drawBestArrow();
$('style').onchange=()=>{$('styleReason').hidden=true;render();};
function updateElo(){const v=$('elo').value;$('opponentEloNumber').value=v;$('eloValue').replaceChildren(document.createTextNode(v+' '));const sm=document.createElement('small');sm.textContent='Elo';$('eloValue').append(sm);document.querySelectorAll('[data-elo]').forEach(b=>b.classList.toggle('chosen',b.dataset.elo===v));if(state)render();}
$('elo').step='1';
$('opponentEloNumber').onchange=()=>{$('elo').value=Math.round(Math.max(1320,Math.min(3190,Number($('opponentEloNumber').value)||1600)));updateElo();};
$('opponentEloNumber').oninput=()=>{const n=Number($('opponentEloNumber').value);if(n>=1320&&n<=3190){$('elo').value=Math.round(n);updateElo();}};
$('elo').oninput=updateElo;document.querySelectorAll('[data-elo]').forEach(b=>b.onclick=()=>{$('elo').value=b.dataset.elo;updateElo();});
$('side').onchange=()=>{side=$('side').value;flipped=side==='b';render();maybeComputer();};
function setMode(next){if(busy){toast('Дождитесь хода Stockfish.');return;}mode=next;selected=null;$('playTab').classList.toggle('active',next==='play');$('analysisTab').classList.toggle('active',next==='analysis');document.querySelector('.settings').classList.toggle('disabled',next==='analysis');render();maybeComputer();}
$('playTab').onclick=()=>setMode('play');$('analysisTab').onclick=()=>setMode('analysis');
$('auto').onchange=()=>{if($('auto').checked)analyse();};
$('loadFen').onclick=async()=>{if(busy)return;try{const value=$('fen').value.trim();const result=await api('state',{fen:value});invalidateReview();start=result.fen;history=[];verbose=[];state=result;selected=null;setMode('analysis');positionChanged();toast('Позиция загружена в режим разбора.');}catch(e){fail(e);}};
$('copyFen').onclick=()=>navigator.clipboard.writeText(state.fen).then(()=>toast('FEN скопирован.'),fail);
$('export').onclick=async()=>{try{const result=await api('export',{...(reviewSource||payload()),white:side==='w'?'Игрок':'Stockfish',black:side==='b'?'Игрок':'Stockfish'});const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([result.pgn],{type:'application/x-chess-pgn;charset=utf-8'}));a.download='chess-studio.pgn';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}catch(e){fail(e);}};
$('import').onclick=()=>{if(!busy)$('pgnFile').click();};
$('pgnFile').onchange=async e=>{const file=e.target.files[0];if(!file||busy)return;try{const result=await api('import',{pgn:await file.text()});invalidateReview();start=result.start;history=result.history;verbose=result.verbose;state=result;selected=null;setMode('analysis');positionChanged();toast('Партия загружена. Нажмите «Разобрать всю партию».');}catch(e){fail(e);}finally{e.target.value='';}};
function updateAnalysisProfile(recalculate=true){
  const full=$('analysisFull').checked;const elo=Math.round(Math.max(1320,Math.min(3190,Number($('analysisEloNumber').value)||2500)));
  $('analysisEloNumber').value=elo;$('analysisElo').value=elo;$('analysisElo').disabled=$('analysisEloNumber').disabled=full;
  $('analysisProfile').textContent='Советы: '+(full?'полная сила':elo+' Elo')+' · '+($('analysisStyle').value==='tal'?'в стиле Таля':'обычный Stockfish')+' · очеловечивание: '+$('analysisHuman').selectedOptions[0].textContent.toLowerCase();
  if(recalculate&&state){stopReview();reviewResults=[];renderReviewResults();revision++;resetEvaluation();drawBestArrow();clearTimeout(profileTimer);profileTimer=setTimeout(()=>analyse(),250);}
}
$('analysisElo').oninput=()=>{$('analysisEloNumber').value=$('analysisElo').value;updateAnalysisProfile();};
$('analysisEloNumber').onchange=()=>updateAnalysisProfile();
$('analysisEloNumber').oninput=()=>{const n=Number($('analysisEloNumber').value);if(n>=1320&&n<=3190)updateAnalysisProfile();};
$('analysisStyle').onchange=()=>updateAnalysisProfile();$('analysisFull').onchange=()=>updateAnalysisProfile();
$('analysisHuman').onchange=()=>updateAnalysisProfile();
$('reviewGame').onclick=reviewWholeGame;$('stopReview').onclick=stopReview;
$('reviewStart').onclick=()=>navigateReview(0).catch(fail);$('reviewPrev').onclick=()=>navigateReview(history.length-1).catch(fail);$('reviewNext').onclick=()=>navigateReview(history.length+1).catch(fail);$('reviewEnd').onclick=()=>navigateReview(reviewSource?.history.length||history.length).catch(fail);
updateAnalysisProfile(false);
api('state').then(result=>{state=result;render();analyse();}).catch(fail);
