// Explicit certificate trust for isolated executable tests; no global trust-store changes.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const crypto = require('node:crypto');
module.exports = environment => {
  const directory = () => {
    const env = environment();
    const home = process.platform === 'win32' ? env.USERPROFILE : env.HOME;
    return path.join(home || os.homedir(), '.config/switchboard/tls');
  };
  return {
    fetch(url, options = {}) {
      if (new URL(url).protocol !== 'https:') return Promise.reject(Error('Fixture requests require HTTPS'));
      return new Promise((resolve, reject) => {
        const request = https.request(url, {...options, ca:fs.readFileSync(path.join(directory(),'ca.pem'))}, response => {
          const chunks=[];
          response.on('data',chunk=>chunks.push(chunk));
          response.on('error',reject);
          response.on('end',()=>resolve(new Response([204,304].includes(response.statusCode)?null:Buffer.concat(chunks),
            {status:response.statusCode,headers:response.headers})));
        });
        request.on('error',reject);
        if(options.body)request.write(options.body);
        request.end();
      });
    },
    launch(chromium, options) {
      const certificate = new crypto.X509Certificate(fs.readFileSync(path.join(directory(),'localhost.pem')));
      const pin = crypto.createHash('sha256').update(certificate.publicKey.export({type:'spki',format:'der'})).digest('base64');
      // Chromium trusts exactly this fixture key, without importing it into the user's OS store.
      return chromium.launch({...options,args:[...(options.args||[]),'--ignore-certificate-errors-spki-list='+pin]});
    },
  };
};
