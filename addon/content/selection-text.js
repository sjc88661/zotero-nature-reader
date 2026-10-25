(function(root) {
  'use strict';
  // Must match common.js markdown/inline textContent, including source buttons.
  function inlineText(value) {
    return String(value).split(/(\*\*[^*]+\*\*|`[^`]+`|\[[A-Z]\d+\s+p\.\d+\])/g).map(token => {
      if (token.startsWith('**') && token.endsWith('**')) return token.slice(2,-2);
      if (token.startsWith('`') && token.endsWith('`')) return token.slice(1,-1);
      const ref=token.match(/^\[([A-Z]\d+)\s+p\.(\d+)\]$/);
      return ref ? `${ref[1]} · p.${ref[2]}` : token;
    }).join('');
  }
  function displayText(markdown) {
    let code=false,result='';
    for(const line of String(markdown || '').split(/\r?\n/)) {
      if(/^```/.test(line)){code=!code;continue;}
      if(code){result+=line+'\n';continue;}
      if(!line.trim())continue;
      const content=line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/)||line.match(/^#{1,6}\s+(.+)$/);
      result+=inlineText(content?content[1]:line);
    }
    return result;
  }
  const api={displayText};root.ZNRText=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);
