const fs = require('fs');
const path = require('path');

const files = ['dry-fruits.html', 'premium-dates.html', 'seeds.html', 'healthy-snacks.html'];
const root = process.cwd();

const newMarkup = `<div class="buttons">

                <a href="#" class="add-to-cart" data-action="add-to-cart">
                    <i class="fas fa-cart-plus"></i>
                    <span>Add to Cart</span>
                </a>

                <a href="#" class="buy-now" data-action="buy-now">
                    <i class="fas fa-bolt"></i>
                    <span>Buy Now</span>
                </a>

            </div>`;

const buttonsRegex = /<div class="buttons">[\s\S]*?<\/div>/g;

for (const file of files) {
  const fullPath = path.join(root, file);
  let text = fs.readFileSync(fullPath, 'utf8');
  const matches = text.match(buttonsRegex) || [];
  if (matches.length > 0) {
    text = text.replace(buttonsRegex, newMarkup);
    fs.writeFileSync(fullPath, text, 'utf8');
    console.log(`${file}: replaced ${matches.length} button block(s)`);
  } else {
    console.log(`${file}: no replacements`);
  }
}
