const express = require('express');
const path = require('path');
const compression = require('compression');

const app = express();
app.use(compression());

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir, { maxAge: '7d', etag: true }));
app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const PORT = process.env.FRONTEND_PORT || 3008;
app.listen(PORT, () => {
  console.log(`Frontend server running on port ${PORT}`);
});
