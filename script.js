// Alehulsh (አለሁልሽ) - Interactive Landing Page Scripts

// ----------------------------------------------------------------------
// 1. Theme Management (Dark Mode Default + Light Mode Switcher)
// ----------------------------------------------------------------------
function getInitialTheme() {
    const saved = localStorage.getItem('alehulsh_theme');
    if (saved) return saved;
    return 'dark'; // Always default to Dark Mode on first load
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    if (document.body) {
        document.body.setAttribute('data-theme', theme);
    }
    localStorage.setItem('alehulsh_theme', theme);

    const themeIcon = document.getElementById('themeIcon');
    const themeBtn = document.getElementById('themeToggleBtn');
    const drawerThemeBtn = document.getElementById('drawerThemeToggleBtn');

    if (theme === 'light') {
        if (themeIcon) themeIcon.className = 'fa-solid fa-moon';
        if (themeBtn) themeBtn.setAttribute('title', 'Switch to Dark Mode');
        if (drawerThemeBtn) drawerThemeBtn.innerHTML = '<i class="fa-solid fa-moon"></i> Dark Mode';
    } else {
        if (themeIcon) themeIcon.className = 'fa-solid fa-sun';
        if (themeBtn) themeBtn.setAttribute('title', 'Switch to Light Mode');
        if (drawerThemeBtn) drawerThemeBtn.innerHTML = '<i class="fa-solid fa-sun"></i> Light Mode';
    }
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(nextTheme);
}

// Immediately apply theme on script load
applyTheme(getInitialTheme());

document.addEventListener('DOMContentLoaded', () => {
    // Re-verify theme icons on DOM ready
    applyTheme(getInitialTheme());

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

            document.querySelectorAll('.faq-item').forEach(i => i.classList.remove('active'));

            if (!isOpen) {
                item.classList.add('active');
            }
        });
    });

    // ----------------------------------------------------------------------
    // 4. Smooth Floating Card Parallax / Tilt on Mouse Move
    // ----------------------------------------------------------------------
    const stage = document.querySelector('.radar-interactive-stage');
    const cards = document.querySelectorAll('.floating-glass-card');
    const phone = document.querySelector('.phone-mockup-frame');

    if (stage && window.innerWidth > 992) {
        stage.addEventListener('mousemove', (e) => {
            const rect = stage.getBoundingClientRect();
            const x = e.clientX - rect.left - rect.width / 2;
            const y = e.clientY - rect.top - rect.height / 2;

            if (phone) {
                phone.style.transform = `rotateY(${x * 0.03}deg) rotateX(${-y * 0.03}deg)`;
            }

            cards.forEach((card, index) => {
                const factor = (index + 1) * 0.015;
                card.style.transform = `translate(${x * factor}px, ${y * factor}px)`;
            });
        });

        stage.addEventListener('mouseleave', () => {
            if (phone) {
                phone.style.transform = 'none';
            }
            cards.forEach((card) => {
                card.style.transform = 'none';
            });
        });
    }

});

// iOS Coming Soon Alert
function showIosComingSoon(event) {
    if (event) event.preventDefault();
    alert("🍎 Alehulsh for iOS is currently under development!\n\nThe iOS version is being built and will be available soon on the Apple App Store.\n\nAndroid users can tap 'Download APK' to get the live app directly.");
}
