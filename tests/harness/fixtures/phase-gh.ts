// 実サービスへ委譲しない、コメントとラベルを保存する gh fixture。
import { appendFileSync, existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
const args=process.argv.slice(2), key=args.join(" ");
const log=process.env.MEDIA_LOG!;const stateFile=path.join(path.dirname(log),"gh-state.json");
const head="a".repeat(40);
interface Comment {id:number;body:string;html_url:string;user:{login:string};created_at:string;updated_at:string}
interface PrState{head:string;comments:Comment[];reviews:unknown[];state:string;isCrossRepository:boolean}
const state:{prs?:Record<string,Partial<PrState>>;head:string;labels:string[];comments:Comment[];reviews:unknown[];labelEvents?:unknown[];edits:number}=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,"utf8")):{head,labels:["harness:impl-review","harness:merge-ok"],comments:[],reviews:[],edits:0};
const save=()=>writeFileSync(stateFile,JSON.stringify(state));const out=(x:unknown)=>{const bytes=Buffer.from(`${typeof x==="string"?x:JSON.stringify(x)}\n`);let offset=0;while(offset<bytes.length){try{offset+=writeSync(1,bytes,offset,Math.min(4096,bytes.length-offset));}catch(error){if((error as NodeJS.ErrnoException).code!=="EAGAIN")throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1);}}};const event=(x:string)=>appendFileSync(log,`${x}\n`);
const fail=process.env.GH_FAILURE;
// PR 5 は従来どおりトップレベルの状態、それ以外の番号は state.prs[番号] の個別状態。未登録の番号は失敗させる。
const prView=(n:string)=>{const m=state.prs?.[n];if(n==="5")return{head:state.head,comments:state.comments,reviews:state.reviews,state:m?.state??"OPEN",isCrossRepository:m?.isCrossRepository??false};
 if(!m)throw Error(`unknown pr ${n}`);return{head:m.head??"c".repeat(40),comments:m.comments??[],reviews:m.reviews??[],state:m.state??"OPEN",isCrossRepository:m.isCrossRepository??false};};
if(key==="repo view --json nameWithOwner -q .nameWithOwner")out("example/project");
else if(key==="repo view --json owner -q .owner.login")out("owner");
else if(key==="api user --jq .login")out("bot");
else if(key==="issue view 3 --json title -q .title")out("テスト");
else if(key==="issue view 3 --json url -q .url")out("https://github.com/example/project/issues/3");
else if(key.startsWith("pr list ")){event(`pr-list ${key}`);out("5");}
else if(key.startsWith("issue list "))out(key.includes("harness:awaiting-merge")&&state.labels.includes("harness:awaiting-merge")?"3":"");
else if(/^pr view [1-9][0-9]* --json state,isCrossRepository$/.test(key)){const v=prView(args[2]!);out({state:v.state,isCrossRepository:v.isCrossRepository});}
else if(/^pr view [1-9][0-9]* --json headRefOid -q \.headRefOid$/.test(key)&&args[2]!=="5")out(prView(args[2]!).head);
else if(/^pr view [1-9][0-9]* --json headRefOid,url$/.test(key)&&args[2]!=="5")out({headRefOid:prView(args[2]!).head,url:`https://github.com/example/project/pull/${args[2]}`});
else if(/^pr view [1-9][0-9]* --json mergeable,mergeStateStatus,statusCheckRollup$/.test(key)&&args[2]!=="5"){prView(args[2]!);out({mergeable:process.env.MERGEABLE??"MERGEABLE",statusCheckRollup:process.env.CI_BAD?[{name:"test",conclusion:"FAILURE"}]:[]});}
else if(key==="pr view 5 --json headRefOid -q .headRefOid"){
 if((fail==="head-before"&&state.comments.length)||(fail==="head-final"&&state.comments.some(c=>c.body.includes("harness:gate")))){state.head="b".repeat(40);save();}out(state.head);
}
else if(key==="pr view 5 --json headRefOid,url")out({headRefOid:state.head,url:"https://github.com/example/project/pull/5"});
else if(key==="pr view 5 --json mergeable,mergeStateStatus,statusCheckRollup")out({mergeable:process.env.MERGEABLE??"MERGEABLE",statusCheckRollup:process.env.CI_BAD?[{name:"test",conclusion:"FAILURE"}]:[]});
else if(key==="issue view 3 --json labels"){
 if(fail==="label-final-read"&&state.comments.some(c=>c.body.includes("harness:gate")))process.exit(1);
 out({labels:state.labels.map(name=>({name}))});
}
else if(key==="issue view 3 --json labels -q .labels[].name")out(state.labels.join("\n"));
else if(args[0]==="issue"&&args[1]==="edit"){
 state.edits++;if(fail==="label-start"&&!state.comments.length){save();process.exit(1);}
 if((fail==="label-final"||fail==="recovery")&&state.comments.some(c=>c.body.includes("harness:gate"))){save();process.exit(1);}
 for(let i=3;i<args.length;i+=2){if(args[i]==="--remove-label"&&fail!=="label-left")state.labels=state.labels.filter(l=>l!==args[i+1]);if(args[i]==="--add-label"&&!state.labels.includes(args[i+1]))state.labels.push(args[i+1]);}event("label");save();
}
else if(args[0]==="api"&&args.includes("--input")){
 const body=JSON.parse(readFileSync(args[args.indexOf("--input")+1],"utf8")).body;
 const method=args[args.indexOf("--method")+1];
 if(method==="POST"){
  if(fail==="post")process.exit(1);
  const id=(state.comments.at(-1)?.id??9)+1;const c={id,body,html_url:`https://github.com/example/project/pull/5#issuecomment-${id}`,user:{login:"bot"},created_at:"2026-10-27T00:00:00Z",updated_at:"2026-10-27T00:00:00Z"};state.comments.push(c);event("comment");save();out(c);
 }else{
  if(fail==="patch"&&body.includes("harness:gate"))process.exit(1);
  if(fail==="recovery"&&body.includes("harness:pending"))process.exit(1);
  const c=state.comments.find(c=>c.id===Number(args[1].split("/").at(-1)));if(!c)throw Error("unknown comment");c.body=body;if(process.env.POST_BODY)writeFileSync(process.env.POST_BODY,body);c.updated_at="2026-10-27T00:00:10Z";event("patch");save();
  if(body.includes("harness:gate")){
   if(fail==="patch-loss")process.exit(1);
   if(fail==="bad-time")c.updated_at="bad";
   if(fail==="bad-created")c.created_at="2026-10-27T00:00:01Z";
   if(fail==="bad-id")c.id++;
  }
  out(c);
 }
}
else if(args[0]==="api"&&/^repos\/example\/project\/issues\/comments\/[0-9]+$/.test(args[1]??"")){out(state.comments.find(c=>c.id===Number(args[1].split("/").at(-1))));}
else if(args[0]==="api"&&args.includes("--slurp")){const other=/\/(?:issues|pulls)\/([1-9][0-9]*)\/(?:comments|reviews)$/.exec(key)?.[1];if(other&&other!=="5"&&other!=="3"){const v=prView(other);out(key.endsWith("/comments")?v.comments.map(c=>[c]):[v.reviews]);}else if(key.endsWith("/comments"))out(state.comments.map(c=>[c]));else if(key.endsWith("/reviews"))out([state.reviews]);else if(key.endsWith("/issues/3/events"))out((state.labelEvents??[{event:"labeled",label:{name:"harness:merge-ok"},created_at:"2026-10-27T00:00:11Z"}]).map(e=>[e]));else throw Error("unknown api");}
else if((args[0]==="pr"||args[0]==="issue")&&args[1]==="comment"){
 event("comment");const file=args.indexOf("--body-file");if(file>=0&&process.env.POST_BODY)writeFileSync(process.env.POST_BODY,readFileSync(args[file+1]));const body=args.indexOf("--body");if(body>=0&&process.env.POST_BODY)writeFileSync(process.env.POST_BODY,args[body+1]);out("https://github.com/example/project/pull/5#issuecomment-99");
}
else if(args[0]==="pr"&&args[1]==="merge"){event(`merge ${args.slice(3).join(" ")}`);event(`merge-target ${args[2]}`);}
else throw Error(`unexpected gh fixture: ${key}`);
