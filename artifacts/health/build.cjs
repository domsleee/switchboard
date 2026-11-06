// Package the fixture and the real Health UI as a portable, offline mockup.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),ui=path.join(root,'tools/switchboard/static');
const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8')
  .replace('<link rel="stylesheet" href="../../tools/switchboard/static/style.css">',()=>`<style>${fs.readFileSync(path.join(ui,'style.css'),'utf8')}</style>`)
  .replace('<script src="../../tools/switchboard/static/tasks.js"></script>',()=>`<script>${fs.readFileSync(path.join(ui,'tasks.js'),'utf8')}</script>`);
fs.writeFileSync(process.argv[2]||path.join(__dirname,'preview.html'),html);
