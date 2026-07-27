document.addEventListener('DOMContentLoaded', function () {
    const headerPlaceholder = document.getElementById('header');
    const footerPlaceholder = document.getElementById('footer');

    if (!headerPlaceholder && !footerPlaceholder) {
        return;
    }

    const loadFragment = async (target, fileName) => {
        if (!target) {
            return;
        }

        const baseUrl = new URL('.', window.location.href);
        const response = await fetch(new URL(fileName, baseUrl));
        if (!response.ok) {
            throw new Error('Failed to load ' + fileName);
        }

        target.innerHTML = await response.text();
    };

    const loadIncludes = async () => {
        try {
            await loadFragment(headerPlaceholder, 'header.html');
            await loadFragment(footerPlaceholder, 'footer.html');

            const currentPage = window.location.pathname.split('/').pop() || 'index.html';
            const navLinks = document.querySelectorAll('#header a[href]');
            navLinks.forEach(function (link) {
                const href = link.getAttribute('href');
                if (!href || href === '#') {
                    return;
                }

                const normalizedHref = href.split('?')[0].split('#')[0];
                const normalizedPage = currentPage.split('?')[0].split('#')[0];
                if (normalizedHref === normalizedPage) {
                    link.classList.add('active');
                    if (link.closest('.dropdown-menu')) {
                        link.closest('.dropdown').querySelector('.dropdown-toggle').classList.add('active');
                    }
                }
            });

        } catch (error) {
            console.error(error);
        }
    };

    loadIncludes();
});
