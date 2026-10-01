// Secure checkout entry: GET shows a buyer form, POST builds a PayU
// hosted-checkout request (with our own surl/furl) and auto-submits it.
// Usage: /api/pay?product=adjust  (built-in) or /api/pay?product=<id> (admin-added)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PAYU_KEY = process.env.PAYU_KEY;
const PAYU_SALT = process.env.PAYU_SALT;
const BASE = 'https://extension-store-six.vercel.app';
const PAYU_URL = 'https://secure.payu.in/_payment';

const PRODUCTS = {
  adjust: { name: 'Adjustment Layer — One Click Fit', amount: '5.00', productinfo: 'Adjustment Layer' },
  bin: { name: 'Download Bin — Live in Premiere', amount: '5.00', productinfo: 'Download Bin' },
};

// Admin-added products live in products.json (written by /api/admin).
function dynamicProducts() {
  try {
    const p = path.join(process.cwd(), 'products.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { /* ignore */ }
  return [];
}

// Resolve a product key -> { name, amount, productinfo } or null.
function resolveProduct(key) {
  if (PRODUCTS[key]) {
    return { name: PRODUCTS[key].name, amount: PRODUCTS[key].amount, productinfo: PRODUCTS[key].productinfo };
  }
  const hit = dynamicProducts().filter(function (x) { return x && x.id === key && x.active; })[0];
  if (hit) {
    return { name: hit.name, amount: Number(hit.price).toFixed(2), productinfo: hit.name };
  }
  return null;
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formPage(productKey, prod, errMsg, prev) {
  const err = errMsg ? '<div class="err">' + esc(errMsg) + '</div>' : '';
  const v = prev || {};
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Checkout — ' + esc(prod.name) + '</title>'
    + '<style>'
    + '*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#1a1210;color:#f5e6c8;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;padding:20px}'
    + '.card{background:#241a14;border:3px solid #ffd23f;border-radius:14px;max-width:420px;width:100%;padding:28px;box-shadow:8px 8px 0 #e63946}'
    + '.kicker{display:inline-block;background:#e63946;color:#fff;font-size:11px;letter-spacing:2px;padding:5px 10px;border-radius:4px;margin-bottom:12px}'
    + 'h1{color:#ffd23f;font-size:22px;margin:0 0 6px}.price{color:#4fd1c5;font-weight:700;margin:0 0 18px}'
    + 'label{display:block;font-size:13px;margin:12px 0 5px;color:#ffd23f}'
    + 'input{width:100%;padding:12px;border:2px solid #4fd1c5;border-radius:8px;background:#1a1210;color:#f5e6c8;font-size:16px}'
    + 'input:focus{outline:none;border-color:#ffd23f}'
    + 'button{width:100%;margin-top:20px;padding:14px;background:#ffd23f;color:#1a1210;border:none;border-radius:8px;font-size:17px;font-weight:800;cursor:pointer}'
    + 'button:active{transform:scale(.98)}'
    + '.err{background:#e63946;color:#fff;padding:10px;border-radius:8px;font-size:14px;margin-bottom:10px}'
    + '.note{font-size:12px;color:#a89880;margin-top:14px;text-align:center}'
    + '</style></head><body><div class="card">'
    + '<span class="kicker">★ NAKSH\'S RETRO TOOL DUKAAN ★</span>'
    + '<h1>' + esc(prod.name) + '</h1>'
    + '<p class="price">Only ₹' + esc(prod.amount) + ' — one-time payment</p>'
    + err
    + '<form method="post" action="/api/pay?product=' + esc(productKey) + '">'
    + '<label>Name</label><input name="firstname" required maxlength="50" placeholder="Your name" value="' + esc(v.firstname) + '">'
    + '<label>Email</label><input name="email" type="email" required placeholder="you@example.com" value="' + esc(v.email) + '">'
    + '<label>Phone (10-digit mobile)</label><input name="phone" required inputmode="numeric" maxlength="13" placeholder="98765 43210" value="' + esc(v.phone) + '">'
    + '<button type="submit">Pay ₹' + esc(prod.amount) + ' →</button>'
    + '</form>'
    + '<p class="note">Payment happens on PayU\'s secure page. Your download will start automatically right after payment.</p>'
    + '</div></body></html>';
}

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    const params = new URLSearchParams(body);
    body = {};
    for (const [k, v] of params) body[k] = v;
  }
  return body || {};
}

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    const productKey = (q.product || '').toLowerCase();
    const prod = resolveProduct(productKey);
    if (!prod) {
      res.status(400).send('Product not found');
      return;
    }
    if (!PAYU_KEY || !PAYU_SALT) {
      res.status(500).send('Server setup is incomplete. Please contact support.');
      return;
    }

    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(formPage(productKey, prod));
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).send('Method not allowed');
      return;
    }

    const body = parseBody(req);
    const firstname = String(body.firstname || '').replace(/[^a-zA-Z ]/g, '').trim().slice(0, 50);
    const email = String(body.email || '').trim().slice(0, 100);
    let phone = String(body.phone || '').replace(/[\s-]/g, '');
    if (phone.startsWith('+91')) phone = phone.slice(3);
    if (phone.startsWith('91') && phone.length === 12) phone = phone.slice(2);

    if (firstname.length < 2) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(formPage(productKey, prod, 'Please enter a valid name (letters only).', body));
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(formPage(productKey, prod, 'Please enter a valid email address.', body));
      return;
    }
    if (!/^[6-9]\d{9}$/.test(phone)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(formPage(productKey, prod, 'Please enter a valid 10-digit mobile number.', body));
      return;
    }

    const txnid = 'NAKSH' + Date.now().toString(36).toUpperCase() + Math.floor(1000 + Math.random() * 9000);
    const surl = BASE + '/api/verify';
    const furl = BASE + '/api/verify';

    const hashStr = [PAYU_KEY, txnid, prod.amount, prod.productinfo, firstname, email,
      '', '', '', '', '', '', '', '', '', '', PAYU_SALT].join('|');
    const hash = crypto.createHash('sha512').update(hashStr).digest('hex');

    const fields = {
      key: PAYU_KEY, txnid: txnid, amount: prod.amount, productinfo: prod.productinfo,
      firstname: firstname, email: email, phone: phone,
      surl: surl, furl: furl, hash: hash,
    };
    const inputs = Object.keys(fields).map(function (k) {
      return '<input type="hidden" name="' + k + '" value="' + esc(fields[k]) + '">';
    }).join('');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send('<!doctype html><html><head><meta charset="utf-8"><title>Taking you to PayU…</title>'
      + '<style>body{background:#1a1210;color:#ffd23f;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh}</style>'
      + '</head><body><p>Taking you to PayU\'s secure payment page…</p>'
      + '<form id="payu" action="' + PAYU_URL + '" method="post">' + inputs + '</form>'
      + '<script>document.getElementById("payu").submit();</script></body></html>');
  } catch (e) {
    res.status(500).send('Server error. Please try again in a bit.');
  }
};
