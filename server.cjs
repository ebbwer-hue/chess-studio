const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {Chess} = require('./vendor/chess.cjs');
function findEngine(dir) {
  for (const item of fs.readdirSync(dir, {withFileTypes:true})) {
    const p = path.join(dir,item.name);
    if (item.isDirectory()) { const result=findEngine(p); if(result) return result; }
    else if (/stockfish.*\.exe$/i.test(item.name)) return p;
  }
}
class Engine {
  constructor() { this.queue=Promise.resolve(); this.proc=null; }
  async init() {
    if(this.proc) return;
    this.proc=spawn(findEngine(path.join(__dirname,'engine')),[],{windowsHide:true});
    this.buffer=''; this.listeners=new Set();
    this.proc.stdout.on('data',data=>{
      this.buffer+=data;
      const lines=this.buffer.split(/\r?\n/); this.buffer=lines.pop();
      for(const line of lines) for(const cb of [...this.listeners]) cb(line);
    });
    this.proc.stderr.on('data',()=>{});
    this.proc.on('error',()=>{});
    this.proc.on('exit',()=>{ this.proc=null; });
    const hello=this.wait('uciok'); this.send('uci');
    const lines=await hello;
    const elo=lines.find(x=>x.startsWith('option name UCI_Elo '));
    this.min=Number(elo?.match(/min (\d+)/)?.[1]||1320);
    this.max=Number(elo?.match(/max (\d+)/)?.[1]||3190);
    this.name=lines.find(x=>x.startsWith('id name '))?.slice(8)||'Stockfish';
    this.send('setoption name Threads value 2');
    this.send('setoption name Hash value 64');
    const ready=this.wait('readyok'); this.send('isready'); await ready;
  }
  send(cmd) { if(!this.proc) throw Error('Движок не запущен'); this.proc.stdin.write(cmd+'\n'); }
  wait(prefix,timeout=20000) {
    return new Promise((resolve,reject)=>{
      const lines=[];
      const timer=setTimeout(()=>{this.listeners.delete(cb); this.proc?.kill(); reject(Error('Stockfish не ответил вовремя. Повторите запрос.'));},timeout);
      const cb=line=>{lines.push(line);if(line.startsWith(prefix)){clearTimeout(timer);this.listeners.delete(cb);resolve(lines);}};
      this.listeners.add(cb);
    });
  }
  run(fen,options={}) {
    const job=this.queue.then(async()=>{
      await this.init();
      this.send('setoption name UCI_LimitStrength value '+(options.elo?'true':'false'));
      if(options.elo) this.send('setoption name UCI_Elo value '+Math.min(this.max,Math.max(this.min,options.elo)));
      this.send('setoption name MultiPV value '+(options.multiPV||(options.elo?1:3)));
      this.send('position fen '+fen);
      const answer=this.wait('bestmove ');
      this.send('go movetime '+(options.time||1000)+(options.root?' searchmoves '+options.root:''));
      const lines=await answer;
      const variations=new Map();
      for(const line of lines) {
        const match=line.match(/info depth (\d+).*?score (cp|mate) (-?\d+).*? pv (.+)/);
        if(!match) continue;
        const rank=Number(line.match(/multipv (\d+)/)?.[1]||1);
        const b=new Chess(fen), san=[];
        for(const uci of match[4].split(' ').slice(0,10)) {
          try { const m=b.move({from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci[4]}); if(!m) break; san.push(m.san); } catch {break;}
        }
        variations.set(rank,{rank,depth:Number(match[1]),type:match[2],value:Number(match[3])*(new Chess(fen).turn()==='w'?1:-1),moves:san,pv:match[4].split(' ').slice(0,10),uci:match[4].split(' ')[0]});
      }
      return {best:lines.at(-1).split(' ')[1],lines:[...variations.values()].sort((a,b)=>a.rank-b.rank),name:this.name,min:this.min,max:this.max};
    });
    this.queue=job.catch(()=>{}); return job;
  }
  close(){this.proc?.kill();}
}
const analysis=new Engine(), opponent=new Engine();
const material={p:100,n:320,b:330,r:500,q:900,k:0};
function attackingScore(fen,line) {
  const b=new Chess(fen),color=b.turn(),enemy=color==='w'?'b':'w';
  const u=line.uci,m=b.move({from:u.slice(0,2),to:u.slice(2,4),promotion:u[4]});
  let value=0;const reasons=[];
  if(b.isCheckmate())return {attackScore:100000,reasons:['матовая атака']};
  if(b.isCheck()){value+=30;reasons.push('шах')};
  if(m.captured){value+=8;reasons.push('тактическое взятие');}
  const king=b.board().flat().find(p=>p?.type==='k'&&p.color===enemy);
  let pressure=0;
  if(king)for(let df=-1;df<=1;df++)for(let dr=-1;dr<=1;dr++){
    const f=king.square.charCodeAt(0)+df,r=Number(king.square[1])+dr;
    if(f>=97&&f<=104&&r>=1&&r<=8)pressure+=b.attackers(String.fromCharCode(f)+r,color).length;
  }
  value+=pressure*5;if(pressure>=3)reasons.push('давление на короля');
  // Reward a concrete material investment visible in the principal variation,
  // rather than rewarding every loose piece as if it were a sound sacrifice.
  let balance=0,investment=0;
  for(const next of (line.pv||[]).slice(1,7)){
    try{const move=b.move({from:next.slice(0,2),to:next.slice(2,4),promotion:next[4]});
      if(move.captured)balance+=(move.color===color?1:-1)*material[move.captured];
      investment=Math.max(investment,-balance);
    }catch{break;}
  }
  // The initial capture must be included in net material accounting.
  investment=Math.max(0,investment-(material[m.captured]||0));
  if(investment>=200){value+=Math.min(50,investment/8);reasons.push('материальный риск ради инициативы');}
  if(['n','b'].includes(m.piece))value+=4;
  return {attackScore:value,reasons:reasons.length?reasons:['активное продолжение']};
}
function chooseTal(fen,lines,baseline,elo) {
  const sign=new Chess(fen).turn()==='w'?1:-1;
  const cp=l=>l.type==='mate'?(l.value*sign>0?100000-Math.abs(l.value):-100000+Math.abs(l.value)):l.value*sign;
  const base=lines.find(l=>l.uci===baseline)||lines[0];
  if(!base)return {uci:baseline,reasons:['ход Stockfish']};
  const best=[...lines].sort((a,b)=>cp(b)-cp(a))[0];
  if(best.type==='mate'&&cp(best)>0)return {...best,reasons:['матовая атака']};
  const budget=Math.round(40+Math.max(0,3190-elo)/1870*50);
  const pool=lines.filter(l=>l.type===base.type&&cp(l)>=cp(base)-budget&&cp(l)<=cp(base)+35);
  const ranked=(pool.length?pool:[base]).map(l=>({...l,...attackingScore(fen,l)}));
  ranked.sort((a,b)=>(b.attackScore-(cp(base)-cp(b))/6)-(a.attackScore-(cp(base)-cp(a))/6));
  return ranked[0];
}
async function recommend(engine,fen,{elo,time=1000,style='classic',human='off'}={}) {
  const rating=elo?Math.round(Math.max(1320,Math.min(3190,Number(elo)||2500))):null;
  const result=await engine.run(fen,{elo:rating,time,multiPV:3});
  let chosen=result.best,reason=null;
  if(style==='tal'&&chosen!=='(none)'){
    const candidates=await engine.run(fen,{multiPV:humanProfiles[human]?12:8,time:Math.max(300,Math.round(time*.65))});
    if(!candidates.lines.some(l=>l.uci===chosen)){
      const base=await engine.run(fen,{root:chosen,multiPV:1,time:300});candidates.lines.push(...base.lines);
    }
    const choice=chooseTal(fen,candidates.lines,chosen,rating||3190);
    chosen=choice.uci;reason=choice.reasons;result.lines=candidates.lines;
  }
  let humanInfo=null;
  if(humanProfiles[human]&&new Chess(fen).moves().length){
    if(style!=='tal'){
      const candidates=await engine.run(fen,{multiPV:12,time:Math.max(300,Math.round(time*.65))});result.lines=candidates.lines;
    }
    if(!result.lines.some(l=>l.uci===chosen)){
      const base=await engine.run(fen,{root:chosen,multiPV:1,time:300});result.lines.push(...base.lines);
    }
    const choice=chooseHuman(new Chess(fen),result.lines,chosen,{level:human,elo:rating||3190,style});
    if(choice.uci!==chosen&&style==='tal'){
      const candidate=result.lines.find(l=>l.uci===choice.uci);reason=candidate?attackingScore(fen,candidate).reasons:['Мат в один ход'];
    }
    chosen=choice.uci;humanInfo={level:human,reason:choice.reason};
  }
  let line=result.lines.find(l=>l.uci===chosen);
  if(!line&&chosen&&chosen!=='(none)'&&chosen!=='0000'){
    const exact=await engine.run(fen,{root:chosen,multiPV:1,time:300});line=exact.lines[0];
  }
  return {...result,best:chosen,lines:line?[line,...result.lines.filter(l=>l.uci!==chosen).slice(0,2)]:result.lines,elo:rating,style:style==='tal'?'tal':'classic',reason,humanInfo};
}
function relativeScore(line,color){
  if(!line)return 0;const value=line.value*(color==='w'?1:-1);
  return line.type==='mate'?(value>0?100000-Math.abs(value):-100000+Math.abs(value)):value;
}
function classifyMove(loss,same){
  if(same)return {key:'best',label:'Выбор анализатора'};
  if(loss<50)return {key:'good',label:'Хороший ход'};
  if(loss<100)return {key:'inaccuracy',label:'Неточность'};
  if(loss<250)return {key:'mistake',label:'Ошибка'};
  return {key:'blunder',label:'Грубая ошибка'};
}
const humanProfiles={light:{chance:.18,budget:30,temp:22},normal:{chance:.35,budget:85,temp:45},strong:{chance:.55,budget:180,temp:75}};
function naturalMoveScore(board,move){
  let score=0;
  if(move.captured)score+=.5;
  const last=board.history({verbose:true}).at(-1);
  if(last?.captured&&last.to===move.to)score+=1.2;
  const early=Number(board.fen().split(' ')[5])<=12;
  if(early){
    if(['n','b'].includes(move.piece)&&move.from[1]===(move.color==='w'?'1':'8'))score+=1;
    if(move.san==='O-O'||move.san==='O-O-O')score+=1;
    if(move.piece==='q'&&!move.captured&&!move.san.includes('+'))score-=.8;
    if(move.piece==='p'&&['d','e'].includes(move.to[0]))score+=.4;
  }
  if(move.san.includes('+'))score+=.35;
  return score;
}
function chooseHuman(board,lines,baseline,{level='normal',elo=1600,style='classic',rng=Math.random}={}){
  const profile=humanProfiles[level];
  const legal=board.moves({verbose:true}),uci=m=>m.from+m.to+(m.promotion||'');
  if(!profile)return {uci:baseline,reason:'Обычный выбор движка'};
  if(legal.length===1)return {uci:uci(legal[0]),reason:'Единственный допустимый ход'};
  const mate=legal.find(m=>m.san.endsWith('#'));
  if(mate)return {uci:uci(mate),reason:'Мат в один ход'};
  const unique=[...new Map(lines.map(l=>[l.uci,l])).values()].filter(l=>legal.some(m=>uci(m)===l.uci));
  const base=unique.find(l=>l.uci===baseline);
  if(!base)return {uci:baseline,reason:'Обычный выбор движка'};
  if(base.type==='mate')return {uci:baseline,reason:'Форсированный вариант'};
  const ratingFactor=.35+.65*Math.max(0,Math.min(1,(3190-elo)/1870));
  if(rng()>profile.chance*ratingFactor)return {uci:baseline,reason:'Уверенное продолжение'};
  const score=l=>relativeScore(l,board.turn());
  const budget=profile.budget*ratingFactor;
  const pool=unique.filter(l=>l.type==='cp'&&score(l)>=score(base)-budget&&score(l)<=score(base)+45);
  if(!pool.length)return {uci:baseline,reason:'Обычный выбор движка'};
  const weighted=pool.map(line=>{
    const move=legal.find(m=>uci(m)===line.uci);
    const natural=naturalMoveScore(board,move);
    const attack=style==='tal'?attackingScore(board.fen(),line).attackScore/40:0;
    return {line,weight:Math.exp(Math.max(-15,Math.min(8,(score(line)-score(base))/(profile.temp*ratingFactor)+natural+attack)))};
  });
  let pick=rng()*weighted.reduce((sum,item)=>sum+item.weight,0);
  const chosen=weighted.find(item=>(pick-=item.weight)<=0)?.line||weighted.at(-1).line;
  return {uci:chosen.uci,reason:chosen.uci===baseline?'Естественное продолжение':'Практический выбор среди близких вариантов'};
}
function humanThinkTime(board,level,rng=Math.random){
  if(!humanProfiles[level])return 0;
  if(board.moves().length<=1)return Math.round(350+rng()*550);
  const history=board.history({verbose:true}),last=history.at(-1);
  const complex=board.isCheck()||last?.captured||board.moves({verbose:true}).filter(m=>m.captured).length>=4;
  return Math.round((complex?1700:800)+rng()*(complex?2600:2100));
}
function state(board) {
  let status=board.turn()==='w'?'Ход белых':'Ход чёрных';
  if(board.isCheckmate()) status='Мат. Победили '+(board.turn()==='w'?'чёрные':'белые');
  else if(board.isStalemate()) status='Ничья — пат';
  else if(board.isThreefoldRepetition()) status='Ничья — троекратное повторение';
  else if(board.isInsufficientMaterial()) status='Ничья — недостаточно материала';
  else if(board.isDraw()) status='Ничья';
  else if(board.isCheck()) status+=' · Шах';
  return {fen:board.fen(),pieces:board.board().flat().filter(Boolean),turn:board.turn(),status,over:board.isGameOver(),check:board.isCheck(),moves:board.moves({verbose:true}).map(m=>({from:m.from,to:m.to,promotion:m.promotion}))};
}
function fromBody(body) {
  const b=new Chess(body.start||undefined);
  if(Array.isArray(body.history)) for(const move of body.history) b.move(move);
  else if(body.fen) b.load(body.fen);
  return b;
}
const server=http.createServer(async(req,res)=>{
  try {
    if(req.method==='POST' && req.url.startsWith('/api/')) {
      if(req.headers.origin && req.headers.origin!==`http://${req.headers.host}`) throw Error('Недопустимый источник запроса');
      let raw=''; for await(const chunk of req) {raw+=chunk;if(raw.length>500000)throw Error('Слишком большой запрос');}
      const data=JSON.parse(raw||'{}'); const board=fromBody(data); let result;
      if(req.url==='/api/state') result=state(board);
      else if(req.url==='/api/move') {const move=board.move(data.move);result={...state(board),move};}
      else if(req.url==='/api/analyse') result=await recommend(analysis,board.fen(),{elo:data.elo,time:Math.max(200,Math.min(5000,Number(data.time)||1200)),style:data.style,human:data.human});
      else if(req.url==='/api/review-move'){
        const before=board.fen(),color=board.turn();
        const played=board.move(data.move);const uci=played.from+played.to+(played.promotion||'');
        const suggestion=await recommend(analysis,before,{elo:data.elo,style:data.style,human:data.human,time:Math.max(200,Math.min(1500,Number(data.time)||500))});
        // Grade against the strongest candidate, so a weak or romantic adviser
        // cannot label its own inferior move objectively best.
        const reference=await analysis.run(before,{multiPV:1,time:500});
        const actual=await analysis.run(before,{root:uci,multiPV:1,time:400});
        const loss=Math.max(0,relativeScore(reference.lines[0],color)-relativeScore(actual.lines[0],color));
        const grade=classifyMove(loss,reference.best===uci);
        if(grade.key==='best')grade.label='Лучший ход';
        result={san:played.san,from:played.from,to:played.to,color,fen:before,after:board.fen(),loss:Math.min(2000,Math.round(loss)),grade,suggestion:suggestion.lines[0]||null,reason:suggestion.reason,elo:suggestion.elo,style:suggestion.style,humanInfo:suggestion.humanInfo};
      }
      else if(req.url==='/api/play') {
        if(board.isGameOver()) result=state(board);
        else {
          const elo=Number(data.elo)||1600;
          const human=humanProfiles[data.human]?data.human:'off';
          const thinkMs=data.humanTiming===false?0:humanThinkTime(board,human);
          const info=await opponent.run(board.fen(),{elo,time:human==='off'?900:Math.round(350+Math.random()*450)});let u=info.best,styleInfo=null,candidates=null;
          if(data.style==='tal'){
            candidates=await opponent.run(board.fen(),{multiPV:human==='off'?8:12,time:1100});
            if(!candidates.lines.some(l=>l.uci===u)){
              const baseline=await opponent.run(board.fen(),{multiPV:1,root:u,time:400});
              candidates.lines.push(...baseline.lines);
            }
            const choice=chooseTal(board.fen(),candidates.lines,u,elo);u=choice.uci;
            styleInfo={name:'В стиле Таля',reasons:choice.reasons};
          }
          let humanInfo=null;
          if(human!=='off'){
            if(!candidates)candidates=await opponent.run(board.fen(),{multiPV:12,time:800});
            if(!candidates.lines.some(l=>l.uci===u)){
              const base=await opponent.run(board.fen(),{multiPV:1,root:u,time:300});candidates.lines.push(...base.lines);
            }
            const choice=chooseHuman(board,candidates.lines,u,{level:human,elo,style:data.style});
            if(choice.uci!==u&&styleInfo){const line=candidates.lines.find(l=>l.uci===choice.uci);styleInfo.reasons=line?attackingScore(board.fen(),line).reasons:['Мат в один ход'];}
            u=choice.uci;humanInfo={level:human,reason:choice.reason};
          }
          const move=board.move({from:u.slice(0,2),to:u.slice(2,4),promotion:u[4]}); result={...state(board),move,styleInfo,humanInfo,thinkMs};
        }
      } else if(req.url==='/api/export') {const g=board;g.header('Event','Chess Studio','White',data.white||'Игрок','Black',data.black||'Stockfish');result={pgn:g.pgn()};}
      else if(req.url==='/api/import') {
        const g=new Chess();g.loadPgn(data.pgn);result={...state(g),start:g.getHeaders().FEN||null,history:g.history(),verbose:g.history({verbose:true})};
      } else throw Error('Неизвестная команда');
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(result));return;
    }
    if(req.method!=='GET') {res.writeHead(405);res.end();return;}
    const publicDir=path.join(__dirname,'public');
    const file=path.resolve(publicDir,'.'+decodeURIComponent(req.url.split('?')[0]==='/'?'/index.html':req.url.split('?')[0]));
    if(!file.startsWith(publicDir+path.sep)) {res.writeHead(403);res.end();return;}
    if(!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end('Not found');return;}
    const content=fs.readFileSync(file);
    res.writeHead(200,{'Content-Type':file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html; charset=utf-8','Cache-Control':'no-cache'});res.end(content);
  } catch(error) {res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:error.message}));}
});
if(require.main===module) {
  server.listen(0,'127.0.0.1',()=>{
    const url='http://127.0.0.1:'+server.address().port;
    console.log('Chess Studio: '+url+'\nЗакройте это окно, чтобы завершить программу.');
    if(!process.argv.includes('--no-open')) spawn('cmd',['/c','start','',url],{windowsHide:true});
  });
  process.on('SIGINT',()=>{analysis.close();opponent.close();server.close();process.exit();});
  process.on('exit',()=>{analysis.close();opponent.close();});
}
module.exports={Engine,state,server,analysis,opponent,chooseTal,attackingScore,recommend,classifyMove,chooseHuman,humanThinkTime};
