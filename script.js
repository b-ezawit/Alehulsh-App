// Alehulsh (አለሁልሽ) - Interactive Landing Page Scripts

document.addEventListener('DOMContentLoaded', () => {
    
    // ----------------------------------------------------------------------
    // 1. Theme Management (Light Mode Default + Dark Mode Switcher)
    // ----------------------------------------------------------------------
    const themeToggleBtn = document.getElementById('themeToggleBtn');
    const drawerThemeToggleBtn = document.getElementById('drawerThemeToggleBtn');
    const themeIcon = document.getElementById('themeIcon');
    const htmlElement = document.documentElement;

    // Load saved theme or default to light mode
    const savedTheme = localStorage.getItem('alehulsh_theme') || 'light';
    applyTheme(savedTheme);

    function applyTheme(theme) {
        htmlElement.setAttribute('data-theme', theme);
        localStorage.setItem('alehulsh_theme', theme);
        
        if (themeIcon) {
            if (theme === 'dark') {
                themeIcon.className = 'fa-solid fa-sun';
                themeToggleBtn.setAttribute('title', 'Switch to Light Mode');
            } else {
                themeIcon.className = 'fa-solid fa-moon';
                themeToggleBtn.setAttribute('title', 'Switch to Dark Mode');
            }
        }
    }

    function toggleTheme() {
        const currentTheme = htmlElement.getAttribute('data-theme') || 'light';
        const nextTheme = currentTheme === 'light' ? 'dark' : 'light';
        applyTheme(nextTheme);
    }

    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', toggleTheme);
    }

    if (drawerThemeToggleBtn) {
        drawerThemeToggleBtn.addEventListener('click', toggleTheme);
    }

    // ----------------------------------------------------------------------
    // 2. Mobile Drawer Navigation Toggle
    // ----------------------------------------------------------------------
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const closeDrawerBtn = document.getElementById('closeDrawerBtn');
    const mobileDrawer = document.getElementById('mobileDrawer');
    const drawerBackdrop = document.getElementById('drawerBackdrop');
    const drawerLinks = document.querySelectorAll('.drawer-link, .drawer-download-btn');

    function openDrawer() {
        if (mobileDrawer) mobileDrawer.classList.add('open');
        if (drawerBackdrop) drawerBackdrop.classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    function closeDrawer() {
        if (mobileDrawer) mobileDrawer.classList.remove('open');
        if (drawerBackdrop) drawerBackdrop.classList.remove('active');
        document.body.style.overflow = '';
    }

    if (mobileMenuBtn) {
        mobileMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openDrawer();
        });
    }

    if (closeDrawerBtn) {
        closeDrawerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeDrawer();
        });
    }

    if (drawerBackdrop) {
        drawerBackdrop.addEventListener('click', closeDrawer);
    }

    drawerLinks.forEach(link => {
        link.addEventListener('click', closeDrawer);
    });

    // ----------------------------------------------------------------------
    // 3. FAQ Accordion Toggle
    // ----------------------------------------------------------------------
    const faqQuestions = document.querySelectorAll('.faq-question');

    faqQuestions.forEach(question => {
        question.addEventListener('click', () => {
            const item = question.parentElement;
            const isOpen = item.classList.contains('active');

            // Close all items
            document.querySelectorAll('.faq-item').forEach(i => i.classList.remove('active'));

            // Toggle clicked item
            if (!isOpen) {
                item.classList.add('active');
            }
        });
    });

    // ----------------------------------------------------------------------
    // 4. Smooth Floating Card Parallax / Tilt on Mouse Move
    // ----------------------------------------------------------------------
    const stage = document.querySelector('.hero-visual-stage');
    const cards = document.querySelectorAll('.floating-glass-card');
    const artwork = document.querySelector('.hero-artwork-img');

    if (stage && window.innerWidth > 992) {
        stage.addEventListener('mousemove', (e) => {
            const rect = stage.getBoundingClientRect();
            const x = e.clientX - rect.left - rect.width / 2;
            const y = e.clientY - rect.top - rect.height / 2;

            if (artwork) {
                artwork.style.transform = `scale(1.02) rotateY(${x * 0.03}deg) rotateX(${-y * 0.03}deg)`;
            }

            cards.forEach((card, index) => {
                const factor = (index + 1) * 0.015;
                card.style.transform = `translate(${x * factor}px, ${y * factor}px)`;
            });
        });

        stage.addEventListener('mouseleave', () => {
            if (artwork) {
                artwork.style.transform = 'none';
            }
            cards.forEach((card) => {
                card.style.transform = 'none';
            });
        });
    }

});

// iOS Coming Soon Modal / Alert
function showIosComingSoon(event) {
    if (event) event.preventDefault();
    alert("🍎 Alehulsh for iOS is currently under development!\n\nThe iOS version is being built and will be available soon on the Apple App Store.\n\nAndroid users can tap 'Download APK' to get the live app directly.");
}
