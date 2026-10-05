(function ($) {
    "use strict";

    var CART_STORAGE_KEY = 'puffora-cart';
    var BUY_NOW_STORAGE_KEY = 'puffora-buy-now';

    window.PufforaCart = {
        getStoredCart: function () {
            try {
                var storedValue = sessionStorage.getItem(CART_STORAGE_KEY);
                return storedValue ? JSON.parse(storedValue) : { items: [] };
            } catch (error) {
                return { items: [] };
            }
        },
        saveCart: function (cart) {
            sessionStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
        },
        getCartItems: function () {
            return this.getStoredCart().items || [];
        },
        getCartCount: function (cart) {
            if (!cart || !cart.items) {
                return 0;
            }

            return cart.items.reduce(function (total, item) {
                return total + (Number(item.quantity) || 0);
            }, 0);
        },
        updateBadge: function () {
            var cart = this.getStoredCart();
            var count = this.getCartCount(cart);
            document.querySelectorAll('[data-cart-count]').forEach(function (element) {
                element.textContent = count;
            });
            document.querySelectorAll('[data-cart-badge]').forEach(function (element) {
                element.classList.toggle('has-items', count > 0);
            });
        },
        addItem: function (product) {
            var cart = this.getStoredCart();
            var cartItemKey = product.productId + (product.variantId ? '-' + product.variantId : '');
            var existingItem = cart.items.find(function (item) {
                var itemKey = item.productId + (item.variantId ? '-' + item.variantId : '');
                return itemKey === cartItemKey;
            });

            if (existingItem) {
                existingItem.quantity += 1;
            } else {
                cart.items.push({
                    productId: product.productId,
                    productName: product.productName,
                    productPrice: Number(product.productPrice) || 0,
                    productImage: product.productImage || '',
                    variantId: product.variantId || '',
                    variantSize: product.variantSize || '250',
                    quantity: 1
                });
            }

            this.saveCart(cart);
            this.updateBadge();
            this.updateCartView();
            return cart;
        },
        clearCart: function () {
            this.saveCart({ items: [] });
            this.updateBadge();
            this.updateCartView();
        },
        updateCartView: function () {
            var cart = this.getStoredCart();
            var cartItems = cart.items || [];
            var subtotal = cartItems.reduce(function (total, item) {
                return total + ((Number(item.productPrice) || 0) * (Number(item.quantity) || 0));
            }, 0);
            var shipping = subtotal > 0 ? 99 : 0;
            var grandTotal = subtotal + shipping;

            document.querySelectorAll('[data-cart-subtotal]').forEach(function (element) {
                element.textContent = '₹' + subtotal.toLocaleString('en-IN');
            });
            document.querySelectorAll('[data-cart-shipping]').forEach(function (element) {
                element.textContent = '₹' + shipping.toLocaleString('en-IN');
            });
            document.querySelectorAll('[data-cart-grand-total]').forEach(function (element) {
                element.textContent = '₹' + grandTotal.toLocaleString('en-IN');
            });
        },
        initialize: function () {
            this.updateBadge();
            this.updateCartView();
        }
    };

    // Spinner
    var spinner = function () {
        setTimeout(function () {
            if ($('#spinner').length > 0) {
                $('#spinner').removeClass('show');
            }
        }, 1);
    };
    spinner();
    
    
    // Initiate the wowjs
    new WOW().init();


    // Fixed Navbar — simplified to avoid layout shifts
    $(window).on('scroll resize', function () {
        if ($(this).scrollTop() > 45) {
            $('.fixed-top').addClass('bg-white shadow');
        } else {
            $('.fixed-top').removeClass('bg-white shadow');
        }
    });
    
    
    // Back to top button
    $(window).scroll(function () {
        if ($(this).scrollTop() > 300) {
            $('.back-to-top').fadeIn('slow');
        } else {
            $('.back-to-top').fadeOut('slow');
        }
    });
    $('.back-to-top').click(function () {
        $('html, body').animate({scrollTop: 0}, 1500, 'easeInOutExpo');
        return false;
    });


    // Testimonials carousel
    $(".testimonial-carousel").owlCarousel({
        autoplay: true,
        smartSpeed: 1000,
        margin: 25,
        loop: true,
        center: true,
        dots: false,
        nav: true,
        navText : [
            '<i class="bi bi-chevron-left"></i>',
            '<i class="bi bi-chevron-right"></i>'
        ],
        responsive: {
            0:{
                items:1
            },
            768:{
                items:2
            },
            992:{
                items:3
            }
        }
    });

    document.addEventListener('DOMContentLoaded', function () {
        window.PufforaCart.initialize();
    });

    window.addEventListener('load', function () {
        window.PufforaCart.updateBadge();
        window.PufforaCart.updateCartView();
    });

    window.addEventListener('pageshow', function () {
        window.PufforaCart.updateBadge();
        window.PufforaCart.updateCartView();
    });

})(jQuery);
