// server.js — CommonJS shim entry point for LiteSpeed's lsnode.js
// lsnode.js uses require(), which cannot load an ESM graph containing
// a top-level await. Loading app.js via dynamic import() sidesteps that
// restriction entirely, since import() is always async-safe.

import('./app.js')
  .then((mod) => mod.start())
  .catch((err) => {
    console.error('Failed to start app.js:', err);
    process.exit(1);
  });
