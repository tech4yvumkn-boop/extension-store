// POST from PayU (surl) -> verify payment with PayU API -> 302 to thank-you page with token.
// The thank-you page unlocks with ?token= and shows only the bought product.
const crypto = require('crypto');

const PAYU_KEY = process.env.PAYU_KEY;
const PAYU_SALT = process.env.PAYU_SALT;

// Canonical product keys used by the storefront page.
function productFrom(info) {
  const s = (info || '').toLowerCase();
  if (s.includes('adjustment')) return 'adjust';
  if (s.includes('download bin')) return 'bin';
  return null;
}

function b64urlEncode(str) {
  return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Token binds txnid + product + expiry, HMAC-signed with the merchant salt.
function signToken(txnid, product, exp) {
  const payload = txnid + '|' + product + '|' + exp;
  const hmac = crypto.createHmac('sha256', PAYU_SALT).update(payload).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return b64urlEncode(payload + '|' + hmac);
}

function page(title, msg) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + title + '</title>'
    + '<style>body{background:#1a1210;color:#f5e6c8;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}h1{color:#ffd23f;font-size:26px}</style>'
    + '</head><body><div><h1>' + title + '</h1><p>' + msg + '</p></div></body></html>';
}

module.exports = async (req, res) => {
  try {
    let body = req.body;
    if (typeof body === 'string') {
      const params = new URLSearchParams(body);
      body = {};
      for (const [k, v] of params) body[k] = v;
    }
    body = body || {};
    const q = req.query || {};
    const txnid = body.txnid || q.txnid;
    if (!txnid) {
      res.status(400).send(page('Error', 'Transaction ID nahi mila. Ye page sirf PayU payment ke baad khulta hai.'));
      return;
    }
    if (!PAYU_KEY || !PAYU_SALT) {
      res.status(500).send(page('Setup adhura hai', 'Server me PayU keys set nahi hain. Naksh se sampark karo.'));
      return;
    }

    // Authoritative check: ask PayU directly about this transaction.
    const command = 'verify_payment';
    const hash = crypto.createHash('sha512').update(PAYU_KEY + '|' + command + '|' + txnid + '|' + PAYU_SALT).digest('hex');
    const params = new URLSearchParams({ key: PAYU_KEY, command: command, var1: txnid, hash: hash });
    const vr = await fetch('https://info.payu.in/merchant/postservice?form=2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: params.toString(),
    });
    const data = await vr.json();
    const txn = data && data.transaction_details && data.transaction_details[txnid];

    if (!txn || txn.status !== 'success') {
      res.status(402).send(page('Payment verify nahi hui', 'Hum tumhari payment confirm nahi kar paye. Agar paise kate hain to 5-10 minute ruko, phir Naksh se sampark karo.'));
      return;
    }

    const product = productFrom(txn.productinfo || body.productinfo || '');
    if (!product) {
      res.status(404).send(page('Product nahi mila', 'Is payment se juda product pehchana nahi gaya. Naksh se sampark karo.'));
      return;
    }

    const exp = Math.floor(Date.now() / 1000) + 30 * 60; // 30 min
    const token = signToken(txnid, product, exp);
    const dest = '/?token=' + encodeURIComponent(token) + '&product=' + encodeURIComponent(product) + '#thank-you';
    res.writeHead(302, { Location: dest });
    res.end();
  } catch (e) {
    res.status(500).send(page('Kuch gadbad hui', 'Server me error aaya. Thodi der baad retry karo ya Naksh se sampark karo.'));
  }
};
