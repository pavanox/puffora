let interval;

const PRODUCT_NAME_MAP = {
    almond: 'Almond',
    anjeer: 'Anjeer',
    cashew: 'Cashew',
    pista: 'Pista',
    walnut: 'Walnut',
    ajwa: 'Ajwa',
    kalmi: 'Kalmi',
    mashrook: 'Mashrook',
    medjool: 'Medjool',
    pumpkin: 'Pumpkin',
    watermelon: 'Watermelon',
    muskmelon: 'Muskmelon',
    sunflower: 'Sunflower',
    chia: 'Chia',
    sabja: 'Sabja',
    makhana: 'Makhana'
};

const PRODUCT_PRICE_MAP = {
    almond: 349,
    anjeer: 259,
    cashew: 269,
    pista: 699,
    walnut: 349,
    ajwa: 999,
    kalmi: 699,
    mashrook: 899,
    medjool: 1099,
    pumpkin: 174,
    watermelon: 249,
    muskmelon: 249,
    sunflower: 100,
    chia: 124,
    sabja: 149,
    makhana: 459
};

// Explicit selling price per pack size, keyed by product slug then pack size.
// These are authoritative: the older VARIANT_PRICING multipliers are only a
// fallback for products that have no explicit price listed here.
const PRODUCT_VARIANT_PRICE_MAP = {
    cashew: { 250: 269, 500: 549, 1000: 1049 },
    almond: { 250: 349, 500: 669, 1000: 1299 },
    walnut: { 250: 349, 500: 700, 1000: 1399 },
    sabja: { 250: 149, 500: 299, 1000: 599 },
    anjeer: { 250: 259, 500: 525, 1000: 1050 },
    pumpkin: { 250: 174, 500: 349, 1000: 699 },
    sunflower: { 250: 100, 500: 200, 1000: 399 },
    chia: { 250: 124, 500: 249, 1000: 499 },
    watermelon: { 250: 249, 500: 499, 1000: 999 },
    muskmelon: { 250: 249, 500: 499, 1000: 999 }
};

// Returns the selling price for a product at a given pack size, preferring the
// explicit table and falling back to the base price times the size multiplier.
function getVariantPrice(categoryId, sizeKey) {
    const explicit = PRODUCT_VARIANT_PRICE_MAP[categoryId];
    if (explicit && explicit[sizeKey] !== undefined) {
        return explicit[sizeKey];
    }

    const basePrice = PRODUCT_PRICE_MAP[categoryId] || 0;
    return Math.round(basePrice * (VARIANT_PRICING[sizeKey] || 1));
}

const PRODUCT_VARIANTS = {
    250: { size: '250 g', multiplier: 1 },
    500: { size: '500 g', multiplier: 1.8 },
    1000: { size: '1 kg', multiplier: 3.2 }
};

const VARIANT_PRICING = {
    250: 1.0,
    500: 1.8,
    1000: 3.2
};

const PRODUCT_PAGE_MAP = {
    'dry-fruits.html': 'Dry Fruits',
    'premium-dates.html': 'Premium Dates',
    'seeds.html': 'Seeds',
    'healthy-snacks.html': 'Healthy Snacks'
};

function createVariantSelector(category) {
    const categoryId = category.id || '';
    const basePrice = PRODUCT_PRICE_MAP[categoryId] || 0;
    
    const selectorContainer = document.createElement('div');
    selectorContainer.className = 'pack-size-selector';
    
    const label = document.createElement('div');
    label.className = 'pack-size-label';
    label.textContent = 'Pack Size:';
    
    const optionsContainer = document.createElement('div');
    optionsContainer.className = 'pack-size-options';
    
    Object.entries(PRODUCT_VARIANTS).forEach(([sizeKey, variantInfo]) => {
        const variantId = `${categoryId}-${sizeKey}`;
        const variantPrice = getVariantPrice(categoryId, sizeKey);
        
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'pack-size-option';
        option.dataset.variantId = variantId;
        option.dataset.variantSize = sizeKey;
        option.dataset.variantPrice = variantPrice;
        option.textContent = variantInfo.size;
        
        if (sizeKey === '250') {
            option.classList.add('active');
        }
        
        option.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            updateVariantSelection(category, this);
        });
        
        optionsContainer.appendChild(option);
    });
    
    selectorContainer.appendChild(label);
    selectorContainer.appendChild(optionsContainer);
    
    const priceDisplay = document.createElement('div');
    priceDisplay.className = 'price-display';
    const basePrice250 = getVariantPrice(categoryId, '250');
    priceDisplay.innerHTML = `<span class="price-value">₹${basePrice250}</span>`;
    
    selectorContainer.appendChild(priceDisplay);
    
    return selectorContainer;
}

function updateVariantSelection(category, selectedButton) {
    const selectorContainer = category.querySelector('.pack-size-selector');
    const priceDisplay = selectorContainer.querySelector('.price-display');
    
    selectorContainer.querySelectorAll('.pack-size-option').forEach(btn => {
        btn.classList.remove('active');
    });
    
    selectedButton.classList.add('active');
    
    const variantPrice = parseInt(selectedButton.dataset.variantPrice);
    priceDisplay.innerHTML = `<span class="price-value">₹${variantPrice}</span>`;
    
    updateButtonMetadata(category);
}

function initSlider(category){

    let slides=category.querySelectorAll(".slide");
    let dotsContainer=category.querySelector(".dots");
    let prev=category.querySelector(".prev");
    let next=category.querySelector(".next");

    dotsContainer.innerHTML="";

    let current=0;

    slides.forEach((s,i)=>{

        let dot=document.createElement("span");
        dot.className="dot";

        if(i==0) dot.classList.add("active");

        dot.onclick=()=>{

            current=i;
            show();

        };

        dotsContainer.appendChild(dot);

    });

    let dots=dotsContainer.querySelectorAll(".dot");

    function show(){

        slides.forEach(sl=>sl.classList.remove("active"));
        dots.forEach(d=>d.classList.remove("active"));

        slides[current].classList.add("active");
        dots[current].classList.add("active");

    }

    function nextSlide(){

        current++;

        if(current>=slides.length)
            current=0;

        show();

    }

    function prevSlide(){

        current--;

        if(current<0)
            current=slides.length-1;

        show();

    }

    next.onclick=()=>{

        nextSlide();
        restart();

    }

    prev.onclick=()=>{

        prevSlide();
        restart();

    }

    function restart(){

        clearInterval(interval);

        interval=setInterval(nextSlide,3000);

    }

    restart();

}

document.querySelectorAll(".category").forEach(initSlider);

function changeCategory(id,btn){

    document.querySelectorAll(".category").forEach(c=>c.classList.remove("active"));

    document.getElementById(id).classList.add("active");

    document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));

    btn.classList.add("active");

}

function updateButtonMetadata(category) {
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    const pageLabel = PRODUCT_PAGE_MAP[currentPage] || currentPage;
    
    const categoryId = (category.id || '').toLowerCase();
    const productId = `${currentPage.replace('.html', '')}-${categoryId}`;
    const productName = PRODUCT_NAME_MAP[categoryId] || categoryId;
    const firstImage = category.querySelector('.slides .slide') ? category.querySelector('.slides .slide').getAttribute('src') || '' : '';
    
    const activeVariantButton = category.querySelector('.pack-size-option.active');
    const variantId = activeVariantButton ? activeVariantButton.dataset.variantId : `${categoryId}-250`;
    const variantPrice = activeVariantButton ? parseInt(activeVariantButton.dataset.variantPrice) : getVariantPrice(categoryId, '250');
    const variantSize = activeVariantButton ? activeVariantButton.dataset.variantSize : '250';

    category.querySelectorAll('.buttons .add-to-cart, .buttons .buy-now').forEach((button) => {
        button.setAttribute('data-product-id', productId);
        button.setAttribute('data-product-name', productName);
        button.setAttribute('data-product-price', String(variantPrice));
        button.setAttribute('data-product-image', firstImage);
        button.setAttribute('data-product-page', pageLabel);
        button.setAttribute('data-variant-id', variantId);
        button.setAttribute('data-variant-size', variantSize);
    });
}

function setupProductButtonMetadata(){
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    const pageLabel = PRODUCT_PAGE_MAP[currentPage] || currentPage;

    document.querySelectorAll('.category').forEach((category) => {
        const categoryId = (category.id || '').toLowerCase();
        const productId = `${currentPage.replace('.html', '')}-${categoryId}`;
        const productName = PRODUCT_NAME_MAP[categoryId] || categoryId;
        const basePrice = PRODUCT_PRICE_MAP[categoryId] || 0;
        const firstImage = category.querySelector('.slides .slide') ? category.querySelector('.slides .slide').getAttribute('src') || '' : '';
        
        const variantPrice = getVariantPrice(categoryId, '250');

        category.querySelectorAll('.buttons .add-to-cart, .buttons .buy-now').forEach((button) => {
            button.setAttribute('data-product-id', productId);
            button.setAttribute('data-product-name', productName);
            button.setAttribute('data-product-price', String(variantPrice));
            button.setAttribute('data-product-image', firstImage);
            button.setAttribute('data-product-page', pageLabel);
            button.setAttribute('data-variant-id', `${categoryId}-250`);
            button.setAttribute('data-variant-size', '250');
        });
    });
}

const BUY_NOW_STORAGE_KEY = 'puffora-buy-now';

function persistBuyNowItem(product){
    try {
        sessionStorage.setItem(BUY_NOW_STORAGE_KEY, JSON.stringify({
            ...product,
            quantity: 1
        }));
    } catch (error) {
        console.error(error);
    }
}

function handleProductButtonClick(event){
    const button = event.target.closest('a.add-to-cart, a.buy-now');

    if (!button) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    const product = {
        productId: button.getAttribute('data-product-id') || '',
        productName: button.getAttribute('data-product-name') || 'Product',
        productPrice: Number(button.getAttribute('data-product-price')) || 0,
        productImage: button.getAttribute('data-product-image') || '',
        productPage: button.getAttribute('data-product-page') || '',
        variantId: button.getAttribute('data-variant-id') || '',
        variantSize: button.getAttribute('data-variant-size') || '250'
    };

    if (!product.productId) {
        return;
    }

    if (button.classList.contains('buy-now')) {
        persistBuyNowItem(product);

        const originalMarkup = button.innerHTML;
        button.classList.add('is-added');
        button.innerHTML = '<i class="fas fa-check-circle"></i><span>Preparing checkout</span>';

        window.setTimeout(() => {
            button.classList.remove('is-added');
            button.innerHTML = originalMarkup;
            window.location.assign('checkout.html');
        }, 250);

        return;
    }

    if (!window.PufforaCart || typeof window.PufforaCart.addItem !== 'function') {
        return;
    }

    window.PufforaCart.addItem(product);

    const originalMarkup = button.innerHTML;
    button.classList.add('is-added');
    button.innerHTML = '<i class="fas fa-check-circle"></i><span>Added to cart</span>';

    window.setTimeout(() => {
        button.classList.remove('is-added');
        button.innerHTML = originalMarkup;
    }, 1200);
}

function initializeProductActions(){
    setupProductButtonMetadata();

    document.querySelectorAll('.category').forEach((category) => {
        const variantSelector = createVariantSelector(category);
        const dotsContainer = category.querySelector('.dots');
        
        if (dotsContainer && dotsContainer.parentNode) {
            dotsContainer.parentNode.insertBefore(variantSelector, dotsContainer.nextSibling);
        }
    });

    if (!document.body.dataset.productButtonHandlerAttached) {
        document.body.dataset.productButtonHandlerAttached = 'true';
        document.addEventListener('click', handleProductButtonClick);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeProductActions);
} else {
    initializeProductActions();
}