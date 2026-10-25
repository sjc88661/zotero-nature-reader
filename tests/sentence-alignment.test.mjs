import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const scope={module:{exports:{}}};vm.runInNewContext(fs.readFileSync(new URL('../addon/content/sentence-alignment.js',import.meta.url),'utf8'),scope);
const api=scope.module.exports;
const pick=(block,text)=>api.resolve(block,[{start:block.translation.indexOf(text),end:block.translation.indexOf(text)+text.length,text}]);
test('科学缩写、小数、括号中的译注不会改变句子边界及原始 UTF16 索引',()=>{
 const b={original:'P. pastoris (syn. K. phaffii) produced 8.7 g/L (Fig. 2). Tal2 gave 12 proteins. Other results followed.',translation:'毕赤酵母产生 8.7 g/L（译注：Fig. 2. 原文缩写。）。Tal2 得到 12 个蛋白。后面还有结果。'};
 assert.equal(api.sentences(b.original,'original').length,3);assert.equal(api.sentences(b.translation,'translation').length,3);
 assert.equal(pick(b,'Tal2 得到').text,'Tal2 gave 12 proteins.');assert.equal(pick(b,'后面').text,'Other results followed.');
 assert.equal(b.original.slice(pick(b,'Tal2').ranges[0].start,pick(b,'Tal2').ranges[0].end),'Tal2 gave 12 proteins.');
 assert.equal(pick(b,'原文缩写').mode,'unresolved','translator notes have no exact source sentence');
});
test('句子拆分、合并和译文句序变化使用内容锚点；无依据时不按长度猜测',()=>{
 const b={original:'A gave 243 proteins. B gave 158 proteins. Other findings followed.',translation:'A 有 243 个蛋白，B 有 158 个蛋白。还有其他发现。'};
 assert.equal(pick(b,'243').text,'A gave 243 proteins. B gave 158 proteins.');assert.equal(pick(b,'其他').mode,'unresolved');
 const split={original:'A gave 243 proteins and B gave 158 proteins.',translation:'A 有 243 个蛋白。B 有 158 个蛋白。'};
 assert.equal(pick(split,'158').text,split.original);
 const swapped={original:'A gave 243 proteins. B gave 158 proteins. Other findings followed.',translation:'B 有 158 个蛋白。A 有 243 个蛋白。还有其他发现。'};
 assert.equal(pick(swapped,'158').text,'B gave 158 proteins.');assert.equal(pick(swapped,'其他').mode,'unresolved');
 const unrelated={original:'First claim. Second claim.',translation:'另外的解释。没有对应内容。'};assert.equal(pick(unrelated,'解释').mode,'unresolved');
});
