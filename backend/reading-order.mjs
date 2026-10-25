import {spawn} from 'node:child_process';
export const READING_ORDER_VERSION = 4;

export function makeOrderRepair(python, script) {
  return ({pdf, blocks, signal}) => new Promise((resolve,reject) => {
    const child=spawn(python,[script,'--pdf',pdf],{windowsHide:true,stdio:['pipe','pipe','pipe'],signal});
    let output='',errors='';
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>output+=chunk);
    child.stderr.on('data',chunk=>errors=(errors+chunk).slice(-4000));
    child.on('error',reject);child.stdin.on('error',reject);
    child.on('close',code=>{
      if(code!==0)return reject(new Error(errors||'阅读顺序校正失败，原有内容已保留。'));
      try{resolve(JSON.parse(output));}catch{reject(new Error('阅读顺序校正器未返回有效结果。'));}
    });
    child.stdin.end(JSON.stringify(blocks.map(({id,page,type,bbox})=>({id,page,type,bbox}))),'utf8');
  });
}
