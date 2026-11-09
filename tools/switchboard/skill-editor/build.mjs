import { build } from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const source=fileURLToPath(new URL('./editor.js',import.meta.url)),output=fileURLToPath(new URL('../static/skill-editor.js',import.meta.url));
const result=await build({entryPoints:[source],bundle:true,minify:true,format:'iife',globalName:'SwitchboardSkillEditor',target:['es2022'],outfile:output,legalComments:'eof',write:false,metafile:true});
const packages=[...new Set(Object.keys(result.metafile.inputs).filter(path=>path.includes('node_modules/')).map(path=>path.split('node_modules/')[1].split('/')[0]))].sort();
const licenses=await Promise.all(packages.map(async name=>{
  const root=new URL('./node_modules/'+name+'/',import.meta.url),pkg=JSON.parse(await readFile(new URL('package.json',root),'utf8'));
  return `${name} ${pkg.version}\n${await readFile(new URL('LICENSE',root),'utf8')}`;
}));
const text='// Generated from tools/switchboard/skill-editor/editor.js. Run npm ci && npm run build in that folder.\n'+result.outputFiles[0].text+'\n/* Bundled third-party licenses\n\n'+licenses.join('\n\n')+'\n*/\n';
if(process.argv.includes('--check')){
  if((await readFile(output,'utf8')).replace(/\r\n/g,'\n')!==text.replace(/\r\n/g,'\n'))throw Error('Stale skill editor bundle. Run npm run build in tools/switchboard/skill-editor.');
}else await writeFile(output,text);
