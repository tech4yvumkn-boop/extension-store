// Admin API for managing the store's dynamic product catalog.
// Every action requires the admin password (x-admin-password header or body.password).
// Product files (ZIPs/GIFs) and products.json live in the GitHub repo, written via
// the GitHub Contents API, so Vercel auto-redeploys and the product goes live in ~1-2 min.
//
//   GET  /api/admin?action=list                            -> { products: [...] }
//   POST /api/admin?action=upload {id, kind, base64}       -> { path } or { url }
//   POST /api/admin?action=save   {id, name, price, tagline, description, zipPath, gifUrl}
//   POST /api/admin?action=toggle {id, active}
//   POST /api/admin?action=del    {id}

const REPO = 'tech4yvumkn-boop/extension-store';
const BRANCH = 'main';
const GITHUB_API = 'https://api.github.com';
const MAX_FILE_BYTES = 3 * 1024 * 1024; // 3MB per upload (Vercel request body limit)

function json(res, code, data) {
  res.setHeader('Content-Type', 'application/json');
  res.status(code).send(JSON.stringify(data));
}

function parseBody(req) {
  let b = req.body;
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch (e) { b = {}; }
  }
  return b || {};
}

function ghHeaders() {
  return {
    'Authorization': 'Bearer ' + process.env.GITHUB_TOKEN,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'extension-store-admin',
  };
}

async function ghGet(repoPath) {
  const r = await fetch(GITHUB_API + '/repos/' + REPO + '/contents/' + repoPath + '?ref=' + BRANCH, {
    headers: ghHeaders(),
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('GitHub read failed (' + r.status + ')');
  return r.json();
}

async function ghPut(repoPath, base64, sha, message) {
  const body = { message: message, content: base64, branch: BRANCH };
  if (sha) body.sha = sha;
  const r = await fetch(GITHUB_API + '/repos/' + REPO + '/contents/' + repoPath, {
    method: 'PUT',
    headers: ghHeaders(),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('GitHub write failed (' + r.status + '): ' + (await r.text()).slice(0, 160));
  return r.json();
}

async function readProducts() {
  const f = await ghGet('products.json');
  if (!f) return { products: [], sha: null };
  const text = Buffer.from(f.content, 'base64').toString('utf8');
  return { products: JSON.parse(text), sha: f.sha };
}

async function writeProducts(products, sha, message) {
  const base64 = Buffer.from(JSON.stringify(products, null, 2)).toString('base64');
  await ghPut('products.json', base64, sha, message);
}

module.exports = async (req, res) => {
  try {
    const action = ((req.query && req.query.action) || '').toLowerCase();
    const body = parseBody(req);

    if (!process.env.GITHUB_TOKEN || !process.env.ADMIN_PASSWORD) {
      json(res, 500, { error: 'Server setup is incomplete.' });
      return;
    }
    const pw = req.headers['x-admin-password'] || body.password || '';
    if (pw !== process.env.ADMIN_PASSWORD) {
      json(res, 401, { error: 'Wrong password.' });
      return;
    }

    if (action === 'list' && req.method === 'GET') {
      const data = await readProducts();
      json(res, 200, { products: data.products });
      return;
    }

    if (action === 'upload' && req.method === 'POST') {
      const id = String(body.id || '').replace(/[^a-z0-9-]/g, '').slice(0, 60);
      const kind = body.kind === 'gif' ? 'gif' : 'zip';
      const base64 = String(body.base64 || '').replace(/\s+/g, '');
      if (!id) { json(res, 400, { error: 'Missing product id.' }); return; }
      if (!base64) { json(res, 400, { error: 'No file data received.' }); return; }
      let buf;
      try { buf = Buffer.from(base64, 'base64'); } catch (e) { buf = Buffer.alloc(0); }
      if (buf.length < 10 || buf.length > MAX_FILE_BYTES) {
        json(res, 400, { error: 'File must be between 10 bytes and 3MB.' });
        return;
      }
      if (kind === 'zip' && !(buf[0] === 0x50 && buf[1] === 0x4B)) {
        json(res, 400, { error: 'That file does not look like a ZIP.' });
        return;
      }
      if (kind === 'gif' && !(buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)) {
        json(res, 400, { error: 'That file does not look like a GIF.' });
        return;
      }
      const repoPath = kind === 'zip' ? 'product-zips/' + id + '.zip' : 'product-gifs/' + id + '.gif';
      const existing = await ghGet(repoPath);
      await ghPut(repoPath, base64, existing ? existing.sha : null, 'Admin: upload ' + kind + ' for ' + id);
      if (kind === 'zip') json(res, 200, { path: repoPath });
      else json(res, 200, { url: '/' + repoPath });
      return;
    }

    if (action === 'save' && req.method === 'POST') {
      const id = String(body.id || '').replace(/[^a-z0-9-]/g, '').slice(0, 60);
      const name = String(body.name || '').trim().slice(0, 80);
      const priceNum = parseFloat(body.price);
      const tagline = String(body.tagline || '').trim().slice(0, 140);
      const description = String(body.description || '').trim().slice(0, 2000);
      const zipPath = String(body.zipPath || '').trim();
      const gifUrl = String(body.gifUrl || '').trim() || null;
      if (!id) { json(res, 400, { error: 'Missing product id.' }); return; }
      if (name.length < 2) { json(res, 400, { error: 'Product name is too short.' }); return; }
      if (!(priceNum > 0) || priceNum > 100000) { json(res, 400, { error: 'Enter a valid price.' }); return; }
      if (!zipPath || zipPath.indexOf('product-zips/') !== 0) {
        json(res, 400, { error: 'Upload the product ZIP first.' });
        return;
      }

      const data = await readProducts();
      const now = new Date().toISOString();
      const prev = data.products.find(function (p) { return p.id === id; });
      const product = {
        id: id,
        name: name,
        price: priceNum.toFixed(2),
        tagline: tagline,
        description: description,
        zipPath: zipPath,
        gifUrl: gifUrl,
        active: prev ? !!prev.active : true,
        createdAt: prev ? prev.createdAt : now,
        updatedAt: now,
      };
      const idx = data.products.findIndex(function (p) { return p.id === id; });
      if (idx >= 0) data.products[idx] = product; else data.products.push(product);
      await writeProducts(data.products, data.sha, 'Admin: ' + (prev ? 'update' : 'add') + ' product ' + id);
      json(res, 200, { product: product });
      return;
    }

    if (action === 'toggle' && req.method === 'POST') {
      const id = String(body.id || '');
      const data = await readProducts();
      const p = data.products.find(function (x) { return x.id === id; });
      if (!p) { json(res, 404, { error: 'Product not found.' }); return; }
      p.active = body.active !== false && body.active !== 'false';
      p.updatedAt = new Date().toISOString();
      await writeProducts(data.products, data.sha, 'Admin: toggle product ' + id);
      json(res, 200, { product: p });
      return;
    }

    if (action === 'del' && req.method === 'POST') {
      const id = String(body.id || '');
      const data = await readProducts();
      const next = data.products.filter(function (x) { return x.id !== id; });
      if (next.length === data.products.length) { json(res, 404, { error: 'Product not found.' }); return; }
      await writeProducts(next, data.sha, 'Admin: delete product ' + id);
      json(res, 200, { deleted: id });
      return;
    }

    json(res, 400, { error: 'Unknown action.' });
  } catch (e) {
    json(res, 500, { error: 'Server error: ' + String((e && e.message) || e).slice(0, 200) });
  }
};
