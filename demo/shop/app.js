const API_TOKEN = 'demo-bearer-5d2e8f0a1b';

const ART = {
  beanie:
    '<svg viewBox="0 0 80 80" width="100%" height="100%"><path d="M12 54c0-24 12-38 28-38s28 14 28 38z" fill="#c8431f"/><rect x="10" y="52" width="60" height="14" rx="3" fill="#b13a1a"/><path d="M22 53v12M30 53v12M38 53v12M46 53v12M54 53v12M62 53v12" stroke="#8f2d14" stroke-width="2"/></svg>',
  shades:
    '<svg viewBox="0 0 80 80" width="100%" height="100%"><circle cx="22" cy="42" r="14" fill="#2b2d2f"/><circle cx="58" cy="42" r="14" fill="#2b2d2f"/><path d="M36 39q4-5 8 0" stroke="#2b2d2f" stroke-width="3.5" fill="none"/><path d="M8 38l-6-4M72 38l6-4" stroke="#2b2d2f" stroke-width="3.5"/></svg>',
  tee:
    '<svg viewBox="0 0 80 80" width="100%" height="100%"><circle cx="40" cy="22" r="12" fill="#e0b48a"/><path d="M16 80V50l16-9h16l16 9v30z" fill="#161616"/></svg>',
};

const TRASH =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 3h6l1 2h4v2H4V5h4zM6 9h12l-1 12H7z"/></svg>';

const CART = [
  { id: 1, name: 'Gradient Graphic T-shirt', size: 'Large', color: 'White', price: 145, art: 'beanie', discounts: [{ code: 'WELCOME20' }] },
  { id: 2, name: 'Checkered Shirt', size: 'Medium', color: 'Red', price: 180, art: 'shades' },
  { id: 3, name: 'Skinny Fit Jeans', size: 'Large', color: 'Blue', price: 240, art: 'tee' },
];

function renderCartRow(item) {
  const row = document.createElement('li');
  row.className = 'cart-item';
  row.innerHTML =
    `<div class="thumb">${ART[item.art]}</div>` +
    `<div class="info"><strong class="name">${item.name}</strong><span class="meta">Size: ${item.size}</span><span class="meta">Color: ${item.color}</span><span class="price">$${item.price}</span></div>` +
    `<button class="trash" type="button" aria-label="Remove">${TRASH}</button>` +
    '<div class="qty"><button type="button" aria-label="Fewer">&minus;</button><span>1</span><button type="button" aria-label="More">+</button></div>';
  return row;
}

function renderSummary(items) {
  const codes = items.map((item) => item.discounts.map((discount) => discount.code));
  document.getElementById('discount-label').textContent = `Discount (${codes.flat().length ? '-20%' : '0%'})`;
}

function renderCart(items) {
  const list = document.getElementById('cart-list');
  items.forEach((item) => list.appendChild(renderCartRow(item)));
  renderSummary(items);
}

async function placeOrder() {
  const email = document.querySelector('#checkout [name=customer_email]').value;
  const response = await fetch('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
    body: JSON.stringify({
      customer: { email },
      items: CART.map((item) => ({ sku: `SKU-${item.id}`, price: item.price.toFixed(2), qty: 1 })),
    }),
  });
  if (!response.ok) console.error('POST /api/orders failed with status', response.status);
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('place-order').addEventListener('click', placeOrder);
  renderCart(CART);
});
window.addEventListener('load', placeOrder);
