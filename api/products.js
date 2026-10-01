// Public catalog of admin-added products (active only, no file paths exposed).
const fs = require('fs');
const path = require('path');

module.exports = async (req, res) => {
  try {
    const p = path.join(process.cwd(), 'products.json');
    let products = [];
    if (fs.existsSync(p)) {
      const all = JSON.parse(fs.readFileSync(p, 'utf8'));
      products = all.filter(function (x) { return x && x.active; });
    }
    const out = products.map(function (x) {
      return {
        id: x.id,
        name: x.name,
        price: x.price,
        tagline: x.tagline || '',
        description: x.description || '',
        gifUrl: x.gifUrl || null,
      };
    });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.status(200).send(JSON.stringify(out));
  } catch (e) {
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send('[]');
  }
};
