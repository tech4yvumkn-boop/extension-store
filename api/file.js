// Serves the ZIP only for a valid, unexpired, HMAC-signed token issued by /api/verify.
// Called as /api/file?product=<key>&token=<token> by the success page.
// Supports built-in products (FILES map) and admin-added products (products.json -> product-zips/).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PAYU_SALT = process.env.PAYU_SALT;

const FILES = {
  'adjust': 'adjustment-layer.zip',
  // 'bin': 'download-bin.zip', // add when the ZIP is ready
};

function dynamicZipPath(productId) {
  try {
    const p = path.join(process.cwd(), 'products.json');
    if (!fs.existsSync(p)) return null;
    const list = JSON.parse(fs.readFileSync(p, 'utf8'));
    const hit = list.filter(function (x) { return x && x.id === productId && x.active && x.zipPath; })[0];
    return hit ? hit.zipPath : null;
  } catch (e) { return null; }
}

function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString();
}

function findZip(name) {
  const candidates = [
    path.join(process.cwd(), name),
    path.join(__dirname, '..', '..', name),
    path.join(__dirname, '..', name),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (e) { /* try next */ }
  }
  return null;
}

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    const token = q.token;
    const qProduct = (q.product || '').toLowerCase();
    if (!token) { res.status(400).send('Token missing'); return; }
    if (!PAYU_SALT) { res.status(500).send('Server setup is incomplete'); return; }

    let inner;
    try { inner = b64urlDecode(token); } catch (e) { res.status(403).send('Invalid token'); return; }
    const parts = inner.split('|');
    if (parts.length !== 4) { res.status(403).send('Invalid token'); return; }
    const txnid = parts[0], tProduct = parts[1], exp = parts[2], sig = parts[3];

    if (Math.floor(Date.now() / 1000) > parseInt(exp, 10)) { res.status(403).send('This download link has expired'); return; }

    const payload = txnid + '|' + tProduct + '|' + exp;
    const expected = crypto.createHmac('sha256', PAYU_SALT).update(payload).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      res.status(403).send('Invalid token');
      return;
    }

    // The token binds the product; the query param must match it.
    if (qProduct && qProduct !== tProduct) { res.status(403).send('Invalid token'); return; }

    const file = FILES[tProduct] || dynamicZipPath(tProduct);
    if (!file) { res.status(404).send('File not found'); return; }
    const filePath = findZip(file);
    if (!filePath) { res.status(500).send('File not found on server'); return; }

    const stat = fs.statSync(filePath);
    const downloadName = file.split('/').pop();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="' + downloadName + '"');
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    res.status(500).send('Server error');
  }
};
