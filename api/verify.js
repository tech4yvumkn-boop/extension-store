// POST from PayU (surl) -> verify payment with PayU API -> success page that
// auto-starts the download. Supports built-in and admin-added products.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PAYU_KEY = process.env.PAYU_KEY;
const PAYU_SALT = process.env.PAYU_SALT;

// Canonical product keys used by the storefront page.
function productFrom(info) {
  const s = (info || '').toLowerCase();
  if (s.includes('adjustment')) return 'adjust';
  if (s.includes('download bin')) return 'bin';
  // Admin-added products: productinfo is the product name (exact match).
  try {
    const p = path.join(process.cwd(), 'products.json');
    if (fs.existsSync(p)) {
      const list = JSON.parse(fs.readFileSync(p, 'utf8'));
      const hit = list.filter(function (x) {
        return x && x.active && String(x.name).toLowerCase() === s;
      })[0];
      if (hit) return hit.id;
    }
  } catch (e) { /* ignore */ }
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

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(title, msg) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + esc(title) + '</title>'
    + '<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#1a1210;color:#f5e6c8;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;padding:20px;text-align:center}'
    + '.card{background:#241a14;border:3px solid #ffd23f;border-radius:14px;max-width:420px;width:100%;padding:28px;box-shadow:8px 8px 0 #e63946}'
    + '.kicker{display:inline-block;background:#e63946;color:#fff;font-size:11px;letter-spacing:2px;padding:5px 10px;border-radius:4px;margin-bottom:12px}'
    + 'h1{color:#ffd23f;font-size:24px;margin:0 0 10px}p{line-height:1.6}'
    + 'a{color:#4fd1c5}.note{font-size:12px;color:#a89880;margin-top:16px}</style>'
    + '</head><body><div class="card">'
    + '<span class="kicker">★ NAKSH\'S RETRO TOOL DUKAAN ★</span>'
    + '<h1>' + esc(title) + '</h1><p>' + msg + '</p></div></body></html>';
}

// Success page: confirms payment and auto-starts the download in a hidden frame.
function successPage(dlUrl) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Payment Successful</title>'
    + '<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#1a1210;color:#f5e6c8;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;padding:20px;text-align:center}'
    + '.card{background:#241a14;border:3px solid #ffd23f;border-radius:14px;max-width:420px;width:100%;padding:28px;box-shadow:8px 8px 0 #e63946}'
    + '.kicker{display:inline-block;background:#e63946;color:#fff;font-size:11px;letter-spacing:2px;padding:5px 10px;border-radius:4px;margin-bottom:12px}'
    + '.paid{display:inline-block;background:#ffd23f;color:#1a1210;font-weight:800;font-size:13px;letter-spacing:2px;padding:6px 14px;border-radius:4px;transform:rotate(-4deg);margin-bottom:10px}'
    + 'h1{color:#ffd23f;font-size:26px;margin:0 0 10px}p{line-height:1.6}'
    + 'a{color:#4fd1c5}.note{font-size:12px;color:#a89880;margin-top:16px}</style>'
    + '</head><body><div class="card">'
    + '<span class="kicker">★ NAKSH\'S RETRO TOOL DUKAAN ★</span><br>'
    + '<span class="paid">★ PAID ★</span>'
    + '<h1>Payment Successful</h1>'
    + '<p>Thank you! Your payment is confirmed.<br>Your download has started automatically.</p>'
    + '<iframe src="' + esc(dlUrl) + '" style="display:none" title="download"></iframe>'
    + '<p><a href="' + esc(dlUrl) + '">If the download doesn\'t start, click here</a></p>'
    + '<p class="note">This download link was made only for you and expires in a few minutes. Please do not share it.</p>'
    + '</div></body></html>';
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
      res.status(400).send(page('Error', 'No transaction ID found. This page only opens right after a PayU payment. If you just paid and see this, please contact support with your payment receipt.'));
      return;
    }
    if (!PAYU_KEY || !PAYU_SALT) {
      res.status(500).send(page('Setup incomplete', 'PayU keys are not configured on the server. Please contact support.'));
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
      res.status(402).send(page('Payment could not be verified', 'We could not confirm your payment. If money was deducted, please wait 5-10 minutes, then contact support.'));
      return;
    }

    const product = productFrom(txn.productinfo || body.productinfo || '');
    if (!product) {
      res.status(404).send(page('Product not found', 'We could not identify the product linked to this payment. Please contact support.'));
      return;
    }

    const exp = Math.floor(Date.now() / 1000) + 10 * 60; // 10 min
    const token = signToken(txnid, product, exp);
    const dlUrl = '/api/file?token=' + encodeURIComponent(token) + '&product=' + encodeURIComponent(product);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(successPage(dlUrl));
  } catch (e) {
    res.status(500).send(page('Something went wrong', 'A server error occurred. Please try again in a bit or contact support.'));
  }
};
